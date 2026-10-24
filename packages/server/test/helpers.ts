import { EventEmitter } from 'node:events';
import { D, PerpEngine, SimEngine, SpotEngine } from '@sim/engine';
import type { AggTrade, BookSnapshot, Candle1m, Decimal, Market, PriceLevel, Side } from '@sim/engine';
import { FakeMarket } from '../../engine/test/fixtures.ts';
import { FakePerpMarket } from '../../engine/test/perpFixtures.ts';
import type { CatchUpHistory, Settlement } from '../src/catchup/history.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { loadLedger, loadPerpState, loadSpotState, toJson } from '../src/db/store.ts';
import { createLogger } from '../src/log.ts';
import type { MarkUpdate } from '../src/market/perpFeed.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { EngineRunner } from '../src/runner.ts';
import type { RunnerMessage } from '../src/runner.ts';
import exchangeInfo from './fixtures/btcusdt-exchangeinfo.json' with { type: 'json' };

export const WATCHDOG_MS = 5000;
export const tick = () => new Promise<void>((r) => setImmediate(r));
/** Lets every promise chain started so far (a catch-up run over FakeHistory, say) run to its end. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** Manual timers: nothing runs until the test fires it. */
export function fakeTimers() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t = { fn, ms, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  // The 5 s socket-watchdog check is bookkeeping; tests address it explicitly via fireMs.
  const pending = () => timers.filter((t) => t.live && t.ms !== WATCHDOG_MS);
  const all = () => timers.filter((t) => t.live);
  const fire = (i = 0) => {
    const t = pending()[i]!;
    t.live = false;
    t.fn();
  };
  const fireMs = (ms: number) => {
    const t = timers.find((x) => x.live && x.ms === ms)!;
    t.live = false;
    t.fn();
  };
  return { setTimer, pending, all, fire, fireMs };
}

export class FakeWs extends EventEmitter {
  sent: string[] = [];
  /** Client pings sent; our code must never send any on Binance sockets. */
  pings = 0;
  closed = false;
  terminated = false;
  constructor(public url: string) {
    super();
  }
  send(d: string) {
    this.sent.push(d);
  }
  ping() {
    this.pings++;
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.terminated = true;
  }
  open() {
    this.emit('open');
  }
  msg(o: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(o)), false);
  }
  drop() {
    this.emit('close');
  }
}


/** A clock with timers that run in due order when the test advances time. */
export class FakeClock {
  private timers: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
  private seq = 0;
  constructor(public now: number) {}

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = { at: this.now + Math.max(0, ms), seq: this.seq++, fn, live: true };
    this.timers.push(t);
    return () => {
      t.live = false;
    };
  };

  /** Move time forward by ms, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.live && t.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      due.live = false;
      this.now = Math.max(this.now, due.at);
      due.fn();
    }
    this.now = end;
    this.timers = this.timers.filter((t) => t.live);
  }
}

/**
 * The engine's FakeMarket plus what the runner and client hub use of MarketData: bestBid,
 * consume, health snapshot, tickers, book top, recent trades and the 'trade' / 'book' events.
 */
export class TestMarket extends FakeMarket {
  private readonly emitter = new EventEmitter();
  staleReason = 'Disconnected';
  /** What consume() was given, in order; the book itself is left as it is. */
  readonly consumed: { symbol: string; side: Side; levels: PriceLevel[] }[] = [];
  /** Runs inside each consume() call, e.g. to look at the DB at that moment. */
  onConsume: (() => void) | null = null;
  constructor(private readonly symbols: string[] = ['BTCUSDT']) {
    super();
  }
  on(event: string, cb: (...args: any[]) => void): this {
    this.emitter.on(event, cb);
    return this;
  }
  off(event: string, cb: (...args: any[]) => void): this {
    this.emitter.off(event, cb);
    return this;
  }
  /** Deliver a live trade, as MarketData does. */
  trade(symbol: string, t: AggTrade): void {
    this.setLastPrice(symbol, t.price);
    this.emitter.emit('trade', symbol, t);
  }
  consume(symbol: string, side: Side, levels: PriceLevel[]): void {
    this.consumed.push({ symbol, side, levels });
    this.onConsume?.();
  }
  bestBid(symbol: string): { price: Decimal; fresh: boolean } | null {
    const b = this.book(symbol).bids[0];
    return b ? { price: b.price, fresh: this.isFresh(symbol) } : null;
  }
  healthSnapshot(): Record<string, { fresh: boolean; reason: string | null }> {
    return Object.fromEntries(
      this.symbols.map((s) => [s, { fresh: this.isFresh(s), reason: this.isFresh(s) ? null : this.staleReason }]),
    );
  }
  tickers(): Record<string, { last: Decimal; open24h: Decimal; change24hPct: Decimal }> {
    return {};
  }
  bookTop(symbol: string, levels = 20): BookSnapshot {
    const b = this.book(symbol);
    return { bids: b.bids.slice(0, levels), asks: b.asks.slice(0, levels) };
  }
  recentTrades(_symbol: string, _n?: number): AggTrade[] {
    return [];
  }
}

