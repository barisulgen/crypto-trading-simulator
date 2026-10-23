export interface HealthCfg {
  silentMs: number;
  lagMs: number;
  noUpdateMs: number;
}

/** A mark price received longer ago than this is stale. */
export const MARK_MAX_AGE_MS = 10_000;

const SILENT_WAIT = 'Waiting for order-book update after a silent connection';
const PAUSE_WAIT = 'Waiting for order-book update after a pause';
const SILENT_MARK_WAIT = 'Waiting for mark price after a silent connection';
const PAUSE_MARK_WAIT = 'Waiting for mark price after a pause';

export type Stream = 'depth' | 'trade' | 'ticker' | 'mark';

/** The streams of a spot connection: depth, trades and tickers in one socket. */
const SPOT_STREAMS: readonly Stream[] = ['depth', 'trade', 'ticker'];

export interface FeedHealthOptions {
  /** What the connection carries (default: depth, trade and ticker, as the spot stream does). */
  streams?: readonly Stream[];
  /** Default MARK_MAX_AGE_MS. */
  markMaxAgeMs?: number;
}

interface SymState {
  bookValid: boolean;
  lastDepth: number | null;
  /** When the last current (not late) mark price was received; null before the first. */
  lastMark: number | null;
  /** Lag in ms of the latest event of each stream; infinite when its event time was unusable. */
  lag: Record<Stream, number>;
  /**
   * Why the book is old until a current depth event arrives (a frame came after a silent stretch,
   * or the process was paused), or null.
   */
  needsDepth: string | null;
  /** The same for the mark price: old until a current mark update arrives. */
  needsMark: string | null;
}

/**
 * Judges per-symbol data freshness of one connection from its health plus a long no-update
 * limit. A connection carrying depth needs a synced, current book; one carrying the mark price
 * needs a current mark received at most markMaxAgeMs ago.
 */
export class FeedHealth {
  private readonly syms = new Map<string, SymState>();
  private readonly depth: boolean;
  private readonly mark: boolean;
  private readonly markMaxAgeMs: number;
  private connected = false;
  private lastFrame = 0;
  private connectAt = 0;
  private clockOffset = 0;

  constructor(symbols: string[], private readonly cfg: HealthCfg, opts: FeedHealthOptions = {}) {
    const streams = opts.streams ?? SPOT_STREAMS;
    this.depth = streams.includes('depth');
    this.mark = streams.includes('mark');
    this.markMaxAgeMs = opts.markMaxAgeMs ?? MARK_MAX_AGE_MS;
    for (const s of symbols) {
      this.syms.set(s, {
        bookValid: false,
        lastDepth: null,
        lastMark: null,
        lag: { depth: 0, trade: 0, ticker: 0, mark: 0 },
        needsDepth: null,
        needsMark: null,
      });
    }
  }

  private st(symbol: string): SymState {
    const s = this.syms.get(symbol);
    if (!s) throw new Error(`Unknown symbol ${symbol}`);
    return s;
  }

  onConnect(now: number): void {
    this.connected = true;
    this.lastFrame = now;
    this.connectAt = now;
  }

  onDisconnect(_now: number): void {
    this.connected = false;
    for (const s of this.syms.values()) s.bookValid = false;
  }

  onFrame(now: number): void {
    this.touch(now);
  }

  /**
   * The process was paused (sleep, event-loop freeze): what arrives next may have been buffered
   * during the pause, so every book is old until its next current depth event, as after a silent
   * stretch.
   */
  markStalled(_now: number): void {
    for (const s of this.syms.values()) {
      s.needsDepth = PAUSE_WAIT;
      s.needsMark = PAUSE_MARK_WAIT;
    }
  }

  /**
   * A frame arrived. After more than silentMs without one (a dead socket, or a frozen process
   * whose buffered frames only now arrive) every book may be old, and a trade or ticker does not
   * show otherwise: each symbol then waits for its next current depth event (and mark update).
   */
  private touch(now: number): void {
    if (now - this.lastFrame > this.cfg.silentMs) {
      for (const s of this.syms.values()) {
        s.needsDepth = SILENT_WAIT;
        s.needsMark = SILENT_MARK_WAIT;
      }
    }
    this.lastFrame = now;
  }

  private late(lag: number): boolean {
    return !(lag <= this.cfg.lagMs);
  }

