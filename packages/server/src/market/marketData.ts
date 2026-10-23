import { EventEmitter } from 'node:events';
import { D } from '@sim/engine';
import type { AggTrade, BookSnapshot, Decimal, MarketView, PriceLevel, Side, SpotRules } from '@sim/engine';
import type { Logger } from '../log.ts';
import type { BinanceRest } from '../binance/rest.ts';
import { parseSpotRules, parseSymbolStatus } from '../binance/parseRules.ts';
import type { FeedHealth } from './feedHealth.ts';
import { LiveMarket } from './liveMarket.ts';
import type { LocalBook } from './localBook.ts';
import { measureClockOffset, Pollers } from './pollers.ts';
import type { DepthLevels, Ticker } from './streamParse.ts';
import { defaultSetTimer } from './ws.ts';
import type { SetTimer } from './ws.ts';

export const AVG_PRICE_POLL_MS = 10_000;
export const AVG_PRICE_MAX_AGE_MS = 60_000;
export const RULES_REFRESH_MS = 3_600_000;
/** While any symbol is not TRADING on Binance, exchangeInfo is polled this often to see the halt end. */
export const HALT_REPOLL_MS = 45_000;
export const CLOCK_REFRESH_MS = 600_000;
const POLL_STAGGER_MS = 1000;

export interface MarketDataDeps {
  symbols: string[];
  /** The SpotFeed (or a stand-in): emits trade / ticker / book / snapshot. */
  feed: EventEmitter;
  books: Map<string, LocalBook>;
  health: FeedHealth;
  rest: Pick<BinanceRest, 'exchangeInfo' | 'avgPrice' | 'serverTime'>;
  logger: Logger;
  now?: () => number;
  setTimer?: SetTimer;
}

/**
 * What the engine and API may know about the market. Never invents a price. The engine's view of
 * a book (book, best, bestBid) holds back what the owner's own taker fills took (OwnLiquidity);
 * bookTop, shown to the owner, is the real book.
 */
export class MarketData extends EventEmitter implements MarketView {
  private readonly symbols: string[];
  private readonly health: FeedHealth;
  private readonly rest: MarketDataDeps['rest'];
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly pollers: Pollers;
  private readonly live: LiveMarket;
  private readonly ruleMap = new Map<string, SpotRules>();
  /** Binance trading status per symbol, from the same exchangeInfo entry as its rules. */
  private readonly status = new Map<string, string>();
  private readonly avg = new Map<string, { price: Decimal; at: number }>();
  /** The last best bid of a synced book and when it was seen; kept while the book is emptied. */
  private readonly lastBid = new Map<string, { price: Decimal; at: number }>();
  private started = false;

  constructor(d: MarketDataDeps) {
    super();
    this.symbols = d.symbols;
    this.health = d.health;
    this.rest = d.rest;
    this.log = d.logger;
    this.now = d.now ?? Date.now;
    this.pollers = new Pollers(d.setTimer ?? defaultSetTimer);
    this.live = new LiveMarket(d.books);
    d.feed.on('trade', (symbol: string, t: AggTrade) => {
      this.live.onTrade(symbol, t);
      this.emit('trade', symbol, t);
    });
    d.feed.on('ticker', (symbol: string, t: Ticker) => {
      this.live.onTicker(symbol, t);
      this.emit('ticker', symbol, t);
    });
    d.feed.on('book', (symbol: string, levels?: DepthLevels) => {
      this.live.onBook(symbol, levels);
      this.noteBid(symbol);
      this.emit('book', symbol);
    });
    d.feed.on('snapshot', (symbol: string) => this.live.onSnapshot(symbol));
  }

