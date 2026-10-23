export interface HealthCfg {
  silentMs: number;
  lagMs: number;
  noUpdateMs: number;
}

const SILENT_WAIT = 'Waiting for order-book update after a silent connection';
const PAUSE_WAIT = 'Waiting for order-book update after a pause';

type Stream ='depth' | 'trade' | 'ticker';

interface SymState {
  bookValid: boolean;
  lastDepth: number | null;
  /** Lag in ms of the latest event of each stream; infinite when its event time was unusable. */
  lag: Record<Stream, number>;
  /**
   * Why the book is old until a current depth event arrives (a frame came after a silent stretch,
   * or the process was paused), or null.
   */
  needsDepth: string | null;
}

/** Judges per-symbol data freshness from connection health plus a long no-update limit. */
export class FeedHealth {
  private readonly syms = new Map<string, SymState>();
  private connected = false;
  private lastFrame = 0;
  private connectAt = 0;
  private clockOffset = 0;

  constructor(symbols: string[], private readonly cfg: HealthCfg) {
    for (const s of symbols) {
      this.syms.set(s, {
        bookValid: false,
        lastDepth: null,
        lag: { depth: 0, trade: 0, ticker: 0 },
        needsDepth: null,
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
    for (const s of this.syms.values()) s.needsDepth = PAUSE_WAIT;
  }

  /**
   * A frame arrived. After more than silentMs without one (a dead socket, or a frozen process
   * whose buffered frames only now arrive) every book may be old, and a trade or ticker does not
   * show otherwise: each symbol then waits for its next current depth event.
   */
  private touch(now: number): void {
    if (now - this.lastFrame > this.cfg.silentMs) {
      for (const s of this.syms.values()) s.needsDepth = SILENT_WAIT;
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
    // It also shows the connection has caught up, which is all a late trade or ticker signals; a
    // quiet symbol would otherwise stay stale until its next trade.
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
    const { silentMs, noUpdateMs } = this.cfg;
    if (!this.connected) return 'Disconnected';
    if (now - this.lastFrame > silentMs) return `Connection silent for ${silentMs / 1000}s`;
    if (!s.bookValid) return 'Order book resyncing';
    const late = Object.values(s.lag).filter((lag) => this.late(lag));
    if (late.length > 0) {
      const worst = Math.max(...late);
      return Number.isFinite(worst) ? `Feed lagging by ${(worst / 1000).toFixed(1)}s` : 'Feed lagging (invalid event time)';
    }
    if (s.needsDepth !== null) return s.needsDepth;
    if (now - (s.lastDepth ?? this.connectAt) > noUpdateMs) {
      return `No order-book updates for ${noUpdateMs / 1000}s`;
    }
    return null;
  }

  isFresh(symbol: string, now: number): boolean {
    return this.reason(symbol, now) === null;
  }

  /** When the last frame of any kind, or the connection's opening, was received (0 before the first). */
  lastFrameAt(): number {
    return this.lastFrame;
  }
}
