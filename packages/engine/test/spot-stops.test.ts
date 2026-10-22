import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import { isTriggered } from '../src/spot/triggers.ts';
import type { AggTrade, EngineCtx, EngineEvent, Fill, SpotOrder, SpotOrderRequest } from '../src/types.ts';
import { btcRules, FakeMarket, seedCoins, testCtx } from './fixtures.ts';

const NOW = 1_000_000;
const EXECUTING = 'Order is already executing and cannot be cancelled';
const ESTIMATE = 'Estimate if triggered now';

/** sampleBook, last price 99.95, 1000 USDT (unless given) and 2 BTC in the spot wallet. */
function setup(opts: { usdt?: string; btc?: string } = {}) {
  const market = new FakeMarket();
  const ctx = testCtx(market, { now: NOW });
  const engine = new SpotEngine(emptySpotState(['USDT', 'BTC']));
  const usdt = D(opts.usdt ?? '1000');
  if (usdt.gt(0)) engine.deposit('spot', usdt, ctx);
  seedCoins(engine.state, 'BTC', D(opts.btc ?? '2'));
  const bal = (asset: string) => engine.state.balances.spot[asset]!;
  const stored = (id: string) => engine.state.orders.get(id)!;
  return { market, ctx, engine, bal, stored };
}

type StopType = 'stop_loss' | 'take_profit';
const stop = (side: 'buy' | 'sell', type: StopType, triggerPrice: string, fields: Partial<SpotOrderRequest>) =>
  ({ symbol: 'BTCUSDT', side, type, triggerPrice, ...fields }) as SpotOrderRequest;
const sellStop = (trigger: string, qty: string) => stop('sell', 'stop_loss', trigger, { qty });
const buyStop = (trigger: string, qty: string) => stop('buy', 'stop_loss', trigger, { qty });

let tradeId = 0;
function trade(price: string, qty = '1', sellerInitiated = true): AggTrade {
  tradeId += 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

function only<T extends EngineEvent['type']>(events: EngineEvent[], type: T): Extract<EngineEvent, { type: T }> {
  expect(events.map((e) => e.type)).toEqual([type]);
  return events[0] as Extract<EngineEvent, { type: T }>;
}
const placed = (events: EngineEvent[]): SpotOrder => only(events, 'order_placed').order;
/** The orders of every order_placed event, in order. */
const placedOrders = (events: EngineEvent[]): SpotOrder[] =>
  events.flatMap((e) => (e.type === 'order_placed' ? [e.order] : []));
const reasons = (events: EngineEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'order_rejected' ? [e.reason] : []));
const limit = (side: 'buy' | 'sell', price: string, qty: string, extra: Partial<SpotOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'limit', price, qty, ...extra }) as SpotOrderRequest;
function rejectReason(events: EngineEvent[]): string {
  const e = only(events, 'order_rejected');
  expect(e.order.status).toBe('rejected');
  expect(e.order.rejectReason).toBe(e.reason);
  return e.reason;
}
function fillOf(events: EngineEvent[]): { fill: Fill; order: SpotOrder } {
  const e = events.find((x) => x.type === 'fill');
  if (!e || e.type !== 'fill') throw new Error(`no fill event in ${events.map((x) => x.type).join(', ')}`);
  return { fill: e.fill, order: e.order };
}

/** Arrive at the order's arrival time (arrive is a no-op before it). */
function arriveNow(engine: SpotEngine, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

/** Submit, arrive and expect the order armed (open, no events); returns the order id. */
function arm(engine: SpotEngine, r: SpotOrderRequest, ctx: EngineCtx): string {
  const order = placed(engine.submit(r, ctx));
  expect(arriveNow(engine, order, ctx)).toEqual([]);
  expect(engine.state.orders.get(order.id)!.status).toBe('open');
  return order.id;
}

/** Request a cancel and deliver it at its arrival time; returns what its arrival did. */
function cancelNow(engine: SpotEngine, id: string, ctx: EngineCtx): EngineEvent[] {
  const r = engine.cancel(id, ctx);
  if (!r.ok) throw new Error(r.reason);
  expect(r.events).toEqual([]);
  ctx.now = Math.max(ctx.now, engine.state.orders.get(id)!.cancelArrivesAt!);
  return engine.arriveCancel(id, ctx);
}

/** Arm, then trigger with a trade at `at`; returns the triggered order. */
function armAndTrigger(engine: SpotEngine, r: SpotOrderRequest, at: string, ctx: EngineCtx): SpotOrder {
  const id = arm(engine, r, ctx);
  const e = only(engine.onTrade('BTCUSDT', trade(at), ctx), 'order_triggered');
  expect(e.order.id).toBe(id);
  return e.order;
}

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());
const book = (bids: [string, string][], asks: [string, string][]) => ({
  bids: bids.map(([p, q]) => ({ price: D(p), qty: D(q) })),
  asks: asks.map(([p, q]) => ({ price: D(p), qty: D(q) })),
});

describe('isTriggered', () => {
  it('sell stop ≤, buy stop ≥, sell take-profit ≥, buy take-profit ≤', () => {
    const at = (type: StopType, side: 'buy' | 'sell', trigger: string, lasts: string[]) =>
      lasts.map((last) => isTriggered(type, side, D(trigger), D(last)));
    expect(at('stop_loss', 'sell', '99', ['99.01', '99', '98'])).toEqual([false, true, true]);
    expect(at('stop_loss', 'buy', '101', ['100.99', '101', '102'])).toEqual([false, true, true]);
    expect(at('take_profit', 'sell', '110', ['109.99', '110', '111'])).toEqual([false, true, true]);
    expect(at('take_profit', 'buy', '90', ['90.01', '90', '89'])).toEqual([false, true, true]);
  });
});

