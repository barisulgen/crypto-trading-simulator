import { describe, expect, it } from 'vitest';
import { D, SpotEngine } from '@sim/engine';
import type { AggTrade, SpotOrderRequest } from '@sim/engine';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { loadSpotState, toJson, touchAlive } from '../src/db/store.ts';
import { createLogger } from '../src/log.ts';
import { EngineRunner, RefusedError, RESTART_REASON, submittedOrder } from '../src/runner.ts';
import { btcRules } from '../../engine/test/fixtures.ts';
import { FakeClock, FakeHealth, TestMarket, liveStack } from './helpers.ts';

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
const limitBuy = (price: string, qty: string): SpotOrderRequest => ({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', price, qty });
const stopSell = (qty: string, triggerPrice: string): SpotOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'sell',
  type: 'stop_loss',
  qty,
  triggerPrice,
});

/** The gaps saved as open, as rows. */
const openGapsOf = (db: Db) => db.prepare('SELECT symbol, started_at AS startedAt, reason FROM open_gaps').all();
/** The recorded feed_gap payloads, oldest first. */
const gapsOf = (db: Db) =>
  (db.prepare("SELECT payload FROM events WHERE type = 'feed_gap' ORDER BY id").all() as { payload: string }[]).map(
    (r) => JSON.parse(r.payload),
  );

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
  const health = new FakeHealth(() => clock.now);
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
  const openGapRows = () => openGapsOf(db);
  const gaps = () => gapsOf(db);
  return { db, clock, seasonId, market, health, engine, runner, sent, fatal, logs, logger, notices, orderRow, eventsOf, openGapRows, gaps };
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

    // The data goes stale before the triggered order's arrival: it waits, never rejected. The
    // gap starts at the last fresh moment, the trade just processed, not at the poll that sees it.
    t.market.setFresh('BTCUSDT', false); // at T0 + 400; health is polled every second from T0
    const staleAt = T0 + 400;
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

    expect(b.engine.state.orders.get(limit.id)!.status).toBe('pending');
    // Not sent again before the symbol's data is first fresh after startup (not started: no health poll).
    b.clock.advance(5000);
    expect(b.orderRow(limit.id)!.status).toBe('pending');
    b.runner.start(); // first poll: fresh, so a fresh arrival delay from now
    expect(b.engine.state.orders.get(limit.id)!.arrivesAt).toBe(b.clock.now + 100);
    expect(JSON.parse(b.orderRow(limit.id)!.data).arrivesAt).toBe(b.clock.now + 100);
    b.clock.advance(99);
    expect(b.orderRow(limit.id)!.status).toBe('pending');
    b.clock.advance(1);
    expect(b.orderRow(limit.id)!.status).toBe('open');
  });

  it('restart: re-armed pending orders wait while the data is stale, then get a fresh delay (a pair shares one)', () => {
    const a = setup();
    a.runner.start();
    withBtc(a);
    const limit = submittedOrder(a.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: '99.50', qty: '1' }));
    const pair = a.runner.attachOco({ symbol: 'BTCUSDT', qty: '0.5', stopLoss: '95', takeProfit: '110' });
    const legs = pair.flatMap((e) => (e.type === 'order_placed' ? [e.order.id] : []));
    expect(legs).toHaveLength(2);
    a.runner.stop();

    a.clock.advance(60_000);
    const market = new TestMarket(SYMBOLS);
    market.setFresh('BTCUSDT', false); // books not synced yet after the restart
    const b = setup({ db: a.db, clock: a.clock, market });
    b.runner.start();
    b.clock.advance(10_000);
    for (const id of [limit.id, ...legs]) expect(b.orderRow(id)!.status).toBe('pending'); // waiting, not rejected

    market.setFresh('BTCUSDT', true);
    b.clock.advance(1000); // the next health poll sees fresh data
    const at = b.clock.now + 100;
    for (const id of [limit.id, ...legs]) expect(b.engine.state.orders.get(id)!.arrivesAt).toBe(at);
    b.clock.advance(100);
    expect(b.orderRow(limit.id)!.status).toBe('open');
    for (const id of legs) expect(b.orderRow(id)!.status).toBe('open');
    expect(b.fatal).toEqual([]);
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
      // closed by a.runner.stop(): stale after the trade at T0 + 400, stopped at T0 + 5.5 s
      { startedAt: T0 + 400, endedAt: T0 + 5500, reason: 'Disconnected' },
      { startedAt: lastAlive, endedAt: startAt, reason: 'Server offline' },
    ]);
  });

  it('stop() records a gap still open at shutdown as a feed_gap ending at the stop time and clears its row', () => {
    const t = setup();
    t.runner.start(); // fresh at the first poll, T0
    t.market.setFresh('BTCUSDT', false);
    t.clock.advance(1000); // seen stale at T0 + 1000: the gap starts at T0, the last fresh moment
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0, reason: 'Disconnected' }]);
    t.clock.advance(4500);
    t.runner.stop(); // at T0 + 5500
    expect(t.gaps()).toEqual([{ startedAt: T0, endedAt: T0 + 5500, reason: 'Disconnected' }]);
    expect(t.openGapRows()).toEqual([]);
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

  it('a cancel is a request: the order stays open until the cancel arrives 100 ms later, then it is cancelled', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    const order = submittedOrder(t.runner.submit(limitBuy('99.50', '1')));
    t.clock.advance(100);
    expect(t.orderRow(order.id)!.status).toBe('open');

    t.sent.length = 0;
    expect(t.runner.cancel(order.id)).toEqual({ ok: true, events: [] });
    const at = t.clock.now + 100;
    expect(t.orderRow(order.id)!.status).toBe('open');
    expect(JSON.parse(t.orderRow(order.id)!.data).cancelArrivesAt).toBe(at);
    const orders = t.sent.filter((m) => m.type === 'orders').at(-1)!;
    expect(orders.orders).toEqual([expect.objectContaining({ id: order.id, status: 'open', cancelArrivesAt: at })]);
    expect(t.runner.cancel(order.id)).toEqual({ ok: false, reason: 'Cancel already requested' });

    t.clock.advance(99);
    expect(t.orderRow(order.id)!.status).toBe('open');
    t.clock.advance(1);
    expect(t.orderRow(order.id)!.status).toBe('cancelled');
    expect(t.eventsOf('order_cancelled').map((e) => [e.time, e.payload.reason])).toEqual([[at, 'user']]);
    expect(t.runner.openOrders()).toEqual([]);
    expect(t.engine.state.balances.spot.USDT!.locked.toString()).toBe('0');
    expect(t.fatal).toEqual([]);
  });

  it('a trade during the cancel delay fills the order; the late cancel is recorded and gives an error notice', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    const order = submittedOrder(t.runner.submit(limitBuy('99.50', '1')));
    t.clock.advance(100);
    t.runner.cancel(order.id);
    t.clock.advance(1);
    t.market.trade('BTCUSDT', trade('99.00', '5'));
    expect(t.orderRow(order.id)!.status).toBe('filled');

    t.clock.advance(99);
    expect(t.eventsOf('cancel_rejected').map((e) => e.payload.reason)).toEqual([
      'Cancel arrived too late: order already filled',
    ]);
    expect(t.sent.filter((m) => m.type === 'notice' && m.kind === 'cancel_rejected')).toEqual([
      { type: 'notice', kind: 'cancel_rejected', level: 'error', text: 'Cancel arrived too late: order already filled' },
    ]);
    expect(JSON.parse(t.orderRow(order.id)!.data).cancelArrivesAt).toBeNull();
    expect(t.orderRow(order.id)!.status).toBe('filled');
  });

  it('restart: a cancel in flight when the server stopped reached the exchange meanwhile: cancelled during startup recovery', () => {
    const a = setup();
    a.runner.start();
    a.runner.deposit('spot', D('1000'));
    const limit = submittedOrder(a.runner.submit(limitBuy('99.50', '1')));
    a.clock.advance(100);
    expect(a.runner.cancel(limit.id).ok).toBe(true);
    // A pending order whose cancel is in flight too: cancelled, never re-sent.
    const pending = submittedOrder(a.runner.submit(limitBuy('99.40', '1')));
    expect(a.runner.cancel(pending.id).ok).toBe(true);
    a.runner.stop();

    a.clock.advance(60_000);
    const b = setup({ db: a.db, clock: a.clock }); // not started: recovery alone
    for (const id of [limit.id, pending.id]) {
      expect(b.engine.state.orders.get(id)!.status).toBe('cancelled');
      expect(b.orderRow(id)!.status).toBe('cancelled');
    }
    expect(b.eventsOf('order_cancelled').map((e) => [e.payload.order.id, e.payload.reason, e.time])).toEqual([
      [limit.id, 'user', b.clock.now],
      [pending.id, 'user', b.clock.now],
    ]);
    expect(b.engine.state.balances.spot.USDT!.locked.toString()).toBe('0');
    b.runner.start();
    b.clock.advance(5000);
    expect(b.orderRow(pending.id)!.status).toBe('cancelled');
    expect(b.fatal).toEqual([]);
  });

  it('restart: a cancel in flight on an order that filled before the stop is recorded as too late during startup', () => {
    const a = setup();
    a.runner.start();
    a.runner.deposit('spot', D('1000'));
    const order = submittedOrder(a.runner.submit(limitBuy('99.50', '1')));
    a.clock.advance(100);
    a.runner.cancel(order.id);
    a.clock.advance(1);
    a.market.trade('BTCUSDT', trade('99.00', '5'));
    expect(a.orderRow(order.id)!.status).toBe('filled');
    a.runner.stop(); // before the cancel arrives
    expect(JSON.parse(a.orderRow(order.id)!.data).cancelArrivesAt).not.toBeNull();
    expect(a.eventsOf('cancel_rejected')).toEqual([]);

    a.clock.advance(60_000);
    const b = setup({ db: a.db, clock: a.clock });
    expect(b.eventsOf('cancel_rejected').map((e) => [e.time, e.symbol, e.payload.order.id, e.payload.reason])).toEqual([
      [b.clock.now, 'BTCUSDT', order.id, 'Cancel arrived too late: order already filled'],
    ]);
    expect(b.eventsOf('cancel_rejected')[0]!.payload.order.cancelArrivesAt).toBeNull();
    expect(JSON.parse(b.orderRow(order.id)!.data).cancelArrivesAt).toBeNull();
    expect(b.orderRow(order.id)!.status).toBe('filled');

    // Recorded once: a later restart finds nothing left to answer.
    const c = setup({ db: a.db, clock: a.clock });
    expect(c.eventsOf('cancel_rejected')).toHaveLength(1);
    expect(c.fatal).toEqual([]);
  });

  it('restart within the cancel delay: the cancel arrives at its own time', () => {
    const a = setup();
    a.runner.start();
    a.runner.deposit('spot', D('1000'));
    const order = submittedOrder(a.runner.submit(limitBuy('99.50', '1')));
    a.clock.advance(100);
    a.runner.cancel(order.id);
    const at = a.clock.now + 100;
    a.runner.stop();
    a.clock.advance(40);

    const b = setup({ db: a.db, clock: a.clock });
    expect(b.orderRow(order.id)!.status).toBe('open');
    b.clock.advance(at - b.clock.now - 1);
    expect(b.orderRow(order.id)!.status).toBe('open');
    b.clock.advance(1);
    expect(b.orderRow(order.id)!.status).toBe('cancelled');
  });

  it('restart before the rules load: a cancel that needs them waits, then is applied once the data is fresh', () => {
    const a = setup();
    a.runner.start();
    a.runner.deposit('spot', D('1000'));
    const order = submittedOrder(
      a.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'stop_loss', triggerPrice: '101', quoteQty: '50.5' }),
    );
    a.clock.advance(100);
    expect(a.runner.cancel(order.id).ok).toBe(true);
    a.runner.stop();
    a.clock.advance(60_000);

    const market = new TestMarket(SYMBOLS);
    market.clearRules('BTCUSDT');
    market.setFresh('BTCUSDT', false);
    const b = setup({ db: a.db, clock: a.clock, market });
    b.runner.start();
    b.clock.advance(5000);
    expect(b.fatal).toEqual([]);
    expect(b.orderRow(order.id)!.status).toBe('open');

    market.setRules('BTCUSDT', btcRules);
    market.setFresh('BTCUSDT', true);
    b.clock.advance(1000);
    expect(b.orderRow(order.id)!.status).toBe('cancelled');
    expect(b.eventsOf('order_cancelled').map((e) => [e.payload.reason, e.payload.cancelledQty])).toEqual([['user', '0.5']]);
    expect(b.fatal).toEqual([]);
  });

  it('restart before the rules load: a held-back pending order whose cancel reached the exchange is cancelled, not re-sent', () => {
    const a = setup();
    a.runner.start();
    a.runner.deposit('spot', D('1000'));
    const order = submittedOrder(
      a.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'stop_loss', triggerPrice: '101', quoteQty: '50.5' }),
    );
    expect(a.runner.cancel(order.id).ok).toBe(true); // still pending: arrives with its cancel at T0 + 100
    a.runner.stop();
    a.clock.advance(60_000);

    const market = new TestMarket(SYMBOLS);
    market.clearRules('BTCUSDT');
    market.setFresh('BTCUSDT', false);
    const b = setup({ db: a.db, clock: a.clock, market });
    b.runner.start();
    b.clock.advance(5000);
    expect(b.orderRow(order.id)!.status).toBe('pending');

    market.setRules('BTCUSDT', btcRules);
    market.setFresh('BTCUSDT', true);
    b.clock.advance(1000); // the first fresh poll
    expect(b.orderRow(order.id)!.status).toBe('cancelled');
    expect(b.eventsOf('order_cancelled').map((e) => [e.payload.reason, e.payload.cancelledQty])).toEqual([['user', '0.5']]);
    b.clock.advance(1000);
    expect(b.orderRow(order.id)!.status).toBe('cancelled');
    expect(b.eventsOf('order_rejected')).toEqual([]);
    expect(b.fatal).toEqual([]);
  });

  it('restart inside the delays: the cancel timer of a held-back order cancels it, not its stale old arrival', () => {
    const a = setup();
    a.runner.start();
    a.runner.deposit('spot', D('1000'));
    const order = submittedOrder(a.runner.submit(limitBuy('100.10', '1'))); // arrives at T0 + 100
    a.clock.advance(50);
    expect(a.runner.cancel(order.id).ok).toBe(true); // cancel arrives at T0 + 150
    a.runner.stop();

    const market = new TestMarket(SYMBOLS);
    market.setFresh('BTCUSDT', false);
    const b = setup({ db: a.db, clock: a.clock, market });
    b.runner.start();
    b.clock.advance(200);
    expect(b.orderRow(order.id)!.status).toBe('cancelled');
    expect(b.eventsOf('order_cancelled').map((e) => e.payload.reason)).toEqual(['user']);
    expect(b.eventsOf('order_rejected')).toEqual([]);
    market.setFresh('BTCUSDT', true);
    b.clock.advance(1000);
    expect(b.orderRow(order.id)!.status).toBe('cancelled');
    expect(b.eventsOf('fill')).toEqual([]);
    expect(b.fatal).toEqual([]);
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

  it('the first equity snapshot after a sleep is skipped: it would price the coins on the book from before the pause', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    t.clock.advance(59_000 - 300); // fresh polls every second, the last at T0 + 59 s
    const snaps = () => t.db.prepare('SELECT time FROM equity_snapshots').all() as { time: number }[];
    expect(snaps()).toEqual([]);
    t.clock.now += 28_800_000; // asleep: no timer runs
    t.clock.advance(0); // the overdue snapshot runs before the overdue poll
    expect(snaps()).toEqual([]);
    expect(t.health.stalls).toEqual([T0 + 59_000 + 28_800_000]);
    // The pause is recorded from the last poll before it (here closed at once by the overdue poll,
    // as this test market's data is fresh).
    expect(t.gaps()).toEqual([
      { startedAt: T0 + 59_000, endedAt: T0 + 59_000 + 28_800_000, reason: 'Server paused (sleep or freeze)' },
    ]);
    t.clock.advance(60_000); // the data is fresh: snapshots resume
    expect(snaps()).toEqual([{ time: T0 + 59_000 + 28_800_000 + 60_000 }]);
  });
});