  /** Loads rules, measures the clock offset and starts the pollers. Idempotent; stop() then start() restarts. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollers.every(() => this.refreshRules(), () => (this.anyHalted() ? HALT_REPOLL_MS : RULES_REFRESH_MS), 0, true);
    this.pollers.every(() => this.refreshClockOffset(), CLOCK_REFRESH_MS, 0, true);
    this.symbols.forEach((s, i) =>
      this.pollers.every(async () => (await this.pollAvgPrice(s), true), AVG_PRICE_POLL_MS, i * POLL_STAGGER_MS, false),
    );
  }

  stop(): void {
    this.started = false;
    this.pollers.stop();
  }

  /** True when every symbol has rules afterwards. */
  async refreshRules(): Promise<boolean> {
    try {
      const info = await this.rest.exchangeInfo(this.symbols);
      for (const raw of info?.symbols ?? []) {
        try {
          const rules = parseSpotRules(raw);
          const status = parseSymbolStatus(raw);
          if (this.symbols.includes(rules.symbol)) {
            this.ruleMap.set(rules.symbol, rules);
            this.status.set(rules.symbol, status);
          }
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
      const offset = await measureClockOffset(() => this.rest.serverTime(), this.now);
      if (offset === null) return false;
      this.health.setClockOffset(offset);
      return true;
    } catch (e) {
      this.log.warn(`serverTime failed: ${(e as Error).message}`);
      return false;
    }
  }

  // MarketView
  isFresh(symbol: string): boolean {
    return this.ruleMap.has(symbol) && this.halted(symbol) === null && this.health.isFresh(symbol, this.now());
  }

  /** Whether Binance is not trading any of the symbols, as of the last exchangeInfo. */
  private anyHalted(): boolean {
    return this.symbols.some((s) => this.halted(s) !== null);
  }

  /** Why Binance is not trading the symbol, or null when it is (or its status is not known yet). */
  private halted(symbol: string): string | null {
    const st = this.status.get(symbol);
    return st === undefined || st === 'TRADING' ? null : `Trading halted on Binance (${st})`;
  }

  book(symbol: string): BookSnapshot {
    return this.live.book(symbol);
  }

  best(symbol: string, side: Side): Decimal | null {
    return this.live.best(symbol, side);
  }

  /**
   * The owner's own taker fill took `levels` from the side a `side` order takes (asks for a buy,
   * bids for a sell): later walks see those levels reduced until a depth update touches them.
   */
  consume(symbol: string, side: Side, levels: PriceLevel[]): void {
    this.live.consume(symbol, side, levels);
    this.noteBid(symbol);
  }

  avgPrice(symbol: string): Decimal | null {
    const a = this.avg.get(symbol);
    return a && this.now() - a.at <= AVG_PRICE_MAX_AGE_MS ? a.price : null;
  }

  lastPrice(symbol: string): Decimal | null {
    return this.live.lastPrice(symbol);
  }

  rules(symbol: string): SpotRules {
    const r = this.ruleMap.get(symbol);
    if (!r) throw new Error(`Rules not loaded for ${symbol}`);
    return r;
  }

  // Extras for the API and UI
  /**
   * The best bid and when it was received, less what the owner's own sells took (the price the
   * coins could still be sold at, so holdings are never valued above it). While the symbol is
   * stale (its book may be emptied until the next snapshot) it is the last real bid of the synced
   * book, never an invented one; null only when there has been no bid since start.
   */
  bestBid(symbol: string): { price: Decimal; fresh: boolean; at: number } | null {
    const bid = this.best(symbol, 'sell');
    if (bid && this.isFresh(symbol)) return { price: bid, fresh: true, at: this.now() };
    const last = this.lastBid.get(symbol);
    if (last) return { price: last.price, fresh: false, at: last.at };
    // A snapshot not yet bridged by a diff: real bids, just fetched.
    return bid ? { price: bid, fresh: false, at: this.now() } : null;
  }

  /** Remember the best bid (less the owner's own fills) and when it was seen, for while the book is emptied. */
  private noteBid(symbol: string): void {
    if (!this.live.has(symbol)) return;
    const bid = this.best(symbol, 'sell');
    if (bid) this.lastBid.set(symbol, { price: bid, at: this.now() });
  }

  tickers(): Record<string, Ticker> {
    return this.live.tickers();
  }

  recentTrades(symbol: string, n?: number): AggTrade[] {
    return this.live.recentTrades(symbol, n);
  }

  bookTop(symbol: string, levels = 20): BookSnapshot {
    return this.live.bookTop(symbol, levels);
  }

  healthSnapshot(): Record<string, { fresh: boolean; reason: string | null }> {
    const now = this.now();
    const out: Record<string, { fresh: boolean; reason: string | null }> = {};
    for (const s of this.symbols) {
      // A halt first: the depth stream goes quiet during one, which would otherwise hide it.
      const reason = this.halted(s) ?? this.health.reason(s, now);
      out[s] = { fresh: reason === null && this.ruleMap.has(s), reason: reason ?? (this.ruleMap.has(s) ? null : 'Trading rules not loaded') };
    }
    return out;
  }
}
