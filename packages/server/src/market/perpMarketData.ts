import { EventEmitter } from 'node:events';
import type { AggTrade, BookSnapshot, Bracket, Decimal, PerpMarketView, PerpRules, PriceLevel, Side, TierSet } from '@sim/engine';
import { TIERS_REFRESH_MS } from '../config.ts';
import type { Logger } from '../log.ts';
import type { FuturesRest } from '../binance/futuresRest.ts';
import { parsePerpRules } from '../binance/parsePerpRules.ts';
import type { FeedHealth } from './feedHealth.ts';
import { LiveMarket } from './liveMarket.ts';
import type { LocalBook } from './localBook.ts';
import { CLOCK_REFRESH_MS, HALT_REPOLL_MS, RULES_REFRESH_MS } from './marketData.ts';
import type { MarkUpdate, PerpHealth } from './perpFeed.ts';
import { measureClockOffset, Pollers } from './pollers.ts';
import type { DepthLevels, Ticker } from './streamParse.ts';
import { defaultSetTimer } from './ws.ts';
import type { SetTimer } from './ws.ts';

export { TIERS_REFRESH_MS };

export interface PerpMarketDataDeps {
  symbols: string[];
  /** The PerpFeed (or a stand-in): emits trade / ticker / mark / book / snapshot. */
  feed: EventEmitter;
  books: Map<string, LocalBook>;
  health: PerpHealth;
  rest: Pick<FuturesRest, 'exchangeInfo' | 'serverTime'>;
  /** The leverage tiers of every symbol (TierLoader). */
  tiers: { load(now: number): Promise<TierSet> };
  logger: Logger;
  now?: () => number;
  setTimer?: SetTimer;
}

export interface PerpMark {
  markPrice: Decimal;
  fundingRate: Decimal;
  nextFundingTime: number;
  fresh: boolean;
}

/**
 * What the perp engine and the API may know about the USDⓈ-M perpetuals. Never invents a price.
 * A symbol is fresh only when both feed connections are healthy and its book, trades and mark
 * price are current, its rules and leverage tiers are loaded and Binance is trading it. The
 * engine's view of a book (book, best) holds back what the owner's own taker fills took; bookTop,
 * shown to the owner, is the real book. Rules refresh hourly (every 45 s while any symbol is not
 * TRADING, as Binance changes price bounds and halts); tiers load at start and every 24 h, and a
 * failed refresh keeps the previous ones.
 */
export class PerpMarketData extends EventEmitter implements PerpMarketView {
  private readonly symbols: string[];
  private readonly health: PerpHealth;
  private readonly rest: PerpMarketDataDeps['rest'];
  private readonly tiers: PerpMarketDataDeps['tiers'];
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly pollers: Pollers;
  private readonly live: LiveMarket;
  private readonly ruleMap = new Map<string, PerpRules>();
  private readonly mark = new Map<string, MarkUpdate>();
  private tierSet: TierSet | null = null;
  private started = false;
  /** Called once rules and tiers have both loaded (see ready()). */
  private readyWaiters: (() => void)[] = [];

  constructor(d: PerpMarketDataDeps) {
    super();
    this.symbols = d.symbols;
    this.health = d.health;
    this.rest = d.rest;
    this.tiers = d.tiers;
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
    d.feed.on('mark', (symbol: string, m: MarkUpdate) => {
      this.mark.set(symbol, m);
      this.emit('mark', symbol, m);
    });
    d.feed.on('book', (symbol: string, levels?: DepthLevels) => {
      this.live.onBook(symbol, levels);
      this.emit('book', symbol);
    });
    d.feed.on('snapshot', (symbol: string) => this.live.onSnapshot(symbol));
  }

