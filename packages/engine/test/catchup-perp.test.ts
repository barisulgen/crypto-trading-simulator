import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { deposit, emptyLedger } from '../src/account/ledger.ts';
import type { Candle1m, CatchUpInput } from '../src/catchup/types.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import type { PerpEvent, PerpOrder, PerpOrderRequest } from '../src/perp/types.ts';
import { applyCatchUp, catchUpNeeds, SimEngine } from '../src/sim.ts';
import type { SimCtx, SimEvent } from '../src/sim.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import type { AggTrade } from '../src/types.ts';
import { FakeMarket } from './fixtures.ts';
import { FakePerpMarket } from './perpFixtures.ts';

/** A UTC time on the test day, 2026-10-24. */
const T = (h: number, m: number, sec = 0, ms = 0) => Date.UTC(2026, 9, 24, h, m, sec, ms);
const HOUR = 3_600_000;
const FROM = T(6, 0);
const TO = T(12, 0);
const SYMBOL = 'BTCUSDT';
const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

/**
 * BTCUSDT perps on FakePerpMarket (book 79990 / 80000, mark and last 80000, BTC tiers), 1000 USDT
 * in the leverage wallet, perp fees 0.02 % maker and 0.05 % taker. Ids and rng are deterministic
 * (every arrival delay is 100 ms).
 */
