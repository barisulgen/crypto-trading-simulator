import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { deposit, emptyLedger } from '../src/account/ledger.ts';
import type { Candle1m, CatchUpInput } from '../src/catchup/types.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import { neverSettled } from '../src/perp/funding.ts';
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
function openLong(t: Setup, at = T(5, 50)): void {
  place(t, { side: 'buy', type: 'market', qty: '0.1' }, at);
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

/** Set the position's stop-loss and/or take-profit (at 05:55 by default) and let them arrive (armed). */
function armTpSl(t: Setup, input: { stopLoss?: string; takeProfit?: string }, at = T(5, 55)): PerpOrder[] {
  t.ctx.now = at;
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
    // Dated when its window closes, 15 s after the funding time: its sizes are final only then.
    expect(funding!.time).toBe(T(8, 0, 15));
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

  it('the liquidation price a funding raises is judged on its minute’s mark, dated no earlier than the funding', () => {
    const t = setup();
    openLong(t);
    const marks = markCandles([candle(T(8, 0), '76350', '80000')]);
    const settled = { ...funding0800, time: T(8, 0, 0, 1) };
    const events = run(t, input({ markCandles: marks, funding: [settled] }));
    expect(ofType(events, 'funding').map((e) => [e.time, e.fundingTime])).toEqual([[T(8, 0, 15, 1), T(8, 0, 0, 1)]]);
    const liquidations = ofType(events, 'liquidation').map((e) => [e.time, s(e.markPrice)]);
    expect(liquidations).toEqual([[T(8, 0, 15, 1), '76353.31325301']]);
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(['funding', 'liquidation']);
    expectTaggedInOrder(events);
  });

  it('a liquidation in the minute the gap starts in is dated no earlier than the gap', () => {
    const t = setup();
    openLong(t);
    const from = T(6, 0, 30);
    const events = run(t, input({ from, markCandles: markCandles([candle(T(6, 0), '76340', '80000')]) }));
    expect(ofType(events, 'liquidation').map((e) => e.time)).toEqual([from]);
    expectTaggedInOrder(events);
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

describe('perp catch-up: funding windows (15 s either side of 08:00, rate 0.0001, mark 79000)', () => {
  it('a long closed by a replayed fill at 07:59:50 still pays on the size it held in the window', () => {
    const t = setup();
    openLong(t);
    const o = place(t, { side: 'sell', type: 'limit', qty: '0.1', price: '80500', reduceOnly: true });
    const events = run(t, input({ trades: [trade(101, '80600', '0.1', false, T(7, 59, 50))], funding: [funding0800] }));
    expect(ofType(events, 'fill').map((e) => [e.order.id, e.time])).toEqual([[o.id, T(7, 59, 50)]]);
    expect(t.position()).toBeUndefined();
    const funding = ofType(events, 'funding');
    expect(funding.map((e) => [e.time, s(e.qty), s(e.amount), e.target])).toEqual([[T(8, 0, 15), '0.1', '-0.79', 'wallet']]);
    // 600 + 396 margin + 50 − 1.61 maker fee, then − 0.79 funding.
    expect(s(t.lev().free)).toBe('1043.6');
    expectTaggedInOrder(events);
  });

  it('a long added to by a replayed fill at 08:00:05 pays on the larger size', () => {
    const t = setup();
    openLong(t);
    place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    const events = run(t, input({ trades: [trade(101, '78950', '0.1', true, T(8, 0, 5))], funding: [funding0800] }));
    const funding = ofType(events, 'funding');
    expect(funding.map((e) => [e.time, s(e.qty), s(e.amount), e.target])).toEqual([[T(8, 0, 15), '0.2', '-1.58', 'margin']]);
    // 396 + 395 − 1.58 fee, then − 1.58 funding.
    expect(s(t.position()!.margin)).toBe('787.84');
    expectTaggedInOrder(events);
  });

  it('a short opened by a replayed fill at 08:00:05 receives nothing: it was not held through the window', () => {
    const t = setup();
    place(t, { side: 'sell', type: 'limit', qty: '0.1', price: '80500' });
    const events = run(t, input({ trades: [trade(101, '80600', '0.1', false, T(8, 0, 5))], funding: [funding0800] }));
    expect(ofType(events, 'position_opened').map((e) => [e.time, e.position.side])).toEqual([[T(8, 0, 5), 'short']]);
    expect(ofType(events, 'funding')).toEqual([]);
    expect(t.position()!.funding.isZero()).toBe(true);
  });
});

describe('perp catch-up: funding windows at the edges of the gap', () => {
  it('a gap ending inside the window leaves it open for the live path, which settles it on what live fills add', () => {
    const t = setup();
    openLong(t);
    place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    const to = T(8, 0, 5);
    const events = run(
      t,
      input({
        to,
        candles: minutes('79990', '80010', [], FROM, to),
        markCandles: minutes('79995', '80005', [], FROM, to),
        funding: [funding0800],
      }),
    );
    expect(ofType(events, 'funding')).toEqual([]);
    expect(t.sim.perp.state.funding.windows[SYMBOL]?.fundingTime).toBe(T(8, 0));

    // Live again: a fill at 08:00:10 adds to the long inside the window; the live path then closes
    // the window at 08:00:15 and settles it, once.
    t.ctx.now = T(8, 0, 10);
    const live = t.sim.onTrade('perp', SYMBOL, trade(200, '78950', '0.1', true, T(8, 0, 10)), t.ctx);
    expect(ofType(live, 'fill').map((e) => s(e.fill.qty))).toEqual(['0.1']);
    t.ctx.now = T(8, 0, 15);
    t.sim.closeFundingWindow(SYMBOL, T(8, 0), t.ctx);
    const settled = t.sim.applyFunding(SYMBOL, T(8, 0), D('0.0001'), D('79000'), t.ctx);
    expect(ofType(settled, 'funding').map((e) => [s(e.qty), s(e.amount)])).toEqual([['0.2', '-1.58']]);
    expect(t.sim.applyFunding(SYMBOL, T(8, 0), D('0.0001'), D('79000'), t.ctx)).toEqual([]);
  });

  it('a settlement whose window closed before the gap is dated at the gap start, not before it', () => {
    const t = setup();
    openLong(t);
    const events = run(t, input({ funding: [{ ...funding0800, time: T(5, 0) }] }));
    expect(ofType(events, 'funding').map((e) => [e.time, e.fundingTime, s(e.amount)])).toEqual([
      [FROM, T(5, 0), '-0.79'],
    ]);
    expectTaggedInOrder(events);
  });

  it('a window that closed in minutes no candle covered settles before a cancel that arrived after its close', () => {
    const t = setup();
    openLong(t);
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    t.ctx.now = T(8, 0, 29, 900);
    expect(t.sim.cancel('perp', o.id, t.ctx)).toEqual({ ok: true, events: [] });
    const uncovered = (c: Candle1m) => c.openTime !== T(7, 59) && c.openTime !== T(8, 0);
    const events = run(
      t,
      input({
        candles: lastCandles().filter(uncovered),
        markCandles: markCandles().filter(uncovered),
        funding: [funding0800],
      }),
    );
    expect(events.filter((e) => e.type !== 'catch_up').map((e) => [e.type, e.time])).toEqual([
      ['funding', T(8, 0, 15)],
      ['order_cancelled', T(8, 0, 30)],
    ]);
    expectTaggedInOrder(events);
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

  it('a stop held from before a gap older than 47 h closes before the limits are cancelled at the gap start', () => {
    const t = setup();
    const from = TO - 50 * HOUR;
    openLong(t, from - 600_000);
    const [sl] = armTpSl(t, { stopLoss: '78000' }, from - 540_000);
    const o = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' }, from - 480_000);
    // Triggered 30 s before the gap by a buyer-initiated trade (which fills no buy limit); its
    // arrival found the data stale, so it waits.
    t.ctx.now = from - 30_000;
    const fired = t.sim.onTrade('perp', SYMBOL, trade(50, '77990', '1', false, from - 30_000), t.ctx);
    expect(fired.map((e) => e.type)).toEqual(['order_triggered']);
    t.perpMarket.setFresh(SYMBOL, false);
    t.ctx.now = t.stored(sl!.id).arrivesAt!;
    expect(t.sim.arrive('perp', sl!.id, t.ctx)).toEqual([]);

    const candles = [candle(from - 60_000, '77800', '78100'), ...minutes('79990', '80010', [], TO - 60 * 60_000)];
    const events = run(t, input({ from, candles, markCandles: [], trades: 'unavailable' }));
    expect(ofType(events, 'fill').map((e) => [e.order.id, s(e.fill.price), e.time])).toEqual([
      [sl!.id, '77800', from - 30_000],
    ]);
    const cancelled = ofType(events, 'order_cancelled');
    expect(cancelled.map((e) => [e.order.id, e.reason, e.time])).toEqual([[o.id, 'catch_up_unavailable', from]]);
    expectTaggedInOrder(events);
  });

  it('a gap older than 47 h cancels its limits at its start before a cancel that arrived later in the gap', () => {
    const t = setup();
    const from = TO - 50 * HOUR;
    const first = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' }, from - 600_000);
    const second = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' }, from - 540_000);
    // The owner cancels the first one hour into the gap; the first walked minute is an hour later still.
    t.ctx.now = from + HOUR;
    expect(t.sim.cancel('perp', first.id, t.ctx)).toEqual({ ok: true, events: [] });
    const candles = minutes('79990', '80010', [], TO - 60 * 60_000);
    const events = run(t, input({ from, candles, markCandles: [], trades: 'unavailable' }));
    const cancelled = ofType(events, 'order_cancelled');
    expect(cancelled.map((e) => [e.order.id, e.reason, e.time])).toEqual([
      [first.id, 'catch_up_unavailable', from],
      [second.id, 'catch_up_unavailable', from],
    ]);
    const late = ofType(events, 'cancel_rejected');
    expect(late.map((e) => [e.order.id, e.time])).toEqual([[first.id, from + HOUR + 100]]);
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

  it('each replayed fill is judged on the minute’s mark: a later fill’s margin does not hide a liquidation', () => {
    const t = setup();
    const first = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    const second = place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '76100' });
    // After the first fill the liquidation price is 75367.27…; after both it would be 73983.9…
    const marks = markCandles([candle(T(10, 30), '75000', '80000')]);
    const trades = [trade(101, '78950', '0.1', true, T(10, 30, 20)), trade(102, '76000', '0.1', true, T(10, 30, 40))];
    const candles = lastCandles([candle(T(10, 30), '76000', '80000')]);
    const events = run(t, input({ candles, trades, markCandles: marks }));
    expect(ofType(events, 'fill').map((e) => [e.order.id, e.time])).toEqual([[first.id, T(10, 30, 20)]]);
    const liquidations = ofType(events, 'liquidation').map((e) => [e.time, s(e.markPrice)]);
    expect(liquidations).toEqual([[T(10, 30, 20), '75367.2690763']]);
    expect(ofType(events, 'order_cancelled').map((e) => [e.order.id, e.reason])).toEqual([[second.id, 'liquidation']]);
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

describe('perp catch-up: funding times with no settlement given (fundingTimes)', () => {
  it('a gap ending inside [T − 15 s, T) opens T’s window at T − 15 s on the size then, widened by the gap’s fills, left open', () => {
    const t = setup();
    openLong(t);
    place(t, { side: 'buy', type: 'limit', qty: '0.1', price: '79000' });
    const to = T(7, 59, 50);
    const events = run(
      t,
      input({
        to,
        candles: minutes('79990', '80010', [candle(T(7, 59), '78900', '80010')], FROM, to),
        markCandles: minutes('79995', '80005', [], FROM, to),
        trades: [trade(101, '78950', '0.1', true, T(7, 59, 47))],
        fundingTimes: [T(8, 0)],
      }),
    );
    expect(ofType(events, 'fill').map((e) => e.time)).toEqual([T(7, 59, 47)]);
    expect(ofType(events, 'funding')).toEqual([]);
    const w = t.sim.perp.state.funding.windows[SYMBOL]!;
    expect(w.fundingTime).toBe(T(8, 0));
    expect([s(w.long.max), s(w.long.min)]).toEqual(['0.2', '0.1']);

    // Live again: the live path closes it at 08:00:15 and settles it once, on the larger size.
    t.ctx.now = T(8, 0, 15);
    t.sim.closeFundingWindow(SYMBOL, T(8, 0), t.ctx);
    const settled = t.sim.applyFunding(SYMBOL, T(8, 0), D('0.0001'), D('79000'), t.ctx);
    expect(ofType(settled, 'funding').map((e) => [s(e.qty), s(e.amount)])).toEqual([['0.2', '-1.58']]);
  });

  it('a window inside the gap with no settlement yet is opened and closed in the walk and left waiting for its rate', () => {
    const t = setup();
    openLong(t);
    const events = run(t, input({ fundingTimes: [T(8, 0)] }));
    expect(ofType(events, 'funding')).toEqual([]);
    expect(t.sim.perp.state.funding.windows[SYMBOL]).toBeUndefined();
    const pending = t.sim.perp.state.funding.pending.map((w) => [w.symbol, w.fundingTime, s(w.long.max)]);
    expect(pending).toEqual([[SYMBOL, T(8, 0), '0.1']]);
    t.ctx.now = T(12, 5);
    const settled = t.sim.applyFunding(SYMBOL, T(8, 0), D('0.0001'), D('79000'), t.ctx);
    expect(ofType(settled, 'funding').map((e) => [s(e.qty), s(e.amount)])).toEqual([['0.1', '-0.79']]);
  });

  it('a funding time also given with its settlement is settled once, from the settlement', () => {
    const t = setup();
    openLong(t);
    const events = run(t, input({ funding: [funding0800], fundingTimes: [T(8, 0)] }));
    expect(ofType(events, 'funding').map((e) => [e.time, s(e.amount)])).toEqual([[T(8, 0, 15), '-0.79']]);
    expect(t.sim.perp.state.funding.pending).toEqual([]);
    expect(t.sim.perp.state.funding.windows[SYMBOL]).toBeUndefined();
  });

  it('a time with no settlement while a later one is settled never happened (the interval changed): not modelled, its waiting window dropped', () => {
    const t = setup();
    openLong(t);
    // 07:00 was projected by an earlier run and waits for its rate; Binance settled 08:00 and
    // nothing at 07:00, so 07:00 never happened. 10:00 has no settlement after it yet: kept.
    t.ctx.now = T(5, 51);
    t.sim.openFundingWindow(SYMBOL, T(7, 0), t.ctx);
    t.sim.closeFundingWindow(SYMBOL, T(7, 0), t.ctx);
    expect(t.sim.perp.state.funding.pending.map((w) => w.fundingTime)).toEqual([T(7, 0)]);
    const events = run(t, input({ funding: [funding0800], fundingTimes: [T(7, 0), T(8, 0), T(10, 0)] }));
    expect(ofType(events, 'funding').map((e) => [e.fundingTime, s(e.amount)])).toEqual([[T(8, 0), '-0.79']]);
    expect(t.sim.perp.state.funding.pending.map((w) => w.fundingTime)).toEqual([T(10, 0)]);
    expect(t.sim.perp.state.funding.windows[SYMBOL]).toBeUndefined();
    expect(t.sim.perp.state.funding.applied[SYMBOL]).toEqual([T(8, 0)]);
  });

  it('a time whose record has a rate but no usable mark price did happen, though a later one is settled: kept waiting for its rate, never dropped', () => {
    const t = setup();
    openLong(t);
    // Binance recorded 07:00 (rate given, mark price missing) and settled 08:00: 07:00 happened, so
    // its window keeps waiting for a usable settlement and nothing is estimated for it.
    t.ctx.now = T(5, 51);
    t.sim.openFundingWindow(SYMBOL, T(7, 0), t.ctx);
    t.sim.closeFundingWindow(SYMBOL, T(7, 0), t.ctx);
    const events = run(
      t,
      input({ funding: [funding0800], fundingRecords: [T(7, 0), T(8, 0)], fundingTimes: [T(7, 0), T(8, 0), T(10, 0)] }),
    );
    expect(ofType(events, 'funding').map((e) => [e.fundingTime, s(e.amount)])).toEqual([[T(8, 0), '-0.79']]);
    expect(t.sim.perp.state.funding.pending.map((w) => w.fundingTime)).toEqual([T(7, 0), T(10, 0)]);
    expect(t.sim.perp.state.funding.applied[SYMBOL]).toEqual([T(8, 0)]);
  });

  it('neverSettled: any record within 60 s of the time, usable or not, shows it happened', () => {
    const at = T(7, 0);
    expect(neverSettled(at, [T(8, 0)])).toBe(true);
    expect(neverSettled(at, [T(8, 0)], [at + 3, T(8, 0)])).toBe(false);
    expect(neverSettled(at, [T(8, 0)], [at - 60_000, T(8, 0)])).toBe(false);
    expect(neverSettled(at, [T(8, 0)], [at + 60_001, T(8, 0)])).toBe(true);
    // A later record that is not a usable settlement does not show the time was skipped.
    expect(neverSettled(at, [], [T(8, 0)])).toBe(false);
  });

  it('a time with no settlement is kept when no later settlement is known, or when it lies before the settlements fetched', () => {
    const t = setup();
    openLong(t);
    t.ctx.now = T(5, 51);
    t.sim.openFundingWindow(SYMBOL, T(5, 0), t.ctx); // before the gap's settlements were fetched
    t.sim.closeFundingWindow(SYMBOL, T(5, 0), t.ctx);
    run(t, input({ funding: [funding0800], fundingTimes: [T(11, 0)] }));
    expect(t.sim.perp.state.funding.pending.map((w) => w.fundingTime)).toEqual([T(5, 0), T(11, 0)]);
  });

  it('dropFundingWindow removes the open or waiting window of that time only, moving no money', () => {
    const t = setup();
    openLong(t);
    t.ctx.now = T(5, 51);
    t.sim.openFundingWindow(SYMBOL, T(7, 0), t.ctx);
    t.sim.closeFundingWindow(SYMBOL, T(7, 0), t.ctx);
    t.sim.openFundingWindow(SYMBOL, T(8, 0), t.ctx);
    t.sim.dropFundingWindow(SYMBOL, T(9, 0), t.ctx);
    expect(t.sim.perp.state.funding.pending.map((w) => w.fundingTime)).toEqual([T(7, 0)]);
    expect(t.sim.perp.state.funding.windows[SYMBOL]?.fundingTime).toBe(T(8, 0));
    t.sim.dropFundingWindow(SYMBOL, T(7, 0), t.ctx);
    t.sim.dropFundingWindow(SYMBOL, T(8, 0), t.ctx);
    expect(t.sim.perp.state.funding.pending).toEqual([]);
    expect(t.sim.perp.state.funding.windows[SYMBOL]).toBeUndefined();
    expect(s(t.lev().free)).toBe('600');
    expect(s(t.position()!.margin)).toBe('396');
  });

  it('a funding time whose window opens at or after the end of the gap is left to the live path', () => {
    const t = setup();
    openLong(t);
    const to = T(7, 59, 45);
    run(
      t,
      input({
        to,
        candles: minutes('79990', '80010', [], FROM, to),
        markCandles: minutes('79995', '80005', [], FROM, to),
        fundingTimes: [T(8, 0)],
      }),
    );
    expect(t.sim.perp.state.funding.windows[SYMBOL]).toBeUndefined();
    expect(t.sim.perp.state.funding.pending).toEqual([]);
  });
});

describe('liquidateOnMarkRange: live marks held back while catching up (long 0.1 @80000, margin 396)', () => {
  it('a lowest mark at or below the liquidation price liquidates at that price as the mark, as catch-up does', () => {
    // The same position liquidated by catch-up from a mark candle, for comparison.
    const ref = setup();
    openLong(ref);
    const fromCandle = ofType(run(ref, input({ markCandles: markCandles([candle(T(9, 13), '76000', '80000')]) })), 'liquidation');

    const t = setup();
    openLong(t);
    t.ctx.now = T(12, 0, 30);
    const events = t.sim.liquidateOnMarkRange(SYMBOL, D('70000'), D('80100'), t.ctx);
    const [liq] = ofType(events, 'liquidation');
    expect(liq).toBeDefined();
    expect(liq!.time).toBe(T(12, 0, 30));
    expect(liq!.catchUp).toBeUndefined();
    const split = (e: Perp<'liquidation'>) => [s(e.markPrice), s(e.tradingLoss), s(e.liquidationFee), s(e.remainder), s(e.marginLost)];
    expect(split(liq!)).toEqual(split(fromCandle[0]!));
    expect(split(liq!)).toEqual(['76345.3815261', '365.46184739', '30.53815261', '0', '396']);
    expect(t.position()).toBeUndefined();
    expect(s(t.lev().free)).toBe('600');
  });

  it('marks that stayed above the liquidation price liquidate nothing', () => {
    const t = setup();
    openLong(t);
    t.ctx.now = T(12, 0, 30);
    expect(t.sim.liquidateOnMarkRange(SYMBOL, D('76346'), D('90000'), t.ctx)).toEqual([]);
    expect(t.position()).toBeDefined();
  });

  it('a short is liquidated when the highest mark reached its liquidation price', () => {
    const t = setup();
    openShort(t);
    t.ctx.now = T(12, 0, 30);
    const [liq] = ofType(t.sim.liquidateOnMarkRange(SYMBOL, D('70000'), D('83625.5'), t.ctx), 'liquidation');
    expect(s(liq!.markPrice)).toBe('83625.49800797');
    expect(t.position()).toBeUndefined();
  });

  it('does nothing without a position', () => {
    const t = setup();
    expect(t.sim.liquidateOnMarkRange(SYMBOL, D('1'), D('1000000'), t.ctx)).toEqual([]);
  });
});
