import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { D } from '@sim/engine';
import type { Decimal } from '@sim/engine';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

/**
 * A fake Binance for end-to-end tests: one local HTTP + WebSocket server answering every host the
 * simulator talks to, in Binance's own message and response shapes (taken from the recorded
 * fixtures), driven by the test through the control methods below. Everything it serves is
 * derived from what the test told it: the books, the trades (live and history), the mark prices
 * (sampled every second, also while nobody is connected, as Binance keeps computing them) and the
 * funding settlements.
 *
 * Addresses, all on one port (see env()):
 * - spot REST /api/v3/..., futures REST /fapi/v1/..., web API /bapi/...
 * - spot streams under /spot-ws: /stream?streams=... (combined) and /ws (SUBSCRIBE, klines)
 * - futures streams under /futures-ws: /public/stream?streams=... (depth), /market/stream?streams=...
 *   (aggTrade, markPrice@1s, miniTicker) and /market/ws (SUBSCRIBE, klines)
 */

export type FakeMarket = 'spot' | 'perp';
type Level = [string, string];

const FIXTURES = new URL('../fixtures/', import.meta.url);
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

export const COINS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];
export const SYMBOLS = COINS.map((c) => `${c}USDT`);

/** A plausible starting price per symbol; every one fits both markets' tick sizes below. */
export const START_PRICES: Record<string, string> = {
  BTCUSDT: '80000',
  ETHUSDT: '3000',
  SOLUSDT: '150',
  NEARUSDT: '3',
  XRPUSDT: '2.5',
  BNBUSDT: '600',
  DOGEUSDT: '0.2',
  SUIUSDT: '3.5',
  HYPEUSDT: '40',
  AVAXUSDT: '30',
};

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};
const MINUTE = 60_000;
/** Each depth event spans this many update ids (U..u), as real futures events often span several. */
const IDS_PER_EVENT = 10;
const HEARTBEAT_MS = 500;
const MARK_MS = 1000;

interface Trade {
  a: number;
  p: string;
  q: string;
  T: number;
  /** The buyer was the maker: the seller initiated. */
  m: boolean;
}

interface Book {
  bids: Map<string, string>;
  asks: Map<string, string>;
  /** The u of the last depth event. */
  lastU: number;
}

interface MarkState {
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  nextFundingTime: number;
  /** While true no markPriceUpdate is sent for the symbol (the samples go on). */
  paused: boolean;
  samples: { t: number; p: string }[];
}

interface Settlement {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

/** A connected stream socket: combined (streams fixed by its URL) or raw (streams by SUBSCRIBE). */
interface Conn {
  ws: WebSocket;
  market: FakeMarket;
  kind: 'combined' | 'raw';
  streams: Set<string>;
}

export interface MarkFields {
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: number;
}

/** One request the fake answered, for assertions. */
export interface FakeRequest {
  at: number;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

const HISTORY_PATHS = new Set([
  '/api/v3/klines',
  '/api/v3/aggTrades',
  '/fapi/v1/klines',
  '/fapi/v1/markPriceKlines',
  '/fapi/v1/aggTrades',
  '/fapi/v1/fundingRate',
]);

const sortDesc = (a: Level, b: Level) => D(b[0]).comparedTo(D(a[0]));
const sortAsc = (a: Level, b: Level) => D(a[0]).comparedTo(D(b[0]));

/** The 8-hour funding time after `now`, as Binance's default schedule. */
export function nextEightHour(now: number): number {
  const step = 8 * 3_600_000;
  return Math.floor(now / step) * step + step;
}

export class FakeBinance {
  private server: Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly conns = new Set<Conn>();
  private readonly books = new Map<string, Book>();
  private readonly trades = new Map<string, Trade[]>();
  private readonly nextTradeId = new Map<string, number>();
  private readonly marks = new Map<string, MarkState>();
  private readonly settlements: Settlement[] = [];
  private readonly startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private dark = false;
  private restDark = false;
  private historyHeld = false;
  private heldResponses: (() => void)[] = [];
  /** Every REST request answered or held, oldest first. */
  readonly requests: FakeRequest[] = [];