function setup() {
  const perpMarket = new FakePerpMarket();
  const counters = new Map<string, number>();
  const ctx: SimCtx = {
    now: T(5, 50),
    rng: () => 0,
    newId: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}${n}`;
    },
    spotMarket: new FakeMarket(),
    perpMarket,
    fees: { spot: { maker: D('0.001'), taker: D('0.001') }, perp: { maker: D('0.0002'), taker: D('0.0005') } },
  };
  const ledger = emptyLedger(['USDT', 'BTC']);
  const sim = new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));
  deposit(ledger, 'leverage', D('1000'), ctx);
  const lev = () => ledger.balances.leverage.USDT!;
  const stored = (id: string) => sim.perp.state.orders.get(id)!;
  const position = () => sim.perp.state.positions[SYMBOL];
  return { perpMarket, ctx, sim, lev, stored, position };
}

type Setup = ReturnType<typeof setup>;

/** Submit at `at`, then arrive at the order's arrival time; returns the order as it then is. */
function place(t: Setup, req: Omit<PerpOrderRequest, 'symbol'>, at = T(5, 50)): PerpOrder {
  t.ctx.now = at;
  const events = t.sim.submit('perp', { symbol: SYMBOL, ...req }, t.ctx);
  const e = events[0];
  if (events.length !== 1 || e?.type !== 'order_placed') throw new Error(`not placed: ${JSON.stringify(events)}`);
  t.ctx.now = e.order.arrivesAt!;
  t.sim.arrive('perp', e.order.id, t.ctx);
  return t.stored(e.order.id);
}

/** Market long 0.1 at 80000, 20x: margin 400 − fee 4 = 396; free 600. */
function openLong(t: Setup): void {
  place(t, { side: 'buy', type: 'market', qty: '0.1' });
  expect(t.position()).toMatchObject({ side: 'long' });
  expect(s(t.position()!.margin)).toBe('396');
  expect(s(t.lev().free)).toBe('600');
}

/** Market short 0.1 at 80000, 20x: margin 396; free 600. */
function openShort(t: Setup): void {
  t.perpMarket.setBook(SYMBOL, {
    bids: [{ price: D('80000'), qty: D('1') }],
    asks: [{ price: D('80010'), qty: D('1') }],
  });
  place(t, { side: 'sell', type: 'market', qty: '0.1' });
  expect(t.position()).toMatchObject({ side: 'short' });
  expect(s(t.position()!.entryPrice)).toBe('80000');
  expect(s(t.position()!.margin)).toBe('396');
}

/** Set the position's stop-loss and/or take-profit at 05:55 and let them arrive (armed). */
function armTpSl(t: Setup, input: { stopLoss?: string; takeProfit?: string }): PerpOrder[] {
  t.ctx.now = T(5, 55);
  const placed = t.sim.setPositionTpSl(SYMBOL, input, t.ctx);
  const legs = placed.map((e) => {
    if (e.type !== 'order_placed') throw new Error(`not placed: ${JSON.stringify(placed)}`);
    return e.order;
  });
  t.ctx.now = legs[0]!.arrivesAt!;
  t.sim.arrive('perp', legs[0]!.id, t.ctx);
  for (const l of legs) expect(t.stored(l.id).status).toBe('open');
  return legs.map((l) => t.stored(l.id));
}

function candle(at: number, low: string, high: string): Candle1m {
  return { openTime: at, open: D(high), high: D(high), low: D(low), close: D(low) };
}

/** One candle per minute of [from, to), quiet (`low`–`high`), with the given minutes replaced. */
function minutes(low: string, high: string, overrides: Candle1m[] = [], from = FROM, to = TO): Candle1m[] {
  const out: Candle1m[] = [];
  for (let at = from; at < to; at += 60_000) {
    out.push(overrides.find((c) => c.openTime === at) ?? candle(at, low, high));
  }
  return [...overrides.filter((c) => c.openTime < from), ...out];
}
const lastCandles = (overrides: Candle1m[] = []) => minutes('79990', '80010', overrides);
const markCandles = (overrides: Candle1m[] = []) => minutes('79995', '80005', overrides);

function input(extra: Partial<CatchUpInput> = {}): CatchUpInput {
  return {
    market: 'perp',
    symbol: SYMBOL,
    from: FROM,
    to: TO,
    lastTradeIdBefore: 100,
    endTradeId: null,
    candles: lastCandles(),
    trades: [],
    markCandles: markCandles(),
    funding: [],
    ...extra,
  };
}

function trade(id: number, price: string, qty: string, sellerInitiated: boolean, time: number): AggTrade {
  return { id, price: D(price), qty: D(qty), sellerInitiated, time };
}

/** Run the catch-up at 12:00:01, after the gap. */
function run(t: Setup, inp: CatchUpInput): SimEvent[] {
  t.ctx.now = T(12, 0, 1);
  return applyCatchUp(t.sim, inp, t.ctx);
}

type Perp<K extends PerpEvent['type']> = Extract<PerpEvent, { type: K }>;
const ofType = <K extends PerpEvent['type']>(events: SimEvent[], type: K): Perp<K>[] =>
  events.filter((e) => e.type === type && 'market' in e && e.market === 'perp') as Perp<K>[];
const summary = (events: SimEvent[]) => {
  const last = events[events.length - 1];
  if (last?.type !== 'catch_up') throw new Error(`no catch_up summary last in ${events.map((e) => e.type)}`);
  return last;
};
const tag = (basis: string, from = FROM, to = TO) => ({ from, to, basis });

/** Every event but the summary carries the catch-up tag, and the times never go backwards. */
function expectTaggedInOrder(events: SimEvent[]): void {
  for (const e of events.slice(0, -1)) expect('catchUp' in e && e.catchUp).toBeTruthy();
  const times = events.map((e) => e.time);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
}

const funding0800 = { time: T(8, 0), rate: D('0.0001'), markPrice: D('79000') };

describe('perp catch-up: funding and mark-candle liquidation (long 0.1 @80000, margin 396)', () => {
  it('applies the funding settled in the gap, then liquidates at the liquidation price the mark low reached', () => {
    const t = setup();
    openLong(t);
    // At 07:30 the mark low 76350 is above the liquidation price before funding (76345.38…).
    const marks = markCandles([candle(T(7, 30), '76350', '80000'), candle(T(9, 13), '76340', '80000')]);
    const events = run(t, input({ markCandles: marks, funding: [funding0800] }));

    const [funding] = ofType(events, 'funding');
    expect(ofType(events, 'funding')).toHaveLength(1);
    expect(funding!.time).toBe(T(8, 0));
    expect(funding!.fundingTime).toBe(T(8, 0));
    expect(s(funding!.amount)).toBe('-0.79');
    expect(funding!.target).toBe('margin');
    expect(funding!.catchUp).toEqual(tag('funding_history'));

    const [liq] = ofType(events, 'liquidation');
    expect(ofType(events, 'liquidation')).toHaveLength(1);
    expect(liq!.time).toBe(T(9, 13));
    expect(s(liq!.position.margin)).toBe('395.21');
    expect(s(liq!.markPrice)).toBe('76353.31325301');
    expect(s(liq!.tradingLoss)).toBe('364.6686747');
    expect(s(liq!.liquidationFee)).toBe('30.5413253');
    expect(s(liq!.remainder)).toBe('0');
    expect(s(liq!.marginLost)).toBe('395.21');
    expect(liq!.catchUp).toEqual(tag('mark_candle'));
    const [closed] = ofType(events, 'position_closed');
    expect(closed).toMatchObject({ time: T(9, 13), reason: 'liquidated' });

    expect(t.position()).toBeUndefined();
    // The leverage wallet outside the margin is untouched.
    expect(s(t.lev().free)).toBe('600');
    expect(summary(events)).toMatchObject({ type: 'catch_up', market: 'perp', symbol: SYMBOL, from: FROM, to: TO });
    expect(summary(events).actions).toEqual([
      'Funding paid 0.79 USDT on 0.1 BTC long at 08:00 UTC (settled rate 0.0001, mark 79000)',
      'Long 0.1 BTC liquidated at 76353.31325301, its liquidation price, when the mark reached it at 09:13 UTC; ' +
        'margin lost 395.21 USDT (estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('funding comes first in its minute: the liquidation price it raises is judged on that minute’s mark', () => {
    const t = setup();
    openLong(t);
    const marks = markCandles([candle(T(8, 0), '76350', '80000')]);
    const events = run(t, input({ markCandles: marks, funding: [funding0800] }));
    expect(ofType(events, 'liquidation').map((e) => [e.time, s(e.markPrice)])).toEqual([[T(8, 0), '76353.31325301']]);
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(['funding', 'liquidation']);
  });

  it('a stop-loss reached in the minute the mark reaches the liquidation price is cancelled by the liquidation', () => {
    const t = setup();
    openLong(t);
    const [sl] = armTpSl(t, { stopLoss: '77000' });
    const events = run(
      t,
      input({
        candles: lastCandles([candle(T(9, 13), '76900', '80000')]),
        markCandles: markCandles([candle(T(9, 13), '76340', '80000')]),
      }),
    );
    expect(ofType(events, 'fill')).toEqual([]);
    expect(ofType(events, 'liquidation').map((e) => e.time)).toEqual([T(9, 13)]);
    const cancelled = ofType(events, 'order_cancelled');
    expect(cancelled.map((e) => [e.order.id, e.reason, e.time])).toEqual([[sl!.id, 'liquidation', T(9, 13)]]);
    expect(cancelled[0]!.catchUp).toEqual(tag('mark_candle'));
    expect(t.stored(sl!.id).status).toBe('cancelled');
    expect(summary(events).actions).toEqual([
      'Long 0.1 BTC liquidated at 76345.3815261, its liquidation price, when the mark reached it at 09:13 UTC; ' +
        'margin lost 396 USDT (estimated)',
      'Stop-loss cancelled at 09:13:00 UTC (liquidation; estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('a short is liquidated when the mark high reaches its liquidation price', () => {
    const t = setup();
    openShort(t);
    // Liquidation price (8000 + 396) ÷ (0.1 × 1.004) = 83625.49800796…, rounded up to 83625.49800797.
    const marks = markCandles([candle(T(9, 12), '80000', '83620'), candle(T(9, 13), '80000', '83630')]);
    const events = run(t, input({ markCandles: marks }));
    const [liq] = ofType(events, 'liquidation');
    expect(ofType(events, 'liquidation')).toHaveLength(1);
    expect(liq!.time).toBe(T(9, 13));
    expect(liq!.position.side).toBe('short');
    expect(s(liq!.markPrice)).toBe('83625.49800797');
    expect(s(liq!.tradingLoss)).toBe('362.5498008');
    expect(s(liq!.liquidationFee)).toBe('33.4501992');
    expect(s(liq!.remainder)).toBe('0');
    expect(s(liq!.marginLost)).toBe('396');
    expect(t.position()).toBeUndefined();
    expect(s(t.lev().free)).toBe('600');
  });

  it('funding is applied exactly once, even when given twice or by a second run over the same gap', () => {
    const t = setup();
    openLong(t);
    const first = run(t, input({ funding: [funding0800, { ...funding0800 }] }));
    expect(ofType(first, 'funding').map((e) => s(e.amount))).toEqual(['-0.79']);
    expect(s(t.position()!.margin)).toBe('395.21');

    const second = run(t, input({ funding: [funding0800] }));
    expect(ofType(second, 'funding')).toEqual([]);
    expect(s(t.position()!.margin)).toBe('395.21');
    expect(summary(second).actions).toEqual([]);
  });
});

describe('perp catch-up: close-position stops from last-price candles', () => {
  it('a stop-loss reached while the mark stays clear fills the whole position at the minute’s low, taker fee', () => {
    const t = setup();
    openLong(t);
    const [sl] = armTpSl(t, { stopLoss: '78000' });
    const events = run(
      t,
      input({
        candles: lastCandles([candle(T(10, 2), '77800', '78100')]),
        markCandles: markCandles([candle(T(10, 2), '77900', '78100')]),
      }),
    );
    const [fill] = ofType(events, 'fill');
    expect(ofType(events, 'fill')).toHaveLength(1);
    expect(fill!.order.id).toBe(sl!.id);
    expect(fill!.order.status).toBe('filled');
    expect(fill!.time).toBe(T(10, 2));
    expect(s(fill!.fill.qty)).toBe('0.1');
    expect(s(fill!.fill.price)).toBe('77800');
    expect(s(fill!.fill.fee)).toBe('3.89');
    expect(fill!.fill.liquidity).toBe('taker');
    expect(s(fill!.fill.realizedPnl)).toBe('-220');
    expect(fill!.fill.bankruptcyCapped).toBeUndefined();
    expect(fill!.fill.uncappedPrice).toBeUndefined();
    expect(fill!.catchUp).toEqual(tag('candle_worst_price'));
    expect(ofType(events, 'order_triggered').map((e) => [e.time, e.order.id])).toEqual([[T(10, 2), sl!.id]]);

    const [closed] = ofType(events, 'position_closed');
    expect(closed).toMatchObject({ time: T(10, 2), reason: 'stop_loss' });
    expect(s(closed!.exitPrice)).toBe('77800');
    expect(s(closed!.realizedPnl)).toBe('-220');
    expect(closed!.bankruptcyCapped).toBeUndefined();
    expect(t.position()).toBeUndefined();
    // 396 margin − 220 − 3.89 back to the wallet.
    expect(s(t.lev().free)).toBe('772.11');
    expect(summary(events).actions).toEqual([
      'Stop-loss filled 0.1 BTC at 77800 (worst price of 10:02 UTC; estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('a close never loses more than the margin: price capped at the bankruptcy price, fee at what is left', () => {
    const t = setup();
    openLong(t);
    const [sl] = armTpSl(t, { stopLoss: '78000' });
    const events = run(
      t,
      input({
        candles: lastCandles([candle(T(10, 2), '70000', '78100')]),
        markCandles: markCandles([candle(T(10, 2), '77000', '78100')]),
      }),
    );
    const [fill] = ofType(events, 'fill');
    expect(ofType(events, 'fill')).toHaveLength(1);
    expect(fill!.order.id).toBe(sl!.id);
    // Bankruptcy price 80000 − 396 ÷ 0.1.
    expect(s(fill!.fill.price)).toBe('76040');
    expect(s(fill!.fill.quote)).toBe('7604');
    expect(s(fill!.fill.realizedPnl)).toBe('-396');
    expect(s(fill!.fill.fee)).toBe('0');
    expect(fill!.fill.uncovered).toBeNull();
    expect(fill!.fill.bankruptcyCapped).toBe(true);
    expect(s(fill!.fill.uncappedPrice)).toBe('70000');
    const [closed] = ofType(events, 'position_closed');
    expect(closed).toMatchObject({ reason: 'stop_loss', bankruptcyCapped: true });
    expect(s(closed!.exitPrice)).toBe('76040');
    expect(s(closed!.uncappedPrice)).toBe('70000');
    expect(s(closed!.realizedPnl)).toBe('-396');
    expect(s(closed!.fees)).toBe('4');
    expect(t.position()).toBeUndefined();
    // The margin (396) is lost; the leverage wallet is untouched.
    expect(s(t.lev().free)).toBe('600');
    expect(s(t.lev().locked)).toBe('0');
    expect(summary(events).actions).toEqual([
      'Stop-loss filled 0.1 BTC at 76040, the bankruptcy price (worst price of 10:02 UTC was 70000; estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('a close above the bankruptcy price whose fee would take more than the margin left pays only what is left', () => {
    const t = setup();
    openLong(t);
    armTpSl(t, { stopLoss: '78000' });
    const events = run(
      t,
      input({
        candles: lastCandles([candle(T(10, 2), '76050', '78100')]),
        markCandles: markCandles([candle(T(10, 2), '77000', '78100')]),
      }),
    );
    const [fill] = ofType(events, 'fill');
    expect(s(fill!.fill.price)).toBe('76050');
    expect(s(fill!.fill.realizedPnl)).toBe('-395');
    // The fee would be 3.8025; only 1 is left of the margin.
    expect(s(fill!.fill.fee)).toBe('1');
    expect(fill!.fill.bankruptcyCapped).toBe(true);
    expect(s(fill!.fill.uncappedPrice)).toBe('76050');
    expect(s(t.lev().free)).toBe('600');
  });

  it('a stop-loss and a take-profit reached in one minute: the stop-loss closes, the take-profit is cancelled', () => {
    const t = setup();
    openLong(t);
    const [sl, tp] = armTpSl(t, { stopLoss: '78000', takeProfit: '82000' });
    const events = run(t, input({ candles: lastCandles([candle(T(10, 2), '77800', '82100')]) }));
    expect(ofType(events, 'fill').map((e) => [e.order.id, s(e.fill.price)])).toEqual([[sl!.id, '77800']]);
    expect(ofType(events, 'order_cancelled').map((e) => [e.order.id, e.reason])).toEqual([[tp!.id, 'oco']]);
    expect(summary(events).actions).toEqual([
      'Stop-loss filled 0.1 BTC at 77800 (worst price of 10:02 UTC; estimated)',
      'Take-profit cancelled: the other order of its pair triggered (estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('a take-profit fills at the worst price of its minute', () => {
    const t = setup();
    openLong(t);
    const [tp] = armTpSl(t, { takeProfit: '82000' });
    const events = run(t, input({ candles: lastCandles([candle(T(10, 2), '81900', '82100')]) }));
    expect(ofType(events, 'fill').map((e) => [e.order.id, s(e.fill.price), s(e.fill.realizedPnl)])).toEqual([
      [tp!.id, '81900', '190'],
    ]);
    expect(ofType(events, 'position_closed').map((e) => e.reason)).toEqual(['take_profit']);
  });

  it('a stop triggered before the gap and still waiting closes at its trigger minute’s low, capped too', () => {
    const t = setup();
    openLong(t);
    const [sl] = armTpSl(t, { stopLoss: '78000' });
    t.ctx.now = T(5, 59, 30);
    const fired = t.sim.onTrade('perp', SYMBOL, trade(50, '77990', '1', true, T(5, 59, 30)), t.ctx);
    expect(fired.map((e) => e.type)).toEqual(['order_triggered']);
    t.perpMarket.setFresh(SYMBOL, false);
    t.ctx.now = t.stored(sl!.id).arrivesAt!;
    expect(t.sim.arrive('perp', sl!.id, t.ctx)).toEqual([]);
    expect(t.stored(sl!.id)).toMatchObject({ status: 'triggered', arrivesAt: null });

    const events = run(t, input({ candles: lastCandles([candle(T(5, 59), '75000', '80000')]) }));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.id, s(e.fill.price), e.time])).toEqual([[sl!.id, '76040', T(5, 59, 30)]]);
    expect(fills[0]!.fill.bankruptcyCapped).toBe(true);
    expect(s(fills[0]!.fill.uncappedPrice)).toBe('75000');
    expect(fills[0]!.catchUp).toEqual(tag('trigger_minute_worst_price'));
    expect(s(t.lev().free)).toBe('600');
  });
});

describe('perp catch-up: limit orders', () => {
  const crossed = () => lastCandles([candle(T(10, 30), '78900', '80000')]);
  const fillTrades = () => [
    trade(99, '78000', '1', true, T(10, 30, 5)),
    trade(101, '78950', '0.1', true, T(10, 30, 20)),
  ];

  it('asks for marks and funding while a position or opening order exists, and for crossed minutes’ trades', () => {
    const t = setup();
    expect(catchUpNeeds(t.sim, 'perp', SYMBOL, FROM, TO, crossed())).toEqual({
      tradeMinutes: [],
      markCandles: false,
      funding: false,
    });
    place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    expect(catchUpNeeds(t.sim, 'perp', SYMBOL, FROM, TO, crossed())).toEqual({
      tradeMinutes: [T(10, 30)],
      markCandles: true,
      funding: true,
    });
    // A candle that only touches the limit (low 79000) needs no trades.
    const touched = lastCandles([candle(T(10, 30), '79000', '80000')]);
    expect(catchUpNeeds(t.sim, 'perp', SYMBOL, FROM, TO, touched).tradeMinutes).toEqual([]);

    const u = setup();
    openLong(u);
    expect(catchUpNeeds(u.sim, 'perp', SYMBOL, FROM, TO, lastCandles())).toEqual({
      tradeMinutes: [],
      markCandles: true,
      funding: true,
    });
  });

  it('a gap starting more than 47 h ago cancels the resting limits at its start: their trade history is gone', () => {
    const t = setup();
    const from = TO - 50 * HOUR;
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' }, from - 600_000);
    expect(s(t.lev().locked)).toBe('398.95');
    const events = run(
      t,
      input({ from, candles: minutes('79990', '80010', [], TO - 60 * 60_000), markCandles: [], trades: 'unavailable' }),
    );
    const cancelled = ofType(events, 'order_cancelled');
    expect(cancelled.map((e) => [e.order.id, e.reason, e.time])).toEqual([[o.id, 'catch_up_unavailable', from]]);
    expect(cancelled[0]!.catchUp).toEqual(tag('history_unavailable', from));
    expect(t.stored(o.id).status).toBe('cancelled');
    expect(s(t.lev().locked)).toBe('0');
    expect(s(t.lev().free)).toBe('1000');
    expect(summary(events).actions).toEqual([
      'Futures trade history covers only 2 days; open limit orders were cancelled',
    ]);
    expectTaggedInOrder(events);
  });

  it('a limit filled by a replayed trade opens a position whose liquidation is judged from then on', () => {
    const t = setup();
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    // Liquidation price of the new position (margin 395 − fee 1.58): 75367.2690763…
    const marks = markCandles([candle(T(10, 29), '75000', '80000'), candle(T(10, 31), '75300', '80000')]);
    const events = run(t, input({ candles: crossed(), trades: fillTrades(), markCandles: marks }));

    const fills = ofType(events, 'fill');
    const terms = fills.map((e) => [e.order.id, e.time, s(e.fill.qty), s(e.fill.price), s(e.fill.fee)]);
    expect(terms).toEqual([
      [o.id, T(10, 30, 20), '0.1', '79000', '1.58'],
    ]);
    expect(fills[0]!.fill.liquidity).toBe('maker');
    expect(fills[0]!.catchUp).toEqual(tag('aggtrade_replay'));
    const [opened] = ofType(events, 'position_opened');
    expect(opened!.time).toBe(T(10, 30, 20));
    expect(s(opened!.position.margin)).toBe('393.42');

    const [liq] = ofType(events, 'liquidation');
    expect(ofType(events, 'liquidation')).toHaveLength(1);
    expect(liq!.time).toBe(T(10, 31));
    expect(s(liq!.markPrice)).toBe('75367.2690763');
    expect(s(liq!.tradingLoss)).toBe('363.27309237');
    expect(s(liq!.liquidationFee)).toBe('30.14690763');
    expect(t.sim.perp.state.lastTradeId[SYMBOL]).toBe(101);
    expect(summary(events).actions).toEqual([
      'Limit buy filled 0.1 BTC at 79000 (replayed trade at 10:30:20 UTC; estimated)',
      'Long 0.1 BTC liquidated at 75367.2690763, its liquidation price, when the mark reached it at 10:31 UTC; ' +
        'margin lost 393.42 USDT (estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('a position opened by a replayed trade is judged against the rest of that minute’s mark', () => {
    const t = setup();
    place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    const marks = markCandles([candle(T(10, 30), '75300', '80000')]);
    const events = run(t, input({ candles: crossed(), trades: fillTrades(), markCandles: marks }));
    expect(ofType(events, 'liquidation').map((e) => e.time)).toEqual([T(10, 30, 20)]);
    expectTaggedInOrder(events);
  });

  it('a stop-loss attached to the limit is placed by its fill and checked against the same minute', () => {
    const t = setup();
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000', attach: { stopLoss: '78500' } });
    const events = run(t, input({ candles: lastCandles([candle(T(10, 30), '78400', '80000')]), trades: fillTrades() }));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.type, s(e.fill.price), e.time, e.catchUp?.basis])).toEqual([
      ['limit', '79000', T(10, 30, 20), 'aggtrade_replay'],
      ['stop_loss', '78400', T(10, 30, 20), 'candle_worst_price'],
    ]);
    expect(fills[1]!.order.parentId).toBe(o.id);
    expect(t.position()).toBeUndefined();
    expect(summary(events).actions).toEqual([
      'Limit buy filled 0.1 BTC at 79000 (replayed trade at 10:30:20 UTC; estimated)',
      'Attached stop-loss 78500 placed at 10:30:20 UTC (estimated)',
      'Stop-loss filled 0.1 BTC at 78400 (worst price of 10:30 UTC; estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('a trade repeated in the fetched list (a page boundary) is used once', () => {
    const t = setup();
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.2', price: '79000' });
    const repeated = trade(101, '78950', '0.1', true, T(10, 30, 20));
    const trades = [repeated, { ...repeated }, trade(102, '78950', '0.1', true, T(10, 30, 40))];
    const events = run(t, input({ candles: crossed(), trades }));
    expect(ofType(events, 'fill').map((e) => [s(e.fill.qty), e.time])).toEqual([
      ['0.1', T(10, 30, 20)],
      ['0.1', T(10, 30, 40)],
    ]);
    expect(s(t.stored(o.id).filledQty)).toBe('0.2');
  });

  it('a cancel in flight across the gap takes effect at its arrival', () => {
    const t = setup();
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    t.ctx.now = T(10, 29, 50);
    expect(t.sim.cancel('perp', o.id, t.ctx)).toEqual({ ok: true, events: [] });
    const events = run(t, input({ candles: crossed(), trades: fillTrades() }));
    expect(ofType(events, 'fill')).toEqual([]);
    const [cancelled] = ofType(events, 'order_cancelled');
    expect(cancelled).toMatchObject({ reason: 'user', time: T(10, 29, 50, 100) });
    expect(cancelled!.catchUp).toEqual(tag('cancel_arrival'));
    expect(s(t.lev().locked)).toBe('0');
  });
});

describe('perp catch-up: nothing open', () => {
  it('produces no events at all', () => {
    const t = setup();
    expect(run(t, input({ funding: [funding0800] }))).toEqual([]);
  });

  it('an open position with a quiet gap gives a summary with no actions', () => {
    const t = setup();
    openLong(t);
    const events = run(t, input());
    expect(events).toHaveLength(1);
    expect(summary(events).actions).toEqual([]);
  });
});