describe('placing a stop', () => {
  it('sell stop_loss trigger 99.00 qty 1 → pending, then open after arrival, BTC 1 locked', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(sellStop('99.00', '1'), ctx));
    expect(order.status).toBe('pending');
    expect(order.type).toBe('stop_loss');
    expect(s(order.triggerPrice)).toBe('99');
    expect(s(order.qty)).toBe('1');
    expect(order.lockAsset).toBe('BTC');
    expect(s(order.lockAmount)).toBe('1');
    expect(order.arrivesAt).toBe(NOW + 100);
    expect(s(bal('BTC').locked)).toBe('1');
    expect(s(bal('BTC').free)).toBe('1');

    expect(arriveNow(engine, order, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('open');
    expect(s(stored(order.id).lockAmount)).toBe('1');
    expect(s(bal('BTC').locked)).toBe('1');
  });

  it('would trigger now at placement → rejected, nothing locked', () => {
    const { market, ctx, engine, bal } = setup();
    market.setLastPrice('BTCUSDT', D('98.90'));
    expect(rejectReason(engine.submit(sellStop('99.00', '1'), ctx))).toBe(
      'Stop would trigger immediately (last 98.9, trigger 99)',
    );
    expect(rejectReason(engine.submit(stop('sell', 'take_profit', '98.50', { qty: '1' }), ctx))).toBe(
      'Take-profit would trigger immediately (last 98.9, trigger 98.5)',
    );
    expect(s(bal('BTC').locked)).toBe('0');
  });

  it('would trigger at arrival → rejected like the exchange would, lock released', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(sellStop('99.00', '1'), ctx));
    market.setLastPrice('BTCUSDT', D('98.90'));
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe('Stop would trigger immediately (last 98.9, trigger 99)');
    expect(stored(order.id).status).toBe('rejected');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');
  });

  it('stale at submit or at arrival → rejected; last price unavailable → rejected', () => {
    const { market, ctx, engine, bal } = setup();
    const order = placed(engine.submit(sellStop('99.00', '1'), ctx));
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(engine.submit(sellStop('99.00', '1'), ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(s(bal('BTC').locked)).toBe('0');
    market.setFresh('BTCUSDT', true);
    market.setLastPrice('BTCUSDT', null);
    expect(rejectReason(engine.submit(sellStop('99.00', '1'), ctx))).toBe('Last price unavailable for BTCUSDT');
  });

  it('owner stops: no average price needed; a missing last price rejects at arrival and for a pair', () => {
    const { market, ctx, engine, stored } = setup();
    market.setAvgPrice('BTCUSDT', null);
    const id = arm(engine, sellStop('99.00', '0.5'), ctx);
    expect(stored(id).status).toBe('open');

    const pending = placed(engine.submit(sellStop('98.00', '0.5'), ctx));
    market.setLastPrice('BTCUSDT', null);
    expect(rejectReason(arriveNow(engine, pending, ctx))).toBe('Last price unavailable for BTCUSDT');
    const pair = engine.attachOco({ symbol: 'BTCUSDT', qty: '0.5', stopLoss: '95', takeProfit: '110' }, ctx);
    expect(reasons(pair)).toEqual(['Last price unavailable for BTCUSDT', 'Last price unavailable for BTCUSDT']);
  });

  it('request problems: trigger missing, filters, funds, attach on a stop', () => {
    const { ctx, engine } = setup({ usdt: '50' });
    expect(rejectReason(engine.submit(stop('sell', 'stop_loss', '', { qty: '1' }), ctx))).toBe('Enter a trigger price');
    expect(rejectReason(engine.submit(stop('sell', 'stop_loss', '99', {}), ctx))).toBe(
      'Enter either a coin amount or a dollar amount',
    );
    expect(rejectReason(engine.submit(sellStop('99.005', '1'), ctx))).toBe(
      'PRICE_FILTER: trigger price 99.005 is not a multiple of tick size 0.01',
    );
    expect(rejectReason(engine.submit(sellStop('99', '0.05'), ctx))).toBe(
      'NOTIONAL: order value 4.95 is below the minimum 5',
    );
    expect(rejectReason(engine.submit(sellStop('99', '3'), ctx))).toBe('Insufficient BTC: need 3, available 2');
    expect(rejectReason(engine.submit(buyStop('101', '0.5'), ctx))).toBe('Insufficient USDT: need 50.5, available 50');
    const attach = { stopLoss: '95', takeProfit: '110' };
    expect(rejectReason(engine.submit(stop('buy', 'stop_loss', '101', { qty: '0.1', attach }), ctx))).toBe(
      'Attached stop-loss and take-profit cannot be added to a stop or take-profit order',
    );
  });

  it('dollar-sized sell stop: quoteQty 49.50 at trigger 99 → qty 0.5, BTC 0.5 locked', () => {
    const { ctx, engine, bal } = setup();
    const order = placed(engine.submit(stop('sell', 'stop_loss', '99', { quoteQty: '49.50' }), ctx));
    expect(s(order.qty)).toBe('0.5');
    expect(s(order.quoteQty)).toBe('49.5');
    expect(s(order.lockAmount)).toBe('0.5');
    expect(s(bal('BTC').locked)).toBe('0.5');
  });

  it('6th live stop/take-profit on BTCUSDT → MAX_NUM_ALGO_ORDERS (pending, open and triggered all count)', () => {
    const { ctx, engine } = setup();
    armAndTrigger(engine, sellStop('99', '0.1'), '99', ctx); // triggered
    arm(engine, sellStop('98', '0.1'), ctx); // open
    placed(engine.submit(sellStop('97', '0.1'), ctx)); // pending
    placed(engine.submit(stop('sell', 'take_profit', '110', { qty: '0.1' }), ctx));
    const fifth = placed(engine.submit(buyStop('101', '0.1'), ctx));
    // Limit orders are not algo orders.
    placed(engine.submit(limit('buy', '99', '0.1'), ctx));
    expect(rejectReason(engine.submit(sellStop('96', '0.1'), ctx))).toBe(
      'MAX_NUM_ALGO_ORDERS: already 5 open stop/take-profit orders on BTCUSDT (maximum 5)',
    );
    expect(only(cancelNow(engine, fifth.id, ctx), 'order_cancelled').reason).toBe('user');
    placed(engine.submit(sellStop('96', '0.1'), ctx));
  });
});