  constructor() {
    for (const s of SYMBOLS) {
      const price = START_PRICES[s]!;
      for (const market of ['spot', 'perp'] as FakeMarket[]) {
        const key = this.key(market, s);
        this.books.set(key, { bids: new Map(), asks: new Map(), lastU: 1000 });
        this.trades.set(key, []);
        this.nextTradeId.set(key, market === 'spot' ? 5_000_000 : 9_000_000);
        this.setBookQuiet(market, s, defaultBook(price));
      }
      this.marks.set(s, {
        markPrice: price,
        indexPrice: price,
        fundingRate: '0.00010000',
        nextFundingTime: nextEightHour(Date.now()),
        paused: false,
        samples: [{ t: Date.now(), p: price }],
      });
    }
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.markTick(), MARK_MS));
    for (const t of this.timers) t.unref();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.releaseHistory();
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  get port(): number {
    return (this.server!.address() as AddressInfo).port;
  }

  /** The simulator's endpoint settings pointing at this fake. */
  env(): Record<string, string> {
    const base = `127.0.0.1:${this.port}`;
    return {
      BINANCE_SPOT_REST_URL: `http://${base}`,
      BINANCE_FUTURES_REST_URL: `http://${base}`,
      BINANCE_WEB_URL: `http://${base}`,
      BINANCE_SPOT_WS_URL: `ws://${base}/spot-ws`,
      BINANCE_FUTURES_WS_URL: `ws://${base}/futures-ws`,
    };
  }

  /** Stream sockets open now, per market. */
  connections(market?: FakeMarket): number {
    return [...this.conns].filter((c) => market === undefined || c.market === market).length;
  }

  // ---- control ----

  /** Drops every stream socket and refuses new ones; with `rest`, every REST request fails (503) too. */
  outage(opts: { rest?: boolean } = {}): void {
    this.dark = true;
    this.restDark = opts.rest ?? false;
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
  }

  /** Ends an outage: sockets and REST are served again. */
  resume(): void {
    this.dark = false;
    this.restDark = false;
  }

  /** History requests (klines, mark klines, aggTrades, fundingRate) wait until releaseHistory(). */
  holdHistory(): void {
    this.historyHeld = true;
  }

  releaseHistory(): void {
    this.historyHeld = false;
    for (const send of this.heldResponses.splice(0)) send();
  }

  /** History requests waiting now. */
  heldHistoryRequests(): number {
    return this.heldResponses.length;
  }

  /** Replaces the book (levels as [price, qty]) and sends the change as one depth update. */
  setBook(market: FakeMarket, symbol: string, book: { bids: Level[]; asks: Level[] }): void {
    const cur = this.book(market, symbol);
    const diff = (side: Map<string, string>, next: Level[]): Level[] => {
      const keep = new Map(next.map(([p, q]) => [canon(p), q]));
      const out: Level[] = [...keep.entries()];
      for (const p of side.keys()) if (!keep.has(p)) out.push([p, '0']);
      return out;
    };
    this.depth(market, symbol, { b: diff(cur.bids, book.bids), a: diff(cur.asks, book.asks) });
  }

  /** Sends one depth update setting the given levels (qty '0' removes one). */
  depth(market: FakeMarket, symbol: string, levels: { b?: Level[]; a?: Level[] }): void {
    const book = this.book(market, symbol);
    const b = (levels.b ?? []).map(([p, q]): Level => [canon(p), q]);
    const a = (levels.a ?? []).map(([p, q]): Level => [canon(p), q]);
    for (const [p, q] of b) if (D(q).isZero()) book.bids.delete(p);
    else book.bids.set(p, q);
    for (const [p, q] of a) if (D(q).isZero()) book.asks.delete(p);
    else book.asks.set(p, q);
    const U = book.lastU + 1;
    const u = book.lastU + IDS_PER_EVENT;
    const pu = book.lastU;
    book.lastU = u;
    const E = Date.now();
    const data =
      market === 'spot'
        ? { e: 'depthUpdate', E, s: symbol, U, u, b, a }
        : { e: 'depthUpdate', E, T: E, s: symbol, U, u, pu, b, a };
    this.send(market, `${symbol.toLowerCase()}@depth@100ms`, data);
  }

