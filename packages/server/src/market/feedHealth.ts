export interface HealthCfg {
  silentMs: number;
  lagMs: number;
  noUpdateMs: number;
}

export interface HealthTransition {
  symbol: string;
  fresh: boolean;
  reason: string | null;
  at: number;
}

interface SymState {
  bookValid: boolean;
  lastDepth: number | null;
  lag: number;
  lagging: boolean;
  /** A frame came after a silent stretch: the book is old until a current depth event arrives. */
  needsDepth: boolean;
  reportedFresh: boolean;
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
        lag: 0,
        lagging: false,
        needsDepth: false,
        reportedFresh: false,
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
   * A frame arrived. After more than silentMs without one (a dead socket, or a frozen process
   * whose buffered frames only now arrive) every book may be old, and a trade or ticker does not
   * show otherwise: each symbol then waits for its next current depth event.
   */
  private touch(now: number): void {
    if (now - this.lastFrame > this.cfg.silentMs) {
      for (const s of this.syms.values()) s.needsDepth = true;
    }
    this.lastFrame = now;
  }

  /** Records how late an event stamped by the exchange at `eventTime` is when seen locally at `now`. */
  private measureLag(s: SymState, now: number, eventTime: number): void {
    // A missing or non-numeric event time can never prove the feed is current.
    s.lag = Number.isFinite(eventTime) ? now - (eventTime - this.clockOffset) : Number.POSITIVE_INFINITY;
    s.lagging = !(s.lag <= this.cfg.lagMs);
  }

  onDepth(symbol: string, now: number, eventTime: number): void {
    const s = this.st(symbol);
    this.touch(now);
    s.lastDepth = now;
    this.measureLag(s, now, eventTime);
    // Only a current depth event shows the book is no older than the silence that preceded it.
    if (!s.lagging) s.needsDepth = false;
  }

  onTrade(symbol: string, now: number, eventTime: number): void {
    const s = this.st(symbol);
    this.touch(now);
    this.measureLag(s, now, eventTime);
  }

  onTicker(symbol: string, now: number, eventTime: number): void {
    const s = this.st(symbol);
    this.touch(now);
    this.measureLag(s, now, eventTime);
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
    if (s.lagging) {
      return Number.isFinite(s.lag) ? `Feed lagging by ${(s.lag / 1000).toFixed(1)}s` : 'Feed lagging (invalid event time)';
    }
    if (s.needsDepth) return 'Waiting for order-book update after a silent connection';
    if (now - (s.lastDepth ?? this.connectAt) > noUpdateMs) {
      return `No order-book updates for ${noUpdateMs / 1000}s`;
    }
    return null;
  }

  isFresh(symbol: string, now: number): boolean {
    return this.reason(symbol, now) === null;
  }

  poll(now: number): HealthTransition[] {
    const out: HealthTransition[] = [];
    for (const [symbol, s] of this.syms) {
      const reason = this.reason(symbol, now);
      const fresh = reason === null;
      if (fresh !== s.reportedFresh) {
        s.reportedFresh = fresh;
        out.push({ symbol, fresh, reason, at: now });
      }
    }
    return out;
  }
}
