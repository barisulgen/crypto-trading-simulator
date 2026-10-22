import type { Logger } from '../log.ts';
import type { BinanceRest } from '../binance/rest.ts';
import { ControlQueue } from './controlQueue.ts';
import { defaultSetTimer, defaultWsFactory, rawToString } from './ws.ts';
import type { SetTimer, WsFactory, WsLike } from './ws.ts';

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

export interface Candle {
  /** Open time, ms. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface CandleServiceDeps {
  rest: Pick<BinanceRest, 'klines'>;
  logger: Logger;
  wsFactory?: WsFactory;
  now?: () => number;
  setTimer?: SetTimer;
}

const CACHE_MS = 5000;
const KLINE_WS_URL = 'wss://stream.binance.com:9443/ws';
const WATCHDOG_MS = 30_000;
const WATCHDOG_CHECK_MS = 5000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** A socket that stays open this long has earned a fresh reconnect backoff, kline message or not. */
const KLINE_STABLE_MS = 30_000;
/** A socket without streams stays open this long, so switching chart symbol does not reconnect. */
const IDLE_CLOSE_MS = 10_000;

function checkInterval(i: string): asserts i is Interval {
  if (!(INTERVALS as readonly string[]).includes(i)) throw new Error(`Unsupported interval ${i}`);
}

function checkSymbol(s: string): void {
  if (!/^[A-Z0-9]{3,20}$/.test(s)) throw new Error(`Unsupported symbol ${s}`);
}

export class CandleService {
  private readonly rest: CandleServiceDeps['rest'];
  private readonly log: Logger;
  private readonly wsFactory: WsFactory;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly cache = new Map<string, { at: number; value: Promise<Candle[]> }>();
  private readonly subs = new Map<string, Set<(c: Candle) => void>>();
  private ws: WsLike | null = null;
  /** Control messages for the open socket; null while it is connecting (all streams go out on open). */
  private queue: ControlQueue | null = null;
  private cancelIdleClose: (() => void) | null = null;
  private closed = false;
  private nextId = 1;
  private backoff = BACKOFF_START_MS;
  private cancelReconnect: (() => void) | null = null;

  constructor(d: CandleServiceDeps) {
    this.rest = d.rest;
    this.log = d.logger;
    this.wsFactory = d.wsFactory ?? defaultWsFactory;
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? defaultSetTimer;
  }

  async history(symbol: string, interval: string, endTime?: number): Promise<Candle[]> {
    checkInterval(interval);
    checkSymbol(symbol);
    const key = `${symbol}:${interval}:${endTime ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at <= CACHE_MS) return hit.value;
    const value = this.rest.klines(symbol, interval, 500, endTime).then((rows: unknown) => {
      if (!Array.isArray(rows)) throw new Error('Unexpected klines response');
      return rows
        .filter((r: unknown): r is unknown[] => Array.isArray(r) && r.length >= 6)
        .map((r): Candle => ({
          time: Number(r[0]),
          open: String(r[1]),
          high: String(r[2]),
          low: String(r[3]),
          close: String(r[4]),
          volume: String(r[5]),
        }));
    });
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  subscribe(symbol: string, interval: string, cb: (c: Candle) => void): () => void {
    checkInterval(interval);
    checkSymbol(symbol);
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    let set = this.subs.get(stream);
    if (!set) {
      set = new Set();
      this.subs.set(stream, set);
      this.cancelIdleClose?.();
      this.cancelIdleClose = null;
      this.ensureSocket();
      this.queue?.subscribe([stream]);
    }
    // wrap so the same cb can be subscribed twice and unsubscribed independently
    const entry = (c: Candle) => cb(c);
    set.add(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = this.subs.get(stream);
      if (!cur) return;
      cur.delete(entry);
      if (cur.size === 0) {
        this.subs.delete(stream);
        this.queue?.unsubscribe([stream]);
        if (this.subs.size === 0 && !this.cancelIdleClose) {
          this.cancelIdleClose = this.setTimer(() => {
            this.cancelIdleClose = null;
            if (this.subs.size === 0) this.teardown();
          }, IDLE_CLOSE_MS);
        }
      }
    };
  }

  close(): void {
    this.closed = true;
    this.subs.clear();
    this.teardown();
  }

  private teardown(): void {
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.cancelIdleClose?.();
    this.cancelIdleClose = null;
    this.queue?.close();
    this.queue = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }

  private ensureSocket(): void {
    if (this.ws || this.closed || this.cancelReconnect) return;
    const ws = this.wsFactory(KLINE_WS_URL);
    this.ws = ws;
    let dead = false;
    let lastFrame = this.now();
    let cancelWatchdog: () => void = () => {};
    let cancelStable: () => void = () => {};
    // A server that accepts and closes at once must not be retried every second, so the backoff
    // resets only once the socket has proven itself: it delivered a kline, or it stayed open.
    const proven = () => {
      cancelStable();
      if (!dead && this.ws === ws) this.backoff = BACKOFF_START_MS;
    };
    const down = () => {
      if (dead) return;
      dead = true;
      cancelWatchdog();
      cancelStable();
      if (this.ws === ws) {
        this.ws = null;
        this.queue?.close();
        this.queue = null;
      }
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (this.closed || this.subs.size === 0 || this.ws) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      this.cancelReconnect = this.setTimer(() => {
        this.cancelReconnect = null;
        if (this.subs.size > 0) this.ensureSocket();
      }, delay);
    };
    // Half-open / silent sockets never emit 'close': kill them so the normal reconnect runs.
    const watch = () => {
      cancelWatchdog = this.setTimer(() => {
        if (dead || this.closed) return;
        if (this.now() - lastFrame > WATCHDOG_MS) {
          try {
            ws.terminate();
          } catch {
            // already gone
          }
          down();
        } else {
          watch();
        }
      }, WATCHDOG_CHECK_MS);
    };
    watch();
    ws.on('ping', () => {
      lastFrame = this.now();
    });
    ws.on('open', () => {
      lastFrame = this.now();
      if (dead || this.ws !== ws) return;
      cancelStable = this.setTimer(proven, KLINE_STABLE_MS);
      // Every control message on this connection, including this resubscribe-all, is rate-limited.
      this.queue = new ControlQueue({
        send: (method, params) => {
          try {
            ws.send(JSON.stringify({ method, params, id: this.nextId++ }));
          } catch (e) {
            this.log.warn(`kline ${method} failed: ${(e as Error).message}`); // a dead socket reconnects and resubscribes
          }
        },
        now: this.now,
        setTimer: this.setTimer,
      });
      this.queue.subscribe(this.subs.keys());
    });
    ws.on('message', (raw: unknown) => {
      if (dead) return;
      lastFrame = this.now();
      try {
        const m = JSON.parse(rawToString(raw));
        if (m?.e !== 'kline' || !m.k) return;
        proven();
        const k = m.k;
        const set = this.subs.get(`${String(m.s).toLowerCase()}@kline_${k.i}`);
        if (!set) return;
        const candle: Candle = {
          time: Number(k.t),
          open: String(k.o),
          high: String(k.h),
          low: String(k.l),
          close: String(k.c),
          volume: String(k.v),
        };
        for (const cb of [...set]) cb(candle);
      } catch (e) {
        this.log.warn(`kline message error: ${(e as Error).message}`);
      }
    });
    ws.on('error', (e: unknown) => {
      this.log.warn(`kline socket error: ${(e as Error)?.message ?? e}`);
      down();
    });
    ws.on('close', down);
  }
}