/**
 * What the runner reads from FeedHealth, for runner tests over a TestMarket (whose freshness the
 * test sets): frames keep arriving, the last one just now, until the test sets lastFrame; the
 * stalls the runner reports are listed.
 */
export class FakeHealth {
  lastFrame: number | null = null;
  readonly stalls: number[] = [];
  constructor(private readonly now: () => number) {}
  lastFrameAt(): number {
    return this.lastFrame ?? this.now();
  }
  markStalled(now: number): void {
    this.stalls.push(now);
  }
}

/**
 * The engine's FakePerpMarket plus what the runner reads of PerpMarketData: consume, health
 * snapshot and the 'trade' / 'mark' events. BTCUSDT starts fresh on the engine fixture's book
 * (asks 80000.0 x 0.2, 80010.0 x 1.0; bids 79990.0 x 0.2, 79980.0 x 1.0), mark 80000.
 */
export class TestPerpMarket extends FakePerpMarket {
  private readonly emitter = new EventEmitter();
  staleReason = 'Disconnected';
  readonly consumed: { symbol: string; side: Side; levels: PriceLevel[] }[] = [];
  /** The clock mark receive times are read from (runnerHarness sets it to its fake clock). */
  now: () => number = () => 0;
  private readonly markTimes = new Map<string, number>();
  constructor(private readonly symbols: string[] = ['BTCUSDT']) {
    super();
  }
  on(event: string, cb: (...args: any[]) => void): this {
    this.emitter.on(event, cb);
    return this;
  }
  off(event: string, cb: (...args: any[]) => void): this {
    this.emitter.off(event, cb);
    return this;
  }
  markReceivedAt(symbol: string): number | null {
    return this.markTimes.get(symbol) ?? null;
  }
  /** Deliver a live futures trade, as PerpMarketData does. */
  trade(symbol: string, t: AggTrade): void {
    this.setLastPrice(symbol, t.price);
    this.emitter.emit('trade', symbol, t);
  }
  /** Deliver a mark price update (recorded as the market's mark first, as PerpMarketData does). */
  mark(symbol: string, price: string, nextFundingTime = 0, fundingRate = '0.0001'): void {
    this.setMarkPrice(symbol, D(price));
    this.markTimes.set(symbol, this.now());
    const m: MarkUpdate = { markPrice: D(price), indexPrice: D(price), fundingRate: D(fundingRate), nextFundingTime, eventTime: 0 };
    this.emitter.emit('mark', symbol, m);
  }
  consume(symbol: string, side: Side, levels: PriceLevel[]): void {
    this.consumed.push({ symbol, side, levels });
  }
  healthSnapshot(): Record<string, { fresh: boolean; reason: string | null }> {
    return Object.fromEntries(
      this.symbols.map((s) => [s, { fresh: this.isFresh(s), reason: this.isFresh(s) ? null : this.staleReason }]),
    );
  }
}

/**
 * Binance history for catch-up, served from what the test sets: last-price candles per
 * `${market}:${symbol}`, mark candles and funding per symbol, trades per `${market}:${symbol}`
 * (each answer filtered to the range asked for). Every call is recorded in `calls`; while
 * `failures` holds errors, each call throws the next one.
 */
export class FakeHistory implements CatchUpHistory {
  candleList: Record<string, Candle1m[]> = {};
  markList: Record<string, Candle1m[]> = {};
  tradeList: Record<string, AggTrade[]> = {};
  latest: Record<string, number | null> = {};
  settlements: Record<string, Settlement[]> = {};
  readonly calls: string[] = [];
  readonly failures: Error[] = [];
  /** While set, every call waits for it first: a run in flight the test holds. */
  private blocked: Promise<void> | null = null;

