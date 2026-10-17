import { EventEmitter } from 'node:events';
import { D } from '@sim/engine';
import type { AggTrade, BookSnapshot, Decimal, MarketView, PriceLevel, SpotRules } from '@sim/engine';
import type { Logger } from '../log.ts';
import type { BinanceRest } from '../binance/rest.ts';
import { parseSpotRules } from '../binance/parseRules.ts';
import type { FeedHealth } from './feedHealth.ts';
import type { LocalBook } from './localBook.ts';
import type { Ticker } from './spotFeed.ts';
import { defaultSetTimer } from './ws.ts';
import type { SetTimer } from './ws.ts';

export const AVG_PRICE_POLL_MS = 10_000;
export const AVG_PRICE_MAX_AGE_MS = 60_000;
export const RULES_REFRESH_MS = 3_600_000;
export const CLOCK_REFRESH_MS = 600_000;
const TRADE_RING = 50;
const POLL_STAGGER_MS = 1000;
const STARTUP_RETRY_START_MS = 5000;
const STARTUP_RETRY_MAX_MS = 60_000;

export interface MarketDataDeps {
  symbols: string[];
  /** The SpotFeed (or a stand-in): emits trade / ticker / book. */
  feed: EventEmitter;
  books: Map<string, LocalBook>;
  health: FeedHealth;
  rest: Pick<BinanceRest, 'exchangeInfo' | 'avgPrice' | 'serverTime'>;
  logger: Logger;
  now?: () => number;
  setTimer?: SetTimer;
}

/** What the engine and API may know about the market. Never invents a price. */
export class MarketData extends EventEmitter implements MarketView {
  private readonly symbols: string[];
  private readonly books: Map<string, LocalBook>;
  private readonly health: FeedHealth;
  private readonly rest: MarketDataDeps['rest'];
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly ruleMap = new Map<string, SpotRules>();
  private readonly avg = new Map<string, { price: Decimal; at: number }>();
  private readonly last = new Map<string, Decimal>();
  private readonly tick = new Map<string, Ticker>();
  private readonly trades = new Map<string, AggTrade[]>();
  private cancels = new Set<() => void>();
  private stopped = false;
  private started = false;

  constructor(d: MarketDataDeps) {
    super();
    this.symbols = d.symbols;
    this.books = d.books;
    this.health = d.health;
    this.rest = d.rest;
    this.log = d.logger;
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? defaultSetTimer;
    d.feed.on('trade', (symbol: string, t: AggTrade) => {
      this.last.set(symbol, t.price);
      const ring = this.trades.get(symbol) ?? [];
      ring.unshift(t);
      if (ring.length > TRADE_RING) ring.length = TRADE_RING;
      this.trades.set(symbol, ring);
      this.emit('trade', symbol, t);
    });
    d.feed.on('ticker', (symbol: string, t: Ticker) => {
      this.tick.set(symbol, t);
      this.emit('ticker', symbol, t);
    });
    d.feed.on('book', (symbol: string) => this.emit('book', symbol));
  }

  /** Loads rules, measures the clock offset and starts the pollers. Idempotent; stop() then start() restarts. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.every(() => this.refreshRules(), RULES_REFRESH_MS, 0, true);
    this.every(() => this.refreshClockOffset(), CLOCK_REFRESH_MS, 0, true);
    this.symbols.forEach((s, i) =>
      this.every(async () => (await this.pollAvgPrice(s), true), AVG_PRICE_POLL_MS, i * POLL_STAGGER_MS, false),
    );
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const c of this.cancels) c();
    this.cancels.clear();
  }

  /**
   * Runs `fn` after `firstDelay`, then every `ms`. With `untilFirstSuccess`, a failed run is
   * retried quickly (5 s doubling to 60 s) until it first succeeds, then at the normal period.
   */
  private every(fn: () => Promise<boolean>, ms: number, firstDelay: number, untilFirstSuccess: boolean): void {
    let cancel: () => void = () => {};
    let ok = false;
    let retry = STARTUP_RETRY_START_MS;
    const arm = (delay: number) => {
      this.cancels.delete(cancel);
      cancel = this.setTimer(() => {
        if (this.stopped) return;
        void fn()
          .catch(() => false)
          .then((success) => {
            if (this.stopped) return;
            if (success) ok = true;
            if (ok || !untilFirstSuccess) return arm(ms);
            arm(retry);
            retry = Math.min(retry * 2, STARTUP_RETRY_MAX_MS);
          });
      }, delay);
      this.cancels.add(cancel);
    };
    arm(firstDelay);
  }