  /**
   * One trade, kept in the history (aggTrades, klines) and sent on the trade stream when anyone is
   * connected. `sellerInitiated` defaults to true. `time` defaults to now.
   */
  trade(market: FakeMarket, symbol: string, price: string, qty: string, opts: { sellerInitiated?: boolean; time?: number } = {}): number {
    const key = this.key(market, symbol);
    const a = this.nextTradeId.get(key)!;
    this.nextTradeId.set(key, a + 1);
    const T = opts.time ?? Date.now();
    const t: Trade = { a, p: canon(price), q: qty, T, m: opts.sellerInitiated ?? true };
    const list = this.trades.get(key)!;
    list.push(t);
    list.sort((x, y) => x.T - y.T || x.a - y.a);
    const E = Date.now();
    const data =
      market === 'spot'
        ? { e: 'aggTrade', E, s: symbol, a, p: t.p, q: t.q, f: a * 3, l: a * 3 + 1, T, m: t.m, M: true }
        : { e: 'aggTrade', E, s: symbol, a, p: t.p, q: t.q, nq: t.q, f: a * 3, l: a * 3 + 1, T, m: t.m };
    this.send(market, `${symbol.toLowerCase()}@aggTrade`, data);
    this.sendKlines(market, symbol);
    return a;
  }

  /** Changes the symbol's mark fields; with `push` (default) a markPriceUpdate goes out at once. */
  setMark(symbol: string, fields: MarkFields, push = true): void {
    const m = this.marks.get(symbol)!;
    if (fields.markPrice !== undefined) m.markPrice = fields.markPrice;
    if (fields.indexPrice !== undefined) m.indexPrice = fields.indexPrice;
    if (fields.fundingRate !== undefined) m.fundingRate = fields.fundingRate;
    if (fields.nextFundingTime !== undefined) m.nextFundingTime = fields.nextFundingTime;
    m.samples.push({ t: Date.now(), p: m.markPrice });
    if (push) this.sendMark(symbol);
  }

  /** The symbol's mark stream stops (or starts again); its mark history goes on being sampled. */
  pauseMarks(symbol: string, paused = true): void {
    this.marks.get(symbol)!.paused = paused;
  }

  /** Publishes a funding settlement: fundingRate answers it from now on. */
  publishFunding(symbol: string, s: { fundingTime: number; rate: string; markPrice: string }): void {
    this.settlements.push({ symbol, fundingTime: s.fundingTime, fundingRate: s.rate, markPrice: s.markPrice });
  }

  /** The trades kept for a market and symbol, oldest first. */
  tradesOf(market: FakeMarket, symbol: string): readonly Trade[] {
    return this.trades.get(this.key(market, symbol))!;
  }

  /** The 1-minute candle opening at `minute`, as klines serves it: [open, high, low, close]. */
  candle(market: FakeMarket, symbol: string, minute: number): [string, string, string, string] {
    const c = this.candles(this.trades.get(this.key(market, symbol))!.map((t) => ({ t: t.T, p: t.p })), START_PRICES[symbol]!, minute, MINUTE);
    return [c.o, c.h, c.l, c.c];
  }

  // ---- internals ----

  private key(market: FakeMarket, symbol: string): string {
    return `${market}:${symbol}`;
  }

  private book(market: FakeMarket, symbol: string): Book {
    const b = this.books.get(this.key(market, symbol));
    if (!b) throw new Error(`Unknown symbol ${symbol}`);
    return b;
  }

  private setBookQuiet(market: FakeMarket, symbol: string, book: { bids: Level[]; asks: Level[] }): void {
    const b = this.book(market, symbol);
    b.bids = new Map(book.bids.map(([p, q]) => [canon(p), q]));
    b.asks = new Map(book.asks.map(([p, q]) => [canon(p), q]));
  }

  private lastPrice(market: FakeMarket, symbol: string): string {
    return this.trades.get(this.key(market, symbol))!.at(-1)?.p ?? canon(START_PRICES[symbol]!);
  }