  /** Loads rules, tiers and the clock offset, then keeps them current. Idempotent; stop() then start() restarts. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollers.every(() => this.refreshRules(), () => (this.anyHalted() ? HALT_REPOLL_MS : RULES_REFRESH_MS), 0, true);
    this.pollers.every(() => this.refreshClockOffset(), CLOCK_REFRESH_MS, 0, true);
    this.pollers.every(() => this.refreshTiers(), TIERS_REFRESH_MS, 0, true);
  }

  stop(): void {
    this.started = false;
    this.pollers.stop();
  }

  /**
   * Resolves once trading rules (from an exchangeInfo that listed any of the symbols) and a set of
   * leverage tiers are both held. The perp feed starts only then, so no trade or mark reaches the
   * engine before what it needs to act on it.
   */
  ready(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  private isReady(): boolean {
    return this.ruleMap.size > 0 && this.tierSet !== null;
  }

  private checkReady(): void {
    if (!this.isReady()) return;
    for (const resolve of this.readyWaiters.splice(0)) resolve();
  }

  /** True when every symbol has rules afterwards. A symbol whose entry is missing or malformed keeps its previous rules. */
  async refreshRules(): Promise<boolean> {
    try {
      const info = await this.rest.exchangeInfo();
      for (const raw of info?.symbols ?? []) {
        if (!this.symbols.includes(raw?.symbol)) continue;
        try {
          const rules = parsePerpRules(raw);
          this.ruleMap.set(rules.symbol, rules);
        } catch (e) {
          this.log.warn(`futures exchangeInfo: ${(e as Error).message}`);
        }
      }
      this.checkReady();
      return this.symbols.every((s) => this.ruleMap.has(s));
    } catch (e) {
      this.log.warn(`futures exchangeInfo refresh failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * True when tiers fetched from Binance are held afterwards. A failed load keeps the previous
   * tiers, and so does one that reached only the bundled snapshot while tiers fetched from Binance
   * are held: those are newer. The bundled snapshot is installed when nothing better is held, but
   * the result is then false, so the poller keeps looking for a live source.
   */
  async refreshTiers(): Promise<boolean> {
    try {
      const set = await this.tiers.load(this.now());
      const held = this.tierSet;
      if (held && held.source !== 'bundled' && set.source === 'bundled') {
        this.log.warn(`Leverage tiers: keeping the ${held.source} tiers fetched ${new Date(held.fetchedAt).toISOString()}`);
        return true;
      }
      this.tierSet = set;
      this.checkReady();
      return set.source !== 'bundled';
    } catch (e) {
      this.log.warn(`Leverage tiers refresh failed${this.tierSet ? '; keeping the previous tiers' : ''}: ${(e as Error).message}`);
      return this.tierSet !== null && this.tierSet.source !== 'bundled';
    }
  }

  async refreshClockOffset(): Promise<boolean> {
    try {
      const offset = await measureClockOffset(() => this.rest.serverTime(), this.now);
      if (offset === null) return false;
      this.health.depth.setClockOffset(offset);
      this.health.market.setClockOffset(offset);
      return true;
    } catch (e) {
      this.log.warn(`futures serverTime failed: ${(e as Error).message}`);
      return false;
    }
  }

  // PerpMarketView
  isFresh(symbol: string): boolean {
    return this.reason(symbol, this.now()) === null;
  }

  isMarkFresh(symbol: string): boolean {
    return this.health.market.isMarkFresh(symbol, this.now());
  }

  book(symbol: string): BookSnapshot {
    return this.live.book(symbol);
  }

  best(symbol: string, side: Side): Decimal | null {
    return this.live.best(symbol, side);
  }

  lastPrice(symbol: string): Decimal | null {
    return this.live.lastPrice(symbol);
  }

  markPrice(symbol: string): Decimal | null {
    return this.mark.get(symbol)?.markPrice ?? null;
  }

  rules(symbol: string): PerpRules {
    const r = this.ruleMap.get(symbol);
    if (!r) throw new Error(`Rules not loaded for ${symbol}`);
    return r;
  }

  brackets(symbol: string): Bracket[] {
    const b = this.tierSet?.brackets[symbol];
    if (!b) throw new Error(`Leverage tiers not loaded for ${symbol}`);
    return b;
  }

  /**
   * The owner's own taker fill took `levels` from the side a `side` order takes (asks for a buy,
   * bids for a sell): later walks see those levels reduced until a depth update touches them.
   */
  consume(symbol: string, side: Side, levels: PriceLevel[]): void {
    this.live.consume(symbol, side, levels);
  }

  // Health, for the runner
  /** Both connections' health, so a detected pause can be reported to each (markStalled). */
  healths(): FeedHealth[] {
    return [this.health.depth, this.health.market];
  }

  /** The process was paused: every book waits for a current depth event and every mark for a current mark update. */
  markStalled(now: number): void {
    for (const h of this.healths()) h.markStalled(now);
  }

  /** When the older of the two connections last received a frame: perp data is live only while both are. */
  lastFrameAt(): number {
    return Math.min(this.health.depth.lastFrameAt(), this.health.market.lastFrameAt());
  }

  // Extras for the API and UI
  healthSnapshot(): Record<string, { fresh: boolean; reason: string | null }> {
    const now = this.now();
    const out: Record<string, { fresh: boolean; reason: string | null }> = {};
    for (const s of this.symbols) {
      const reason = this.reason(s, now);
      out[s] = { fresh: reason === null, reason };
    }
    return out;
  }

  tickers(): Record<string, Ticker> {
    return this.live.tickers();
  }

  /** The last mark update of every symbol that has had one, with whether it is fresh now. */
  marks(): Record<string, PerpMark> {
    const out: Record<string, PerpMark> = {};
    for (const [s, m] of this.mark) {
      out[s] = { markPrice: m.markPrice, fundingRate: m.fundingRate, nextFundingTime: m.nextFundingTime, fresh: this.isMarkFresh(s) };
    }
    return out;
  }

  recentTrades(symbol: string, n?: number): AggTrade[] {
    return this.live.recentTrades(symbol, n);
  }

  bookTop(symbol: string, levels = 20): BookSnapshot {
    return this.live.bookTop(symbol, levels);
  }

  /** Where the leverage tiers in use came from and when they were fetched; null before the first load. */
  tierInfo(): { source: TierSet['source']; fetchedAt: number } | null {
    return this.tierSet ? { source: this.tierSet.source, fetchedAt: this.tierSet.fetchedAt } : null;
  }

  /** Why the symbol is not fresh, or null. A halt first: the streams go quiet during one, which would otherwise hide it. */
  private reason(symbol: string, now: number): string | null {
    return (
      this.halted(symbol) ??
      this.health.depth.reason(symbol, now) ??
      this.health.market.reason(symbol, now) ??
      (this.ruleMap.has(symbol) ? null : 'Trading rules not loaded') ??
      (this.tierSet?.brackets[symbol] ? null : 'Leverage tiers not loaded')
    );
  }

  /** Whether Binance is not trading any of the symbols, as of the last exchangeInfo. */
  private anyHalted(): boolean {
    return this.symbols.some((s) => this.halted(s) !== null);
  }

  /** Why Binance is not trading the symbol, or null when it is (or its rules are not loaded yet). */
  private halted(symbol: string): string | null {
    const st = this.ruleMap.get(symbol)?.status;
    return st === undefined || st === 'TRADING' ? null : `Trading halted on Binance (${st})`;
  }
}