  /** Holds every later call until the returned function is called. */
  hold(): () => void {
    let release!: () => void;
    this.blocked = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      this.blocked = null;
      release();
    };
  }

  private async call(what: string): Promise<void> {
    this.calls.push(what);
    if (this.blocked) await this.blocked;
    const e = this.failures.shift();
    if (e) throw e;
  }
  async candles(market: Market, symbol: string, start: number, end: number): Promise<Candle1m[]> {
    await this.call(`candles ${market}:${symbol} ${start} ${end}`);
    const from = Math.floor(start / 60_000) * 60_000;
    return (this.candleList[`${market}:${symbol}`] ?? []).filter((c) => c.openTime >= from && c.openTime <= end);
  }
  async markCandles(symbol: string, start: number, end: number): Promise<Candle1m[]> {
    await this.call(`marks ${symbol} ${start} ${end}`);
    const from = Math.floor(start / 60_000) * 60_000;
    return (this.markList[symbol] ?? []).filter((c) => c.openTime >= from && c.openTime <= end);
  }
  async minuteTrades(market: Market, symbol: string, minute: number): Promise<AggTrade[]> {
    await this.call(`trades ${market}:${symbol} ${minute}`);
    return (this.tradeList[`${market}:${symbol}`] ?? []).filter((t) => t.time >= minute && t.time < minute + 60_000);
  }
  async latestTradeId(market: Market, symbol: string): Promise<number | null> {
    await this.call(`latest ${market}:${symbol}`);
    return this.latest[`${market}:${symbol}`] ?? null;
  }
  async funding(symbol: string, start: number, end: number): Promise<Settlement[]> {
    await this.call(`funding ${symbol} ${start} ${end}`);
    return (this.settlements[symbol] ?? []).filter((f) => f.time >= start && f.time <= end);
  }
}

export const RUNNER_T0 = 1_700_000_000_000;
export const RUNNER_FEES = {
  spot: { maker: D('0.001'), taker: D('0.001') },
  perp: { maker: D('0.0002'), taker: D('0.0005') },
};

export interface RunnerMsg {
  type: string;
  [k: string]: any;
}

/**
 * A runner over a ':memory:' (or given) DB, a spot TestMarket, a TestPerpMarket, a FakeHealth per
 * market and a fake clock, built as main.ts builds it (every state loaded from the DB); rng 0 =
 * 100 ms delays. Not started.
 */
