import WebSocket from 'ws';

/** The slice of a WebSocket the feeds use; `ws` and the test fakes both satisfy it. */
export interface WsLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  /** Hard-kills the socket (no close handshake); needed for half-open connections. */
  terminate(): void;
}

export type WsFactory = (url: string) => WsLike;
/** Schedules `fn` once after `ms`; returns a cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export const defaultWsFactory: WsFactory = (url) => new WebSocket(url, { handshakeTimeout: 10_000 }) as unknown as WsLike;

export const defaultSetTimer: SetTimer = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

export const rawToString = (data: unknown): string =>
  Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

export interface ConnectLimiterOptions {
  /** Most connection attempts in any rolling window (default 240: 80 % of Binance's 300 per 5 min per IP). */
  limit?: number;
  windowMs?: number;
}

/**
 * Binance allows 300 WebSocket connection attempts per 5 minutes per IP, counted across every
 * socket. One limiter is shared by all of them; a socket that would go over waits instead.
 */
export class ConnectLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private attempts: number[] = [];

  constructor(opts: ConnectLimiterOptions = {}) {
    this.limit = opts.limit ?? 240;
    this.windowMs = opts.windowMs ?? 300_000;
  }

  /** Records an attempt at `now` and returns 0, or, when the window is full, the ms to wait (nothing recorded). */
  acquire(now: number): number {
    this.attempts = this.attempts.filter((t) => t > now - this.windowMs);
    if (this.attempts.length < this.limit) {
      this.attempts.push(now);
      return 0;
    }
    return Math.max(1, this.attempts[0]! + this.windowMs - now);
  }
}
