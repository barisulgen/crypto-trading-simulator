import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { deposit, emptyLedger } from '../src/account/ledger.ts';
import type { Candle1m, CatchUpInput } from '../src/catchup/types.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import { applyCatchUp, catchUpNeeds, ctxFor, SimEngine } from '../src/sim.ts';
import type { SimCtx, SimEvent } from '../src/sim.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState, putOrder } from '../src/spot/state.ts';
import type { AggTrade, EngineEvent, SpotOrderRequest } from '../src/types.ts';
import { FakeMarket, seedCoins } from './fixtures.ts';
import { FakePerpMarket } from './perpFixtures.ts';

/** A UTC time on the test day, 2026-10-24. */
const T = (h: number, m: number, sec = 0, ms = 0) => Date.UTC(2026, 9, 24, h, m, sec, ms);
const FROM = T(12, 0);
const TO = T(12, 10);
const SYMBOL = 'BTCUSDT';
const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

/**
 * A fresh BTCUSDT book around 60000 (best bid 60050, best ask 60100, last and average 60000),
 * `usdt` in the spot wallet and `btc` coins held at a 60000 cost. Ids and rng are deterministic;
 * `setRng` sets the value every later arrival delay is drawn from (0 → 100 ms, 0.5 → 200 ms).
 */