export function runnerHarness(
  opts: {
    db?: Db;
    market?: TestMarket;
    perpMarket?: TestPerpMarket;
    clock?: FakeClock;
    symbols?: string[];
    history?: CatchUpHistory;
    funding?: {
      fundingTimes(symbol: string, start: number, end: number): Promise<number[]>;
      caughtUp(symbol: string, since: number): void;
    };
  } = {},
) {
  const symbols = opts.symbols ?? ['BTCUSDT'];
  const db = opts.db ?? openDb(':memory:');
  const clock = opts.clock ?? new FakeClock(RUNNER_T0);
  const seasonId = currentSeasonId(db, () => clock.now);
  const market = opts.market ?? new TestMarket(symbols);
  const perp = opts.perpMarket ?? new TestPerpMarket(symbols);
  perp.now = () => clock.now;
  const health = new FakeHealth(() => clock.now);
  const perpHealth = new FakeHealth(() => clock.now);
  const ledger = loadLedger(db, seasonId, ['USDT', ...symbols.map((s) => s.replace(/USDT$/, ''))]);
  const engine = new SpotEngine(loadSpotState(db, seasonId, ledger));
  const sim = new SimEngine(ledger, engine, new PerpEngine(loadPerpState(db, seasonId, ledger)));
  const sent: RunnerMsg[] = [];
  const fatal: unknown[] = [];
  const logs: string[] = [];
  const logger = createLogger([], (_s, line) => logs.push(line));
  const history = opts.history ?? new FakeHistory();
  const runner = new EngineRunner({
    db,
    seasonId,
    sim,
    spotMarket: market,
    perpMarket: perp,
    health: { spot: health, perp: perpHealth },
    symbols,
    fees: RUNNER_FEES,
    now: () => clock.now,
    rng: () => 0,
    setTimer: clock.setTimer,
    onBroadcast: (m) => sent.push(JSON.parse(toJson(m)) as RunnerMsg),
    onFatal: (e) => fatal.push(e),
    logger,
    history,
    funding: opts.funding,
  });
  const notices = () => sent.filter((m) => m.type === 'notice').map((m) => m.text as string);
  const orderRow = (id: string) =>
    db.prepare('SELECT status, market, data FROM orders WHERE id = ?').get(id) as
      | { status: string; market: string; data: string }
      | undefined;
  const eventsOf = (type: string) =>
    (db.prepare('SELECT time, symbol, payload FROM events WHERE type = ? ORDER BY id').all(type) as {
      time: number;
      symbol: string | null;
      payload: string;
    }[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  return { db, clock, seasonId, market, perp, health, perpHealth, sim, engine, runner, sent, fatal, logs, logger, notices, orderRow, eventsOf, history };
}

type Levels = [string, string][];

/**
 * The real feed, health, market data, engine and runner over a fake socket, a fake clock and a
 * ':memory:' DB: connected, BTCUSDT's book synced (bids 99.90 x 0.4, 99.80 x 1.0, 99.00 x 3.0;
 * asks 100.00 x 0.5, 100.10 x 1.0, 100.50 x 2.0) by depth update 101 at t0 + 1 s, rules and
 * average price loaded, the runner started: fresh on return. The rules carry the symbol's
 * Binance trading status as of the last refreshRules() (setTradingStatus changes it).
 */
export async function liveStack(t0: number) {
  const clock = new FakeClock(t0);
  const sockets: FakeWs[] = [];
  const symbols = ['BTCUSDT'];
  const silent = { info() {}, warn() {}, error() {} };
  const health = new FeedHealth(symbols, { silentMs: 15_000, lagMs: 5000, noUpdateMs: 120_000 });
  const books = new Map([['BTCUSDT', new LocalBook()]]);
  let tradingStatus = 'TRADING';
  const rest = {
    depth: async () => ({
      lastUpdateId: 100,
      bids: [['99.90', '0.4'], ['99.80', '1.0'], ['99.00', '3.0']] as Levels,
      asks: [['100.00', '0.5'], ['100.10', '1.0'], ['100.50', '2.0']] as Levels,
    }),
    exchangeInfo: async () => ({ symbols: [{ ...exchangeInfo.symbols[0]!, status: tradingStatus }] }),
    avgPrice: async () => ({ price: '100' }),
    serverTime: async () => ({ serverTime: clock.now }),
  };
  const common = { symbols, logger: silent, now: () => clock.now, setTimer: clock.setTimer };
  const feed = new SpotFeed({
    ...common,
    rest,
    health,
    books,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w as any;
    },
  });
  const market = new MarketData({ ...common, feed, books, health, rest });
  const db = openDb(':memory:');
  const seasonId = currentSeasonId(db, () => clock.now);
  const ledger = loadLedger(db, seasonId, ['USDT', 'BTC']);
  const engine = new SpotEngine(loadSpotState(db, seasonId, ledger));
  const sim = new SimEngine(ledger, engine, new PerpEngine(loadPerpState(db, seasonId, ledger)));
  const sent: RunnerMessage[] = [];
  const runner = new EngineRunner({
    ...common,
    db,
    seasonId,
    sim,
    spotMarket: market,
    perpMarket: new TestPerpMarket(symbols),
    health: { spot: health, perp: new FakeHealth(() => clock.now) },
    fees: RUNNER_FEES,
    rng: () => 0,
    onBroadcast: (m) => sent.push(m),
    onFatal: (e) => {
      throw e;
    },
    history: new FakeHistory(),
  });

  feed.start();
  const ws = sockets[0]!;
  ws.open();
  clock.advance(1000);
  await tick(); // the snapshot
  /** A depth update (event time now) with update id U. */
  const depth = (U: number, b: Levels = [], a: Levels = []) =>
    ws.msg({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', E: clock.now, s: 'BTCUSDT', U, u: U, b, a } });
  /** An aggTrade with id `id`, stamped by the exchange at E (default now). */
  const trade = (id: number, price: string, E = clock.now) =>
    ws.msg({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E, s: 'BTCUSDT', a: id, p: price, q: '1', T: E, m: true } });
  depth(101);
  await market.refreshRules();
  await market.pollAvgPrice('BTCUSDT');
  runner.start();
  if (!market.isFresh('BTCUSDT')) throw new Error('live stack not fresh after setup');

  const notices = () => sent.flatMap((m) => (m.type === 'notice' ? [m.text] : []));
  const setTradingStatus = (status: string) => {
    tradingStatus = status;
  };
  return { clock, ws, market, db, engine, runner, notices, depth, trade, ping: () => ws.emit('ping'), setTradingStatus };
}
