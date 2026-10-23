import type { Logger } from '../log.ts';
import type { FeedHealth } from './feedHealth.ts';
import type { LimitedWarn } from './streamParse.ts';
import { rawToString } from './ws.ts';
import type { ConnectLimiter, SetTimer, WsFactory, WsLike } from './ws.ts';

const WATCHDOG_CHECK_MS = 5000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export interface FeedSocketDeps {
  /** Names the connection in log lines, e.g. 'spot feed'. */
  name: string;
  url: string;
  /** Only messages for these symbols are passed on. */
  symbols: string[];
  /** The health of this connection: it hears of the connect, every frame and the disconnect. */
  health: FeedHealth;
  logger: Logger;
  warn: LimitedWarn;
  wsFactory: WsFactory;
  now: () => number;
  setTimer: SetTimer;
  /** Terminate the socket when no frame arrived for this long. */
  watchdogMs: number;
  /** Shared by every Binance socket of this process; none when absent. */
  limiter?: ConnectLimiter;
  /** The socket opened (the health already knows). */
  onOpen: () => void;
  /** One combined-stream message: `kind` is the stream name after the symbol, e.g. 'aggTrade'. */
  onMessage: (symbol: string, kind: string, data: any, now: number) => void;
  /** The socket went down (the health already knows); a reconnect follows unless closed. */
  onDown: () => void;
}

/**
 * One Binance combined-stream socket that stays connected: a silent or half-open socket is
 * terminated by a watchdog, and every disconnect reconnects after a backoff that doubles from
 * 1 s to 30 s. The backoff starts over only when the owner calls resetBackoff (the connection
 * proved itself), so a server that accepts and drops at once is not retried every second.
 */
export class FeedSocket {
  private readonly symbols: Set<string>;
  private ws: WsLike | null = null;
  private started = false;
  private closed = false;
  private backoff = BACKOFF_START_MS;
  private cancelReconnect: (() => void) | null = null;

  constructor(private readonly d: FeedSocketDeps) {
    this.symbols = new Set(d.symbols);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closing
    }
  }

  /** The connection delivered what it should: the next reconnect starts from the shortest backoff. */
  resetBackoff(): void {
    this.backoff = BACKOFF_START_MS;
  }

  private connect(): void {
    if (this.closed) return;
    const wait = this.d.limiter?.acquire(this.d.now()) ?? 0;
    if (wait > 0) {
      this.d.warn.warn('connect-limit', `${this.d.name}: connection attempt limit reached; reconnecting in ${Math.ceil(wait / 1000)}s`);
      this.later(wait);
      return;
    }
    const ws = this.d.wsFactory(this.d.url);
    this.ws = ws;
    let dead = false;
    let lastFrame = this.d.now();
    let cancelWatchdog: () => void = () => {};
    const down = (why: string) => {
      if (dead) return;
      dead = true;
      cancelWatchdog();
      if (this.ws === ws) this.ws = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      this.onDown(why);
    };
    // Half-open / silent sockets never emit 'close': kill them so the normal reconnect runs.
    const watch = () => {
      cancelWatchdog = this.d.setTimer(() => {
        if (dead || this.closed) return;
        if (this.d.now() - lastFrame > this.d.watchdogMs) {
          try {
            ws.terminate();
          } catch {
            // already gone
          }
          down('silent socket terminated');
        } else {
          watch();
        }
      }, WATCHDOG_CHECK_MS);
    };
    watch();
    ws.on('open', () => {
      if (dead || this.closed) return;
      lastFrame = this.d.now();
      this.d.health.onConnect(lastFrame);
      this.d.onOpen();
    });
    ws.on('ping', () => {
      if (dead) return;
      lastFrame = this.d.now();
      this.d.health.onFrame(lastFrame);
    });
    ws.on('message', (raw: unknown) => {
      if (dead || this.closed) return;
      lastFrame = this.d.now();
      this.onMessage(raw);
    });
    ws.on('error', (e: unknown) => down(`error: ${(e as Error)?.message ?? e}`));
    ws.on('close', () => down('closed'));
  }

  private later(delay: number): void {
    this.cancelReconnect = this.d.setTimer(() => {
      this.cancelReconnect = null;
      this.connect();
    }, delay);
  }

  private onDown(why: string): void {
    this.d.logger.warn(`${this.d.name} ${why}`);
    this.d.health.onDisconnect(this.d.now());
    this.d.onDown();
    if (this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.later(delay);
  }

  private onMessage(raw: unknown): void {
    const now = this.d.now();
    this.d.health.onFrame(now);
    let msg: any;
    try {
      msg = JSON.parse(rawToString(raw));
    } catch {
      return;
    }
    const stream: unknown = msg?.stream;
    const data = msg?.data;
    if (typeof stream !== 'string' || !data) return;
    const at = stream.indexOf('@');
    const symbol = stream.slice(0, at).toUpperCase();
    const kind = stream.slice(at + 1);
    if (!this.symbols.has(symbol)) return;
    try {
      this.d.onMessage(symbol, kind, data, now);
    } catch (e) {
      this.d.warn.warn(`${symbol}:${kind}`, `${this.d.name}: bad ${kind} message for ${symbol}: ${(e as Error).message}`);
    }
  }
}
