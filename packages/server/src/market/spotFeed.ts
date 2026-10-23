import { EventEmitter } from 'node:events';
import { D } from '@sim/engine';
import type { AggTrade, Decimal } from '@sim/engine';
import type { Logger } from '../log.ts';
import type { BinanceRest } from '../binance/rest.ts';
import type { FeedHealth } from './feedHealth.ts';
import type { LocalBook } from './localBook.ts';
import { defaultSetTimer, defaultWsFactory, rawToString } from './ws.ts';
import type { SetTimer, WsFactory, WsLike } from './ws.ts';

export const SPOT_STREAM_URL = 'wss://stream.binance.com:9443/stream?streams=';

export interface Ticker {
  last: Decimal;
  open24h: Decimal;
  change24hPct: Decimal;
}

export interface SpotFeedDeps {
  symbols: string[];
  rest: Pick<BinanceRest, 'depth'>;
  health: FeedHealth;
  books: Map<string, LocalBook>;
  logger: Logger;
  wsFactory?: WsFactory;
  now?: () => number;
  setTimer?: SetTimer;
  /** Terminate the socket when no frame arrived for this long (default 30 s = 2 x silentMs). */
  watchdogMs?: number;
}

type Levels = [string, string][];
interface Diff {
  U: number;
  u: number;
  b: Levels;
  a: Levels;
}

const SNAPSHOT_STAGGER_MS = 200;
const RETRY_START_MS = 1000;
const RETRY_MAX_MS = 30_000;
const BUFFER_CAP = 1000;
const WATCHDOG_CHECK_MS = 5000;
const LOG_EVERY_MS = 60_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** The exchange event time of a message that parsed; NaN for a malformed one, which proves nothing about lag. */
function eventTime(parsed: boolean, data: any): number {
  return parsed ? data.E : Number.NaN;
}

/** A finite Decimal > 0 from a string, else null. */
function positive(x: unknown): Decimal | null {
  if (typeof x !== 'string') return null;
  try {
    const v = D(x);
    return v.isFinite() && v.gt(0) ? v : null;
  } catch {
    return null;
  }
}

function parseLevels(x: unknown): Levels | null {
  if (!Array.isArray(x)) return null;
  const out: Levels = [];
  for (const l of x) {
    if (!Array.isArray(l) || typeof l[0] !== 'string' || typeof l[1] !== 'string') return null;
    try {
      const p = D(l[0]);
      const q = D(l[1]);
      if (!p.isFinite() || !q.isFinite() || p.isNegative() || q.isNegative()) return null;
    } catch {
      return null;
    }
    out.push([l[0], l[1]]);
  }
  return out;
}

/** Returns a fully validated diff, or null if anything about it is malformed. */
function parseDiff(data: any): Diff | null {
  if (!data || !Number.isSafeInteger(data.U) || !Number.isSafeInteger(data.u)) return null;
  if (!Number.isFinite(data.E)) return null;
  const b = parseLevels(data.b);
  const a = parseLevels(data.a);
  if (!b || !a) return null;
  return { U: data.U, u: data.u, b, a };
}

interface SymState {
  /** Bumped on every resync / disconnect so stale snapshot fetches are ignored. */
  epoch: number;
  snapshotApplied: boolean;
  /** Diffs seen while waiting for a snapshot; bounded by BUFFER_CAP (oldest dropped). */
  buffer: Diff[];
  /** Consecutive failed/forced resyncs; drives the per-symbol exponential backoff. */
  failures: number;
  reportedValid: boolean;
  cancelTimer: (() => void) | null;
}

/** One combined Binance spot stream for all symbols, with per-symbol order-book sync. */
export class SpotFeed extends EventEmitter {
  private readonly symbols: string[];
  private readonly rest: Pick<BinanceRest, 'depth'>;
  private readonly health: FeedHealth;
  private readonly books: Map<string, LocalBook>;
  private readonly log: Logger;
  private readonly wsFactory: WsFactory;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly watchdogMs: number;
  private readonly st = new Map<string, SymState>();
  private readonly lastWarn = new Map<string, number>();
  private ws: WsLike | null = null;
  private started = false;
  private closed = false;
  private backoff = BACKOFF_START_MS;
  private cancelReconnect: (() => void) | null = null;
  private syncedSinceConnect = new Set<string>();

  constructor(d: SpotFeedDeps) {
    super();
    this.symbols = d.symbols;
    this.rest = d.rest;
    this.health = d.health;
    this.books = d.books;
    this.log = d.logger;
    this.wsFactory = d.wsFactory ?? defaultWsFactory;
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? defaultSetTimer;
    this.watchdogMs = d.watchdogMs ?? 30_000;
    for (const s of d.symbols) {
      this.st.set(s, { epoch: 0, snapshotApplied: false, buffer: [], failures: 0, reportedValid: false, cancelTimer: null });
    }
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
    for (const s of this.st.values()) {
      s.epoch++;
      s.cancelTimer?.();
      s.cancelTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closing
    }
  }

