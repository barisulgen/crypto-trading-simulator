import { describe, expect, it } from 'vitest';
import { D } from '@sim/engine';
import type { AggTrade, Candle1m, PerpOrderRequest, SpotOrderRequest } from '@sim/engine';
import { futuresRequestWeight, FuturesRest } from '../src/binance/futuresRest.ts';
import { BinanceRest } from '../src/binance/rest.ts';
import { PauseController } from '../src/binance/restCore.ts';
import type { AggTradesQuery } from '../src/binance/restCore.ts';
import type { Lane } from '../src/binance/weightBudget.ts';
import { CATCHING_UP_REFUSAL } from '../src/catchup/catchUpService.ts';
import { BinanceHistory, PAGE } from '../src/catchup/history.ts';
import type { CatchUpHistory } from '../src/catchup/history.ts';
import type { Db } from '../src/db/db.ts';
import { loadJobs } from '../src/db/store.ts';
import { FUNDING_POLL_MS, FundingService } from '../src/funding/fundingService.ts';
import type { FundingRateQuery } from '../src/binance/futuresRest.ts';
import { marketKey } from '../src/market/marketKey.ts';
import { submittedOrder } from '../src/runner.ts';
import { FakeClock, FakeHistory, runnerHarness, settle } from './helpers.ts';