  private heartbeat(): void {
    if (this.dark) return;
    const E = Date.now();
    for (const s of SYMBOLS) {
      for (const market of ['spot', 'perp'] as FakeMarket[]) {
        this.depth(market, s, {});
        const last = this.lastPrice(market, s);
        const open = canon(START_PRICES[s]!);
        const ticker = { e: '24hrMiniTicker', E, s, c: last, o: open, h: maxOf(last, open), l: minOf(last, open), v: '1000', q: '1000000' };
        this.send(market, `${s.toLowerCase()}@miniTicker`, ticker);
      }
    }
  }

  private markTick(): void {
    const now = Date.now();
    for (const s of SYMBOLS) {
      const m = this.marks.get(s)!;
      m.samples.push({ t: now, p: m.markPrice });
      if (m.samples.length > 20_000) m.samples.splice(0, m.samples.length - 20_000);
      this.sendMark(s);
    }
  }

  private sendMark(symbol: string): void {
    const m = this.marks.get(symbol)!;
    if (m.paused || this.dark) return;
    const E = Date.now();
    this.send('perp', `${symbol.toLowerCase()}@markPrice@1s`, {
      e: 'markPriceUpdate',
      E,
      s: symbol,
      p: m.markPrice,
      ap: m.markPrice,
      P: m.markPrice,
      i: m.indexPrice,
      r: m.fundingRate,
      T: m.nextFundingTime,
      st: 1,
    });
  }

  private send(market: FakeMarket, stream: string, data: object): void {
    if (this.dark) return;
    let combined: string | null = null;
    for (const c of this.conns) {
      if (c.market !== market || c.kind !== 'combined' || !c.streams.has(stream)) continue;
      combined ??= JSON.stringify({ stream, data });
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(combined);
    }
  }

  /** The kline subscribers of a market and symbol get its current candle of each subscribed interval. */
  private sendKlines(market: FakeMarket, symbol: string): void {
    if (this.dark) return;
    const lower = symbol.toLowerCase();
    for (const c of this.conns) {
      if (c.market !== market || c.kind !== 'raw') continue;
      for (const stream of c.streams) {
        const [sym, kind] = stream.split('@');
        if (sym !== lower || !kind?.startsWith('kline_')) continue;
        const interval = kind.slice('kline_'.length);
        const len = INTERVAL_MS[interval];
        if (!len) continue;
        const now = Date.now();
        const open = Math.floor(now / len) * len;
        const k = this.candles(this.tradePoints(market, symbol), START_PRICES[symbol]!, open, len);
        const msg = {
          e: 'kline',
          E: now,
          s: symbol,
          k: { t: open, T: open + len - 1, s: symbol, i: interval, f: 0, L: 0, o: k.o, c: k.c, h: k.h, l: k.l, v: k.v, n: k.n, x: false, q: '0', V: '0', Q: '0', B: '0' },
        };
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
      }
    }
  }

  private tradePoints(market: FakeMarket, symbol: string): { t: number; p: string; q?: string }[] {
    return this.trades.get(this.key(market, symbol))!.map((t) => ({ t: t.T, p: t.p, q: t.q }));
  }

  /**
   * The candle opening at `open`, `len` long, from price points: open, high, low and close of the
   * points in it; with none, flat at the last price before it (`base` before any).
   */
  private candles(points: { t: number; p: string; q?: string }[], base: string, open: number, len: number) {
    const inside = points.filter((x) => x.t >= open && x.t < open + len);
    const before = points.filter((x) => x.t < open).at(-1)?.p ?? canon(base);
    if (inside.length === 0) return { o: before, h: before, l: before, c: before, v: '0', n: 0 };
    let h = inside[0]!.p;
    let l = inside[0]!.p;
    let v = D(0);
    for (const x of inside) {
      h = maxOf(h, x.p);
      l = minOf(l, x.p);
      v = v.plus(x.q ?? '0');
    }
    return { o: inside[0]!.p, h, l, c: inside.at(-1)!.p, v: v.toString(), n: inside.length };
  }