  private url(): string {
    const parts = this.symbols.flatMap((s) => {
      const l = s.toLowerCase();
      return [`${l}@depth@100ms`, `${l}@aggTrade`, `${l}@miniTicker`];
    });
    return SPOT_STREAM_URL + parts.join('/');
  }

  private connect(): void {
    if (this.closed) return;
    this.syncedSinceConnect = new Set();
    const ws = this.wsFactory(this.url());
    this.ws = ws;
    let dead = false;
    let lastFrame = this.now();
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
      cancelWatchdog = this.setTimer(() => {
        if (dead || this.closed) return;
        if (this.now() - lastFrame > this.watchdogMs) {
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
      lastFrame = this.now();
      this.health.onConnect(lastFrame);
      this.symbols.forEach((s, i) => {
        this.st.get(s)!.failures = 0;
        this.resync(s, i * SNAPSHOT_STAGGER_MS);
      });
    });
    ws.on('ping', () => {
      if (dead) return;
      lastFrame = this.now();
      this.health.onFrame(lastFrame);
    });
    ws.on('message', (raw: unknown) => {
      if (dead || this.closed) return;
      lastFrame = this.now();
      this.onMessage(raw);
    });
    ws.on('error', (e: unknown) => down(`error: ${(e as Error)?.message ?? e}`));
    ws.on('close', () => down('closed'));
  }

  private onDown(why: string): void {
    this.log.warn(`spot feed ${why}`);
    this.health.onDisconnect(this.now());
    for (const [sym, s] of this.st) {
      s.epoch++;
      s.cancelTimer?.();
      s.cancelTimer = null;
      s.snapshotApplied = false;
      s.reportedValid = false;
      s.buffer = [];
      s.failures = 0;
      this.emptyBook(sym);
    }
    if (this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.cancelReconnect = this.setTimer(() => {
      this.cancelReconnect = null;
      this.connect();
    }, delay);
  }

  /** Logs at most once per key per minute so a bad stream cannot flood the log. */
  private warnLimited(key: string, msg: string): void {
    const t = this.now();
    const prev = this.lastWarn.get(key);
    if (prev !== undefined && t - prev < LOG_EVERY_MS) return;
    this.lastWarn.set(key, t);
    this.log.warn(msg);
  }

  private onMessage(raw: unknown): void {
    const now = this.now();
    this.health.onFrame(now);
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
    if (!this.st.has(symbol)) return;
    try {
      if (kind.startsWith('depth')) this.onDepth(symbol, data, now);
      else if (kind === 'aggTrade') this.onTrade(symbol, data, now);
      else if (kind === 'miniTicker') this.onTicker(symbol, data, now);
    } catch (e) {
      this.warnLimited(`${symbol}:${kind}`, `spot feed: bad ${kind} message for ${symbol}: ${(e as Error).message}`);
    }
  }

  private onTrade(symbol: string, d: any, now: number): void {
    const price = positive(d.p);
    const qty = positive(d.q);
    const valid = price !== null && qty !== null && Number.isSafeInteger(d.a) && Number.isSafeInteger(d.T);
    this.health.onTrade(symbol, now, eventTime(valid, d));
    if (!valid) {
      this.warnLimited(`${symbol}:aggTrade`, `spot feed: invalid aggTrade for ${symbol}; dropped`);
      return;
    }
    const trade: AggTrade = { id: d.a, price, qty, sellerInitiated: Boolean(d.m), time: d.T };
    this.emit('trade', symbol, trade);
  }

  private onTicker(symbol: string, d: any, now: number): void {
    const last = positive(d.c);
    const open = positive(d.o);
    const valid = last !== null && open !== null;
    this.health.onTicker(symbol, now, eventTime(valid, d));
    if (!valid) {
      this.warnLimited(`${symbol}:miniTicker`, `spot feed: invalid miniTicker for ${symbol}; dropped`);
      return;
    }
    this.emit('ticker', symbol, {
      last,
      open24h: open,
      change24hPct: last.minus(open).div(open).times(100),
    } satisfies Ticker);
  }

  private onDepth(symbol: string, data: any, now: number): void {
    const s = this.st.get(symbol)!;
    const diff = parseDiff(data);
    this.health.onDepth(symbol, now, eventTime(diff !== null, data));
    if (!diff) {
      this.log.warn(`spot feed: malformed depth event for ${symbol}; resyncing`);
      this.invalidate(symbol);
      return;
    }
    if (!s.snapshotApplied) {
      s.buffer.push(diff);
      // Bounded: a later snapshot only has to bridge the first retained diff.
      if (s.buffer.length > BUFFER_CAP) s.buffer.splice(0, s.buffer.length - BUFFER_CAP);
      return;
    }
    this.apply(symbol, diff);
  }

  /** Applies one validated diff to a synced book. Returns false on a gap (resync already scheduled). */
  private apply(symbol: string, diff: Diff): boolean {
    const s = this.st.get(symbol)!;
    const book = this.books.get(symbol)!;
    const r = book.applyDiff(diff);
    if (r === 'gap') {
      this.log.warn(`spot feed: sequence gap on ${symbol}; resyncing`);
      this.invalidate(symbol, [diff]); // keep the triggering diff for the next snapshot to bridge
      return false;
    }
    if (r === 'applied') {
      if (!s.reportedValid) {
        s.reportedValid = true;
        s.failures = 0;
        this.health.setBookValid(symbol, true);
        this.syncedSinceConnect.add(symbol);
        if (this.syncedSinceConnect.size === this.symbols.length) this.backoff = BACKOFF_START_MS;
      }
      this.emit('book', symbol);
    }
    return true;
  }

  /** An invalid book serves nothing: drop its contents until the next snapshot. */
  private emptyBook(symbol: string): void {
    this.books.get(symbol)?.applySnapshot({ lastUpdateId: 0, bids: [], asks: [] });
  }

  private nextDelay(s: SymState): number {
    const delay = Math.min(RETRY_START_MS * 2 ** s.failures, RETRY_MAX_MS);
    s.failures++;
    return delay;
  }

  /** Forced resync (gap, malformed event, failure): per-symbol backoff, 1 s doubling to 30 s. */
  private invalidate(symbol: string, keep: Diff[] = []): void {
    this.resync(symbol, this.nextDelay(this.st.get(symbol)!), keep);
  }

  /** Starts (or restarts) the snapshot sync for one symbol after `delayMs`. */
  private resync(symbol: string, delayMs: number, keep: Diff[] = []): void {
    const s = this.st.get(symbol)!;
    s.epoch++;
    s.cancelTimer?.();
    s.snapshotApplied = false;
    s.reportedValid = false;
    s.buffer = keep.slice(-BUFFER_CAP);
    this.health.setBookValid(symbol, false);
    this.emptyBook(symbol);
    this.scheduleFetch(symbol, delayMs);
  }

  private scheduleFetch(symbol: string, delayMs: number): void {
    const s = this.st.get(symbol)!;
    const epoch = s.epoch;
    s.cancelTimer?.();
    s.cancelTimer = this.setTimer(() => {
      s.cancelTimer = null;
      void this.fetchSnapshot(symbol, epoch);
    }, delayMs);
  }

  private async fetchSnapshot(symbol: string, epoch: number): Promise<void> {
    const s = this.st.get(symbol)!;
    try {
      let snap: any;
      try {
        snap = await this.rest.depth(symbol, 1000);
      } catch (e) {
        if (s.epoch !== epoch || this.closed) return;
        this.log.warn(`spot feed: snapshot fetch failed for ${symbol}: ${(e as Error).message}`);
        this.scheduleFetch(symbol, this.nextDelay(s)); // keeps the (bounded) buffer
        return;
      }
      if (s.epoch !== epoch || this.closed) return;
      const bids = parseLevels(snap?.bids);
      const asks = parseLevels(snap?.asks);
      if (!bids || !asks || !Number.isSafeInteger(snap?.lastUpdateId)) {
        this.log.warn(`spot feed: malformed snapshot for ${symbol}`);
        this.scheduleFetch(symbol, this.nextDelay(s));
        return;
      }
      this.books.get(symbol)!.applySnapshot({ lastUpdateId: snap.lastUpdateId, bids, asks });
      s.snapshotApplied = true;
      const buffered = s.buffer;
      s.buffer = [];
      for (const diff of buffered) {
        if (!this.apply(symbol, diff)) {
          // Snapshot older than the buffered diffs (or a real gap): apply() already scheduled
          // the backed-off retry. Keep every diff so a newer snapshot can bridge them.
          s.buffer = buffered;
          return;
        }
      }
    } catch (e) {
      // e.g. a throwing 'book' listener during replay: never an unhandled rejection.
      this.log.error(`spot feed: sync failed for ${symbol}: ${(e as Error).message}`);
      if (!this.closed && s.epoch === epoch) this.invalidate(symbol);
    }
  }
}