  /** True when every symbol has rules afterwards. */
  async refreshRules(): Promise<boolean> {
    try {
      const info = await this.rest.exchangeInfo(this.symbols);
      for (const raw of info?.symbols ?? []) {
        try {
          const rules = parseSpotRules(raw);
          if (this.symbols.includes(rules.symbol)) this.ruleMap.set(rules.symbol, rules);
        } catch (e) {
          this.log.warn(`exchangeInfo: ${(e as Error).message}`);
        }
      }
      return this.symbols.every((s) => this.ruleMap.has(s));
    } catch (e) {
      this.log.warn(`exchangeInfo refresh failed: ${(e as Error).message}`);
      return false;
    }
  }

  async pollAvgPrice(symbol: string): Promise<void> {
    try {
      const r = await this.rest.avgPrice(symbol);
      this.avg.set(symbol, { price: D(r.price), at: this.now() });
    } catch (e) {
      this.log.warn(`avgPrice ${symbol} failed: ${(e as Error).message}`);
    }
  }

  async refreshClockOffset(): Promise<boolean> {
    try {
      const t0 = this.now();
      const r = await this.rest.serverTime();
      const t1 = this.now();
      const offset = Number(r?.serverTime) - (t0 + t1) / 2;
      if (!Number.isFinite(offset)) return false;
      this.health.setClockOffset(offset);
      return true;
    } catch (e) {
      this.log.warn(`serverTime failed: ${(e as Error).message}`);
      return false;
    }
  }

  // MarketView
  isFresh(symbol: string): boolean {
    return this.ruleMap.has(symbol) && this.health.isFresh(symbol, this.now());
  }

  book(symbol: string): BookSnapshot {
    return this.bookOf(symbol).snapshot();
  }

  avgPrice(symbol: string): Decimal | null {
    const a = this.avg.get(symbol);
    return a && this.now() - a.at <= AVG_PRICE_MAX_AGE_MS ? a.price : null;
  }

  lastPrice(symbol: string): Decimal | null {
    return this.last.get(symbol) ?? null;
  }

  rules(symbol: string): SpotRules {
    const r = this.ruleMap.get(symbol);
    if (!r) throw new Error(`Rules not loaded for ${symbol}`);
    return r;
  }

  // Extras for the API and UI
  bestBid(symbol: string): { price: Decimal; fresh: boolean } | null {
    const lvl: PriceLevel | null = this.bookOf(symbol).bestBid();
    return lvl ? { price: lvl.price, fresh: this.isFresh(symbol) } : null;
  }

  tickers(): Record<string, Ticker> {
    return Object.fromEntries(this.tick);
  }

  recentTrades(symbol: string, n = TRADE_RING): AggTrade[] {
    return (this.trades.get(symbol) ?? []).slice(0, n);
  }

  bookTop(symbol: string, levels = 20): BookSnapshot {
    return this.bookOf(symbol).snapshot(levels);
  }

  healthSnapshot(): Record<string, { fresh: boolean; reason: string | null }> {
    const now = this.now();
    const out: Record<string, { fresh: boolean; reason: string | null }> = {};
    for (const s of this.symbols) {
      const reason = this.health.reason(s, now);
      out[s] = { fresh: reason === null && this.ruleMap.has(s), reason: reason ?? (this.ruleMap.has(s) ? null : 'Trading rules not loaded') };
    }
    return out;
  }

  private bookOf(symbol: string): LocalBook {
    const b = this.books.get(symbol);
    if (!b) throw new Error(`Unknown symbol ${symbol}`);
    return b;
  }
}