  /**
   * Kline rows as Binance answers them: from startTime forward (at most `limit`), or else the
   * latest `limit` ending at endTime (or now). No candle opens before the fake started or in the
   * future.
   */
  private klineRows(points: { t: number; p: string; q?: string }[], base: string, q: Record<string, string>): unknown[] {
    const len = INTERVAL_MS[q.interval ?? ''];
    if (!len) throw new HttpError(400, { code: -1120, msg: 'Invalid interval.' });
    const limit = Math.min(Number(q.limit ?? 500), 1500);
    const now = Date.now();
    const end = Math.min(q.endTime !== undefined ? Number(q.endTime) : now, now);
    const first = Math.floor(this.startedAt / len) * len;
    const opens: number[] = [];
    if (q.startTime !== undefined) {
      for (let t = Math.max(first, Math.floor(Number(q.startTime) / len) * len); t <= end && opens.length < limit; t += len) {
        if (t >= Number(q.startTime) - len + 1) opens.push(t);
      }
    } else {
      for (let t = Math.floor(end / len) * len; t >= first && opens.length < limit; t -= len) opens.unshift(t);
    }
    return opens.map((t) => {
      const c = this.candles(points, base, t, len);
      return [t, c.o, c.h, c.l, c.c, c.v, t + len - 1, '0', c.n, '0', '0', '0'];
    });
  }

  private aggTradeRows(market: FakeMarket, symbol: string, q: Record<string, string>): unknown[] {
    const list = this.trades.get(this.key(market, symbol));
    if (!list) throw new HttpError(400, { code: -1121, msg: 'Invalid symbol.' });
    const limit = Math.min(Number(q.limit ?? 500), 1000);
    let rows: Trade[];
    if (q.fromId !== undefined) rows = [...list].sort((x, y) => x.a - y.a).filter((t) => t.a >= Number(q.fromId)).slice(0, limit);
    else if (q.startTime !== undefined || q.endTime !== undefined) {
      const s = Number(q.startTime ?? 0);
      const e = Number(q.endTime ?? Number.MAX_SAFE_INTEGER);
      rows = list.filter((t) => t.T >= s && t.T <= e).slice(0, limit);
    } else rows = [...list].sort((x, y) => x.a - y.a).slice(-limit);
    return rows.map((t) =>
      market === 'spot'
        ? { a: t.a, p: t.p, q: t.q, f: t.a * 3, l: t.a * 3 + 1, T: t.T, m: t.m, M: true }
        : { a: t.a, p: t.p, q: t.q, f: t.a * 3, l: t.a * 3 + 1, T: t.T, m: t.m },
    );
  }