function setup(opts: { usdt?: string; btc?: string } = {}) {
  const spotMarket = new FakeMarket();
  spotMarket.setBook(SYMBOL, {
    bids: [{ price: D('60050'), qty: D('5') }],
    asks: [{ price: D('60100'), qty: D('5') }],
  });
  spotMarket.setAvgPrice(SYMBOL, D('60000'));
  spotMarket.setLastPrice(SYMBOL, D('60000'));
  const counters = new Map<string, number>();
  let rngValue = 0;
  const ctx: SimCtx = {
    now: T(11, 50),
    rng: () => rngValue,
    newId: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}${n}`;
    },
    spotMarket,
    perpMarket: new FakePerpMarket(),
    fees: { spot: { maker: D('0.001'), taker: D('0.001') }, perp: { maker: D('0.0002'), taker: D('0.0005') } },
  };
  const ledger = emptyLedger(['USDT', 'BTC']);
  const sim = new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));
  const usdt = D(opts.usdt ?? '100000');
  if (usdt.gt(0)) deposit(ledger, 'spot', usdt, ctx);
  seedCoins(sim.spot.state, 'BTC', D(opts.btc ?? '2'), D('60000'));
  const bal = (asset: string) => ledger.balances.spot[asset]!;
  const stored = (id: string) => sim.spot.state.orders.get(id)!;
  const setRng = (v: number) => {
    rngValue = v;
  };
  return { spotMarket, ctx, sim, bal, stored, setRng };
}

type Setup = ReturnType<typeof setup>;

/** Submit at `at`, then arrive at the order's arrival time; returns the order id. */
function place(t: Setup, req: Omit<SpotOrderRequest, 'symbol'>, at = T(11, 50)): string {
  t.ctx.now = at;
  const events = t.sim.submit('spot', { symbol: SYMBOL, ...req } as SpotOrderRequest, t.ctx);
  const e = events[0];
  if (events.length !== 1 || e?.type !== 'order_placed') throw new Error(`not placed: ${JSON.stringify(events)}`);
  t.ctx.now = e.order.arrivesAt!;
  t.sim.arrive('spot', e.order.id, t.ctx);
  return e.order.id;
}

function candle(at: number, low: string, high: string): Candle1m {
  return { openTime: at, open: D(low), high: D(high), low: D(low), close: D(high) };
}

/** One quiet candle per minute of the gap (60000–60050), with the given minutes replaced. */
function candles(overrides: Candle1m[] = []): Candle1m[] {
  const out: Candle1m[] = [];
  for (let m = 0; m < 10; m += 1) {
    const at = T(12, m);
    out.push(overrides.find((c) => c.openTime === at) ?? candle(at, '60000', '60050'));
  }
  return [...overrides.filter((c) => c.openTime < FROM), ...out];
}

function input(c: Candle1m[], trades: AggTrade[] = [], extra: Partial<CatchUpInput> = {}): CatchUpInput {
  return {
    market: 'spot',
    symbol: SYMBOL,
    from: FROM,
    to: TO,
    lastTradeIdBefore: 100,
    endTradeId: null,
    candles: c,
    trades,
    ...extra,
  };
}

function trade(id: number, price: string, qty: string, sellerInitiated: boolean, time: number): AggTrade {
  return { id, price: D(price), qty: D(qty), sellerInitiated, time };
}

/** Run the catch-up at 12:10:01, after the gap. */
function run(t: Setup, inp: CatchUpInput): SimEvent[] {
  t.ctx.now = T(12, 10, 1);
  return applyCatchUp(t.sim, inp, t.ctx);
}

type Spot<K extends EngineEvent['type']> = Extract<EngineEvent, { type: K }>;
const ofType = <K extends EngineEvent['type']>(events: SimEvent[], type: K): Spot<K>[] =>
  events.filter((e) => e.type === type) as Spot<K>[];
const summary = (events: SimEvent[]) => {
  const last = events[events.length - 1];
  if (last?.type !== 'catch_up') throw new Error(`no catch_up summary last in ${events.map((e) => e.type)}`);
  return last;
};
const tag = (basis: string) => ({ from: FROM, to: TO, basis });

/** Every event but the summary carries the catch-up tag, and the times never go backwards. */
function expectTaggedInOrder(events: SimEvent[]): void {
  for (const e of events.slice(0, -1)) expect('catchUp' in e && e.catchUp).toBeTruthy();
  const times = events.map((e) => e.time);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
}

describe('spot catch-up: stops from candles', () => {
  it('a sell stop-loss fills at the low of the minute that reached it, with the taker fee', () => {
    const t = setup();
    const id = place(t, { side: 'sell', type: 'stop_loss', qty: '0.5', triggerPrice: '59000' });
    const usdtBefore = t.bal('USDT').free;
    const bookCalls = t.spotMarket.bookCalls;
    const events = run(
      t,
      input(candles([candle(T(12, 3), '59500', '60000'), candle(T(12, 4), '58800', '59400')])),
    );
    // There is no historical book: the live one is never read.
    expect(t.spotMarket.bookCalls).toBe(bookCalls);

    const [fill] = ofType(events, 'fill');
    expect(ofType(events, 'fill')).toHaveLength(1);
    expect(fill!.time).toBe(T(12, 4));
    expect(fill!.order.id).toBe(id);
    expect(fill!.order.status).toBe('filled');
    expect(s(fill!.fill.qty)).toBe('0.5');
    expect(s(fill!.fill.price)).toBe('58800');
    expect(s(fill!.fill.quote)).toBe('29400');
    expect(s(fill!.fill.fee)).toBe('29.4');
    expect(fill!.fill.feeAsset).toBe('USDT');
    expect(fill!.fill.liquidity).toBe('taker');
    expect(fill!.fill.time).toBe(T(12, 4));
    expect(fill!.catchUp).toEqual(tag('candle_worst_price'));
    // Average cost 60000: proceeds 29400 − 29.4 fee − cost 30000.
    expect(s(fill!.fill.realizedPnl)).toBe('-629.4');

    const triggered = ofType(events, 'order_triggered');
    expect(triggered.map((e) => [e.time, e.order.id])).toEqual([[T(12, 4), id]]);

    const sum = summary(events);
    expect(sum).toMatchObject({ type: 'catch_up', market: 'spot', symbol: SYMBOL, from: FROM, to: TO });
    expect(sum.actions).toContain('Stop-loss filled 0.5 BTC at 58800 (worst price of 12:04 UTC; estimated)');
    expectTaggedInOrder(events);

    expect(s(t.bal('USDT').free)).toBe(s(usdtBefore.plus('29370.6')));
    expect(s(t.bal('BTC').locked)).toBe('0');
    expect(s(t.bal('BTC').free)).toBe('1.5');
  });

  it('a pair whose two legs trigger in one minute: the stop-loss fills, the take-profit is cancelled', () => {
    const t = setup();
    t.ctx.now = T(11, 50);
    const legs = t.sim.spot.attachOco(
      { symbol: SYMBOL, qty: '0.5', stopLoss: '59000', takeProfit: '61000' },
      ctxFor(t.ctx, 'spot'),
    );
    const [sl, tp] = legs.map((e) => (e.type === 'order_placed' ? e.order : null));
    t.ctx.now = sl!.arrivesAt!;
    t.sim.arrive('spot', sl!.id, t.ctx);
    expect(t.stored(tp!.id).status).toBe('open');

    const events = run(t, input(candles([candle(T(12, 4), '58800', '61200')])));
    expect(summary(events).actions).toEqual([
      'Stop-loss filled 0.5 BTC at 58800 (worst price of 12:04 UTC; estimated)',
      'Take-profit 0.5 BTC cancelled: the other order of its pair triggered (estimated)',
    ]);
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.id, s(e.fill.price), s(e.fill.qty)])).toEqual([[sl!.id, '58800', '0.5']]);
    const cancelled = ofType(events, 'order_cancelled');
    expect(cancelled.map((e) => [e.order.id, e.reason, e.time])).toEqual([[tp!.id, 'oco', T(12, 4)]]);
    expect(cancelled[0]!.catchUp).toEqual(tag('candle_worst_price'));
    expect(t.stored(tp!.id).status).toBe('cancelled');
    expect(s(t.bal('BTC').locked)).toBe('0');
    expectTaggedInOrder(events);
  });

  it('a qty-sized buy stop whose cost at the minute high exceeds its lock and free USDT expires', () => {
    const t = setup({ usdt: '6100', btc: '0' });
    const id = place(t, { side: 'buy', type: 'stop_loss', qty: '0.1', triggerPrice: '61000' });
    expect(s(t.bal('USDT').locked)).toBe('6100');
    expect(s(t.bal('USDT').free)).toBe('0');

    const events = run(t, input(candles([candle(T(12, 4), '60500', '62000')])));
    const [rejected] = ofType(events, 'order_rejected');
    expect(ofType(events, 'order_rejected')).toHaveLength(1);
    expect(rejected!.order.id).toBe(id);
    expect(rejected!.afterTrigger).toBe(true);
    expect(rejected!.time).toBe(T(12, 4));
    expect(rejected!.reason).toBe(
      'Triggered stop expired: insufficient funds at execution ' +
        '(need 6200, available 6100; trigger 61000, candle worst 62000)',
    );
    expect(rejected!.catchUp).toEqual(tag('candle_worst_price'));
    expect(summary(events).actions).toEqual([`Buy stop-loss expired at 12:04 UTC (estimated): ${rejected!.reason}`]);
    expect(ofType(events, 'fill')).toEqual([]);
    expect(s(t.bal('USDT').free)).toBe('6100');
    expect(s(t.bal('USDT').locked)).toBe('0');
    expectTaggedInOrder(events);
  });

  /** A sell stop-loss 0.5 @59000 triggered at 11:59:30, whose arrival found the data stale: it waits. */
  function triggeredBeforeGap() {
    const t = setup();
    const id = place(t, { side: 'sell', type: 'stop_loss', qty: '0.5', triggerPrice: '59000' });
    t.ctx.now = T(11, 59, 30);
    const fired = t.sim.onTrade('spot', SYMBOL, trade(50, '58990', '1', true, T(11, 59, 30)), t.ctx);
    expect(fired.map((e) => e.type)).toEqual(['order_triggered']);
    t.spotMarket.setFresh(SYMBOL, false);
    t.ctx.now = t.stored(id).arrivesAt!;
    expect(t.sim.arrive('spot', id, t.ctx)).toEqual([]);
    expect(t.stored(id)).toMatchObject({ status: 'triggered', arrivesAt: null });
    return { t, id };
  }

  it('a stop triggered before the gap and still waiting fills at the low of its trigger minute', () => {
    const { t, id } = triggeredBeforeGap();
    const events = run(t, input(candles([candle(T(11, 59), '58700', '59100')])));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.id, s(e.fill.price), s(e.fill.qty)])).toEqual([[id, '58700', '0.5']]);
    expect(fills[0]!.time).toBe(T(11, 59, 30));
    expect(fills[0]!.catchUp).toEqual(tag('trigger_minute_worst_price'));
    expect(summary(events).actions).toEqual([
      'Stop-loss filled 0.5 BTC at 58700 (worst price of 11:59 UTC, its trigger minute; estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('without its trigger minute’s candle, it fills at the first walked minute’s low, dated in that minute', () => {
    const { t, id } = triggeredBeforeGap();
    const events = run(t, input(candles([candle(T(12, 0), '59700', '60050')])));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.id, s(e.fill.price), e.time])).toEqual([[id, '59700', T(12, 0)]]);
    expectTaggedInOrder(events);
  });

  it('a stop that armed only after a minute ended is not checked against that minute', () => {
    const t = setup();
    const id = place(t, { side: 'sell', type: 'stop_loss', qty: '0.5', triggerPrice: '59000' });
    // As if the stop reached the exchange at 12:06:30.
    putOrder(t.sim.spot.state, { ...t.stored(id), arrivesAt: T(12, 6, 30) });
    const events = run(t, input(candles([candle(T(12, 4), '58800', '59400'), candle(T(12, 7), '58500', '59400')])));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.id, s(e.fill.price), e.time])).toEqual([[id, '58500', T(12, 7)]]);
  });

  it('an attached pair that waited for data arms at the start of the gap', () => {
    const t = setup();
    t.ctx.now = T(11, 50);
    const placed = t.sim.submit(
      'spot',
      { symbol: SYMBOL, side: 'buy', type: 'market', qty: '0.1', attach: { stopLoss: '59500', takeProfit: '62000' } },
      t.ctx,
    );
    t.ctx.now = placed[0]!.time + 1000;
    const done = t.sim.arrive('spot', (placed[0] as Spot<'order_placed'>).order.id, t.ctx);
    const [sl, tp] = ofType(done, 'order_placed').map((e) => e.order);
    // The data goes stale before the pair arrives: it waits for data, unarmed.
    t.spotMarket.setFresh(SYMBOL, false);
    t.ctx.now = sl!.arrivesAt!;
    t.sim.arrive('spot', sl!.id, t.ctx);
    expect(t.stored(sl!.id)).toMatchObject({ status: 'pending', arrivesAt: null });

    const events = run(t, input(candles([candle(T(12, 3), '59400', '60000')])));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.id, s(e.fill.qty), s(e.fill.price), e.time])).toEqual([
      [sl!.id, '0.0999', '59400', T(12, 3)],
    ]);
    expect(ofType(events, 'order_cancelled').map((e) => [e.order.id, e.reason])).toEqual([[tp!.id, 'oco']]);
    expectTaggedInOrder(events);
  });
});

describe('spot catch-up: limit orders from replayed trades', () => {
  const limitTrades = () => [
    trade(99, '59000', '1', true, T(12, 5, 1)),
    trade(101, '59950', '0.3', true, T(12, 5, 10)),
    trade(102, '59940', '5', false, T(12, 5, 20)),
    trade(103, '60000', '2', true, T(12, 5, 30)),
    trade(104, '59990', '1.0', true, T(12, 5, 40)),
  ];

  it('asks for the trades of the minutes whose candle went strictly through a resting limit', () => {
    const t = setup();
    place(t, { side: 'buy', type: 'limit', qty: '1.0', price: '60000' });
    const c = candles([candle(T(12, 5), '59900', '60050')]);
    expect(catchUpNeeds(t.sim, 'spot', SYMBOL, FROM, TO, c)).toEqual({
      tradeMinutes: [T(12, 5)],
      markCandles: false,
      funding: false,
    });
    // A candle that only touches the limit (low 60000) needs no trades.
    expect(catchUpNeeds(t.sim, 'spot', SYMBOL, FROM, TO, candles()).tradeMinutes).toEqual([]);
  });

  it('a sell limit is crossed by a high above it', () => {
    const t = setup();
    place(t, { side: 'sell', type: 'limit', qty: '0.5', price: '60100' });
    const c = candles([candle(T(12, 2), '60000', '60100'), candle(T(12, 7), '60000', '60100.01')]);
    expect(catchUpNeeds(t.sim, 'spot', SYMBOL, FROM, TO, c).tradeMinutes).toEqual([T(12, 7)]);
  });

  it('fills a buy limit at its price from the seller-initiated trades strictly below it, maker fee in BTC', () => {
    const t = setup();
    const id = place(t, { side: 'buy', type: 'limit', qty: '1.0', price: '60000' });
    expect(s(t.bal('USDT').locked)).toBe('60000');
    const btcBefore = t.bal('BTC').free;

    const events = run(t, input(candles([candle(T(12, 5), '59900', '60050')]), limitTrades()));
    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.time, s(e.fill.qty), s(e.fill.price), s(e.fill.fee), e.fill.feeAsset])).toEqual([
      [T(12, 5, 10), '0.3', '60000', '0.0003', 'BTC'],
      [T(12, 5, 40), '0.7', '60000', '0.0007', 'BTC'],
    ]);
    for (const f of fills) {
      expect(f.fill.liquidity).toBe('maker');
      expect(f.catchUp).toEqual(tag('aggtrade_replay'));
    }
    expect(t.stored(id).status).toBe('filled');
    expect(s(t.bal('USDT').locked)).toBe('0');
    expect(s(t.bal('BTC').free)).toBe(s(btcBefore.plus('0.999')));
    expect(summary(events).actions).toEqual([
      'Limit buy filled 0.3 BTC at 60000 (replayed trade at 12:05:10 UTC; estimated)',
      'Limit buy filled 0.7 BTC at 60000 (replayed trade at 12:05:40 UTC; estimated)',
    ]);
    expectTaggedInOrder(events);
  });

  it('uses no trade at or after endTradeId, nor one at or before the order’s arrival', () => {
    const t = setup();
    const id = place(t, { side: 'buy', type: 'limit', qty: '1.0', price: '60000' });
    // As if the order reached the exchange at 12:05:10 exactly: trade #101 at that time is not used.
    putOrder(t.sim.spot.state, { ...t.stored(id), arrivesAt: T(12, 5, 10) });
    const events = run(
      t,
      input(candles([candle(T(12, 5), '59900', '60050')]), limitTrades(), { endTradeId: 104 }),
    );
    expect(ofType(events, 'fill')).toEqual([]);
    expect(t.stored(id).status).toBe('open');
    // Something was open, so the summary is there, with nothing done.
    expect(summary(events).actions).toEqual([]);
  });

  it('with endTradeId unknown, a trade-through after the end of the gap is not used', () => {
    const t = setup();
    const id = place(t, { side: 'buy', type: 'limit', qty: '1.0', price: '60000' });
    const to = T(12, 9, 30);
    const trades = [trade(101, '59900', '0.3', true, T(12, 9, 20)), trade(102, '59900', '0.5', true, to + 5000)];
    const events = run(t, input(candles([candle(T(12, 9), '59900', '60050')]), trades, { to }));
    expect(ofType(events, 'fill').map((e) => [s(e.fill.qty), e.time])).toEqual([['0.3', T(12, 9, 20)]]);
    expect(t.sim.spot.state.lastTradeId[SYMBOL]).toBe(101);
    expect(s(t.stored(id).filledQty)).toBe('0.3');
  });

  it('a minute given twice is walked once', () => {
    const t = setup({ usdt: '200000' });
    const id = place(t, { side: 'buy', type: 'limit', qty: '2.0', price: '60000' });
    const crossed = candle(T(12, 5), '59900', '60050');
    const events = run(t, input([...candles([crossed]), crossed], [trade(101, '59950', '0.3', true, T(12, 5, 10))]));
    expect(ofType(events, 'fill').map((e) => s(e.fill.qty))).toEqual(['0.3']);
    expect(s(t.stored(id).filledQty)).toBe('0.3');
  });

  it('a trade repeated in the fetched list (a page boundary) is used once', () => {
    const t = setup({ usdt: '200000' });
    const id = place(t, { side: 'buy', type: 'limit', qty: '2.0', price: '60000' });
    const repeated = trade(101, '59950', '0.3', true, T(12, 5, 10));
    const events = run(t, input(candles([candle(T(12, 5), '59900', '60050')]), [repeated, { ...repeated }]));
    expect(ofType(events, 'fill').map((e) => s(e.fill.qty))).toEqual(['0.3']);
    expect(s(t.stored(id).filledQty)).toBe('0.3');
  });

  it('two runs over overlapping gaps use a shared trade once, and the live feed then ignores it', () => {
    const t = setup({ usdt: '200000' });
    const id = place(t, { side: 'buy', type: 'limit', qty: '2.0', price: '60000' });
    const shared = trade(101, '59950', '0.3', true, T(12, 5, 10));
    const later = trade(105, '59950', '0.2', true, T(12, 6, 10));
    const first = run(t, input(candles([candle(T(12, 5), '59900', '60050')]), [shared]));
    expect(ofType(first, 'fill').map((e) => s(e.fill.qty))).toEqual(['0.3']);
    expect(t.sim.spot.state.lastTradeId[SYMBOL]).toBe(101);

    // A second gap, 12:05–12:15, overlapping the first; its trades include the shared one again.
    const second: Candle1m[] = [];
    for (let m = 5; m < 15; m += 1) second.push(candle(T(12, m), m <= 6 ? '59900' : '60000', '60050'));
    t.ctx.now = T(12, 15, 1);
    const events = applyCatchUp(
      t.sim,
      input(second, [shared, later], { from: T(12, 5), to: T(12, 15) }),
      t.ctx,
    );
    expect(ofType(events, 'fill').map((e) => [s(e.fill.qty), e.time])).toEqual([['0.2', T(12, 6, 10)]]);
    expect(s(t.stored(id).filledQty)).toBe('0.5');
    expect(t.sim.spot.state.lastTradeId[SYMBOL]).toBe(105);

    // Live again: a trade at or below the raised cursor is a replay and is ignored.
    t.spotMarket.setFresh(SYMBOL, true);
    t.ctx.now = T(12, 15, 2);
    expect(t.sim.onTrade('spot', SYMBOL, trade(105, '59000', '1', true, T(12, 15, 2)), t.ctx)).toEqual([]);
    expect(s(t.stored(id).filledQty)).toBe('0.5');
    const live = t.sim.onTrade('spot', SYMBOL, trade(106, '59000', '1', true, T(12, 15, 2)), t.ctx);
    expect(ofType(live, 'fill').map((e) => s(e.fill.qty))).toEqual(['1']);
  });

  it('an attached pair placed by a replayed fill is checked against the same minute in a second pass', () => {
    const t = setup();
    const id = place(t, {
      side: 'buy',
      type: 'limit',
      qty: '1.0',
      price: '60000',
      attach: { stopLoss: '59500', takeProfit: '62000' },
    });
    const events = run(t, input(candles([candle(T(12, 5), '59400', '60050')]), limitTrades()));

    const fills = ofType(events, 'fill');
    expect(fills.map((e) => [e.order.type, s(e.fill.qty), s(e.fill.price), e.catchUp?.basis])).toEqual([
      ['limit', '0.3', '60000', 'aggtrade_replay'],
      ['limit', '0.7', '60000', 'aggtrade_replay'],
      ['stop_loss', '0.999', '59400', 'candle_worst_price'],
    ]);
    const sl = fills[2]!;
    expect(sl.order.parentId).toBe(id);
    expect(sl.time).toBe(T(12, 5, 40));
    const placed = ofType(events, 'order_placed');
    expect(placed.map((e) => [e.order.type, e.time, e.catchUp?.basis])).toEqual([
      ['stop_loss', T(12, 5, 40), 'aggtrade_replay'],
      ['take_profit', T(12, 5, 40), 'aggtrade_replay'],
    ]);
    const tp = placed[1]!.order;
    expect(ofType(events, 'order_cancelled').map((e) => [e.order.id, e.reason])).toEqual([[tp.id, 'oco']]);
    expect(summary(events).actions).toContain(
      'Stop-loss filled 0.999 BTC at 59400 (worst price of 12:05 UTC; estimated)',
    );
    expectTaggedInOrder(events);
  });
});

describe('spot catch-up: cancels in flight across the gap', () => {
  /** A resting buy limit 1.0 @60000, whose owner asks to cancel at 12:04:50 (arrives 12:04:50.2). */
  function withCancel() {
    const t = setup();
    const id = place(t, { side: 'buy', type: 'limit', qty: '1.0', price: '60000' });
    t.setRng(0.5);
    t.ctx.now = T(12, 4, 50);
    expect(t.sim.cancel('spot', id, t.ctx)).toEqual({ ok: true, events: [] });
    expect(t.stored(id).cancelArrivesAt).toBe(T(12, 4, 50, 200));
    return { t, id };
  }
  const crossed = () => candles([candle(T(12, 4), '59900', '60050')]);

  it('a trade-through before the cancel arrives fills the order; the cancel is rejected at its arrival', () => {
    const { t, id } = withCancel();
    const events = run(t, input(crossed(), [trade(101, '59900', '1', true, T(12, 4, 30))]));
    expect(ofType(events, 'fill').map((e) => [e.order.id, s(e.fill.qty), e.time])).toEqual([
      [id, '1', T(12, 4, 30)],
    ]);
    const [late] = ofType(events, 'cancel_rejected');
    expect(late!.time).toBe(T(12, 4, 50, 200));
    expect(late!.reason).toBe('Cancel arrived too late: order already filled');
    expect(late!.catchUp).toEqual(tag('cancel_arrival'));
    expect(summary(events).actions).toEqual([
      'Limit buy filled 1 BTC at 60000 (replayed trade at 12:04:30 UTC; estimated)',
      'Cancel of limit buy arrived at 12:04:50 UTC: order already filled (estimated)',
    ]);
    expect(t.stored(id).cancelArrivesAt).toBeNull();
    expectTaggedInOrder(events);
  });

  it('without that trade the order is cancelled at the cancel’s arrival, and a later trade fills nothing', () => {
    const { t, id } = withCancel();
    const events = run(t, input(crossed(), [trade(101, '59900', '1', true, T(12, 4, 55))]));
    expect(ofType(events, 'fill')).toEqual([]);
    const [cancelled] = ofType(events, 'order_cancelled');
    expect(ofType(events, 'order_cancelled')).toHaveLength(1);
    expect(cancelled!.order.id).toBe(id);
    expect(cancelled!.reason).toBe('user');
    expect(cancelled!.time).toBe(T(12, 4, 50, 200));
    expect(cancelled!.catchUp).toEqual(tag('cancel_arrival'));
    expect(s(cancelled!.cancelledQty)).toBe('1');
    expect(summary(events).actions).toEqual(['Cancel of limit buy 1 BTC took effect at 12:04:50 UTC (estimated)']);
    expect(s(t.bal('USDT').locked)).toBe('0');
    expectTaggedInOrder(events);
  });
});

describe('spot catch-up: nothing open', () => {
  it('produces no events at all and asks for no trades', () => {
    const t = setup();
    const c = candles([candle(T(12, 4), '50000', '70000')]);
    expect(catchUpNeeds(t.sim, 'spot', SYMBOL, FROM, TO, c)).toEqual({
      tradeMinutes: [],
      markCandles: false,
      funding: false,
    });
    expect(run(t, input(c))).toEqual([]);
  });
});