describe('feed gaps', () => {
  const PAUSED = 'Server paused (sleep or freeze)';
  const lastAliveOf = (db: Db) => Number((db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as { value: string }).value);

  it('a poll more than 5 s after the previous one (sleep) opens a gap there, closed by the next poll that finds fresh data', () => {
    const t = setup();
    t.runner.start();
    t.clock.advance(10_000); // fresh polls every second, the last at T0 + 10 s
    t.clock.now += 5000; // a stall: the overdue poll runs 5 s after the previous one, not yet a pause
    t.clock.advance(0);
    expect(t.openGapRows()).toEqual([]);

    const T = t.clock.now; // that poll, the last before the PC sleeps
    t.clock.now += 28_800_000; // no timer runs while asleep
    t.clock.advance(0); // the overdue poll: the data looks fresh, but the server was paused
    expect(t.gaps()).toEqual([]);
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T, reason: PAUSED }]);
    t.market.trade('BTCUSDT', trade('99.95')); // processed, but only a poll ends a pause
    expect(t.gaps()).toEqual([]);

    t.clock.advance(1000); // the next poll finds the symbol fresh
    expect(t.gaps()).toEqual([{ startedAt: T, endedAt: T + 28_801_000, reason: PAUSED }]);
    expect(t.openGapRows()).toEqual([]);
    expect(t.notices()).toEqual([`Live data interrupted for BTCUSDT: ${PAUSED}`, 'Live data restored for BTCUSDT']);
  });

  it('a submit rejected on stale data that no poll or trade saw records the gap', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    t.clock.advance(1500); // the poll at T0 + 1 s finds the data fresh
    t.market.setFresh('BTCUSDT', false);
    const order = submittedOrder(t.runner.submit(marketBuy('1')));
    expect(order.rejectReason).toBe('Live data interrupted for BTCUSDT');
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 1000, reason: 'Disconnected' }]);
    t.market.setFresh('BTCUSDT', true);
    t.clock.advance(500); // the next poll finds it fresh again
    expect(t.gaps()).toEqual([{ startedAt: T0 + 1000, endedAt: T0 + 2000, reason: 'Disconnected' }]);
    expect(t.notices()).toContain('Live data interrupted for BTCUSDT: Disconnected');
  });

  it('a linked pair rejected on stale data that no poll or trade saw records the gap', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    t.clock.advance(1200); // the poll at T0 + 1 s finds the data fresh
    t.market.setFresh('BTCUSDT', false);
    const events = t.runner.attachOco({ symbol: 'BTCUSDT', qty: '0.5', stopLoss: '95', takeProfit: '110' });
    expect(events.map((e) => (e.type === 'order_rejected' ? e.reason : e.type))).toEqual([
      'Live data interrupted for BTCUSDT',
      'Live data interrupted for BTCUSDT',
    ]);
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 1000, reason: 'Disconnected' }]);
    t.market.setFresh('BTCUSDT', true);
    t.clock.advance(500);
    expect(t.gaps()).toEqual([{ startedAt: T0 + 1000, endedAt: T0 + 2000, reason: 'Disconnected' }]);
  });

  it('a silent connection: the gap starts at the last frame received, not at the poll that detects the silence', async () => {
    const s = await liveStack(T0);
    const T = s.clock.now; // the last frame: the depth update that synced the book
    s.clock.advance(15_000); // the polls keep finding the data fresh until T + 15 s
    expect(s.market.isFresh('BTCUSDT')).toBe(true);
    expect(openGapsOf(s.db)).toEqual([]);
    s.clock.advance(1000); // the poll at T + 16 s sees the silence
    expect(openGapsOf(s.db)).toEqual([{ symbol: 'BTCUSDT', startedAt: T, reason: 'Connection silent for 15s' }]);

    s.depth(102); // frames again; a current depth update ends the wait for the book
    s.clock.advance(1000);
    expect(gapsOf(s.db)).toEqual([{ startedAt: T, endedAt: T + 17_000, reason: 'Connection silent for 15s' }]);
    expect(openGapsOf(s.db)).toEqual([]);
  });

  it('a silence that ends before any poll sees it still starts the gap at its last frame', async () => {
    const s = await liveStack(T0);
    const T = s.clock.now; // the last frame before the silence
    s.clock.advance(15_000); // the polls up to T + 15 s still find the data fresh
    s.clock.advance(500);
    s.trade(2, '99.95'); // frames again at T + 15.5 s: the book may be old, so this trade is skipped
    expect(openGapsOf(s.db)).toEqual([
      { symbol: 'BTCUSDT', startedAt: T, reason: 'Waiting for order-book update after a silent connection' },
    ]);
    s.depth(102);
    s.clock.advance(500);
    expect(gapsOf(s.db)).toEqual([
      { startedAt: T, endedAt: T + 16_000, reason: 'Waiting for order-book update after a silent connection' },
    ]);
  });

  it('a halt on Binance (status BREAK) is a gap with the halt as its reason', async () => {
    const s = await liveStack(T0);
    const T = s.clock.now; // fresh at the poll when the runner started
    s.setTradingStatus('BREAK');
    await s.market.refreshRules();
    for (let i = 0; i < 6; i++) {
      s.ping(); // the connection itself stays alive
      s.clock.advance(5000);
    }
    expect(openGapsOf(s.db)).toEqual([{ symbol: 'BTCUSDT', startedAt: T, reason: 'Trading halted on Binance (BREAK)' }]);

    s.setTradingStatus('TRADING');
    await s.market.refreshRules();
    s.clock.advance(1000);
    expect(gapsOf(s.db)).toEqual([{ startedAt: T, endedAt: T + 31_000, reason: 'Trading halted on Binance (BREAK)' }]);
  });

  it.each([
    ['the next poll', 1000],
    ['the next processed trade', 250],
  ])('a stale stretch between two polls: a skipped trade opens a gap at once, closed by %s', (closer, endedAt) => {
    const t = setup();
    t.runner.start(); // fresh at the poll at T0
    t.market.setBook('BTCUSDT', {
      bids: [{ price: D('59100'), qty: D('1') }, { price: D('59000'), qty: D('1') }, { price: D('58900'), qty: D('5') }],
      asks: [{ price: D('59110'), qty: D('1') }, { price: D('59200'), qty: D('2') }],
    });
    t.market.setLastPrice('BTCUSDT', D('59100'));
    t.market.setAvgPrice('BTCUSDT', D('59100'));
    t.runner.deposit('spot', D('10000'));
    t.runner.submit(marketBuy('0.1'));
    t.clock.advance(100);
    const stop = submittedOrder(t.runner.submit(stopSell('0.05', '59000')));
    t.clock.advance(100);
    expect(t.orderRow(stop.id)!.status).toBe('open');

    // Lag on, a trade through the stop, lag off: all at T0 + 200, between the polls at T0 and T0 + 1 s.
    t.market.staleReason = 'Feed lagging by 6.0s';
    t.market.setFresh('BTCUSDT', false);
    t.market.trade('BTCUSDT', trade('58900'));
    t.market.setFresh('BTCUSDT', true);
    expect(t.orderRow(stop.id)!.status).toBe('open'); // the stale trade was skipped
    expect(t.engine.state.lastTradeId.BTCUSDT).toBeUndefined();
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0, reason: 'Feed lagging by 6.0s' }]);
    expect(t.gaps()).toEqual([]);

    if (closer === 'the next poll') {
      t.clock.advance(800);
    } else {
      t.clock.advance(50);
      const next = trade('59050');
      t.market.trade('BTCUSDT', next);
      // The cursor passes the skipped trade only in the transaction that records the gap.
      expect(t.db.prepare('SELECT last_trade_id AS id FROM trade_cursor').get()).toEqual({ id: next.id });
    }
    expect(t.gaps()).toEqual([{ startedAt: T0, endedAt: T0 + endedAt, reason: 'Feed lagging by 6.0s' }]);
    expect(t.openGapRows()).toEqual([]);
    expect(t.orderRow(stop.id)!.status).toBe('open');
    expect(t.fatal).toEqual([]);
  });

  it('crash while stale: the next start keeps the gap start saved in open_gaps, not the last heartbeat', () => {
    const a = setup();
    a.runner.start();
    a.clock.advance(2000); // fresh at the polls up to T0 + 2 s
    a.market.setFresh('BTCUSDT', false);
    a.clock.advance(3_598_000); // seen stale at T0 + 3 s; the heartbeat keeps writing until T0 + 3600 s
    expect(lastAliveOf(a.db)).toBe(T0 + 3_600_000);

    // The process dies: no stop(), and none of its timers runs again.
    const b = setup({ db: a.db, clock: new FakeClock(a.clock.now) });
    expect(b.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 2000, reason: 'Disconnected' }]);
    b.runner.start();
    expect(b.gaps()).toEqual([{ startedAt: T0 + 2000, endedAt: T0 + 3_600_000, reason: 'Disconnected' }]);
    expect(b.openGapRows()).toEqual([]);
  });

  it('a second crash during startup, before any fresh data, keeps the gap start from the first one', () => {
    const a = setup();
    a.runner.start();
    a.clock.advance(15_000); // fresh throughout; the last heartbeat at T0 + 10 s
    const L = T0 + 10_000;
    expect(lastAliveOf(a.db)).toBe(L);

    // Dies. Starts again at T0 + 60 s with no fresh data: the seed is saved before the first heartbeat.
    const stale = new TestMarket(SYMBOLS);
    stale.setFresh('BTCUSDT', false);
    const b = setup({ db: a.db, clock: new FakeClock(T0 + 60_000), market: stale });
    expect(b.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: L, reason: 'Server offline' }]);
    expect(lastAliveOf(a.db)).toBe(L);
    b.runner.start();
    b.clock.advance(3000);
    expect(lastAliveOf(a.db)).toBe(T0 + 60_000);

    // Dies again before the data was ever fresh; the third start still begins the gap at L.
    const c = setup({ db: a.db, clock: new FakeClock(T0 + 120_000) });
    c.runner.start();
    expect(c.gaps()).toEqual([{ startedAt: L, endedAt: T0 + 120_000, reason: 'Server offline' }]);
    expect(c.openGapRows()).toEqual([]);
  });

  it('a deferred triggered stop executes at the next fresh poll even when no poll saw the data stale, without a trade', () => {
    const t = setup();
    t.runner.start();
    withBtc(t);
    const order = submittedOrder(t.runner.submit(stopSell('0.5', '99')));
    t.clock.advance(100);
    t.market.trade('BTCUSDT', trade('98.90')); // triggered at T0 + 400, arriving at T0 + 500
    t.market.setFresh('BTCUSDT', false);
    t.clock.advance(100); // the arrival lands on stale data: deferred, and the gap opens there
    expect(JSON.parse(t.orderRow(order.id)!.data)).toMatchObject({ status: 'triggered', arrivesAt: null });
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 400, reason: 'Disconnected' }]);
    t.market.setFresh('BTCUSDT', true); // fresh again before any poll saw it stale

    t.clock.advance(499);
    expect(t.orderRow(order.id)!.status).toBe('triggered');
    t.clock.advance(1); // the poll at T0 + 1 s finds the data fresh, as the one before did
    expect(t.orderRow(order.id)!.status).toBe('filled');
    expect(t.gaps()).toEqual([{ startedAt: T0 + 400, endedAt: T0 + 1000, reason: 'Disconnected' }]);
    expect(t.fatal).toEqual([]);
  });

  it('a waiting attached pair arms at the next poll once a last price exists, with no gap and no trade', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    t.runner.submit({ ...marketBuy('1'), attach: { stopLoss: '95', takeProfit: '110' } });
    t.market.setLastPrice('BTCUSDT', null);
    t.clock.advance(200); // the buy fills at T0 + 100; its pair arrives at T0 + 200 with no last price
    const legs = t.runner.openOrders();
    expect(legs.map((o) => [o.status, o.arrivesAt])).toEqual([
      ['pending', null],
      ['pending', null],
    ]);
    t.market.setLastPrice('BTCUSDT', D('99.95'));
    t.clock.advance(800); // the poll at T0 + 1 s
    expect(t.runner.openOrders().map((o) => o.status)).toEqual(['open', 'open']);
    expect(t.gaps()).toEqual([]);
  });

  it('crash after only an arrival saw stale data: the next start keeps the gap start that arrival saved', () => {
    const a = setup();
    a.runner.start();
    withBtc(a);
    const order = submittedOrder(a.runner.submit(stopSell('0.5', '99')));
    a.clock.advance(9500); // T0 + 9.8 s: the stop armed, fresh polls up to T0 + 9 s
    a.market.trade('BTCUSDT', trade('98.90')); // triggered at T0 + 9800, arriving at T0 + 9900
    a.market.setFresh('BTCUSDT', false);
    a.clock.advance(150); // the arrival sees stale data; no poll has yet
    expect(a.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 9800, reason: 'Disconnected' }]);
    touchAlive(a.db, T0 + 10_000); // the heartbeat at T0 + 10 s; the process dies before the next poll

    const b = setup({ db: a.db, clock: new FakeClock(T0 + 60_000) });
    b.runner.start();
    expect(b.gaps()).toEqual([{ startedAt: T0 + 9800, endedAt: T0 + 60_000, reason: 'Disconnected' }]);
    expect(b.orderRow(order.id)!.status).toBe('filled');
  });

  it('a pause while a gap is open: that gap then closes only at a poll, not at a trade', () => {
    const t = setup();
    t.runner.start();
    t.clock.advance(1000);
    t.market.setFresh('BTCUSDT', false);
    t.clock.advance(1000); // seen stale at T0 + 2 s: the gap starts at T0 + 1 s
    t.market.setFresh('BTCUSDT', true);
    t.clock.now += 60_000; // paused before any poll saw the data fresh again
    t.clock.advance(0); // the overdue poll at T0 + 62 s
    expect(t.health.stalls).toEqual([T0 + 62_000]);
    t.market.trade('BTCUSDT', trade('99.95'));
    expect(t.gaps()).toEqual([]);
    t.clock.advance(1000);
    expect(t.gaps()).toEqual([{ startedAt: T0 + 1000, endedAt: T0 + 63_000, reason: 'Disconnected' }]);
  });

  it('a stall seen first by a trade is handled once: pause gap from the last poll, health told once', () => {
    const t = setup();
    t.runner.start();
    t.clock.advance(1000); // the last poll before the stall, at T0 + 1 s
    t.clock.now += 8000;
    t.market.trade('BTCUSDT', trade('99.95')); // the trade listener runs before the overdue poll
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 1000, reason: 'Server paused (sleep or freeze)' }]);
    t.clock.advance(0); // the overdue poll: the stall is already handled
    expect(t.health.stalls).toEqual([T0 + 9000]);
    expect(t.notices().filter((n) => n.startsWith('Live data interrupted'))).toHaveLength(1);
  });

  it('a wall clock stepping back never puts a gap start after its detection', () => {
    const t = setup();
    t.runner.start(); // fresh at T0
    t.health.lastFrame = T0; // the last frame received
    t.clock.now = T0 - 60_000; // the wall clock steps back a minute
    t.market.setFresh('BTCUSDT', false);
    t.market.trade('BTCUSDT', trade('99.95')); // skipped: the gap opens now
    expect(t.openGapRows()).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 - 60_000, reason: 'Disconnected' }]);
  });
});
