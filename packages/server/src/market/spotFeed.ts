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
}

type Levels = [string, string][];
interface Diff {
  U: number;
  u: number;
  b: Levels;
  a: Levels;
}

const SNAPSHOT_STAGGER_MS = 200;
const RETRY_MS = 1000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

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
  buffer: Diff[];
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
  private readonly st = new Map<string, SymState>();
  private ws: WsLike | null = null;
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
    for (const s of d.symbols) {
      this.st.set(s, { epoch: 0, snapshotApplied: false, buffer: [], reportedValid: false, cancelTimer: null });
    }
  }

  start(): void {
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
    const down = (why: string) => {
      if (dead) return;
      dead = true;
      if (this.ws === ws) this.ws = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      this.onDown(why);
    };
    ws.on('open', () => {
      if (dead || this.closed) return;
      this.health.onConnect(this.now());
      this.symbols.forEach((s, i) => this.resync(s, i * SNAPSHOT_STAGGER_MS));
    });
    ws.on('ping', () => {
      if (!dead) this.health.onFrame(this.now());
    });
    ws.on('message', (raw: unknown) => {
      if (dead || this.closed) return;
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
      else if (kind === 'aggTrade') this.onTrade(symbol, data);
      else if (kind === 'miniTicker') this.onTicker(symbol, data);
    } catch (e) {
      this.log.warn(`spot feed: bad ${kind} message for ${symbol}: ${(e as Error).message}`);
    }
  }

  private onTrade(symbol: string, d: any): void {
    const trade: AggTrade = {
      id: d.a,
      price: D(d.p),
      qty: D(d.q),
      sellerInitiated: Boolean(d.m),
      time: d.T,
    };
    this.emit('trade', symbol, trade);
  }

  private onTicker(symbol: string, d: any): void {
    const last = D(d.c);
    const open = D(d.o);
    if (open.isZero()) return;
    this.emit('ticker', symbol, {
      last,
      open24h: open,
      change24hPct: last.minus(open).div(open).times(100),
    } satisfies Ticker);
  }

  private onDepth(symbol: string, data: any, now: number): void {
    const s = this.st.get(symbol)!;
    const diff = parseDiff(data);
    this.health.onDepth(symbol, now, diff ? data.E : Number.NaN);
    if (!diff) {
      this.log.warn(`spot feed: malformed depth event for ${symbol}; resyncing`);
      this.invalidate(symbol);
      return;
    }
    if (!s.snapshotApplied) {
      s.buffer.push(diff);
      return;
    }
    this.apply(symbol, diff);
  }

  /** Applies one validated diff to a synced book. Returns false on a gap (resync already started). */
  private apply(symbol: string, diff: Diff): boolean {
    const s = this.st.get(symbol)!;
    const book = this.books.get(symbol)!;
    const r = book.applyDiff(diff);
    if (r === 'gap') {
      this.log.warn(`spot feed: sequence gap on ${symbol}; resyncing`);
      this.invalidate(symbol);
      return false;
    }
    if (r === 'applied') {
      if (!s.reportedValid) {
        s.reportedValid = true;
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

  private invalidate(symbol: string): void {
    this.health.setBookValid(symbol, false);
    this.resync(symbol, 0);
  }

  /** Starts (or restarts) the snapshot sync for one symbol after `delayMs`. */
  private resync(symbol: string, delayMs: number): void {
    const s = this.st.get(symbol)!;
    s.epoch++;
    s.cancelTimer?.();
    s.snapshotApplied = false;
    s.reportedValid = false;
    s.buffer = [];
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
    let snap: any;
    try {
      snap = await this.rest.depth(symbol, 1000);
    } catch (e) {
      if (s.epoch !== epoch || this.closed) return;
      this.log.warn(`spot feed: snapshot fetch failed for ${symbol}: ${(e as Error).message}`);
      this.scheduleFetch(symbol, RETRY_MS);
      return;
    }
    if (s.epoch !== epoch || this.closed) return;
    const bids = parseLevels(snap?.bids);
    const asks = parseLevels(snap?.asks);
    if (!bids || !asks || !Number.isSafeInteger(snap?.lastUpdateId)) {
      this.log.warn(`spot feed: malformed snapshot for ${symbol}`);
      this.scheduleFetch(symbol, RETRY_MS);
      return;
    }
    this.books.get(symbol)!.applySnapshot({ lastUpdateId: snap.lastUpdateId, bids, asks });
    s.snapshotApplied = true;
    const buffered = s.buffer;
    s.buffer = [];
    for (const diff of buffered) {
      if (!this.apply(symbol, diff)) {
        // Snapshot older than the buffered diffs (or a real gap): apply() restarted
        // the sync. Keep the diffs so a newer snapshot can bridge them (Binance's
        // procedure), and delay the retry so we do not hammer REST.
        s.buffer = buffered;
        s.cancelTimer?.();
        this.scheduleFetch(symbol, RETRY_MS);
        return;
      }
    }
  }
}
