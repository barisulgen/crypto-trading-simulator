import { EventEmitter } from 'node:events';
import { D, SpotEngine } from '@sim/engine';
import type { AggTrade, BookSnapshot, Decimal } from '@sim/engine';
import { FakeMarket } from '../../engine/test/fixtures.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import { loadSpotState } from '../src/db/store.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { EngineRunner } from '../src/runner.ts';
import type { RunnerMessage } from '../src/runner.ts';
import exchangeInfo from './fixtures/btcusdt-exchangeinfo.json' with { type: 'json' };

export const WATCHDOG_MS = 5000;
export const tick = () => new Promise<void>((r) => setImmediate(r));

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
 * The engine's FakeMarket plus what the runner and client hub read from MarketData:
 * bestBid, health snapshot, tickers, book top, recent trades and the 'trade' / 'book' events.
 */
export class TestMarket extends FakeMarket {
  private readonly emitter = new EventEmitter();
  staleReason = 'Disconnected';
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
  const engine = new SpotEngine(loadSpotState(db, seasonId, ['USDT', 'BTC']));
  const sent: RunnerMessage[] = [];
  const runner = new EngineRunner({
    ...common,
    db,
    seasonId,
    engine,
    market,
    health,
    fees: { maker: D('0.001'), taker: D('0.001') },
    rng: () => 0,
    onBroadcast: (m) => sent.push(m),
    onFatal: (e) => {
      throw e;
    },
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