  private depthSnapshot(market: FakeMarket, symbol: string): unknown {
    const b = this.book(market, symbol);
    const bids = [...b.bids.entries()].sort(sortDesc);
    const asks = [...b.asks.entries()].sort(sortAsc);
    if (market === 'spot') return { lastUpdateId: b.lastU, bids, asks };
    // A futures snapshot sits inside the next event's U..u, as Binance's usually does.
    const E = Date.now();
    return { lastUpdateId: b.lastU + IDS_PER_EVENT / 2, E, T: E, bids, asks };
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const route = WS_ROUTES[url.pathname];
    if (this.dark || !route) {
      socket.end(`HTTP/1.1 ${this.dark ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const streams = route.kind === 'combined' ? new Set((url.searchParams.get('streams') ?? '').split('/').filter(Boolean)) : new Set<string>();
      const conn: Conn = { ws, market: route.market, kind: route.kind, streams };
      this.conns.add(conn);
      ws.on('close', () => this.conns.delete(conn));
      ws.on('error', () => this.conns.delete(conn));
      ws.on('message', (raw) => {
        let m: { method?: string; params?: string[]; id?: number };
        try {
          m = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ error: { code: 3, msg: 'Invalid JSON' } }));
          return;
        }
        if (m.method === 'SUBSCRIBE') for (const p of m.params ?? []) conn.streams.add(p);
        else if (m.method === 'UNSUBSCRIBE') for (const p of m.params ?? []) conn.streams.delete(p);
        else if (m.method === 'LIST_SUBSCRIPTIONS') {
          ws.send(JSON.stringify({ result: [...conn.streams], id: m.id }));
          return;
        } else {
          ws.send(JSON.stringify({ error: { code: 2, msg: 'Invalid request' }, id: m.id ?? null }));
          return;
        }
        ws.send(JSON.stringify({ result: null, id: m.id }));
        if (m.method === 'SUBSCRIBE') {
          for (const p of m.params ?? []) {
            const sym = p.split('@')[0]!.toUpperCase();
            if (SYMBOLS.includes(sym)) this.sendKlines(conn.market, sym);
          }
        }
      });
    });
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ at: Date.now(), path: url.pathname, query, headers: req.headers });
    const reply = (status: number, body: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8', 'x-mbx-used-weight-1m': '1' });
      res.end(JSON.stringify(body));
    };
    if (this.restDark) return reply(503, { code: -1001, msg: 'Internal error; unable to process your request. Please try again.' });
    let body: unknown;
    try {
      body = this.answer(url.pathname, query, req);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, e.body);
      return reply(500, { code: -1000, msg: (e as Error).message });
    }
    if (this.historyHeld && HISTORY_PATHS.has(url.pathname)) {
      // Answered when released, from the history as it is then.
      this.heldResponses.push(() => {
        try {
          reply(200, this.answer(url.pathname, query, req));
        } catch (e) {
          reply(500, { code: -1000, msg: (e as Error).message });
        }
      });
      return;
    }
    reply(200, body);
  }

  private answer(path: string, q: Record<string, string>, req: IncomingMessage): unknown {
    const now = Date.now();
    const symbol = q.symbol;
    const known = (s: string | undefined): string => {
      if (!s || !SYMBOLS.includes(s)) throw new HttpError(400, { code: -1121, msg: 'Invalid symbol.' });
      return s;
    };
    switch (path) {
      // ---- spot ----
      case '/api/v3/time':
        return { serverTime: now };
      case '/api/v3/exchangeInfo': {
        const wanted: string[] = q.symbols ? JSON.parse(q.symbols) : SYMBOLS;
        return { ...SPOT_INFO, serverTime: now, symbols: wanted.filter((s) => SYMBOLS.includes(s)).map(spotSymbolInfo) };
      }
      case '/api/v3/depth':
        return this.depthSnapshot('spot', known(symbol));
      case '/api/v3/avgPrice':
        return { mins: 5, price: this.lastPrice('spot', known(symbol)), closeTime: now };
      case '/api/v3/klines':
        return this.klineRows(this.tradePoints('spot', known(symbol)), START_PRICES[symbol!]!, q);
      case '/api/v3/aggTrades':
        return this.aggTradeRows('spot', known(symbol), q);
      // ---- futures ----
      case '/fapi/v1/time':
        return { serverTime: now };
      case '/fapi/v1/exchangeInfo':
        return { ...PERP_INFO, serverTime: now, symbols: SYMBOLS.map(perpSymbolInfo) };
      case '/fapi/v1/depth':
        return this.depthSnapshot('perp', known(symbol));
      case '/fapi/v1/klines':
        return this.klineRows(this.tradePoints('perp', known(symbol)), START_PRICES[symbol!]!, q);
      case '/fapi/v1/markPriceKlines': {
        const m = this.marks.get(known(symbol))!;
        return this.klineRows(m.samples, START_PRICES[symbol!]!, q).map((r) => {
          const row = r as unknown[];
          row[5] = '0';
          row[8] = 0;
          return row;
        });
      }
      case '/fapi/v1/aggTrades':
        return this.aggTradeRows('perp', known(symbol), q);
      case '/fapi/v1/premiumIndex': {
        const one = (s: string) => {
          const m = this.marks.get(s)!;
          return {
            symbol: s,
            markPrice: m.markPrice,
            indexPrice: m.indexPrice,
            estimatedSettlePrice: m.markPrice,
            lastFundingRate: m.fundingRate,
            interestRate: '0.00010000',
            nextFundingTime: m.nextFundingTime,
            time: now,
          };
        };
        return symbol ? one(known(symbol)) : SYMBOLS.map(one);
      }
      case '/fapi/v1/fundingRate': {
        const s = Number(q.startTime ?? 0);
        const e = Number(q.endTime ?? now);
        const limit = Math.min(Number(q.limit ?? 100), 1000);
        return this.settlements
          .filter((r) => (!symbol || r.symbol === symbol) && r.fundingTime >= s && r.fundingTime <= e)
          .sort((a, b) => a.fundingTime - b.fundingTime)
          .slice(0, limit)
          .map((r) => ({ symbol: r.symbol, fundingTime: r.fundingTime, fundingRate: r.fundingRate, markPrice: r.markPrice }));
      }
      case '/fapi/v1/fundingInfo':
        return SYMBOLS.map((s) => ({
          symbol: s,
          adjustedFundingRateCap: '0.02000000',
          adjustedFundingRateFloor: '-0.02000000',
          fundingIntervalHours: 8,
          disclaimer: false,
        }));
      case '/fapi/v1/leverageBracket': {
        // Signed: any key and signature are accepted, but they must be there.
        if (!req.headers['x-mbx-apikey']) throw new HttpError(401, { code: -2014, msg: 'API-key format invalid.' });
        if (!q.signature || !q.timestamp) throw new HttpError(400, { code: -1102, msg: 'Mandatory parameter was not sent.' });
        return LEVERAGE_BRACKETS;
      }
      // ---- web ----
      case '/bapi/futures/v1/friendly/future/common/brackets':
        return BAPI_BRACKETS;
      default:
        throw new HttpError(404, { code: -1, msg: `No such path ${path}` });
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

const WS_ROUTES: Record<string, { market: FakeMarket; kind: 'combined' | 'raw' }> = {
  '/spot-ws/stream': { market: 'spot', kind: 'combined' },
  '/spot-ws/ws': { market: 'spot', kind: 'raw' },
  '/futures-ws/public/stream': { market: 'perp', kind: 'combined' },
  '/futures-ws/market/stream': { market: 'perp', kind: 'combined' },
  '/futures-ws/market/ws': { market: 'perp', kind: 'raw' },
};

/** A price as one canonical decimal string, so the same level is always the same key. */
function canon(p: string): string {
  return D(p).toString();
}

function maxOf(a: string, b: string): string {
  return D(a).gte(D(b)) ? a : b;
}

function minOf(a: string, b: string): string {
  return D(a).lte(D(b)) ? a : b;
}

/** A book around `price`: five levels a side, a tick-sized spread. */
export function defaultBook(price: string): { bids: Level[]; asks: Level[] } {
  const p = D(price);
  const step: Decimal = p.gte(1000) ? D('0.1') : p.gte(10) ? D('0.01') : D('0.0001');
  const bids: Level[] = [];
  const asks: Level[] = [];
  for (let i = 0; i < 5; i++) {
    bids.push([p.minus(step.mul(i + 1)).toString(), '5']);
    asks.push([p.plus(step.mul(i)).toString(), '5']);
  }
  return { bids, asks };
}

const SPOT_FIXTURE = fixture('btcusdt-exchangeinfo.json');
const PERP_FIXTURE = fixture('btcusdt-perp-exchangeinfo.json');
const LEVERAGE_BRACKETS = fixture('leverage-bracket.json');
const BAPI_BRACKETS = fixture('bapi-brackets.json');
const { symbols: _spotSymbols, ...SPOT_INFO } = SPOT_FIXTURE;
const { symbols: _perpSymbols, ...PERP_INFO } = PERP_FIXTURE;

/** The recorded BTCUSDT spot entry, renamed for `symbol`. */
function spotSymbolInfo(symbol: string): unknown {
  const base = structuredClone(SPOT_FIXTURE.symbols[0]);
  return { ...base, symbol, baseAsset: symbol.replace(/USDT$/, '') };
}

/** The recorded BTCUSDT perpetual entry, renamed for `symbol`, its price filter fitted to the coin's price. */
function perpSymbolInfo(symbol: string): unknown {
  const base = structuredClone(PERP_FIXTURE.symbols[0]);
  const price = D(START_PRICES[symbol]!);
  const tick = price.gte(1000) ? '0.10' : price.gte(10) ? '0.010' : '0.0001000';
  base.filters = base.filters.map((f: { filterType: string }) =>
    f.filterType === 'PRICE_FILTER' ? { ...f, tickSize: tick, minPrice: tick } : f,
  );
  return { ...base, symbol, pair: symbol, baseAsset: symbol.replace(/USDT$/, '') };
}
