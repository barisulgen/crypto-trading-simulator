import { describe, expect, it } from 'vitest';
import { D, SpotEngine } from '@sim/engine';
import type { AggTrade, SpotOrderRequest } from '@sim/engine';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { loadSpotState, toJson } from '../src/db/store.ts';
import { createLogger } from '../src/log.ts';
import { EngineRunner, RefusedError, RESTART_REASON, submittedOrder } from '../src/runner.ts';
import { FakeClock, FakeHealth, TestMarket } from './helpers.ts';

const T0 = 1_700_000_000_000;
const SYMBOLS = ['BTCUSDT'];
const ASSETS = ['USDT', 'BTC'];
const FEES = { maker: D('0.001'), taker: D('0.001') };

let tradeId = 0;
const trade = (price: string, qty = '1'): AggTrade => ({
  id: ++tradeId,
  price: D(price),
  qty: D(qty),
  sellerInitiated: true,
  time: T0,
});

const marketBuy = (qty: string): SpotOrderRequest => ({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty });
const stopSell = (qty: string, triggerPrice: string): SpotOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'sell',
  type: 'stop_loss',
  qty,
  triggerPrice,
});

interface Msg {
  type: string;
  [k: string]: any;
}

/** A runner over a ':memory:' (or given) DB, TestMarket, FakeHealth and a fake clock; rng 0 = 100 ms delays. */
function setup(opts: { db?: Db; market?: TestMarket; clock?: FakeClock } = {}) {
  const db = opts.db ?? openDb(':memory:');
  const clock = opts.clock ?? new FakeClock(T0);
  const seasonId = currentSeasonId(db, () => clock.now);
  const market = opts.market ?? new TestMarket(SYMBOLS);
  const health = new FakeHealth(market, SYMBOLS);
  const engine = new SpotEngine(loadSpotState(db, seasonId, ASSETS));
  const sent: Msg[] = [];
  const fatal: unknown[] = [];
  const logs: string[] = [];
  const logger = createLogger([], (_s, line) => logs.push(line));
  const runner = new EngineRunner({
    db,
    seasonId,
    engine,
    market,
    health,
    symbols: SYMBOLS,
    fees: FEES,
    now: () => clock.now,
    rng: () => 0,
    setTimer: clock.setTimer,
    onBroadcast: (m) => sent.push(JSON.parse(toJson(m)) as Msg),
    onFatal: (e) => fatal.push(e),
    logger,
  });
  const notices = () => sent.filter((m) => m.type === 'notice').map((m) => m.text as string);
  const orderRow = (id: string) =>
    db.prepare('SELECT status, data FROM orders WHERE id = ?').get(id) as { status: string; data: string } | undefined;
  const eventsOf = (type: string) =>
    (db.prepare('SELECT time, symbol, payload FROM events WHERE type = ? ORDER BY id').all(type) as {
      time: number;
      symbol: string | null;
      payload: string;
    }[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  return { db, clock, seasonId, market, health, engine, runner, sent, fatal, logs, logger, notices, orderRow, eventsOf };
}

/** Deposit 1000 USDT and buy 1 BTC at market (fills at 100.00 x 0.5 + 100.10 x 0.5). */
function withBtc(t: ReturnType<typeof setup>) {
  t.runner.deposit('spot', D('1000'));
  t.runner.submit(marketBuy('1'));
  t.clock.advance(300);
}

describe('EngineRunner', () => {
  it('persists and broadcasts account and orders after every engine call, even pending -> open (no events)', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    const order = submittedOrder(t.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: '99.50', qty: '1' }));
    expect(order.status).toBe('pending');
    expect(t.orderRow(order.id)!.status).toBe('pending');

    t.sent.length = 0;
    t.clock.advance(100); // arrive(): pending -> open, no engine events
    expect(t.orderRow(order.id)!.status).toBe('open');
    const orders = t.sent.filter((m) => m.type === 'orders').at(-1)!;
    expect(orders.orders).toEqual([expect.objectContaining({ id: order.id, status: 'open', price: '99.5' })]);
    const account = t.sent.filter((m) => m.type === 'account').at(-1)!;
    expect(account.account.spotUsdtLocked).toBe('99.5');
    expect(account.account.total).toBe('1000');
  });

  it('the account carries each held coin\'s cost basis (qty and cost) for holdings, also in the broadcast', () => {
    const t = setup();
    t.runner.start();
    expect(JSON.parse(toJson(t.runner.account())).basis).toEqual({});
    withBtc(t); // 1 BTC for 100.05 USDT, fee 0.001 BTC: 0.999 BTC held at a cost of 100.05
    expect(JSON.parse(toJson(t.runner.account())).basis).toEqual({ BTC: { qty: '0.999', cost: '100.05' } });
    const account = t.sent.filter((m) => m.type === 'account').at(-1)!;
    expect(account.account.basis).toEqual({ BTC: { qty: '0.999', cost: '100.05' } });
  });

  it('a market buy fills at its arrival time, is persisted and gives a fill notice', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    const order = submittedOrder(t.runner.submit(marketBuy('1.2')));
    expect(order.status).toBe('pending');
    expect(order.id).toMatch(/^o-[0-9a-f-]{36}$/);
    t.clock.advance(99);
    expect(t.orderRow(order.id)!.status).toBe('pending');
    t.clock.advance(1);
    expect(t.orderRow(order.id)!.status).toBe('filled');
    expect(t.db.prepare('SELECT count(*) AS n FROM fills').get()).toEqual({ n: 1 });
    expect(t.notices()).toContain('Bought 1.2 BTC @ 100.0583 · slippage $0.07 · fee 0.0012 BTC');
  });

  it('schedules arrive() at the arrivesAt of a triggered stop and fills it', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    const order = submittedOrder(t.runner.submit(stopSell('0.5', '99')));
    t.clock.advance(100);
    expect(t.orderRow(order.id)!.status).toBe('open');

    t.market.trade('BTCUSDT', trade('99.00'));
    expect(t.orderRow(order.id)!.status).toBe('triggered');
    expect(t.notices()).toContain('Stop triggered at 99.00');
    t.clock.advance(100);
    expect(t.orderRow(order.id)!.status).toBe('filled');
    // bids 0.4 @ 99.90 + 0.1 @ 99.80 = 49.94 USDT, avg 99.88; best 99.90 x 0.5 = 49.95 -> slippage 0.01
    expect(t.notices().at(-1)).toBe('Sold 0.5 BTC @ 99.8800 · slippage $0.01 · fee 0.04994 USDT');
  });

  it('records a feed_gap on stale -> fresh and executes a deferred triggered stop on fresh', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    const order = submittedOrder(t.runner.submit(stopSell('0.5', '99')));
    t.clock.advance(100);
    t.market.trade('BTCUSDT', trade('98.90'));
    expect(t.orderRow(order.id)!.status).toBe('triggered');

    // The data goes stale before the triggered order's arrival: it waits, never rejected.
    t.market.setFresh('BTCUSDT', false); // at T0 + 400; health is polled every second from T0
    const staleAt = T0 + 1000;
    t.clock.advance(1000);
    expect(t.orderRow(order.id)!.status).toBe('triggered');
    expect(JSON.parse(t.orderRow(order.id)!.data).arrivesAt).toBeNull();
    expect(t.notices()).toContain('Live data interrupted for BTCUSDT: Disconnected');
    expect(t.eventsOf('feed_gap')).toEqual([]);

    t.market.setFresh('BTCUSDT', true);
    t.clock.advance(5000);
    const freshAt = T0 + 2000;
    expect(t.eventsOf('feed_gap')).toEqual([
      {
        time: freshAt,
        symbol: 'BTCUSDT',
        payload: { startedAt: staleAt, endedAt: freshAt, reason: 'Disconnected' },
      },
    ]);
    expect(t.orderRow(order.id)!.status).toBe('filled');
    expect(t.notices()).toContain('Live data restored for BTCUSDT');
    expect(t.sent.some((m) => m.type === 'health' && m.health.BTCUSDT.fresh === false)).toBe(true);
  });

  it('gives partial-fill and thin-book notices', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    t.runner.submit(marketBuy('5')); // the book has 3.5 BTC of asks
    t.clock.advance(100);
    expect(t.notices()).toEqual([
      'Partial fill: Bought 3.5 BTC @ 100.3143 · slippage $1.10 · fee 0.0035 BTC',
      'Book too thin: 1.5 BTC not filled and cancelled',
    ]);
  });

  it('collapses a rejected pair into one notice', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    t.market.setFresh('BTCUSDT', false);
    const events = t.runner.attachOco({ symbol: 'BTCUSDT', qty: '0.5', stopLoss: '95', takeProfit: '110' });
    expect(events.filter((e) => e.type === 'order_rejected')).toHaveLength(2);
    expect(t.sent.filter((m) => m.type === 'notice' && m.kind === 'rejected').map((m) => m.text)).toEqual([
      'Live data interrupted for BTCUSDT',
    ]);
  });

  it('restart: rejects a pending market order and re-arms a pending limit with a fresh delay', () => {
    const a = setup();
    a.runner.deposit('spot', D('1000'));
    const market = submittedOrder(a.runner.submit(marketBuy('1')));
    const limit = submittedOrder(a.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: '99.50', qty: '1' }));
    expect(market.status).toBe('pending');
    a.runner.stop();

    a.clock.advance(60_000);
    const b = setup({ db: a.db, clock: a.clock });
    const m = b.engine.state.orders.get(market.id)!;
    expect(m.status).toBe('rejected');
    expect(m.rejectReason).toBe(RESTART_REASON);
    expect(RESTART_REASON).toBe('Server restarted before execution');
    expect(b.orderRow(market.id)!.status).toBe('rejected');
    expect(b.eventsOf('order_rejected').map((e) => e.payload.reason)).toEqual(['Server restarted before execution']);
    expect(b.engine.state.balances.spot.USDT!.locked.toString()).toBe('99.5'); // the limit's lock only

    const l = b.engine.state.orders.get(limit.id)!;
    expect(l.status).toBe('pending');
    expect(l.arrivesAt).toBe(a.clock.now + 100);
    b.clock.advance(100);
    expect(b.orderRow(limit.id)!.status).toBe('open');
  });

  it('restart: the first fresh poll records a Server offline gap from last_alive and runs onFresh', () => {
    const a = setup();
    a.runner.start(); // touches last_alive at T0
    withBtc(a);
    const order = submittedOrder(a.runner.submit(stopSell('0.5', '99')));
    a.clock.advance(100);
    a.market.trade('BTCUSDT', trade('98.80'));
    a.market.setFresh('BTCUSDT', false);
    a.clock.advance(100); // arrival lands on stale data: stays triggered, arrivesAt null
    expect(JSON.parse(a.orderRow(order.id)!.data).arrivesAt).toBeNull();
    a.clock.advance(5000); // last heartbeat at T0 + 10 s is not reached yet
    a.runner.stop();
    const lastAlive = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as { value: string }).value);

    a.clock.advance(120_000);
    const market = new TestMarket(SYMBOLS);
    const b = setup({ db: a.db, clock: a.clock, market });
    expect(b.engine.state.orders.get(order.id)!.status).toBe('triggered');
    const startAt = b.clock.now;
    b.runner.start();
    expect(b.orderRow(order.id)!.status).toBe('filled');
    expect(b.eventsOf('feed_gap').map((g) => g.payload)).toEqual([
      // closed by a.runner.stop(): stale since the poll at T0 + 1 s, stopped at T0 + 5.5 s
      { startedAt: T0 + 1000, endedAt: T0 + 5500, reason: 'Disconnected' },
      { startedAt: lastAlive, endedAt: startAt, reason: 'Server offline' },
    ]);
  });

  it('stop() persists a gap still open at shutdown, ending at the stop time', () => {
    const t = setup();
    t.runner.start();
    t.market.setFresh('BTCUSDT', false);
    t.clock.advance(1000); // stale at T0 + 1000
    t.clock.advance(4500);
    t.runner.stop(); // at T0 + 5500
    expect(t.eventsOf('feed_gap').map((g) => g.payload)).toEqual([
      { startedAt: T0 + 1000, endedAt: T0 + 5500, reason: 'Disconnected' },
    ]);
    t.runner.stop(); // a second stop records nothing more
    expect(t.eventsOf('feed_gap')).toHaveLength(1);
  });

  it.each([
    ['past (down longer than the delay)', 60_000],
    ['future (restarted within the delay)', 0],
  ])('restart: schedules arrive() for a triggered order whose arrivesAt is %s', (_label, downMs) => {
    const a = setup();
    a.runner.start();
    withBtc(a);
    const order = submittedOrder(a.runner.submit(stopSell('0.4', '99')));
    a.clock.advance(100);
    a.market.trade('BTCUSDT', trade('98.90'));
    const arrivesAt = a.engine.state.orders.get(order.id)!.arrivesAt!;
    expect(arrivesAt).toBe(a.clock.now + 100);
    a.runner.stop();
    a.clock.advance(downMs);

    // Not started: no health poll / onFresh / trades, so only a scheduled arrive() can fill it.
    const b = setup({ db: a.db, clock: a.clock });
    expect(b.engine.state.orders.get(order.id)!.status).toBe('triggered');
    const wait = Math.max(0, arrivesAt - b.clock.now);
    if (wait > 0) {
      b.clock.advance(wait - 1);
      expect(b.orderRow(order.id)!.status).toBe('triggered');
    }
    b.clock.advance(wait > 0 ? 1 : 0);
    expect(b.orderRow(order.id)!.status).toBe('filled');
  });

  it('a persist failure is fatal: logged, onFatal called, nothing more runs', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    t.db.exec('DROP TABLE balances');
    expect(() => t.runner.deposit('spot', D('5'))).toThrow();
    expect(t.fatal).toHaveLength(1);
    expect(t.logs.some((l) => / error .*persist failed.*no such table: balances/.test(l))).toBe(true);
    expect(() => t.runner.submit(marketBuy('1'))).toThrow(RefusedError);
    t.clock.advance(120_000); // timers are cancelled: no further fatal calls
    expect(t.fatal).toHaveLength(1);
  });

  it('cancelling a dollar-sized buy stop before the rules load is refused, not fatal', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    const order = submittedOrder(
      t.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'stop_loss', triggerPrice: '101', quoteQty: '50.5' }),
    );
    t.clock.advance(100);
    expect(t.orderRow(order.id)!.status).toBe('open');
    t.market.clearRules('BTCUSDT');
    expect(t.runner.cancel(order.id)).toEqual({ ok: false, reason: 'Exchange rules not loaded yet; try again in a moment' });
    expect(t.fatal).toEqual([]);
    expect(t.orderRow(order.id)!.status).toBe('open');
  });

  it('refuses order submission when the loaded state fails its integrity check', () => {
    const a = setup();
    a.runner.deposit('spot', D('1000'));
    a.db.prepare("UPDATE balances SET locked = '5' WHERE asset = 'USDT' AND wallet = 'spot'").run();
    const b = setup({ db: a.db, clock: a.clock });
    expect(b.logs.some((l) => / error .*integrity.*Locked USDT 5 != sum of open order locks 0/.test(l))).toBe(true);
    expect(() => b.runner.submit(marketBuy('1'))).toThrow('Account state failed integrity check; see server log');
  });

  it('writes an equity snapshot every 60 s unless a held coin is stale, and touches last_alive every 10 s', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    const alive = () => Number((t.db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as { value: string }).value);
    t.clock.advance(10_000 - 300);
    expect(alive()).toBe(T0 + 10_000);
    t.clock.advance(50_000);
    const snaps = () => t.db.prepare('SELECT time, total, deposited FROM equity_snapshots').all() as { time: number; total: string; deposited: string }[];
    expect(snaps()).toHaveLength(1);
    expect(snaps()[0]!.time).toBe(T0 + 60_000);
    expect(snaps()[0]!.deposited).toBe('1000');
    t.market.setFresh('BTCUSDT', false);
    t.clock.advance(60_000);
    expect(snaps()).toHaveLength(1);
  });
});