  /**
   * Records how late the latest event of `stream`, stamped by the exchange at `eventTime`, is when
   * seen locally at `now`. Each stream keeps its own verdict: a current trade or ticker says
   * nothing about a late order book, so only a later depth event clears a depth lag.
   */
  private measure(symbol: string, stream: Stream, now: number, eventTime: number): SymState {
    const s = this.st(symbol);
    this.touch(now);
    // A missing or non-numeric event time can never prove the feed is current.
    s.lag[stream] = Number.isFinite(eventTime) ? now - (eventTime - this.clockOffset) : Number.POSITIVE_INFINITY;
    return s;
  }

  onDepth(symbol: string, now: number, eventTime: number): void {
    const s = this.measure(symbol, 'depth', now, eventTime);
    s.lastDepth = now;
    if (this.late(s.lag.depth)) return;
    // Only a current depth event shows the book is no older than the silence that preceded it.
    s.needsDepth = null;
    this.caughtUp(s);
  }

  /** A mark price update (Binance sends one per symbol every second). */
  onMark(symbol: string, now: number, eventTime: number): void {
    const s = this.measure(symbol, 'mark', now, eventTime);
    if (this.late(s.lag.mark)) return;
    s.lastMark = now;
    s.needsMark = null;
    if (!this.depth) this.caughtUp(s);
  }

  /**
   * A current depth event (or, on a connection without depth, a current mark update) shows the
   * connection has caught up, which is all a late trade or ticker signals; a quiet symbol would
   * otherwise stay stale until its next trade.
   */
  private caughtUp(s: SymState): void {
    s.lag.trade = 0;
    s.lag.ticker = 0;
  }

  onTrade(symbol: string, now: number, eventTime: number): void {
    this.measure(symbol, 'trade', now, eventTime);
  }

  onTicker(symbol: string, now: number, eventTime: number): void {
    this.measure(symbol, 'ticker', now, eventTime);
  }

  setBookValid(symbol: string, valid: boolean): void {
    this.st(symbol).bookValid = valid;
  }

  /** ms: exchangeTime - localTime. */
  setClockOffset(ms: number): void {
    this.clockOffset = ms;
  }

  reason(symbol: string, now: number): string | null {
    const s = this.st(symbol);
    const { noUpdateMs } = this.cfg;
    const down = this.connectionReason(now);
    if (down !== null) return down;
    if (this.depth && !s.bookValid) return 'Order book resyncing';
    const lagging = this.lagReason(Object.values(s.lag));
    if (lagging !== null) return lagging;
    if (this.depth) {
      if (s.needsDepth !== null) return s.needsDepth;
      if (now - (s.lastDepth ?? this.connectAt) > noUpdateMs) {
        return `No order-book updates for ${noUpdateMs / 1000}s`;
      }
    }
    return this.mark ? this.markAge(s, now) : null;
  }

  isFresh(symbol: string, now: number): boolean {
    return this.reason(symbol, now) === null;
  }

  /**
   * Why the symbol's mark price is not usable, or null: it needs a healthy connection and a
   * current mark update received at most markMaxAgeMs ago; trades and tickers do not count.
   * Always a reason on a connection that does not carry the mark price.
   */
  markReason(symbol: string, now: number): string | null {
    const s = this.st(symbol);
    if (!this.mark) return 'No mark price on this connection';
    return this.connectionReason(now) ?? this.lagReason([s.lag.mark]) ?? this.markAge(s, now);
  }

  isMarkFresh(symbol: string, now: number): boolean {
    return this.markReason(symbol, now) === null;
  }

  private connectionReason(now: number): string | null {
    const { silentMs } = this.cfg;
    if (!this.connected) return 'Disconnected';
    if (now - this.lastFrame > silentMs) return `Connection silent for ${silentMs / 1000}s`;
    return null;
  }

  /** The worst of `lags` that is late, as a reason; null when none is. */
  private lagReason(lags: number[]): string | null {
    const late = lags.filter((lag) => this.late(lag));
    if (late.length === 0) return null;
    const worst = Math.max(...late);
    return Number.isFinite(worst) ? `Feed lagging by ${(worst / 1000).toFixed(1)}s` : 'Feed lagging (invalid event time)';
  }

  private markAge(s: SymState, now: number): string | null {
    if (s.needsMark !== null) return s.needsMark;
    if (s.lastMark === null) return 'Waiting for mark price';
    if (now - s.lastMark > this.markMaxAgeMs) return `No mark price for ${this.markMaxAgeMs / 1000}s`;
    return null;
  }

  /** When the last frame of any kind, or the connection's opening, was received (0 before the first). */
  lastFrameAt(): number {
    return this.lastFrame;
  }
}
