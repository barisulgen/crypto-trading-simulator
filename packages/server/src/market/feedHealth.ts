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
      this.syms.set(s, { bookValid: false, lastDepth: null, lag: 0, lagging: false, reportedFresh: false });
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
    this.lastFrame = now;
  }

  onDepth(symbol: string, now: number, eventTime: number): void {
    const s = this.st(symbol);
    this.lastFrame = now;
    s.lastDepth = now;
    s.lag = now - (eventTime - this.clockOffset);
    s.lagging = s.lag > this.cfg.lagMs;
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
    if (s.lagging) return `Feed lagging by ${(s.lag / 1000).toFixed(1)}s`;
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