/** 2026-10-24 12:00:00 UTC, a minute boundary. */
const T = Date.UTC(2026, 9, 24, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const SYMBOL = 'BTCUSDT';
const SPOT = marketKey('spot', SYMBOL);
const PERP = marketKey('perp', SYMBOL);

function candle(at: number, low: string, high: string): Candle1m {
  return { openTime: at, open: D(high), high: D(high), low: D(low), close: D(low) };
}

/** One candle per minute from the minute of `from` to the minute of `to`, `low`–`high`, with the given minutes replaced. */
function minutes(from: number, to: number, low: string, high: string, overrides: Candle1m[] = []): Candle1m[] {
  const out: Candle1m[] = [];
  for (let at = Math.floor(from / MIN) * MIN; at <= to; at += MIN) {
    out.push(overrides.find((c) => c.openTime === at) ?? candle(at, low, high));
  }
  return out;
}

const trade = (id: number, price: string, qty: string, sellerInitiated = false, time = 0): AggTrade => ({
  id,
  price: D(price),
  qty: D(qty),
  sellerInitiated,
  time,
});

const stopSell = (qty: string, triggerPrice: string): SpotOrderRequest => ({ symbol: SYMBOL, side: 'sell', type: 'stop_loss', qty, triggerPrice });
const limit = (side: 'buy' | 'sell', price: string, qty: string): SpotOrderRequest => ({ symbol: SYMBOL, side, type: 'limit', price, qty });
const perpLimit = (side: 'buy' | 'sell', price: string, qty: string): PerpOrderRequest => ({ symbol: SYMBOL, side, type: 'limit', price, qty });

/** runnerHarness over a FakeHistory (unless given another history) and a clock at 12:00:00. */
type FundingHooks = { knownTimes(symbol: string): number[]; caughtUp(symbol: string): void };

function setup(opts: { db?: Db; clock?: FakeClock; history?: CatchUpHistory; funding?: FundingHooks } = {}) {
  const history = opts.history ?? new FakeHistory();
  const t = runnerHarness({ db: opts.db, clock: opts.clock ?? new FakeClock(T), history, funding: opts.funding });
  const jobs = () => loadJobs(t.db, t.seasonId);
  const fillsOf = (orderId: string) =>
    t.db.prepare('SELECT qty, price, time FROM fills WHERE order_id = ? ORDER BY rowid').all(orderId) as {
      qty: string;
      price: string;
      time: number;
    }[];
  const fake = history instanceof FakeHistory ? history : new FakeHistory();
  return { ...t, history: fake, jobs, fillsOf };
}

type Setup = ReturnType<typeof setup>;

/**
 * Started at 12:00:00; 1 BTC bought (0.999 held), a 0.5 BTC sell stop at 99 armed, plus the given
 * limit orders, all arrived by 12:00:00.200.
 */
function withStop(t: Setup, limits: SpotOrderRequest[] = []) {
  t.runner.start();
  t.runner.deposit('spot', D('1000'));
  t.runner.submit({ symbol: SYMBOL, side: 'buy', type: 'market', qty: '1' });
  t.clock.advance(100);
  const stop = submittedOrder(t.runner.submit(stopSell('0.5', '99')));
  const orders = limits.map((l) => submittedOrder(t.runner.submit(l)));
  t.clock.advance(100);
  expect(t.engine.state.orders.get(stop.id)!.status).toBe('open');
  return { stop, orders };
}

/** Spot data stale from 12:00:00.200, seen at the poll at 12:00:01, for `ms`. */
function spotGap(t: Setup, ms: number) {
  t.market.setFresh(SYMBOL, false);
  t.clock.advance(ms);
}

/** The spot candles of the gap: quiet (99.5–100), 12:04 down to 98.8. */
const spotCandles = (to: number) => minutes(T - MIN, to, '99.5', '100', [candle(T + 4 * MIN, '98.8', '100')]);

describe('catch-up: spot', () => {
  it('a stop-loss across a 10-min gap is filled by the job; live trades held during the run go through afterwards, in order', async () => {
    const t = setup();
    const { stop, orders } = withStop(t, [limit('sell', '100.25', '0.1'), limit('sell', '100.35', '0.1')]);
    const [a, b] = [orders[0]!, orders[1]!];
    spotGap(t, 10 * MIN); // stale since the poll at 12:00:00
    expect(t.runner.gate(SPOT)).toBe('stale');
    t.history.candleList[SPOT] = spotCandles(T + 11 * MIN);
    const release = t.history.hold();
    t.market.setFresh(SYMBOL, true);
    t.clock.advance(1000); // the poll at 12:10:01 finds it fresh
    const to = T + 601_000;
    expect(t.runner.gate(SPOT)).toBe('catching_up');
    expect(t.jobs()).toEqual([
      expect.objectContaining({ market: 'spot', symbol: SYMBOL, status: 'pending', startedAt: T - 5000, endedAt: to }),
    ]);
    expect(t.eventsOf('feed_gap').map((e) => e.payload)).toEqual([
      { startedAt: T, endedAt: to, reason: 'Disconnected', lastTradeIdBefore: null },
    ]);

    // While catching up: nothing trades on BTCUSDT spot, and live trades are held.
    expect(() => t.runner.submit(limit('buy', '90', '0.1'))).toThrow(CATCHING_UP_REFUSAL);
    expect(() => t.runner.cancel(a.id)).toThrow(CATCHING_UP_REFUSAL);
    t.market.trade(SYMBOL, trade(500, '100.30', '0.05'));
    t.market.trade(SYMBOL, trade(501, '100.40', '1'));
    expect(t.fillsOf(a.id)).toEqual([]);
    expect(t.engine.state.lastTradeId.BTCUSDT).toBeUndefined();

    release();
    await settle();
    expect(t.runner.gate(SPOT)).toBe('live');
    // Candles from one lag allowance before the gap; no trades needed (no limit was crossed).
    expect(t.history.calls).toEqual([`candles spot:BTCUSDT ${T - 5000} ${to}`]);
    // The stop: filled by the job at the worst price of 12:04, dated then.
    expect(t.fillsOf(stop.id)).toEqual([{ qty: '0.5', price: '98.8', time: T + 4 * MIN }]);
    // Then the held trades, in order: 500 fills 0.05 of the first limit, 501 the rest of it and the second.
    expect(t.fillsOf(a.id).map((f) => f.qty)).toEqual(['0.05', '0.05']);
    expect(t.fillsOf(b.id).map((f) => f.qty)).toEqual(['0.1']);
    expect(t.engine.state.lastTradeId.BTCUSDT).toBe(501);
    const fills = t.eventsOf('fill').map((e) => e.payload.order.id);
    expect(fills.indexOf(stop.id)).toBeLessThan(fills.indexOf(a.id));
    expect(t.jobs()).toEqual([expect.objectContaining({ status: 'done', endTradeId: 500, doneAt: t.clock.now, attempts: 0 })]);

    // One summary event, and one notice from it.
    const line = 'Stop-loss filled 0.5 BTC at 98.8 (worst price of 12:04 UTC; estimated)';
    expect(t.eventsOf('catch_up').map((e) => [e.symbol, e.payload.actions])).toEqual([[SYMBOL, [line]]]);
    expect(t.notices()).toContain(`Caught up BTCUSDT after the data gap 11:59–12:10 UTC: ${line}`);
    expect(t.notices().filter((n) => n.startsWith('Sold 0.5'))).toEqual([]); // the estimated fill reads only in the summary
    expect(t.fatal).toEqual([]);
  });

  it('with nothing open, a closing gap creates no job: onFresh runs and the key is live at once', () => {
    const t = setup();
    t.runner.start();
    t.runner.deposit('spot', D('1000'));
    spotGap(t, 10 * MIN);
    t.market.setFresh(SYMBOL, true);
    t.clock.advance(1000);
    expect(t.runner.gate(SPOT)).toBe('live');
    expect(t.jobs()).toEqual([]);
    expect(t.history.calls).toEqual([]);
    expect(t.eventsOf('feed_gap')).toHaveLength(1);
  });

  it('overlapping gaps around a restart: the pending job is extended over the startup gap, one job, one fill', async () => {
    const a = setup();
    const { stop } = withStop(a);
    spotGap(a, 10 * MIN);
    a.history.hold(); // never released: the process dies with its run in flight
    a.market.setFresh(SYMBOL, true);
    a.clock.advance(1000); // 12:10:01: catching up
    expect(a.runner.gate(SPOT)).toBe('catching_up');
    a.clock.advance(4000); // the last heartbeat at 12:10:00, before the gap's end; dies at 12:10:05

    const b = setup({ db: a.db, clock: new FakeClock(T + 20 * MIN) });
    b.history.candleList[SPOT] = spotCandles(T + 20 * MIN);
    b.runner.start(); // the startup gap from 12:10:00 overlaps the pending job by 6 s (with the lag allowance 11 s)
    await settle();
    expect(b.jobs()).toEqual([expect.objectContaining({ status: 'done', startedAt: T - 5000, endedAt: T + 20 * MIN })]);
    expect(b.history.calls).toEqual([`candles spot:BTCUSDT ${T - 5000} ${T + 20 * MIN}`]);
    expect(b.fillsOf(stop.id)).toEqual([{ qty: '0.5', price: '98.8', time: T + 4 * MIN }]);
    expect(b.eventsOf('catch_up')).toHaveLength(1);
    expect(b.fatal).toEqual([]);
  });

  it('crash right after the catch-up commit: a restart finds the job done and the fill once; the next job starts at its end', async () => {
    const a = setup();
    const { stop } = withStop(a, [limit('buy', '50', '0.1')]); // a far limit stays open across both gaps
    spotGap(a, 10 * MIN);
    a.history.candleList[SPOT] = spotCandles(T + 11 * MIN);
    a.market.setFresh(SYMBOL, true);
    a.clock.advance(1000);
    await settle();
    expect(a.fillsOf(stop.id)).toHaveLength(1);
    const [first] = a.jobs();
    expect(first).toMatchObject({ status: 'done', endedAt: T + 601_000 });
    a.clock.advance(4000); // dies at 12:10:05; the last heartbeat at 12:10:00

    const b = setup({ db: a.db, clock: new FakeClock(T + 15 * MIN) });
    b.history.candleList[SPOT] = spotCandles(T + 15 * MIN); // the same history, 12:04 still in it
    b.runner.start();
    await settle();
    expect(b.engine.state.orders.has(stop.id)).toBe(false); // finished: not loaded again
    expect(b.fillsOf(stop.id)).toHaveLength(1);
    // The startup gap (from 12:09:55 with the lag allowance) is clipped to the done job's end.
    expect(b.jobs()).toEqual([
      expect.objectContaining({ id: first!.id, status: 'done', endedAt: T + 601_000 }),
      expect.objectContaining({ status: 'done', startedAt: T + 601_000, endedAt: T + 15 * MIN }),
    ]);
    expect(b.history.calls).toEqual([`candles spot:BTCUSDT ${T + 601_000} ${T + 15 * MIN}`]);
    expect(b.fatal).toEqual([]);
  });

  it('a REST failure (429) is retried after 5, 10, then 20 s with attempts and the error recorded; orders on that coin are refused meanwhile', async () => {
    const t = setup();
    withStop(t);
    spotGap(t, 10 * MIN);
    t.history.candleList[SPOT] = spotCandles(T + 11 * MIN);
    for (let i = 0; i < 3; i++) t.history.failures.push(new Error('Binance /api/v3/klines HTTP 429: '));
    t.market.setFresh(SYMBOL, true);
    t.clock.advance(1000);
    await settle();
    const job = () => t.jobs()[0]!;
    expect(job()).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Binance /api/v3/klines HTTP 429: ' });
    expect(t.logs.some((l) => l.includes('Catch-up of BTCUSDT failed (attempt 1): Binance /api/v3/klines HTTP 429: ; retrying in 5s'))).toBe(true);

    expect(() => t.runner.submit(limit('buy', '90', '0.1'))).toThrow(CATCHING_UP_REFUSAL);
    // The gate is per market and symbol: the perp market of the coin trades on.
    expect(t.runner.gate(PERP)).toBe('live');
    expect(t.runner.catchingUp()).toEqual([SPOT]);
    expect(t.runner.healthSnapshot().BTCUSDT).toEqual({ fresh: true, reason: null, catchingUp: true });
    const health = t.sent.filter((m) => m.type === 'health').at(-1)!;
    expect(health.catchingUp).toEqual([SPOT]);

    const step = async (ms: number) => {
      t.clock.advance(ms);
      await settle();
    };
    await step(4999);
    expect(job().attempts).toBe(1);
    await step(1); // 5 s
    expect(job().attempts).toBe(2);
    await step(9999);
    expect(job().attempts).toBe(2);
    await step(1); // 10 s more
    expect(job().attempts).toBe(3);
    expect(t.runner.gate(SPOT)).toBe('catching_up');
    await step(19_999);
    expect(job().status).toBe('pending');
    await step(1); // 20 s more: succeeds
    expect(job()).toMatchObject({ status: 'done', attempts: 3 });
    expect(t.runner.gate(SPOT)).toBe('live');
    expect(t.eventsOf('catch_up')).toHaveLength(1);
    expect(t.runner.healthSnapshot().BTCUSDT).toEqual({ fresh: true, reason: null });
  });

  it('held-back trades past 10 minutes are dropped: the job then runs to that moment and the next trade bounds its replay', async () => {
    const t = setup();
    withStop(t, [limit('buy', '99.2', '0.1')]);
    spotGap(t, 5 * MIN);
    t.history.candleList[SPOT] = minutes(T - MIN, T + 20 * MIN, '99.5', '100', [candle(T + 3 * MIN, '99.1', '100')]);
    t.history.tradeList[SPOT] = [trade(300, '99.15', '1', true, T + 3 * MIN + 10_000)];
    const release = t.history.hold();
    t.market.setFresh(SYMBOL, true);
    t.clock.advance(1000);
    expect(t.runner.gate(SPOT)).toBe('catching_up');
    t.market.trade(SYMBOL, trade(600, '100', '0.1'));
    t.clock.advance(10 * MIN);
    const overflowAt = t.clock.now;
    t.market.trade(SYMBOL, trade(601, '100', '0.1')); // 10 min after the first held trade: all dropped
    expect(t.jobs()[0]).toMatchObject({ status: 'pending', endedAt: overflowAt });
    expect(t.logs.some((l) => l.includes('1 live trades held back while catching up; dropped'))).toBe(true);
    release();
    await settle();
    expect(t.jobs()).toEqual([expect.objectContaining({ status: 'done', endedAt: overflowAt, endTradeId: 601 })]);
    // The run fetched again for the longer interval, and replayed the gap's trade (300 < 601).
    expect(t.history.calls.filter((c) => c.startsWith('candles'))).toEqual([
      `candles spot:BTCUSDT ${T - 5000} ${T + 301_000}`,
      `candles spot:BTCUSDT ${T - 5000} ${overflowAt}`,
    ]);
    expect(t.engine.state.lastTradeId.BTCUSDT).toBe(601);
  });

  it('a run is applied in one transaction with its job: a job no longer pending is never applied, and nothing is written', async () => {
    const t = setup();
    const { stop } = withStop(t);
    spotGap(t, 10 * MIN);
    t.history.candleList[SPOT] = spotCandles(T + 11 * MIN);
    const release = t.history.hold();
    t.market.setFresh(SYMBOL, true);
    t.clock.advance(1000);
    t.db.prepare("UPDATE catchup_jobs SET status = 'done'").run(); // as if it had been applied already
    release();
    await settle();
    expect(t.fatal).toHaveLength(1);
    expect(t.fillsOf(stop.id)).toEqual([]);
    expect(t.eventsOf('catch_up')).toEqual([]);
    expect(t.orderRow(stop.id)!.status).toBe('open');
  });

  it('a gap closing only at a poll (after a pause) holds the fresh trades meanwhile for the run, so the cursor never skips the gap', async () => {
    const t = setup();
    withStop(t, [limit('buy', '99.2', '0.1')]);
    t.clock.now += 8000; // a pause: no timer ran
    t.market.trade(SYMBOL, trade(700, '100', '0.1')); // fresh, but the pause's gap closes only at a poll
    expect(t.runner.gate(SPOT)).toBe('stale');
    expect(t.engine.state.lastTradeId.BTCUSDT).toBeUndefined();
    t.history.candleList[SPOT] = minutes(T - MIN, T + MIN, '99.5', '100', [candle(T, '99.1', '100')]);
    t.history.tradeList[SPOT] = [trade(650, '99.15', '1', true, T + 5000)];
    t.clock.advance(1000); // the poll: fresh, the gap closes
    await settle();
    const [job] = t.jobs();
    expect(job).toMatchObject({ status: 'done', endTradeId: 700 });
    const limitId = t.eventsOf('order_placed').find((e) => e.payload.order.type === 'limit')!.payload.order.id;
    expect(t.fillsOf(limitId).map((f) => [f.qty, f.price])).toEqual([['0.1', '99.2']]); // replayed trade 650
    expect(t.engine.state.lastTradeId.BTCUSDT).toBe(700);
  });
});

/** Started at 12:00:00 with 1000 USDT in the leverage wallet and a long 0.1 at 80000 (margin 396). */
function withLong(t: Setup) {
  t.runner.start();
  t.runner.deposit('leverage', D('1000'));
  t.runner.submitPerp({ symbol: SYMBOL, side: 'buy', type: 'market', qty: '0.1' });
  t.clock.advance(100);
  expect(t.sim.perp.state.positions.BTCUSDT!.margin.toString()).toBe('396');
}

describe('catch-up: perps', () => {
  it('a 50 h gap cancels the perp limits at its start (no trades fetched), and still applies funding and the mark-candle liquidation', async () => {
    const a = setup();
    withLong(a);
    a.runner.submitPerp(perpLimit('buy', '70000', '0.05'));
    a.clock.advance(100);
    a.runner.stop(); // the last heartbeat at 12:00:00

    const history = new FakeHistory();
    history.markList.BTCUSDT = [candle(T + 20 * HOUR, '76340', '80000')];
    // The last price went through the limit at 14:00: catchUpNeeds asks for that minute, but the
    // futures trades of a gap starting over 47 h ago are gone, so none is fetched.
    history.candleList[PERP] = [candle(T + 2 * HOUR, '69000', '80000')];
    history.settlements.BTCUSDT = [{ time: T + 8 * HOUR, rate: D('0.0001'), markPrice: D('79000') }];
    const release = history.hold();
    const b = setup({ db: a.db, clock: new FakeClock(T + 50 * HOUR), history });
    b.runner.start();
    expect(b.runner.gate(PERP)).toBe('catching_up');
    expect(b.runner.gate(SPOT)).toBe('live'); // nothing open on spot: no job
    expect(() => b.runner.setLeverage(SYMBOL, 10)).toThrow(CATCHING_UP_REFUSAL);
    expect(() => b.runner.setMarginMode(SYMBOL, 'isolated')).toThrow(CATCHING_UP_REFUSAL);
    expect(() => b.runner.addMargin(SYMBOL, '10')).toThrow(CATCHING_UP_REFUSAL);
    expect(() => b.runner.removeMargin(SYMBOL, '10')).toThrow(CATCHING_UP_REFUSAL);
    expect(() => b.runner.setPositionTpSl(SYMBOL, { stopLoss: '70000' })).toThrow(CATCHING_UP_REFUSAL);
    expect(() => b.runner.submitPerp(perpLimit('buy', '60000', '0.01'))).toThrow(CATCHING_UP_REFUSAL);
    release();
    await settle();

    const from = T - 5000;
    expect(b.history.calls.some((c) => c.startsWith('trades') || c.startsWith('latest'))).toBe(false);
    const [cancelled] = b.eventsOf('order_cancelled');
    expect(cancelled).toMatchObject({ time: from, payload: { reason: 'catch_up_unavailable', catchUp: { from, basis: 'history_unavailable' } } });
    expect(b.eventsOf('funding').map((e) => [e.time, e.payload.amount])).toEqual([[T + 8 * HOUR + 15_000, '-0.79']]);
    expect(b.eventsOf('liquidation').map((e) => [e.time, e.payload.markPrice])).toEqual([[T + 20 * HOUR, '76353.31325301']]);
    expect(b.sim.perp.state.positions.BTCUSDT).toBeUndefined();
    expect(b.jobs()).toEqual([expect.objectContaining({ market: 'perp', status: 'done', startedAt: from, endedAt: T + 50 * HOUR })]);
    const notice = b.notices().find((n) => n.startsWith('Caught up BTCUSDT perp'))!;
    expect(notice).toContain('Futures trade history covers only 2 days; open limit orders were cancelled');
    expect(notice).toContain('Long 0.1 BTC liquidated at 76353.31325301');
    expect(b.runner.gate(PERP)).toBe('live');
    expect(b.fatal).toEqual([]);
  });

  it('a mark held back during the run past the liquidation price liquidates after it, at the liquidation price as the mark (the catch-up split)', async () => {
    const t = setup();
    withLong(t);
    t.perp.setFresh(SYMBOL, false);
    t.clock.advance(2 * MIN);
    t.history.markList.BTCUSDT = minutes(T - MIN, T + 3 * MIN, '79995', '80005');
    const release = t.history.hold();
    t.perp.setFresh(SYMBOL, true);
    t.clock.advance(1000);
    expect(t.runner.gate(PERP)).toBe('catching_up');
    t.perp.mark(SYMBOL, '70000'); // far past the liquidation price 76345.38…
    t.perp.mark(SYMBOL, '80500');
    expect(t.sim.perp.state.positions.BTCUSDT).toBeDefined(); // not applied while catching up
    release();
    await settle();
    const [liq] = t.eventsOf('liquidation');
    expect(t.eventsOf('liquidation')).toHaveLength(1);
    // As catch-up liquidates on a mark candle: the liquidation price as the mark, not the extreme.
    expect(liq!.payload).toMatchObject({
      markPrice: '76345.3815261',
      tradingLoss: '365.46184739',
      liquidationFee: '30.53815261',
      remainder: '0',
      marginLost: '396',
    });
    expect(liq!.payload.catchUp).toBeUndefined();
    expect(t.sim.perp.state.positions.BTCUSDT).toBeUndefined();
    expect(t.notices().some((n) => n.startsWith('LIQUIDATED: BTCUSDT long 0.1 at mark 76345.4'))).toBe(true);
  });

  it('weight: a 30-min gap with one limit touched in 3 minutes makes exactly 3 aggTrades calls (60 weight), all in the gap', async () => {
    const clock = new FakeClock(T);
    const touched = [T + 5 * MIN, T + 12 * MIN, T + 20 * MIN];
    const urls: string[] = [];
    const json = (body: unknown) =>
      ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' }) as unknown as Response;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const q = (k: string) => Number(u.searchParams.get(k));
      if (u.pathname === '/fapi/v1/klines' || u.pathname === '/fapi/v1/markPriceKlines') {
        const rows: unknown[] = [];
        for (let at = Math.floor(q('startTime') / MIN) * MIN; at <= q('endTime') && rows.length < q('limit'); at += MIN) {
          const low = u.pathname === '/fapi/v1/klines' && touched.includes(at) ? '78900' : '79500';
          rows.push([at, '80000', '80100', low, '80000', '1', at + MIN - 1]);
        }
        return json(rows);
      }
      if (u.pathname === '/fapi/v1/aggTrades') {
        const start = q('startTime');
        const i = touched.indexOf(start);
        const price = start === touched[2] ? '78950' : '79100';
        return json([{ a: 700 + i, p: price, q: '0.05', f: 1, l: 1, T: start + 1000, m: true }]);
      }
      if (u.pathname === '/fapi/v1/fundingRate') return json([]);
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const pause = new PauseController(() => clock.now);
    const futures = new FuturesRest(fetchImpl, () => clock.now, { setTimer: clock.setTimer, pause });
    const spot = new BinanceRest(fetchImpl, () => clock.now, { setTimer: clock.setTimer, pause });
    const t = setup({ clock, history: new BinanceHistory(spot, futures) });
    t.runner.start();
    t.runner.deposit('leverage', D('1000'));
    t.runner.submitPerp(perpLimit('buy', '79000', '0.05'));
    t.clock.advance(100);
    t.perp.setFresh(SYMBOL, false);
    t.clock.advance(30 * MIN);
    t.perp.setFresh(SYMBOL, true);
    t.perp.trade(SYMBOL, trade(9000, '80000', '0.01')); // closes the gap: the first trade after it, held
    expect(t.runner.gate(PERP)).toBe('catching_up');
    await settle(60);
    expect(t.runner.gate(PERP)).toBe('live');

    const agg = urls.map((u) => new URL(u)).filter((u) => u.pathname === '/fapi/v1/aggTrades');
    expect(agg.map((u) => Number(u.searchParams.get('startTime')))).toEqual(touched);
    expect(agg.reduce((w, u) => w + futuresRequestWeight(u.pathname, u.search.slice(1)), 0)).toBe(60);
    expect(t.jobs()).toEqual([expect.objectContaining({ status: 'done', endTradeId: 9000 })]);
    expect(t.sim.perp.state.positions.BTCUSDT!.qty.toString()).toBe('0.05'); // filled by the replayed trade at 12:20:01
    futures.dispose();
    spot.dispose();
  });
});

/** A fundingRate endpoint the test scripts: each poll takes the next answer (none left: an empty list). */
function fakeFundingRest() {
  const answers: unknown[][] = [];
  const calls: FundingRateQuery[] = [];
  return {
    answers,
    calls,
    rest: {
      fundingRate: async (q: FundingRateQuery) => {
        calls.push(q);
        return answers.shift() ?? [];
      },
    },
  };
}

/** A runner and a FundingService over it, bound to each other as main.ts binds them. */
function withFunding(opts: { db?: Db; clock: FakeClock; history?: FakeHistory }) {
  let funding: FundingService | null = null;
  const hooks = { knownTimes: (s: string) => funding!.knownTimes(s), caughtUp: (s: string) => funding!.caughtUp(s) };
  const t = setup({ db: opts.db, clock: opts.clock, history: opts.history, funding: hooks });
  const f = fakeFundingRest();
  funding = new FundingService({ rest: f.rest, sim: t.runner, market: t.perp, now: () => t.clock.now, setTimer: t.clock.setTimer, logger: t.logger });
  const run = async (ms: number) => {
    const end = t.clock.now + ms;
    while (t.clock.now < end) {
      t.clock.advance(Math.min(1000, end - t.clock.now));
      await settle(5);
    }
  };
  return { ...t, funding, f, run };
}

describe('catch-up and funding windows', () => {
  const FT = T + 10 * MIN; // a funding time
  const settled = (markPrice = '80000') => [{ symbol: SYMBOL, fundingTime: FT, fundingRate: '0.0001', markPrice }];

  it('a gap ending inside [T − 15 s, T) opens T’s window at T − 15 s on the size then, widened by the gap’s fills; settled once, live', async () => {
    const t = withFunding({ clock: new FakeClock(T) });
    withLong(t);
    t.runner.submitPerp(perpLimit('buy', '79000', '0.05'));
    t.funding.start();
    t.perp.mark(SYMBOL, '80000', FT); // the mark stream names the funding time
    await t.run(FT - 2 * MIN - t.clock.now);
    t.perp.setFresh(SYMBOL, false); // a gap from 12:08 to 12:09:55
    t.history.candleList[PERP] = minutes(FT - 3 * MIN, FT, '79500', '80100', [candle(FT - MIN, '78900', '80100')]);
    t.history.markList.BTCUSDT = minutes(FT - 3 * MIN, FT, '79995', '80005');
    t.history.tradeList[PERP] = [trade(800, '78950', '0.05', true, FT - 10_000)];
    t.history.latest[PERP] = 900;
    await t.run(2 * MIN - 5000);
    expect(t.sim.perp.state.funding.windows.BTCUSDT).toBeUndefined(); // its open at T − 15 s waited for catch-up
    t.perp.setFresh(SYMBOL, true);
    await t.run(1000); // the poll at 12:09:56: fresh, catching up, applied
    expect(t.runner.gate(PERP)).toBe('live');
    const w = t.sim.perp.state.funding.windows.BTCUSDT!;
    expect([w.fundingTime, w.long.max.toString(), w.long.min.toString()]).toEqual([FT, '0.15', '0.1']);
    expect(t.jobs()).toEqual([expect.objectContaining({ status: 'done', endTradeId: 901 })]);

    t.f.answers.push(settled());
    await t.run(15_000 + FUNDING_POLL_MS + 5000);
    expect(t.eventsOf('funding').map((e) => [e.payload.qty, e.payload.amount, e.payload.catchUp])).toEqual([['0.15', '-1.2', undefined]]);
    await t.run(FUNDING_POLL_MS * 3);
    expect(t.eventsOf('funding')).toHaveLength(1);
    expect(t.fatal).toEqual([]);
  });

  it('a window a run left open for the live path is closed and settled once, though the funding service never saw its time', async () => {
    const a = withFunding({ clock: new FakeClock(FT - 40_000) });
    withLong(a);
    a.runner.stop(); // the last heartbeat at 12:09:20

    const history = new FakeHistory();
    history.markList.BTCUSDT = minutes(FT - 2 * MIN, FT, '79995', '80005');
    history.settlements.BTCUSDT = [{ time: FT, rate: D('0.0001'), markPrice: D('80000') }];
    const b = withFunding({ db: a.db, clock: new FakeClock(FT + 5000), history });
    b.runner.start();
    b.funding.start();
    b.perp.mark(SYMBOL, '80000', FT + 8 * HOUR); // the mark stream names only the next funding time
    await settle();
    // The run's gap ends inside the window: left open, for the live path to close on time.
    expect(b.sim.perp.state.funding.windows.BTCUSDT?.fundingTime).toBe(FT);
    expect(b.eventsOf('funding')).toEqual([]);
    b.f.answers.push(settled());
    await b.run(10_000 + FUNDING_POLL_MS + 5000);
    expect(b.sim.perp.state.funding.windows.BTCUSDT).toBeUndefined();
    expect(b.eventsOf('funding').map((e) => [e.payload.fundingTime, e.payload.qty, e.payload.amount])).toEqual([[FT, '0.1', '-0.8']]);
    await b.run(FUNDING_POLL_MS * 3);
    expect(b.eventsOf('funding')).toHaveLength(1);
    expect(b.f.calls).toHaveLength(1);
  });

  it('a window inside the gap with no settlement published yet: the run opens and closes it at its times, then it is polled until settled, once', async () => {
    const t = withFunding({ clock: new FakeClock(T) });
    withLong(t);
    t.runner.submitPerp(perpLimit('buy', '79000', '0.05'));
    t.funding.start();
    t.perp.mark(SYMBOL, '80000', FT); // the mark stream names the funding time before the gap
    await t.run(FT - 2 * MIN - t.clock.now);
    t.perp.setFresh(SYMBOL, false); // a gap from 12:08 to 12:11, across the whole window
    t.history.candleList[PERP] = minutes(FT - 3 * MIN, FT + MIN, '79500', '80100', [candle(FT, '78900', '80100')]);
    t.history.markList.BTCUSDT = minutes(FT - 3 * MIN, FT + MIN, '79995', '80005');
    t.history.tradeList[PERP] = [trade(800, '78950', '0.05', true, FT + 10_000)]; // fills the limit inside the window
    t.history.latest[PERP] = 900;
    await t.run(3 * MIN);
    // Nothing of the window happened live: its open and close waited for catch-up.
    expect(t.sim.perp.state.funding.windows.BTCUSDT).toBeUndefined();
    expect(t.sim.perp.state.funding.pending).toEqual([]);
    expect(t.logs.filter((l) => l.includes('paused through its window'))).toEqual([]);
    t.perp.setFresh(SYMBOL, true);
    await t.run(1000);
    expect(t.runner.gate(PERP)).toBe('live');
    // The settlement is not published yet: the run closed the window at FT + 15 s, widened by the fill at FT + 10 s.
    const pending = t.sim.perp.state.funding.pending.map((w) => [w.fundingTime, w.long.max.toString(), w.long.min.toString()]);
    expect(pending).toEqual([[FT, '0.15', '0.1']]);
    t.f.answers.push([], settled());
    await t.run(FUNDING_POLL_MS + 5000);
    expect(t.eventsOf('funding').map((e) => [e.payload.qty, e.payload.amount])).toEqual([['0.15', '-1.2']]);
    expect(t.sim.perp.state.funding.pending).toEqual([]);
    await t.run(FUNDING_POLL_MS * 3);
    expect(t.eventsOf('funding')).toHaveLength(1);
    expect(t.fatal).toEqual([]);
  });
});

describe('BinanceHistory', () => {
  /** REST stand-ins recording every call with its lane; aggTrades answers from `pages`, in turn. */
  function rests(pages: unknown[][] = []) {
    const calls: { what: string; lane?: Lane }[] = [];
    const spot = {
      klines: async (_s: string, _i: string, limit: number, endTime?: number, opts?: { startTime?: number; lane?: Lane }) => {
        calls.push({ what: `klines ${opts?.startTime} ${endTime} ${limit}`, lane: opts?.lane });
        return [];
      },
      aggTrades: async (q: AggTradesQuery) => {
        calls.push({ what: `aggTrades ${JSON.stringify(q)}` });
        return pages.shift() ?? [];
      },
    };
    const futures = {
      klines: async (_s: string, _i: string, limit: number, start?: number, end?: number, lane?: Lane) => {
        calls.push({ what: `klines ${start} ${end} ${limit}`, lane });
        return [];
      },
      markPriceKlines: async (_s: string, _i: '1m', limit: number, start: number, end: number, lane?: Lane) => {
        calls.push({ what: `marks ${start} ${end} ${limit}`, lane });
        return [];
      },
      aggTrades: async (q: AggTradesQuery, lane?: Lane) => {
        calls.push({ what: `aggTrades ${JSON.stringify(q)}`, lane });
        return pages.shift() ?? [];
      },
      fundingRate: async (q: FundingRateQuery) => {
        calls.push({ what: `fundingRate ${q.startTime} ${q.endTime}` });
        return pages.shift() ?? [];
      },
    };
    return { calls, history: new BinanceHistory(spot, futures) };
  }
  const row = (id: number, time: number, price = '100') => ({ a: id, p: price, q: '1', f: id, l: id, T: time, m: false });

  it('a minute’s trades: by time first, then by id while a page is full, until one reaches past the minute; each id once', async () => {
    const full = Array.from({ length: PAGE }, (_, i) => row(1 + i, T + i));
    // The next page starts at the id after the last, repeats nothing new and runs past the minute.
    const next = [row(PAGE, T + 1000), row(PAGE + 1, T + 59_999), row(PAGE + 2, T + MIN)];
    const { calls, history } = rests([full, next]);
    const trades = await history.minuteTrades('perp', SYMBOL, T);
    expect(calls).toEqual([
      { what: `aggTrades ${JSON.stringify({ symbol: SYMBOL, startTime: T, endTime: T + MIN - 1, limit: PAGE })}`, lane: 'bulk' },
      { what: `aggTrades ${JSON.stringify({ symbol: SYMBOL, fromId: PAGE + 1, limit: PAGE })}`, lane: 'bulk' },
    ]);
    expect(trades.map((x) => x.id)).toEqual([...Array.from({ length: PAGE }, (_, i) => 1 + i), PAGE + 1]);
    expect(new Set(trades.map((x) => x.id)).size).toBe(trades.length);
  });

  it('candles and mark candles ask for no more minutes than the range holds, in the bulk lane', async () => {
    const { calls, history } = rests();
    await history.candles('spot', SYMBOL, T - 5000, T + 30 * MIN);
    await history.candles('perp', SYMBOL, T - 5000, T + 30 * MIN);
    await history.markCandles(SYMBOL, T - 5000, T + 30 * MIN);
    expect(calls).toEqual([
      { what: `klines ${T - MIN} ${T + 30 * MIN} 32`, lane: 'bulk' },
      { what: `klines ${T - MIN} ${T + 30 * MIN} 32`, lane: 'bulk' },
      { what: `marks ${T - MIN} ${T + 30 * MIN} 32`, lane: 'bulk' },
    ]);
  });

  it('funding settlements are taken at their whole minute, once each; records with no usable mark price are skipped', async () => {
    const { history } = rests([
      [
        { symbol: SYMBOL, fundingTime: T + 3, fundingRate: '0.0001', markPrice: '80000' },
        { symbol: SYMBOL, fundingTime: T + 8 * HOUR, fundingRate: '-0.0002', markPrice: '' },
      ],
    ]);
    const settlements = await history.funding(SYMBOL, T - HOUR, T + 9 * HOUR);
    expect(settlements.map((f) => [f.time, f.rate.toString(), f.markPrice.toString()])).toEqual([[T, '0.0001', '80000']]);
  });

  it('the latest trade id: the most recent trade, by neither id nor time', async () => {
    const { calls, history } = rests([[row(41, T), row(42, T + 1)]]);
    expect(await history.latestTradeId('spot', SYMBOL)).toBe(42);
    expect(calls).toEqual([{ what: `aggTrades ${JSON.stringify({ symbol: SYMBOL, limit: 1 })}` }]);
  });
});