describe('trigger and execution', () => {
  it('onTrade(99.01) does not trigger; onTrade(99.00) triggers with a new arrival delay', () => {
    const { ctx, engine, stored } = setup();
    const id = arm(engine, sellStop('99.00', '1'), ctx);
    expect(engine.onTrade('BTCUSDT', trade('99.01', '1', false), ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');

    ctx.now += 5_000;
    const e = only(engine.onTrade('BTCUSDT', trade('99.00', '0.001', false), ctx), 'order_triggered');
    expect(e.time).toBe(ctx.now);
    expect(s(e.lastPrice)).toBe('99');
    expect(e.order.status).toBe('triggered');
    expect(e.order.triggeredAt).toBe(ctx.now);
    expect(e.order.arrivesAt).toBe(ctx.now + 100);
    expect(s(e.order.bestAtSubmit)).toBe('99.9'); // best bid at trigger time
    expect(stored(id)).toEqual(e.order);
    // Already triggered: a further trade does nothing.
    expect(engine.onTrade('BTCUSDT', trade('98', '1'), ctx)).toEqual([]);
  });

  it('triggers are paused while the symbol is stale', () => {
    const { market, ctx, engine, stored } = setup();
    const id = arm(engine, sellStop('99.00', '1'), ctx);
    market.setFresh('BTCUSDT', false);
    expect(engine.onTrade('BTCUSDT', trade('98.00'), ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
  });

  it('gap: the triggered sell stop fills at whatever the book offers, never at the stop price', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const triggered = armAndTrigger(engine, sellStop('99.00', '1'), '99.00', ctx);
    market.setBook('BTCUSDT', book([['97.50', '2']], [['100', '1']]));
    const events = arriveNow(engine, triggered, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const { fill, order } = fillOf(events);
    expect(s(fill.price)).toBe('97.5');
    expect(s(fill.qty)).toBe('1');
    expect(s(fill.triggerPrice)).toBe('99');
    expect(fill.liquidity).toBe('taker');
    expect(fill.feeAsset).toBe('USDT');
    expect(s(fill.fee)).toBe('0.0975');
    expect(s(fill.bestAtSubmit)).toBe('99.9');
    expect(s(fill.bestAtArrival)).toBe('97.5');
    expect(s(fill.driftUsd)).toBe('2.4'); // best bid fell 99.9 → 97.5 between trigger and execution
    expect(s(fill.slippageUsd)).toBe('0');
    expect(order.status).toBe('filled');
    expect(stored(triggered.id).status).toBe('filled');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('1');
    expect(s(bal('USDT').free)).toBe('1097.4025');
  });

  it('thin book after trigger: fills what it can, the rest is cancelled (thin_book)', () => {
    const { market, ctx, engine, bal } = setup();
    const triggered = armAndTrigger(engine, sellStop('99.00', '1'), '99.00', ctx);
    market.setBook('BTCUSDT', book([['98', '0.3']], []));
    const events = arriveNow(engine, triggered, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_cancelled']);
    expect(s(fillOf(events).fill.qty)).toBe('0.3');
    const cancel = events[1]!;
    if (cancel.type !== 'order_cancelled') throw new Error('expected order_cancelled');
    expect(cancel.reason).toBe('thin_book');
    expect(s(cancel.cancelledQty)).toBe('0.7');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('1.7');
  });

  it('triggered + stale at arrival: no rejection, stays triggered, fills on the first fresh book (onFresh)', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const triggered = armAndTrigger(engine, sellStop('99.00', '1'), '99.00', ctx);
    market.setFresh('BTCUSDT', false);
    expect(arriveNow(engine, triggered, ctx)).toEqual([]);
    expect(stored(triggered.id).status).toBe('triggered');
    expect(stored(triggered.id).arrivesAt).toBeNull();
    expect(s(bal('BTC').locked)).toBe('1');
    expect(engine.cancel(triggered.id, ctx)).toEqual({ ok: false, reason: EXECUTING });
    // Still stale: onFresh does nothing.
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);

    ctx.now += 60_000;
    market.setFresh('BTCUSDT', true);
    market.setBook('BTCUSDT', book([['98.00', '5']], [['98.10', '5']]));
    const events = engine.onFresh('BTCUSDT', ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const { fill } = fillOf(events);
    expect(s(fill.price)).toBe('98');
    expect(fill.time).toBe(ctx.now);
    expect(stored(triggered.id).status).toBe('filled');
    expect(s(bal('BTC').locked)).toBe('0');
    // Nothing left to execute; a late arrive is a no-op.
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(engine.arrive(triggered.id, ctx)).toEqual([]);
  });

  it('onFresh leaves a triggered order alone until its arrival time', () => {
    const { ctx, engine, stored } = setup();
    const triggered = armAndTrigger(engine, sellStop('99.00', '1'), '99.00', ctx);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(engine.onFresh('ETHUSDT', ctx)).toEqual([]);
    expect(stored(triggered.id).status).toBe('triggered');
    ctx.now = triggered.arrivesAt!;
    expect(fillOf(engine.onFresh('BTCUSDT', ctx)).order.status).toBe('filled');
  });

  it('a deferred triggered stop fills on the next fresh trade even if onFresh was missed', () => {
    const { market, ctx, engine, stored } = setup();
    const triggered = armAndTrigger(engine, sellStop('99.00', '1'), '99.00', ctx);
    market.setFresh('BTCUSDT', false);
    expect(arriveNow(engine, triggered, ctx)).toEqual([]);
    expect(stored(triggered.id).arrivesAt).toBeNull();
    // A trade while still stale executes nothing.
    expect(engine.onTrade('BTCUSDT', trade('99.50'), ctx)).toEqual([]);
    expect(stored(triggered.id).status).toBe('triggered');

    market.setFresh('BTCUSDT', true);
    const events = engine.onTrade('BTCUSDT', trade('99.50'), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    expect(s(fillOf(events).fill.price)).toBe('99.84'); // 0.4 @ 99.90 + 0.6 @ 99.80
    expect(stored(triggered.id).status).toBe('filled');
  });

  it('buy stop_loss trigger 101 qty 0.5 locks 50.5 USDT and triggers at 101.00', () => {
    const { ctx, engine, bal } = setup();
    const id = arm(engine, buyStop('101', '0.5'), ctx);
    expect(s(bal('USDT').locked)).toBe('50.5');
    expect(engine.onTrade('BTCUSDT', trade('100.99'), ctx)).toEqual([]);
    const triggered = only(engine.onTrade('BTCUSDT', trade('101.00', '1', false), ctx), 'order_triggered').order;
    expect(triggered.id).toBe(id);
    expect(s(triggered.bestAtSubmit)).toBe('100'); // best ask at trigger time
    const { fill } = fillOf(arriveNow(engine, triggered, ctx));
    expect(s(fill.price)).toBe('100');
    expect(s(fill.quote)).toBe('50');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('950');
    expect(s(bal('BTC').free)).toBe('2.4995');
  });

  it('gapped buy stop with funds short expires in full', () => {
    const { market, ctx, engine, bal, stored } = setup({ usdt: '50.5' });
    const triggered = armAndTrigger(engine, buyStop('101', '0.5'), '101.00', ctx);
    expect(s(bal('USDT').free)).toBe('0');
    market.setBook('BTCUSDT', book([['101.90', '5']], [['102.00', '5']]));
    const e = only(arriveNow(engine, triggered, ctx), 'order_rejected');
    expect(e.afterTrigger).toBe(true);
    expect(e.reason).toBe(
      'Triggered stop expired: insufficient funds at execution ' +
        '(need 51, available 50.5; trigger 101, book average 102)',
    );
    expect(e.order.status).toBe('rejected');
    expect(e.order.rejectReason).toBe(e.reason);
    expect(stored(triggered.id).status).toBe('rejected');
    expect(s(stored(triggered.id).lockAmount)).toBe('0');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('50.5');
    expect(s(bal('BTC').free)).toBe('2');
  });

  it('dollar-sized buy stop whose dollars no longer reach one step: rejected after the trigger, lock released', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const triggered = armAndTrigger(engine, stop('buy', 'stop_loss', '101', { quoteQty: '50.5' }), '101.00', ctx);
    expect(s(bal('USDT').locked)).toBe('50.5');
    market.setBook('BTCUSDT', book([['5999999', '5']], [['6000000', '5']]));
    const e = only(arriveNow(engine, triggered, ctx), 'order_rejected');
    expect(e.afterTrigger).toBe(true);
    expect(e.reason).toBe('Amount too small: 50.5 USDT does not reach one step of 0.00001 BTC');
    expect(e.order.status).toBe('rejected');
    expect(e.order.rejectReason).toBe(e.reason);
    expect(stored(triggered.id)).toMatchObject({ status: 'rejected', lockAmount: D(0) });
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');
  });

  it('dollar-sized buy stop with an empty ask side after the trigger keeps the thin-book cancel', () => {
    const { market, ctx, engine, bal } = setup();
    const triggered = armAndTrigger(engine, stop('buy', 'stop_loss', '101', { quoteQty: '50.5' }), '101.00', ctx);
    market.setBook('BTCUSDT', book([['99', '5']], []));
    const events = arriveNow(engine, triggered, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
  });

  it('gapped buy take-profit with funds short says take-profit', () => {
    const { market, ctx, engine } = setup({ usdt: '45' });
    const triggered = armAndTrigger(engine, stop('buy', 'take_profit', '90', { qty: '0.5' }), '90', ctx);
    market.setBook('BTCUSDT', book([['95', '5']], [['95.10', '5']]));
    const e = only(arriveNow(engine, triggered, ctx), 'order_rejected');
    expect(e.afterTrigger).toBe(true);
    expect(e.reason).toBe(
      'Triggered take-profit expired: insufficient funds at execution ' +
        '(need 47.55, available 45; trigger 90, book average 95.1)',
    );
  });

  it('the expiry reason shows the multi-level book average rounded half-up to the tick size', () => {
    const { market, ctx, engine } = setup({ usdt: '50.5' });
    const triggered = armAndTrigger(engine, buyStop('101', '0.5'), '101.00', ctx);
    // 0.25 @ 101.93 + 0.25 @ 102.00 = 50.9825 for 0.5 BTC: average 101.965 → 101.97 (not 101.96).
    market.setBook('BTCUSDT', book([['101.90', '5']], [['101.93', '0.25'], ['102.00', '5']]));
    const e = only(arriveNow(engine, triggered, ctx), 'order_rejected');
    expect(e.reason).toBe(
      'Triggered stop expired: insufficient funds at execution ' +
        '(need 50.9825, available 50.5; trigger 101, book average 101.97)',
    );
  });

  it('same gap with 10 USDT free besides the lock → fills 0.5 at 102', () => {
    const { market, ctx, engine, bal } = setup({ usdt: '60.5' });
    const triggered = armAndTrigger(engine, buyStop('101', '0.5'), '101.00', ctx);
    market.setBook('BTCUSDT', book([['101.90', '5']], [['102.00', '5']]));
    const events = arriveNow(engine, triggered, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const { fill, order } = fillOf(events);
    expect(s(fill.qty)).toBe('0.5');
    expect(s(fill.price)).toBe('102');
    expect(s(fill.triggerPrice)).toBe('101');
    expect(order.status).toBe('filled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('9.5');
    expect(s(bal('BTC').free)).toBe('2.4995');
  });

  it('dollar-sized buy stop under the same gap fills 0.49509 and never expires', () => {
    const { market, ctx, engine, bal } = setup({ usdt: '50.5' });
    const order = placed(engine.submit(stop('buy', 'stop_loss', '101', { quoteQty: '50.5' }), ctx));
    expect(order.qty).toBeNull();
    expect(s(order.quoteQty)).toBe('50.5');
    expect(s(order.lockAmount)).toBe('50.5');
    arriveNow(engine, order, ctx);
    const triggered = only(engine.onTrade('BTCUSDT', trade('101'), ctx), 'order_triggered').order;
    market.setBook('BTCUSDT', book([['101.90', '5']], [['102.00', '5']]));
    const events = arriveNow(engine, triggered, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const { fill, order: after } = fillOf(events);
    expect(s(fill.qty)).toBe('0.49509');
    expect(s(fill.quote)).toBe('50.49918');
    expect(after.status).toBe('filled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('0.00082');
  });

  it('take-profits: sell 110 triggers at 110.00, buy 90 triggers at 90 (USDT 45 locked)', () => {
    const { ctx, engine, bal } = setup();
    const sellTp = arm(engine, stop('sell', 'take_profit', '110', { qty: '1' }), ctx);
    const buyTp = arm(engine, stop('buy', 'take_profit', '90', { qty: '0.5' }), ctx);
    expect(s(bal('USDT').locked)).toBe('45');
    expect(engine.onTrade('BTCUSDT', trade('109.99'), ctx)).toEqual([]);
    expect(only(engine.onTrade('BTCUSDT', trade('110.00'), ctx), 'order_triggered').order.id).toBe(sellTp);
    expect(engine.onTrade('BTCUSDT', trade('90.01'), ctx)).toEqual([]);
    expect(only(engine.onTrade('BTCUSDT', trade('90'), ctx), 'order_triggered').order.id).toBe(buyTp);
  });

  it('triggers run before limit matching on the same trade', () => {
    const { ctx, engine } = setup();
    arm(engine, sellStop('99.00', '1'), ctx);
    const placedLimit = placed(engine.submit(limit('buy', '99.50', '1'), ctx));
    arriveNow(engine, placedLimit, ctx);
    expect(engine.onTrade('BTCUSDT', trade('98.90', '1', true), ctx).map((e) => e.type)).toEqual([
      'order_triggered',
      'fill',
    ]);
  });
});

describe('cancel', () => {
  it('pending and open stops can be cancelled; triggered ones are already executing', () => {
    const { ctx, engine, bal, stored } = setup();
    const pending = placed(engine.submit(sellStop('99', '0.5'), ctx));
    const c1 = only(cancelNow(engine, pending.id, ctx), 'order_cancelled');
    expect(c1.reason).toBe('user');
    expect(s(c1.cancelledQty)).toBe('0.5');
    expect(arriveNow(engine, pending, ctx)).toEqual([]);
    expect(stored(pending.id).status).toBe('cancelled');

    const open = arm(engine, sellStop('99', '1'), ctx);
    expect(only(cancelNow(engine, open, ctx), 'order_cancelled').reason).toBe('user');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');
    expect(engine.onTrade('BTCUSDT', trade('98'), ctx)).toEqual([]);

    const triggered = armAndTrigger(engine, sellStop('97', '1'), '97', ctx);
    expect(engine.cancel(triggered.id, ctx)).toEqual({ ok: false, reason: EXECUTING });
    expect(s(bal('BTC').locked)).toBe('1');
  });

  it('dollar-sized buy stop: cancel releases the dollars and reports the coins they would buy', () => {
    const { ctx, engine, bal } = setup();
    const id = arm(engine, stop('buy', 'stop_loss', '101', { quoteQty: '50.5' }), ctx);
    expect(s(only(cancelNow(engine, id, ctx), 'order_cancelled').cancelledQty)).toBe('0.5');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
  });

  it('a stop that triggers during the cancel delay: the cancel is too late and the triggered order still executes', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = arm(engine, sellStop('99.00', '1'), ctx);
    const t = ctx.now;
    expect(engine.cancel(id, ctx)).toEqual({ ok: true, events: [] });
    expect(stored(id).cancelArrivesAt).toBe(t + 100);

    ctx.now = t + 1;
    const triggered = only(engine.onTrade('BTCUSDT', trade('99.00'), ctx), 'order_triggered').order;
    expect(triggered.arrivesAt).toBe(t + 101);

    ctx.now = t + 100;
    const e = only(engine.arriveCancel(id, ctx), 'cancel_rejected');
    expect(e.reason).toBe('Cancel arrived too late: order already triggered');
    expect(e.order.status).toBe('triggered');
    expect(e.order.cancelArrivesAt).toBeNull();
    expect(stored(id)).toEqual(e.order);
    expect(s(bal('BTC').locked)).toBe('1');

    const { fill, order } = fillOf(arriveNow(engine, stored(id), ctx));
    expect(s(fill.qty)).toBe('1');
    expect(order.status).toBe('filled');
    expect(s(bal('BTC').locked)).toBe('0');
  });

  it('a cancel that needs the exchange rules waits in flight while they are missing; onFresh delivers it', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const id = arm(engine, stop('buy', 'stop_loss', '101', { quoteQty: '50.5' }), ctx);
    expect(engine.cancel(id, ctx).ok).toBe(true);
    const at = stored(id).cancelArrivesAt!;

    market.clearRules('BTCUSDT');
    ctx.now = at + 5_000;
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
    expect(stored(id).cancelArrivesAt).toBe(at);
    expect(s(bal('USDT').locked)).toBe('50.5');

    market.setRules('BTCUSDT', btcRules);
    const e = only(engine.onFresh('BTCUSDT', ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(s(e.cancelledQty)).toBe('0.5');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
  });

  it('cancels that need the exchange rules are refused, with no state change, before the rules load', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const buyStopId = arm(engine, stop('buy', 'stop_loss', '101', { quoteQty: '50.5' }), ctx);
    const parent = placed(engine.submit(limit('buy', '99.50', '1', { attach: { stopLoss: '95', takeProfit: '110' } }), ctx));
    arriveNow(engine, parent, ctx);
    engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    expect(stored(parent.id).status).toBe('partially_filled');
    const sellStopId = arm(engine, sellStop('99', '0.5'), ctx);

    market.clearRules('BTCUSDT');
    const before = JSON.stringify([...engine.state.orders.values(), engine.state.balances]);
    const refused = { ok: false, reason: 'Exchange rules not loaded yet; try again in a moment' };
    expect(engine.cancel(buyStopId, ctx)).toEqual(refused);
    expect(engine.cancel(parent.id, ctx)).toEqual(refused);
    expect(JSON.stringify([...engine.state.orders.values(), engine.state.balances])).toBe(before);
    expect(s(bal('USDT').locked)).not.toBe('0');

    // A cancel that needs no rules still works.
    expect(engine.cancel(sellStopId, ctx).ok).toBe(true);
  });
});

describe('linked SL/TP pair (attachOco)', () => {
  const pair = (engine: SpotEngine, ctx: EngineCtx, qty = '1', stopLoss = '95', takeProfit = '110') =>
    engine.attachOco({ symbol: 'BTCUSDT', qty, stopLoss, takeProfit }, ctx);

  function armPair(engine: SpotEngine, ctx: EngineCtx): [SpotOrder, SpotOrder] {
    const events = pair(engine, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_placed', 'order_placed']);
    const [sl, tp] = placedOrders(events) as [SpotOrder, SpotOrder];
    expect(arriveNow(engine, sl, ctx)).toEqual([]);
    expect(arriveNow(engine, tp, ctx)).toEqual([]);
    return [engine.state.orders.get(sl.id)!, engine.state.orders.get(tp.id)!];
  }

  it('qty 1, SL 95, TP 110 → two pending orders sharing one group and one 1 BTC lock', () => {
    const { ctx, engine, bal, stored } = setup();
    const events = pair(engine, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_placed', 'order_placed']);
    const [sl, tp] = placedOrders(events) as [SpotOrder, SpotOrder];
    expect([sl.type, sl.side, s(sl.triggerPrice), s(sl.qty)]).toEqual(['stop_loss', 'sell', '95', '1']);
    expect([tp.type, tp.side, s(tp.triggerPrice), s(tp.qty)]).toEqual(['take_profit', 'sell', '110', '1']);
    expect(sl.ocoGroupId).not.toBeNull();
    expect(tp.ocoGroupId).toBe(sl.ocoGroupId);
    expect(tp.arrivesAt).toBe(sl.arrivesAt);
    expect(s(sl.lockAmount)).toBe('1');
    expect(s(tp.lockAmount)).toBe('0');
    expect(s(bal('BTC').locked)).toBe('1');
    expect(s(bal('BTC').free)).toBe('1');

    expect(arriveNow(engine, sl, ctx)).toEqual([]);
    expect(stored(sl.id).status).toBe('open');
    expect(stored(tp.id).status).toBe('open');
    expect(arriveNow(engine, tp, ctx)).toEqual([]);
  });

  it('TP triggers at 110 → SL cancelled (oco) in the same call; the lock moves to the TP until it fills', () => {
    const { ctx, engine, bal, stored } = setup();
    const [sl, tp] = armPair(engine, ctx);
    const events = engine.onTrade('BTCUSDT', trade('110'), ctx);
    expect(events.map((e) => e.type)).toEqual(['order_triggered', 'order_cancelled']);
    const [trig, cancel] = events as [
      Extract<EngineEvent, { type: 'order_triggered' }>,
      Extract<EngineEvent, { type: 'order_cancelled' }>,
    ];
    expect(trig.order.id).toBe(tp.id);
    expect(s(trig.order.lockAmount)).toBe('1');
    expect(cancel.order.id).toBe(sl.id);
    expect(cancel.reason).toBe('oco');
    expect(s(cancel.cancelledQty)).toBe('1');
    expect(s(cancel.order.lockAmount)).toBe('0');
    expect(stored(sl.id).status).toBe('cancelled');
    expect(s(bal('BTC').locked)).toBe('1');
    // The cancelled SL never triggers.
    expect(engine.onTrade('BTCUSDT', trade('94'), ctx)).toEqual([]);

    const { fill } = fillOf(arriveNow(engine, trig.order, ctx));
    expect(s(fill.qty)).toBe('1');
    expect(s(fill.triggerPrice)).toBe('110');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('1');
  });

  it('SL triggers at 95 → TP cancelled (oco), SL keeps the lock', () => {
    const { ctx, engine, bal } = setup();
    const [sl, tp] = armPair(engine, ctx);
    const events = engine.onTrade('BTCUSDT', trade('95'), ctx);
    expect(events.map((e) => [e.type, (e as { order: SpotOrder }).order.id])).toEqual([
      ['order_triggered', sl.id],
      ['order_cancelled', tp.id],
    ]);
    expect(s(bal('BTC').locked)).toBe('1');
  });

  it('cancelling either untriggered leg cancels both when the cancel arrives and releases the lock once', () => {
    const { ctx, engine, bal, stored } = setup();
    const [sl, tp] = armPair(engine, ctx);
    expect(engine.cancel(tp.id, ctx)).toEqual({ ok: true, events: [] });
    expect([stored(sl.id).status, stored(tp.id).status]).toEqual(['open', 'open']);
    // The pair has one cancel in flight: the other leg cannot be cancelled again.
    expect(engine.cancel(sl.id, ctx)).toEqual({ ok: false, reason: 'Cancel already requested' });

    ctx.now = stored(tp.id).cancelArrivesAt!;
    const events = engine.arriveCancel(tp.id, ctx);
    expect(events.map((e) => (e.type === 'order_cancelled' ? [e.order.id, e.reason] : e.type))).toEqual([
      [tp.id, 'user'],
      [sl.id, 'oco'],
    ]);
    expect(stored(sl.id).status).toBe('cancelled');
    expect(stored(tp.id).status).toBe('cancelled');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');

    // Cancelling a pending pair (by its SL leg) works the same way.
    const [pSl, pTp] = placedOrders(pair(engine, ctx)) as [SpotOrder, SpotOrder];
    expect(cancelNow(engine, pSl.id, ctx).map((e) => e.type)).toEqual(['order_cancelled', 'order_cancelled']);
    expect(stored(pTp.id).status).toBe('cancelled');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(arriveNow(engine, pSl, ctx)).toEqual([]);
  });

  it('a leg that triggers during the cancel delay: its partner is cancelled by the trigger and the cancel is too late', () => {
    const { ctx, engine, bal, stored } = setup();
    const [sl, tp] = armPair(engine, ctx);
    engine.cancel(sl.id, ctx);
    ctx.now += 1;
    expect(engine.onTrade('BTCUSDT', trade('110'), ctx).map((e) => e.type)).toEqual([
      'order_triggered',
      'order_cancelled',
    ]);
    ctx.now = stored(sl.id).cancelArrivesAt!;
    expect(only(engine.arriveCancel(sl.id, ctx), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already cancelled',
    );
    expect(stored(tp.id).status).toBe('triggered');
    expect(s(bal('BTC').locked)).toBe('1');
  });

  it('a leg that would trigger now rejects the whole pair, nothing locked', () => {
    const { ctx, engine, bal } = setup();
    const events = pair(engine, ctx, '1', '100', '110');
    expect(events.map((e) => e.type)).toEqual(['order_rejected', 'order_rejected']);
    for (const e of events) {
      if (e.type !== 'order_rejected') throw new Error('expected order_rejected');
      expect(e.reason).toBe('Stop would trigger immediately (last 99.95, trigger 100)');
      expect(e.order.status).toBe('rejected');
    }
    expect(reasons(pair(engine, ctx, '1', '95', '99.90'))).toEqual([
      'Take-profit would trigger immediately (last 99.95, trigger 99.9)',
      'Take-profit would trigger immediately (last 99.95, trigger 99.9)',
    ]);
    expect(reasons(pair(engine, ctx, '3'))[0]).toBe('Insufficient BTC: need 3, available 2');
    expect(reasons(pair(engine, ctx, '1,5x'))[0]).toMatch(/^Invalid amount "1,5x"/);
    expect(s(bal('BTC').locked)).toBe('0');
  });

  it('a pair counts as two algo orders', () => {
    const { ctx, engine } = setup();
    for (const t of ['98', '97', '96', '94']) placed(engine.submit(sellStop(t, '0.1'), ctx));
    const full = 'MAX_NUM_ALGO_ORDERS: a stop-loss/take-profit pair needs 2 slots but 4 of 5 are in use on BTCUSDT';
    expect(reasons(pair(engine, ctx, '0.5'))).toEqual([full, full]);
    placed(engine.submit(sellStop('93', '0.1'), ctx));
    const none = 'MAX_NUM_ALGO_ORDERS: a stop-loss/take-profit pair needs 2 slots but 5 of 5 are in use on BTCUSDT';
    expect(reasons(pair(engine, ctx, '0.5'))).toEqual([none, none]);
  });

  it('stale at arrival rejects both legs and releases the lock', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const [sl, tp] = placedOrders(pair(engine, ctx)) as [SpotOrder, SpotOrder];
    market.setFresh('BTCUSDT', false);
    const events = arriveNow(engine, sl, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_rejected', 'order_rejected']);
    expect(stored(sl.id).status).toBe('rejected');
    expect(stored(tp.id).status).toBe('rejected');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');
    expect(arriveNow(engine, tp, ctx)).toEqual([]);
  });
});

describe('pair attached to a buy', () => {
  const attach = { stopLoss: '95', takeProfit: '110' };
  const limitBuy = (qty: string, extra: Partial<SpotOrderRequest> = { attach }) => limit('buy', '99.50', qty, extra);

  it('limit buy 1 @ 99.50 fully filled → pair for the net 0.999', () => {
    const { ctx, engine, bal } = setup();
    const parent = placed(engine.submit(limitBuy('1'), ctx));
    expect(s(parent.attach!.stopLoss)).toBe('95');
    expect(s(parent.attach!.takeProfit)).toBe('110');
    arriveNow(engine, parent, ctx);
    const events = engine.onTrade('BTCUSDT', trade('99.40', '1', true), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_placed', 'order_placed']);
    const [sl, tp] = placedOrders(events) as [SpotOrder, SpotOrder];
    expect([sl.type, s(sl.qty), s(sl.triggerPrice)]).toEqual(['stop_loss', '0.999', '95']);
    expect([tp.type, s(tp.qty), s(tp.triggerPrice)]).toEqual(['take_profit', '0.999', '110']);
    expect(tp.ocoGroupId).toBe(sl.ocoGroupId);
    expect(s(bal('BTC').locked)).toBe('0.999');
    expect(s(bal('BTC').free)).toBe('2');
  });

  it('parent cancelled after a partial fill of 0.5 → pair for 0.4995; cancelled with 0 filled → no pair', () => {
    const { ctx, engine } = setup();
    const parent = placed(engine.submit(limitBuy('1'), ctx));
    arriveNow(engine, parent, ctx);
    engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    const events = cancelNow(engine, parent.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled', 'order_placed', 'order_placed']);
    expect(placedOrders(events).map((o) => s(o.qty))).toEqual(['0.4995', '0.4995']);

    const unfilled = placed(engine.submit(limitBuy('1'), ctx));
    arriveNow(engine, unfilled, ctx);
    expect(cancelNow(engine, unfilled.id, ctx).map((e) => e.type)).toEqual(['order_cancelled']);
  });

  it('a part-filled parent whose cancel is delivered by a later trade activates its pair once', () => {
    const { ctx, engine } = setup();
    const parent = placed(engine.submit(limitBuy('1'), ctx));
    arriveNow(engine, parent, ctx);
    engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    engine.cancel(parent.id, ctx);
    ctx.now = engine.state.orders.get(parent.id)!.cancelArrivesAt!;
    const events = engine.onTrade('BTCUSDT', trade('99.40', '1', true), ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled', 'order_placed', 'order_placed']);
    expect(placedOrders(events).map((o) => s(o.qty))).toEqual(['0.4995', '0.4995']);
  });

  it('parent cancelled after a partial fill while stale → pair waits pending; armed on the next onFresh', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const parent = placed(engine.submit(limitBuy('1'), ctx));
    arriveNow(engine, parent, ctx);
    engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    market.setFresh('BTCUSDT', false);
    const events = cancelNow(engine, parent.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled', 'order_placed', 'order_placed']);
    const [sl, tp] = placedOrders(events) as [SpotOrder, SpotOrder];
    for (const leg of [sl, tp]) {
      expect([leg.status, leg.arrivesAt, leg.parentId, s(leg.qty)]).toEqual(['pending', null, parent.id, '0.4995']);
    }
    expect(s(bal('BTC').locked)).toBe('0.4995');
    // Still stale: nothing arms.
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('99.80'), ctx)).toEqual([]);
    expect(stored(sl.id).status).toBe('pending');

    market.setFresh('BTCUSDT', true);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(stored(sl.id).status).toBe('open');
    expect(stored(tp.id).status).toBe('open');
    expect(s(stored(sl.id).lockAmount)).toBe('0.4995');
    expect(s(stored(tp.id).lockAmount)).toBe('0');
    expect(s(bal('BTC').locked)).toBe('0.4995');
  });

  it('attached pair stale at arrival waits; the first fresh trade rejects it if it would trigger now', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const parent = placed(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1', attach }, ctx));
    const [sl, tp] = placedOrders(arriveNow(engine, parent, ctx)) as [SpotOrder, SpotOrder];
    market.setFresh('BTCUSDT', false);
    expect(arriveNow(engine, sl, ctx)).toEqual([]);
    expect([stored(sl.id).status, stored(sl.id).arrivesAt]).toEqual(['pending', null]);
    expect([stored(tp.id).status, stored(tp.id).arrivesAt]).toEqual(['pending', null]);
    expect(s(bal('BTC').locked)).toBe('0.999');

    // Fresh again, but the price ran through the take-profit meanwhile: the exchange would reject now.
    market.setFresh('BTCUSDT', true);
    market.setLastPrice('BTCUSDT', D('111'));
    const events = engine.onTrade('BTCUSDT', trade('111', '1', false), ctx);
    expect(reasons(events)).toEqual([
      'Take-profit would trigger immediately (last 111, trigger 110)',
      'Take-profit would trigger immediately (last 111, trigger 110)',
    ]);
    expect(s(bal('BTC').locked)).toBe('0');
  });

  it('average price unavailable at a stale activation → the attached pair still waits pending and arms later', () => {
    const { market, ctx, engine, stored } = setup();
    const parent = placed(engine.submit(limitBuy('1'), ctx));
    arriveNow(engine, parent, ctx);
    engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    market.setFresh('BTCUSDT', false);
    market.setAvgPrice('BTCUSDT', null);
    const events = cancelNow(engine, parent.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled', 'order_placed', 'order_placed']);
    const [sl, tp] = placedOrders(events) as [SpotOrder, SpotOrder];
    expect([sl.status, sl.arrivesAt]).toEqual(['pending', null]);

    market.setFresh('BTCUSDT', true); // the average price is still missing: stops do not need it
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect([stored(sl.id).status, stored(tp.id).status]).toEqual(['open', 'open']);
  });

  it('last price unavailable when an attached pair arms → legs stay pending, then arm once it is back', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const parent = placed(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1', attach }, ctx));
    const [sl, tp] = placedOrders(arriveNow(engine, parent, ctx)) as [SpotOrder, SpotOrder];
    market.setLastPrice('BTCUSDT', null);
    expect(arriveNow(engine, sl, ctx)).toEqual([]);
    expect([stored(sl.id).status, stored(sl.id).arrivesAt]).toEqual(['pending', null]);
    expect([stored(tp.id).status, stored(tp.id).arrivesAt]).toEqual(['pending', null]);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(stored(sl.id).status).toBe('pending');
    expect(s(bal('BTC').locked)).toBe('0.999');

    market.setLastPrice('BTCUSDT', D('99.95'));
    expect(engine.onTrade('BTCUSDT', trade('99.95'), ctx)).toEqual([]);
    expect([stored(sl.id).status, stored(tp.id).status]).toEqual(['open', 'open']);
    expect(s(bal('BTC').locked)).toBe('0.999');
  });

  it('last price unavailable at activation (fresh) → the attached pair is placed and waits, not rejected', () => {
    const { market, ctx, engine, stored } = setup();
    const parent = placed(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1', attach }, ctx));
    market.setLastPrice('BTCUSDT', null);
    const events = arriveNow(engine, parent, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_placed', 'order_placed']);
    const [sl] = placedOrders(events) as [SpotOrder, SpotOrder];
    expect(arriveNow(engine, sl, ctx)).toEqual([]);
    expect(stored(sl.id).status).toBe('pending');
    market.setLastPrice('BTCUSDT', D('99.95'));
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(stored(sl.id).status).toBe('open');
  });

  it('market buy with a pair: activates when the market order fills at arrival', () => {
    const { ctx, engine } = setup();
    const parent = placed(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1', attach }, ctx));
    const events = arriveNow(engine, parent, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_placed', 'order_placed']);
    expect(placedOrders(events).map((o) => s(o.qty))).toEqual(['0.999', '0.999']);
  });

  it('pair rejected at activation (TP below last) → parent stays filled, both legs rejected', () => {
    const { ctx, engine, bal, stored } = setup();
    // Above the limit price, so it passes when placed, but below the last price (99.95) when the buy fills.
    const parent = placed(engine.submit(limitBuy('1', { attach: { stopLoss: '95', takeProfit: '99.60' } }), ctx));
    arriveNow(engine, parent, ctx);
    const events = engine.onTrade('BTCUSDT', trade('99.40', '1', true), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_rejected', 'order_rejected']);
    expect(reasons(events)[0]).toBe('Take-profit would trigger immediately (last 99.95, trigger 99.6)');
    expect(stored(parent.id).status).toBe('filled');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2.999');
  });

  it('attach on a sell is rejected', () => {
    const { ctx, engine } = setup();
    const marketSell: SpotOrderRequest = { symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '1', attach };
    expect(rejectReason(engine.submit(marketSell, ctx))).toBe('Attached stop-loss and take-profit are only for buys');
    expect(rejectReason(engine.submit(limit('sell', '101', '1', { attach }), ctx))).toBe(
      'Attached stop-loss and take-profit are only for buys',
    );
  });
});

describe('pair attached to a buy is validated up front', () => {
  const attach = { stopLoss: '95', takeProfit: '110' };
  const pair = (stopLoss: string, takeProfit: string) => ({ attach: { stopLoss, takeProfit } });
  const marketBuy = (qty: string, extra: Partial<SpotOrderRequest> = { attach }): SpotOrderRequest => ({
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'market',
    qty,
    ...extra,
  });
  const dollarBuy = (quoteQty: string, extra: Partial<SpotOrderRequest> = { attach }): SpotOrderRequest => ({
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'market',
    quoteQty,
    ...extra,
  });
  const limitBuy = (price: string, qty: string, extra: Partial<SpotOrderRequest> = { attach }) =>
    limit('buy', price, qty, extra);

  /** Nothing bought, nothing locked. */
  function expectUntouched(bal: (asset: string) => { free: Decimal; locked: Decimal }) {
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');
    expect(s(bal('BTC').locked)).toBe('0');
  }

  it('an off-tick stop-loss rejects the whole market buy', () => {
    const { ctx, engine, bal, stored } = setup();
    const events = engine.submit(marketBuy('1', pair('95.123', '110')), ctx);
    expect(rejectReason(events)).toBe('PRICE_FILTER: trigger price 95.123 is not a multiple of tick size 0.01');
    expect(stored('o1').status).toBe('rejected');
    expect(engine.state.orders.size).toBe(1);
    expectUntouched(bal);
  });

  it('PRICE_FILTER: the stop-loss is checked before the take-profit, both before the reference prices', () => {
    const { ctx, engine, bal } = setup();
    expect(rejectReason(engine.submit(marketBuy('1', pair('95.123', '110.456')), ctx))).toBe(
      'PRICE_FILTER: trigger price 95.123 is not a multiple of tick size 0.01',
    );
    expect(rejectReason(engine.submit(marketBuy('1', pair('95', '110.456')), ctx))).toBe(
      'PRICE_FILTER: trigger price 110.456 is not a multiple of tick size 0.01',
    );
    // An off-tick take-profit that is also below the limit price reports the filter first.
    expect(rejectReason(engine.submit(limitBuy('99.50', '1', pair('95', '99.123')), ctx))).toBe(
      'PRICE_FILTER: trigger price 99.123 is not a multiple of tick size 0.01',
    );
    expectUntouched(bal);
  });

  it('limit and post-only: stop-loss below and take-profit above the limit price', () => {
    const { ctx, engine, bal } = setup();
    expect(rejectReason(engine.submit(limitBuy('99.50', '1', pair('99.60', '110')), ctx))).toBe(
      'Attached stop-loss 99.6 must be below the limit price 99.5',
    );
    expect(rejectReason(engine.submit(limitBuy('99.50', '1', pair('99.50', '110')), ctx))).toBe(
      'Attached stop-loss 99.5 must be below the limit price 99.5',
    );
    expect(rejectReason(engine.submit(limitBuy('99.50', '1', pair('95', '99.50')), ctx))).toBe(
      'Attached take-profit 99.5 must be above the limit price 99.5',
    );
    const postOnly = (stopLoss: string, takeProfit: string): SpotOrderRequest =>
      limit('buy', '99', '1', { type: 'post_only', ...pair(stopLoss, takeProfit) });
    expect(rejectReason(engine.submit(postOnly('99.01', '110'), ctx))).toBe(
      'Attached stop-loss 99.01 must be below the limit price 99',
    );
    expect(rejectReason(engine.submit(postOnly('95', '98.99'), ctx))).toBe(
      'Attached take-profit 98.99 must be above the limit price 99',
    );
    expectUntouched(bal);
    // Just inside the limit price is accepted.
    placed(engine.submit(postOnly('98.99', '99.01'), ctx));
    placed(engine.submit(limitBuy('99.50', '1', pair('99.49', '99.51')), ctx));
  });

  it('market: stop-loss below and take-profit above the last price', () => {
    const { ctx, engine, bal } = setup();
    expect(rejectReason(engine.submit(marketBuy('1', pair('95', '99.90')), ctx))).toBe(
      'Attached take-profit 99.9 must be above the last price 99.95',
    );
    expect(rejectReason(engine.submit(marketBuy('1', pair('99.95', '110')), ctx))).toBe(
      'Attached stop-loss 99.95 must be below the last price 99.95',
    );
    expectUntouched(bal);
    placed(engine.submit(marketBuy('1', pair('99.94', '99.96')), ctx));
  });

  it('market buy with a pair and no last price is rejected; without a pair, or with a limit price, it is not', () => {
    const { market, ctx, engine, bal } = setup();
    market.setLastPrice('BTCUSDT', null);
    expect(rejectReason(engine.submit(marketBuy('1'), ctx))).toBe('Last price unavailable for BTCUSDT');
    expectUntouched(bal);
    placed(engine.submit(marketBuy('1', {}), ctx));
    placed(engine.submit(limitBuy('99.50', '1'), ctx));
  });

  it('a pair needs 3 order slots (the buy and two legs)', () => {
    const { market, ctx, engine, bal } = setup();
    market.setRules('BTCUSDT', { ...btcRules, maxNumOrders: 3 });
    placed(engine.submit(limitBuy('99', '1', {}), ctx)); // 1 slot in use
    const message = 'MAX_NUM_ORDERS: an order with an attached pair needs 3 slots but 1 of 3 are in use on BTCUSDT';
    expect(rejectReason(engine.submit(marketBuy('1'), ctx))).toBe(message);
    expect(rejectReason(engine.submit(limitBuy('98', '1'), ctx))).toBe(message);
    expect(s(bal('BTC').locked)).toBe('0');
    placed(engine.submit(marketBuy('1', {}), ctx)); // without a pair one slot is enough: 2 in use now

    market.setRules('BTCUSDT', { ...btcRules, maxNumOrders: 4 });
    expect(rejectReason(engine.submit(marketBuy('1'), ctx))).toBe(
      'MAX_NUM_ORDERS: an order with an attached pair needs 3 slots but 2 of 4 are in use on BTCUSDT',
    );
    market.setRules('BTCUSDT', { ...btcRules, maxNumOrders: 5 });
    placed(engine.submit(marketBuy('1'), ctx)); // exactly 3 slots free
  });

  it('a pair needs 2 algo-order slots: 4 of 5 in use rejects the buy before anything fills', () => {
    const { ctx, engine, bal } = setup();
    for (let i = 0; i < 4; i++) arm(engine, sellStop('98', '0.1'), ctx);
    const pairMessage =
      'MAX_NUM_ALGO_ORDERS: a stop-loss/take-profit pair needs 2 slots but 4 of 5 are in use on BTCUSDT';
    const events = engine.submit(marketBuy('1'), ctx);
    expect(rejectReason(events)).toBe(pairMessage);
    expect(rejectReason(engine.submit(limitBuy('99.50', '1'), ctx))).toBe(pairMessage);
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').locked)).toBe('0.4');
    // 3 of 5: a pair fits.
    const { ctx: ctx3, engine: engine3 } = setup();
    for (let i = 0; i < 3; i++) arm(engine3, sellStop('98', '0.1'), ctx3);
    placed(engine3.submit(marketBuy('1'), ctx3));
  });

  it('NOTIONAL of each leg is checked on the expected net quantity', () => {
    const { ctx, engine, bal } = setup();
    // 0.05 BTC is 5.00 at the average price and passes alone; net of the 0.1 % fee: 0.04995.
    placed(engine.submit(marketBuy('0.05', {}), ctx));
    expect(rejectReason(engine.submit(marketBuy('0.05'), ctx))).toBe(
      'NOTIONAL: order value 4.74525 is below the minimum 5',
    );
    expect(engine.preview(marketBuy('0.05'), ctx).rejectReason).toBe(
      'NOTIONAL: order value 4.74525 is below the minimum 5',
    );
    expect(s(bal('BTC').locked)).toBe('0');
  });

  it('NOTIONAL uses the walked quantity of a dollar-sized market buy', () => {
    const { ctx, engine } = setup();
    // 5.01 USDT buys 0.0501 BTC; net of the fee: floor(0.0500499) = 0.05004; 95 × 0.05004 = 4.7538.
    expect(rejectReason(engine.submit(dollarBuy('5.01'), ctx))).toBe(
      'NOTIONAL: order value 4.7538 is below the minimum 5',
    );
    placed(engine.submit(dollarBuy('5.01', {}), ctx));
  });

  it('NOTIONAL uses the computed quantity of a dollar-sized limit buy', () => {
    const { ctx, engine } = setup();
    // 5.5 USDT at 99.50 buys floor(0.055276…) = 0.05527 BTC; net 0.05521; 90 × 0.05521 = 4.9689.
    const req = (stopLoss: string): SpotOrderRequest => ({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      price: '99.50',
      quoteQty: '5.5',
      attach: { stopLoss, takeProfit: '110' },
    });
    expect(rejectReason(engine.submit(req('90'), ctx))).toBe('NOTIONAL: order value 4.9689 is below the minimum 5');
    placed(engine.submit(req('95'), ctx));
  });

  it('LOT_SIZE of each leg is checked on the net quantity', () => {
    const { market, ctx, engine } = setup();
    market.setRules('BTCUSDT', { ...btcRules, minNotional: D('0') });
    // One step buys fine; the fee leaves less than one step for the pair.
    placed(engine.submit(marketBuy('0.00001', {}), ctx));
    expect(rejectReason(engine.submit(marketBuy('0.00001'), ctx))).toBe(
      'LOT_SIZE: quantity 0 is below the minimum 0.00001',
    );
  });

  it('preview reports the same reason as submit', () => {
    const { ctx, engine } = setup();
    const lateTp = marketBuy('1', pair('95', '99.90'));
    expect(engine.preview(lateTp, ctx).rejectReason).toBe(
      'Attached take-profit 99.9 must be above the last price 99.95',
    );
    expect(engine.preview(marketBuy('1'), ctx).rejectReason).toBeNull();
    const highSl = limitBuy('99.50', '1', pair('99.6', '110'));
    expect(engine.preview(highSl, ctx).rejectReason).toBe('Attached stop-loss 99.6 must be below the limit price 99.5');
    expect(engine.preview(limitBuy('99.50', '1'), ctx).rejectReason).toBeNull();
  });
});

describe('replay guard', () => {
  it('the same trade delivered twice fills only once; older ids are ignored per symbol', () => {
    const { ctx, engine, stored } = setup();
    const resting = placed(engine.submit(limit('buy', '99.50', '2'), ctx));
    arriveNow(engine, resting, ctx);
    const t = trade('99.40', '1', true);
    expect(engine.onTrade('BTCUSDT', t, ctx).map((e) => e.type)).toEqual(['fill']);
    expect(engine.onTrade('BTCUSDT', t, ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', { ...t, id: t.id - 1 }, ctx)).toEqual([]);
    expect(s(stored(resting.id).filledQty)).toBe('1');
    expect(engine.state.lastTradeId).toEqual({ BTCUSDT: t.id });

    // A stop is not triggered by a replayed trade either.
    const stopId = arm(engine, sellStop('99', '0.5'), ctx);
    const low = trade('98', '0.001', false);
    engine.onTrade('BTCUSDT', low, ctx);
    expect(stored(stopId).status).toBe('triggered');
    expect(engine.onTrade('BTCUSDT', low, ctx)).toEqual([]);
  });

  it('trades skipped while stale leave the cursor untouched; replayed later while fresh they are processed', () => {
    const { market, ctx, engine, stored } = setup();
    const resting = placed(engine.submit(limit('buy', '99.50', '1'), ctx));
    arriveNow(engine, resting, ctx);
    const before = trade('99.60', '1', true); // above the limit: no fill, but processed
    expect(engine.onTrade('BTCUSDT', before, ctx)).toEqual([]);
    expect(engine.state.lastTradeId).toEqual({ BTCUSDT: before.id });

    market.setFresh('BTCUSDT', false);
    const gap = trade('99.40', '1', true); // goes through the limit, but matching is paused
    expect(engine.onTrade('BTCUSDT', gap, ctx)).toEqual([]);
    expect(engine.state.lastTradeId).toEqual({ BTCUSDT: before.id });
    expect(s(stored(resting.id).filledQty)).toBe('0');

    market.setFresh('BTCUSDT', true);
    expect(engine.onTrade('BTCUSDT', gap, ctx).map((e) => e.type)).toEqual(['fill']);
    expect(s(stored(resting.id).filledQty)).toBe('1');
    expect(engine.state.lastTradeId).toEqual({ BTCUSDT: gap.id });
  });
});

describe('preview', () => {
  it('stop: walks the current book as if triggered now, taker fee, labelled as an estimate', () => {
    const { ctx, engine, bal } = setup();
    const p = engine.preview(sellStop('99', '1'), ctx);
    expect(s(p.estAvgPrice)).toBe('99.84');
    expect(s(p.estSlippageUsd)).toBe('0.06');
    expect(p.fee.asset).toBe('USDT');
    expect(s(p.fee.amount)).toBe('0.09984');
    expect(s(p.total)).toBe('99.74016');
    expect(s(p.receive)).toBe('99.74016');
    expect(p.note).toBe(ESTIMATE);
    expect(p.rejectReason).toBeNull();
    expect(s(bal('BTC').locked)).toBe('0');
    expect(engine.state.orders.size).toBe(0);

    const buy = engine.preview(stop('buy', 'take_profit', '90', { quoteQty: '50' }), ctx);
    expect(s(buy.total)).toBe('50');
    expect(s(buy.receive)).toBe('0.4995');
    expect(buy.note).toBe(ESTIMATE);
  });

  it('stop preview reports what submit would reject with', () => {
    const { market, ctx, engine } = setup();
    market.setLastPrice('BTCUSDT', D('98.90'));
    const p = engine.preview(sellStop('99', '1'), ctx);
    expect(p.rejectReason).toBe('Stop would trigger immediately (last 98.9, trigger 99)');
    expect(p.note).toBe(ESTIMATE);
    market.setFresh('BTCUSDT', false);
    const stale = engine.preview(sellStop('99', '1'), ctx);
    expect(stale.rejectReason).toBe('Live data interrupted for BTCUSDT');
    expect(stale.total).toBeNull();
  });

  it('market and limit previews have no note', () => {
    const { ctx, engine } = setup();
    expect(engine.preview({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' }, ctx).note).toBeNull();
    expect(engine.preview(limit('buy', '99', '1'), ctx).note).toBeNull();
  });
});
