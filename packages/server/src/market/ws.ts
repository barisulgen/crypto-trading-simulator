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
