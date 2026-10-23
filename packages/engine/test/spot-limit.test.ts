import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { allocateTradeThrough } from '../src/spot/matching.ts';
import { emptySpotState } from '../src/spot/state.ts';
import type { AggTrade, EngineCtx, EngineEvent, Fill, SpotOrder, SpotOrderRequest } from '../src/types.ts';
import { btcRules, FakeMarket, seedCoins, testCtx } from './fixtures.ts';

const NOW = 1_000_000;
const POST_ONLY = 'Post-only order would immediately match; rejected';

/** sampleBook, 1000 USDT and 2 BTC in the spot wallet. */
function setup(opts: { usdt?: string; btc?: string } = {}) {
  const market = new FakeMarket();
  const ctx = testCtx(market, { now: NOW });
  const engine = new SpotEngine(emptySpotState(['USDT', 'BTC']));
  engine.deposit('spot', D(opts.usdt ?? '1000'), ctx);
  seedCoins(engine.state, 'BTC', D(opts.btc ?? '2'));
  const bal = (asset: string) => engine.state.balances.spot[asset]!;
  const stored = (id: string) => engine.state.orders.get(id)!;
  return { market, ctx, engine, bal, stored };
}

const req = (side: 'buy' | 'sell', type: 'limit' | 'post_only', price: string, fields: Partial<SpotOrderRequest>) =>
  ({ symbol: 'BTCUSDT', side, type, price, ...fields }) as SpotOrderRequest;
const limitBuy = (price: string, qty: string) => req('buy', 'limit', price, { qty });
const limitSell = (price: string, qty: string) => req('sell', 'limit', price, { qty });

let tradeId = 0;
function trade(price: string, qty: string, sellerInitiated: boolean): AggTrade {
  tradeId += 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

function placed(events: EngineEvent[]): SpotOrder {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'order_placed') throw new Error(`expected order_placed, got ${e.type}`);
  return e.order;
}

function rejectReason(events: EngineEvent[]): string {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'order_rejected') throw new Error(`expected order_rejected, got ${e.type}`);
  return e.reason;
}

function fills(events: EngineEvent[]): { fill: Fill; order: SpotOrder }[] {
  return events.map((e) => {
    if (e.type !== 'fill') throw new Error(`expected fill, got ${e.type}`);
    return { fill: e.fill, order: e.order };
  });
}

function onlyFill(events: EngineEvent[]): { fill: Fill; order: SpotOrder } {
  expect(events).toHaveLength(1);
  return fills(events)[0]!;
}

/** Arrive at the order's arrival time (arrive is a no-op before it). */
function arriveNow(engine: SpotEngine, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

/** Submit and arrive; returns the order id. */
function rest(engine: SpotEngine, r: SpotOrderRequest, ctx: EngineCtx): string {
  const order = placed(engine.submit(r, ctx));
  expect(arriveNow(engine, order, ctx)).toEqual([]);
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

function only<T extends EngineEvent['type']>(events: EngineEvent[], type: T): Extract<EngineEvent, { type: T }> {
  expect(events.map((e) => e.type)).toEqual([type]);
  return events[0] as Extract<EngineEvent, { type: T }>;
}

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

describe('buy limit fills only on trade-through', () => {
  it('99.50 × 2: touch and buyer-initiated trades never fill; partial then full fill at the limit price', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(limitBuy('99.50', '2'), ctx));
    expect(order.status).toBe('pending');
    expect(order.type).toBe('limit');
    expect(s(order.price)).toBe('99.5');
    expect(s(order.qty)).toBe('2');
    expect(order.lockAsset).toBe('USDT');
    expect(s(order.lockAmount)).toBe('199');
    expect(s(order.bestAtSubmit)).toBe('100');
    expect(order.arrivesAt).toBe(NOW + 100);
    expect(s(bal('USDT').free)).toBe('801');
    expect(s(bal('USDT').locked)).toBe('199');

    expect(arriveNow(engine, order, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('open');
    expect(s(stored(order.id).lockAmount)).toBe('199');

    expect(engine.onTrade('BTCUSDT', trade('99.50', '1', true), ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('99.49', '1', false), ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('open');

    const first = onlyFill(engine.onTrade('BTCUSDT', trade('99.49', '0.5', true), ctx));
    expect(s(first.fill.qty)).toBe('0.5');
    expect(s(first.fill.price)).toBe('99.5');
    expect(s(first.fill.quote)).toBe('49.75');
    expect(first.fill.liquidity).toBe('maker');
    expect(first.fill.feeAsset).toBe('BTC');
    expect(s(first.fill.fee)).toBe('0.0005');
    expect(s(first.fill.feeUsd)).toBe('0.04975');
    expect(s(first.fill.slippageUsd)).toBe('0');
    expect(s(first.fill.driftUsd)).toBe('0');
    expect(s(first.fill.bestAtArrival)).toBe('100');
    expect(s(first.fill.bestAtSubmit)).toBe('100');
    expect(first.fill.orderId).toBe(order.id);
    expect(first.fill.time).toBe(ctx.now);
    expect(first.order.status).toBe('partially_filled');
    expect(s(first.order.lockAmount)).toBe('149.25');
    expect(stored(order.id).status).toBe('partially_filled');
    expect(s(stored(order.id).filledQty)).toBe('0.5');
    expect(s(bal('USDT').locked)).toBe('149.25');
    expect(s(bal('USDT').free)).toBe('801');
    expect(s(bal('BTC').free)).toBe('2.4995');

    const second = onlyFill(engine.onTrade('BTCUSDT', trade('99.40', '3', true), ctx));
    expect(s(second.fill.qty)).toBe('1.5');
    expect(s(second.fill.price)).toBe('99.5');
    expect(s(second.fill.fee)).toBe('0.0015');
    expect(second.order.status).toBe('filled');
    expect(s(second.order.lockAmount)).toBe('0');
    const final = stored(order.id);
    expect(final.status).toBe('filled');
    expect(s(final.filledQty)).toBe('2');
    expect(s(final.filledQuote)).toBe('199');
    expect(s(final.fee)).toBe('0.002');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('801');
    expect(s(bal('BTC').free)).toBe('3.998');

    // A filled order no longer matches.
    expect(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx)).toEqual([]);
  });

  it('trades before arrival do not count', () => {
    const { ctx, engine, stored } = setup();
    const order = placed(engine.submit(limitBuy('99.50', '2'), ctx));
    expect(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('pending');
    arriveNow(engine, order, ctx);
    expect(stored(order.id).status).toBe('open');
    expect(s(stored(order.id).filledQty)).toBe('0');
  });

  it('matching pauses while the symbol is stale', () => {
    const { market, ctx, engine, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    market.setFresh('BTCUSDT', false);
    expect(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
    market.setFresh('BTCUSDT', true);
    expect(s(onlyFill(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx)).fill.qty)).toBe('1');
  });

  it('orders on another symbol are not matched', () => {
    const { ctx, engine } = setup();
    rest(engine, limitBuy('99.50', '1'), ctx);
    expect(engine.onTrade('ETHUSDT', trade('99.00', '5', true), ctx)).toEqual([]);
  });
});

describe('shared trade volume', () => {
  it('price priority: the higher buy fills first', () => {
    const { ctx, engine, bal, stored } = setup();
    const b = rest(engine, limitBuy('99.50', '1'), ctx);
    ctx.now += 1;
    const a = rest(engine, limitBuy('99.60', '1'), ctx);
    const got = fills(engine.onTrade('BTCUSDT', trade('99.40', '1.5', true), ctx));
    expect(got.map((f) => [f.fill.orderId, s(f.fill.qty), s(f.fill.price)])).toEqual([
      [a, '1', '99.6'],
      [b, '0.5', '99.5'],
    ]);
    expect(stored(a).status).toBe('filled');
    expect(stored(b).status).toBe('partially_filled');
    // 199.1 locked at submit: a spent 99.6, b spent 49.75 of its 99.5; credits net of the maker fee.
    expect(s(bal('USDT').locked)).toBe('49.75');
    expect(s(bal('USDT').free)).toBe('800.9');
    expect(s(bal('BTC').free)).toBe('3.4985');
  });

  it('same price: time priority', () => {
    const { ctx, engine } = setup();
    const c = rest(engine, limitBuy('99.50', '1'), ctx);
    ctx.now += 1;
    const e = rest(engine, limitBuy('99.50', '1'), ctx);
    const got = fills(engine.onTrade('BTCUSDT', trade('99.40', '1.2', true), ctx));
    expect(got.map((f) => [f.fill.orderId, s(f.fill.qty)])).toEqual([
      [c, '1'],
      [e, '0.2'],
    ]);
  });
});

describe('allocateTradeThrough', () => {
  const order = (id: string, side: 'buy' | 'sell', price: string, qty: string, createdAt: number, filled = '0') =>
    ({ id, side, price: D(price), qty: D(qty), filledQty: D(filled), createdAt }) as SpotOrder;

  it('never allocates more than the trade quantity and uses remaining quantity', () => {
    const orders = [order('x', 'buy', '99.5', '2', 1, '1.5'), order('y', 'buy', '99.5', '3', 2)];
    const out = allocateTradeThrough(orders, trade('99.4', '1', true));
    expect(out.map((a) => [a.orderId, s(a.qty)])).toEqual([
      ['x', '0.5'],
      ['y', '0.5'],
    ]);
  });

  it('same price: earlier createdAt first, whatever order the caller passes them in', () => {
    const orders = [order('late', 'buy', '99.5', '1', 2), order('early', 'buy', '99.5', '1', 1)];
    const out = allocateTradeThrough(orders, trade('99.4', '1.5', true));
    expect(out.map((a) => [a.orderId, s(a.qty)])).toEqual([
      ['early', '1'],
      ['late', '0.5'],
    ]);
  });

  it('sells: strictly above, buyer-initiated only, lower price first', () => {
    const orders = [
      order('hi', 'sell', '101', '1', 1),
      order('lo', 'sell', '100.5', '1', 2),
      order('b', 'buy', '102', '1', 0),
    ];
    expect(allocateTradeThrough(orders, trade('101', '5', false)).map((a) => a.orderId)).toEqual(['lo']);
    // A seller-initiated trade never fills a sell (here it fills only the buy above it).
    expect(allocateTradeThrough(orders, trade('101.01', '1.5', true)).map((a) => a.orderId)).toEqual(['b']);
    const out = allocateTradeThrough(orders, trade('101.01', '1.5', false));
    expect(out.map((a) => [a.orderId, s(a.qty)])).toEqual([
      ['lo', '1'],
      ['hi', '0.5'],
    ]);
  });
});

describe('sell limit', () => {
  it('101 × 1 fills 0.4 at 101 on a buyer-initiated trade at 101.01', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(limitSell('101', '1'), ctx));
    expect(order.lockAsset).toBe('BTC');
    expect(s(order.lockAmount)).toBe('1');
    expect(s(order.bestAtSubmit)).toBe('99.9');
    arriveNow(engine, order, ctx);
    expect(stored(order.id).status).toBe('open');
    expect(engine.onTrade('BTCUSDT', trade('101.00', '1', false), ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('101.01', '1', true), ctx)).toEqual([]);

    const { fill, order: after } = onlyFill(engine.onTrade('BTCUSDT', trade('101.01', '0.4', false), ctx));
    expect(s(fill.qty)).toBe('0.4');
    expect(s(fill.price)).toBe('101');
    expect(s(fill.quote)).toBe('40.4');
    expect(fill.liquidity).toBe('maker');
    expect(fill.feeAsset).toBe('USDT');
    expect(s(fill.fee)).toBe('0.0404');
    expect(s(fill.bestAtArrival)).toBe('99.9');
    expect(after.status).toBe('partially_filled');
    expect(s(after.lockAmount)).toBe('0.6');
    expect(s(bal('BTC').locked)).toBe('0.6');
    expect(s(bal('BTC').free)).toBe('1');
    expect(s(bal('USDT').free)).toBe('1040.3596');
  });
});

describe('marketable limit', () => {
  it('buy 100.10 × 2: taker fill 1.5 up to the limit, remainder 0.5 rests as maker', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(limitBuy('100.10', '2'), ctx));
    expect(s(order.lockAmount)).toBe('200.2');
    const { fill, order: after } = onlyFill(arriveNow(engine, order, ctx));
    expect(fill.liquidity).toBe('taker');
    expect(s(fill.qty)).toBe('1.5');
    expect(s(fill.quote)).toBe('150.1');
    expect(fill.price.toFixed(8)).toBe('100.06666667');
    expect(s(fill.fee)).toBe('0.0015');
    expect(s(fill.slippageUsd)).toBe('0.1');
    expect(s(fill.bestAtArrival)).toBe('100');
    expect(after.status).toBe('partially_filled');
    expect(s(after.lockAmount)).toBe('50.05');
    expect(stored(order.id).status).toBe('partially_filled');
    expect(s(stored(order.id).lockAmount)).toBe('50.05');
    // 200.2 locked: 150.1 spent, 50.05 kept for the remainder, 0.05 released.
    expect(s(bal('USDT').locked)).toBe('50.05');
    expect(s(bal('USDT').free)).toBe('799.85');
    expect(s(bal('BTC').free)).toBe('3.4985');

    const rest2 = onlyFill(engine.onTrade('BTCUSDT', trade('100.00', '1', true), ctx));
    expect(rest2.fill.liquidity).toBe('maker');
    expect(s(rest2.fill.qty)).toBe('0.5');
    expect(s(rest2.fill.price)).toBe('100.1');
    expect(rest2.order.status).toBe('filled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('799.85');
  });

  it('fully marketable buy fills at arrival and releases the cheaper part of the lock', () => {
    const { ctx, engine, bal } = setup();
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    const { fill, order: after } = onlyFill(arriveNow(engine, order, ctx));
    expect(s(fill.quote)).toBe('100.05');
    expect(after.status).toBe('filled');
    expect(s(after.lockAmount)).toBe('0');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('899.95');
  });

  it('sell 99.85 × 1: hits the 99.90 bid for 0.4, 0.6 rests with 0.6 BTC locked', () => {
    const { ctx, engine, bal } = setup();
    const order = placed(engine.submit(limitSell('99.85', '1'), ctx));
    const { fill, order: after } = onlyFill(arriveNow(engine, order, ctx));
    expect(fill.liquidity).toBe('taker');
    expect(s(fill.qty)).toBe('0.4');
    expect(s(fill.quote)).toBe('39.96');
    expect(s(fill.fee)).toBe('0.03996');
    expect(after.status).toBe('partially_filled');
    expect(s(after.lockAmount)).toBe('0.6');
    expect(s(bal('BTC').locked)).toBe('0.6');
    expect(s(bal('BTC').free)).toBe('1');
    expect(s(bal('USDT').free)).toBe('1039.92004');
  });
});

describe('dollar-sized limit', () => {
  it('buy 99.50 for 199.10 USDT → qty 2.001 (floored to step), lock 199.0995', () => {
    const { ctx, engine, bal } = setup();
    const order = placed(engine.submit(req('buy', 'limit', '99.50', { quoteQty: '199.10' }), ctx));
    expect(s(order.qty)).toBe('2.001');
    expect(s(order.quoteQty)).toBe('199.1');
    expect(s(order.lockAmount)).toBe('199.0995');
    expect(s(bal('USDT').locked)).toBe('199.0995');
  });
});

describe('post-only', () => {
  it('buy at the best ask is rejected at arrival and the lock released', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(req('buy', 'post_only', '100.00', { qty: '1' }), ctx));
    expect(s(bal('USDT').locked)).toBe('100');
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe(POST_ONLY);
    expect(stored(order.id).status).toBe('rejected');
    expect(s(stored(order.id).lockAmount)).toBe('0');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
  });

  it('sell at the best bid is rejected at arrival', () => {
    const { ctx, engine, bal } = setup();
    const order = placed(engine.submit(req('sell', 'post_only', '99.90', { qty: '1' }), ctx));
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe(POST_ONLY);
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('2');
  });

  it('buy 99.95 rests and its trade-through fill is maker', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = rest(engine, req('buy', 'post_only', '99.95', { qty: '1' }), ctx);
    expect(stored(id).status).toBe('open');
    const { fill, order } = onlyFill(engine.onTrade('BTCUSDT', trade('99.90', '1', true), ctx));
    expect(fill.liquidity).toBe('maker');
    expect(s(fill.price)).toBe('99.95');
    expect(s(fill.fee)).toBe('0.001');
    expect(order.status).toBe('filled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('900.05');
  });
});

describe('fee-rate selection', () => {
  it('maker fills use ctx.fees.maker, taker fills ctx.fees.taker', () => {
    const { ctx, engine } = setup();
    ctx.fees = { maker: D('0.0002'), taker: D('0.0005') };
    rest(engine, limitBuy('99.50', '1'), ctx);
    expect(s(onlyFill(engine.onTrade('BTCUSDT', trade('99.40', '1', true), ctx)).fill.fee)).toBe('0.0002');
    const taker = placed(engine.submit(limitBuy('100.10', '1.2'), ctx));
    const { fill } = onlyFill(arriveNow(engine, taker, ctx));
    expect(fill.liquidity).toBe('taker');
    expect(s(fill.qty)).toBe('1.2');
    expect(s(fill.fee)).toBe('0.0006');
  });
});

describe('cancel', () => {
  it('open buy limit → order_cancelled reason user when the cancel arrives, lock released', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '2'), ctx);
    const e = only(cancelNow(engine, id, ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(s(e.cancelledQty)).toBe('2');
    expect(e.time).toBe(ctx.now);
    expect(e.order.status).toBe('cancelled');
    expect(e.order.cancelArrivesAt).toBeNull();
    expect(s(e.order.lockAmount)).toBe('0');
    expect(stored(id).status).toBe('cancelled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
    expect(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx)).toEqual([]);
  });

  it('partially filled sell limit → cancels the remaining quantity and releases the remaining coins', () => {
    const { ctx, engine, bal } = setup();
    const id = rest(engine, limitSell('101', '1'), ctx);
    engine.onTrade('BTCUSDT', trade('101.01', '0.4', false), ctx);
    const e = only(cancelNow(engine, id, ctx), 'order_cancelled');
    expect(s(e.cancelledQty)).toBe('0.6');
    expect(s(e.order.filledQty)).toBe('0.4');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('1.6');
  });

  it('pending limit whose cancel arrives with it → cancelled; a later arrive is a no-op', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(limitBuy('99.50', '2'), ctx));
    expect(only(cancelNow(engine, order.id, ctx), 'order_cancelled').reason).toBe('user');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(arriveNow(engine, order, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('cancelled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
  });

  it('pending market order cannot be cancelled', () => {
    const { ctx, engine, bal } = setup();
    const order = placed(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1.2' }, ctx));
    expect(engine.cancel(order.id, ctx)).toEqual({
      ok: false,
      reason: 'Order is already executing and cannot be cancelled',
    });
    expect(s(bal('USDT').locked)).toBe('120.07');
  });

  it('unknown and terminal orders', () => {
    const { ctx, engine } = setup();
    expect(engine.cancel('nope', ctx)).toEqual({ ok: false, reason: 'Order not found' });
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    cancelNow(engine, id, ctx);
    expect(engine.cancel(id, ctx)).toEqual({ ok: false, reason: 'Order is not open' });
    const filled = placed(engine.submit(limitBuy('100.10', '0.1'), ctx));
    arriveNow(engine, filled, ctx);
    expect(engine.cancel(filled.id, ctx)).toEqual({ ok: false, reason: 'Order is not open' });
  });
});

describe('a cancel reaches the exchange after the arrival delay', () => {
  it('requesting a cancel only sets its arrival time: the order stays open with its lock', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    const t = ctx.now;
    expect(stored(id).cancelArrivesAt).toBeNull();
    expect(engine.cancel(id, ctx)).toEqual({ ok: true, events: [] });
    expect(stored(id).status).toBe('open');
    expect(stored(id).cancelArrivesAt).toBe(t + 100);
    expect(s(stored(id).lockAmount)).toBe('99.5');
    expect(s(bal('USDT').locked)).toBe('99.5');
  });

  it('a trade during the delay still fills the order; the late cancel is recorded and changes nothing else', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    const t = ctx.now;
    engine.cancel(id, ctx);
    ctx.now = t + 1;
    const { fill } = onlyFill(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx));
    expect(s(fill.qty)).toBe('1');
    expect(s(fill.price)).toBe('99.5');
    const balances = JSON.stringify(engine.state.balances);

    ctx.now = t + 100;
    const e = only(engine.arriveCancel(id, ctx), 'cancel_rejected');
    expect(e.reason).toBe('Cancel arrived too late: order already filled');
    expect(e.time).toBe(t + 100);
    expect(e.order.id).toBe(id);
    expect(e.order.status).toBe('filled');
    expect(e.order.cancelArrivesAt).toBeNull();
    expect(stored(id)).toEqual(e.order);
    expect(s(stored(id).filledQty)).toBe('1');
    expect(JSON.stringify(engine.state.balances)).toBe(balances);
    expect(s(bal('USDT').locked)).toBe('0');
    // Delivered once.
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
  });

  it('no trade: nothing happens before the arrival time; at it the order is cancelled and the lock released', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    const t = ctx.now;
    engine.cancel(id, ctx);
    ctx.now = t + 99;
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
    expect(s(bal('USDT').locked)).toBe('99.5');

    ctx.now = t + 100;
    const e = only(engine.arriveCancel(id, ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(e.time).toBe(t + 100);
    expect(s(e.cancelledQty)).toBe('1');
    expect(stored(id).status).toBe('cancelled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
  });

  it('a second cancel while one is in flight is refused and keeps the first arrival time', () => {
    const { ctx, engine, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    const t = ctx.now;
    expect(engine.cancel(id, ctx).ok).toBe(true);
    ctx.now = t + 50;
    expect(engine.cancel(id, ctx)).toEqual({ ok: false, reason: 'Cancel already requested' });
    expect(stored(id).cancelArrivesAt).toBe(t + 100);
  });

  it('a pending order whose cancel arrives first is cancelled before it arrives', () => {
    const { ctx, engine, bal, stored } = setup();
    const t = ctx.now;
    const rng = [0.9999, 0]; // 300 ms for the order, then 100 ms for the cancel
    ctx.rng = () => rng.shift() ?? 0;
    const order = placed(engine.submit(limitBuy('99.50', '1'), ctx));
    expect(order.arrivesAt).toBe(t + 300);
    ctx.now = t + 10;
    expect(engine.cancel(order.id, ctx).ok).toBe(true);
    expect(stored(order.id).cancelArrivesAt).toBe(t + 110);
    expect(stored(order.id).status).toBe('pending');

    ctx.now = t + 110;
    const e = only(engine.arriveCancel(order.id, ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(s(bal('USDT').locked)).toBe('0');
    ctx.now = t + 300;
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('cancelled');
    expect(s(bal('USDT').free)).toBe('1000');
  });

  it('a pending order whose own arrival comes first arrives first: a marketable limit fills as taker', () => {
    const { ctx, engine, stored } = setup();
    const t = ctx.now;
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    expect(order.arrivesAt).toBe(t + 100);
    ctx.now = t + 50;
    expect(engine.cancel(order.id, ctx).ok).toBe(true);
    expect(stored(order.id).cancelArrivesAt).toBe(t + 150);

    ctx.now = t + 100;
    const { fill, order: after } = onlyFill(engine.arrive(order.id, ctx));
    expect(fill.liquidity).toBe('taker');
    expect(after.status).toBe('filled');
    ctx.now = t + 150;
    expect(only(engine.arriveCancel(order.id, ctx), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already filled',
    );
  });

  it('an order rejected at its arrival: the cancel arriving later says so', () => {
    const { ctx, engine, bal } = setup();
    const t = ctx.now;
    const order = placed(engine.submit(req('buy', 'post_only', '100.00', { qty: '1' }), ctx));
    ctx.now = t + 50;
    engine.cancel(order.id, ctx);
    ctx.now = t + 100;
    expect(rejectReason(engine.arrive(order.id, ctx))).toBe(POST_ONLY);
    ctx.now = t + 150;
    expect(only(engine.arriveCancel(order.id, ctx), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already rejected',
    );
    expect(s(bal('USDT').free)).toBe('1000');
  });

  it('a partial fill during the delay: the cancel cancels the rest', () => {
    const { ctx, engine, bal } = setup();
    const id = rest(engine, limitBuy('99.50', '2'), ctx);
    engine.cancel(id, ctx);
    ctx.now += 1;
    engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    ctx.now += 99;
    const e = only(engine.arriveCancel(id, ctx), 'order_cancelled');
    expect(s(e.cancelledQty)).toBe('1.5');
    expect(s(e.order.filledQty)).toBe('0.5');
    expect(s(bal('USDT').locked)).toBe('0');
  });

  it('a trade at or after the cancel arrival time never fills the order, even before arriveCancel runs', () => {
    const { ctx, engine, bal, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    engine.cancel(id, ctx);
    ctx.now = stored(id).cancelArrivesAt!;
    const e = only(engine.onTrade('BTCUSDT', trade('99.00', '5', true), ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(stored(id).status).toBe('cancelled');
    expect(s(stored(id).filledQty)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
  });

  it('a trade past both due times leaves a pending order whose own arrival comes first to its arrival', () => {
    const { ctx, engine, stored } = setup();
    const t = ctx.now;
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    expect(order.arrivesAt).toBe(t + 100);
    ctx.now = t + 50;
    engine.cancel(order.id, ctx);
    expect(stored(order.id).cancelArrivesAt).toBe(t + 150);

    // Processed before the arrival runs: the cancel must not overtake the earlier arrival.
    ctx.now = t + 160;
    expect(engine.onTrade('BTCUSDT', trade('100.00', '0.1', false), ctx)).toEqual([]);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('pending');

    const { fill, order: after } = onlyFill(engine.arrive(order.id, ctx));
    expect(fill.liquidity).toBe('taker');
    expect(after.status).toBe('filled');
    expect(only(engine.arriveCancel(order.id, ctx), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already filled',
    );
  });

  it('a trade past the due time of a cancel that comes before the order arrival delivers the cancel', () => {
    const { ctx, engine, stored } = setup();
    const t = ctx.now;
    const rng = [0.9999, 0]; // 300 ms for the order, then 100 ms for the cancel
    ctx.rng = () => rng.shift() ?? 0;
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    ctx.now = t + 10;
    engine.cancel(order.id, ctx);
    ctx.now = t + 120;
    expect(only(engine.onTrade('BTCUSDT', trade('100.00', '0.1', false), ctx), 'order_cancelled').reason).toBe('user');
    ctx.now = t + 300;
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('cancelled');
  });

  it('arriveCancel run before an arrival due at the same time delivers the arrival first', () => {
    const { ctx, engine, stored } = setup();
    const t = ctx.now;
    const rng = [0.5, 0]; // 200 ms for the order, then 100 ms for the cancel
    ctx.rng = () => rng.shift() ?? 0;
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    expect(order.arrivesAt).toBe(t + 200);
    ctx.now = t + 100;
    engine.cancel(order.id, ctx);
    expect(stored(order.id).cancelArrivesAt).toBe(t + 200);

    // The cancel's timer happens to run first.
    ctx.now = t + 200;
    const events = engine.arriveCancel(order.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'cancel_rejected']);
    const [fill, late] = events;
    expect(fill?.type === 'fill' && fill.fill.liquidity).toBe('taker');
    expect(late?.type === 'cancel_rejected' && late.reason).toBe('Cancel arrived too late: order already filled');
    expect(stored(order.id).status).toBe('filled');
    expect(engine.arrive(order.id, ctx)).toEqual([]);
  });

  it('arriveCancel run late, after an earlier arrival was missed: the order arrives, then the cancel acts', () => {
    const { ctx, engine, bal, stored } = setup();
    const t = ctx.now;
    const order = placed(engine.submit(limitBuy('99.50', '1'), ctx));
    ctx.now = t + 50;
    engine.cancel(order.id, ctx); // arrives t+100, cancel t+150
    ctx.now = t + 5_000;
    const e = only(engine.arriveCancel(order.id, ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(stored(order.id).status).toBe('cancelled');
    expect(stored(order.id).cancelArrivesAt).toBeNull();
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.arrive(order.id, ctx)).toEqual([]);
  });

  it('a buy that its arrival fills inside arriveCancel places its attached pair once', () => {
    const { ctx, engine, stored } = setup();
    const attach = { stopLoss: '95', takeProfit: '110' };
    const order = placed(engine.submit(req('buy', 'limit', '100.10', { qty: '1', attach }), ctx));
    engine.cancel(order.id, ctx); // both arrive 100 ms later
    expect(stored(order.id).cancelArrivesAt).toBe(order.arrivesAt);
    ctx.now = order.arrivesAt!;
    const events = engine.arriveCancel(order.id, ctx);
    expect(events.filter((e) => e.type === 'fill')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'order_placed').map((e) => e.order.type)).toEqual([
      'stop_loss',
      'take_profit',
    ]);
    expect(only(events.filter((e) => e.type === 'cancel_rejected'), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already filled',
    );
    expect(engine.arrive(order.id, ctx)).toEqual([]);
  });

  it('arriveCancelBeforeResend cancels a pending order whose old arrival came first (it is sent again after a restart)', () => {
    const { ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    engine.cancel(order.id, ctx);
    ctx.now = order.arrivesAt! + 60_000;
    const e = only(engine.arriveCancelBeforeResend(order.id, ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(stored(order.id).status).toBe('cancelled');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.arriveCancelBeforeResend(order.id, ctx)).toEqual([]);
  });

  it('arriveCancel ignores unknown orders and orders with no cancel in flight', () => {
    const { ctx, engine, stored } = setup();
    const id = rest(engine, limitBuy('99.50', '1'), ctx);
    expect(engine.arriveCancel('nope', ctx)).toEqual([]);
    ctx.now += 1_000;
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
  });
});

describe('limit submit and arrival checks', () => {
  it('stale at submit → rejected, nothing locked', () => {
    const { market, ctx, engine, bal } = setup();
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(engine.submit(limitBuy('99.50', '1'), ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(s(bal('USDT').locked)).toBe('0');
  });

  it('stale at arrival → rejected, lock released', () => {
    const { market, ctx, engine, bal, stored } = setup();
    const order = placed(engine.submit(limitBuy('99.50', '1'), ctx));
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(stored(order.id).status).toBe('rejected');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('USDT').free)).toBe('1000');
  });

  it('arrive before arrivesAt is a no-op', () => {
    const { ctx, engine, stored } = setup();
    const order = placed(engine.submit(limitBuy('100.10', '1'), ctx));
    ctx.now = order.arrivesAt! - 1;
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('pending');
  });

  it('request problems are rejected with clear reasons', () => {
    const { ctx, engine } = setup({ usdt: '100' });
    expect(rejectReason(engine.submit(req('buy', 'limit', '', { qty: '1' }), ctx))).toBe('Enter a limit price');
    expect(rejectReason(engine.submit(req('buy', 'limit', '99.50', {}), ctx))).toBe(
      'Enter either a coin amount or a dollar amount',
    );
    expect(rejectReason(engine.submit(limitBuy('99.505', '1'), ctx))).toBe(
      'PRICE_FILTER: price 99.505 is not a multiple of tick size 0.01',
    );
    expect(rejectReason(engine.submit(limitBuy('99.50', '0.000015'), ctx))).toBe(
      'LOT_SIZE: quantity 0.000015 is not a multiple of step size 0.00001',
    );
    expect(rejectReason(engine.submit(limitBuy('99.50', '2'), ctx))).toBe('Insufficient USDT: need 199, available 100');
    expect(rejectReason(engine.submit(limitSell('101', '3'), ctx))).toBe('Insufficient BTC: need 3, available 2');
  });

  it('pending and open limits count toward MAX_NUM_ORDERS', () => {
    const { market, ctx, engine } = setup();
    market.setRules('BTCUSDT', { ...btcRules, maxNumOrders: 2 });
    const open = rest(engine, limitBuy('99.50', '1'), ctx);
    placed(engine.submit(limitBuy('99.40', '1'), ctx));
    expect(rejectReason(engine.submit(limitBuy('99.30', '1'), ctx))).toBe(
      'MAX_NUM_ORDERS: already 2 open orders on BTCUSDT (maximum 2)',
    );
    // An order with a cancel in flight is still open and still counts.
    expect(engine.cancel(open, ctx).ok).toBe(true);
    expect(rejectReason(engine.submit(limitBuy('99.30', '1'), ctx))).toBe(
      'MAX_NUM_ORDERS: already 2 open orders on BTCUSDT (maximum 2)',
    );
    ctx.now = engine.state.orders.get(open)!.cancelArrivesAt!;
    engine.arriveCancel(open, ctx);
    placed(engine.submit(limitBuy('99.30', '1'), ctx));
  });
});

describe('limit preview', () => {
  it('resting buy: limit price, no slippage, maker fee', () => {
    const { ctx, engine, bal } = setup();
    const p = engine.preview(limitBuy('99.50', '2'), ctx);
    expect(s(p.estAvgPrice)).toBe('99.5');
    expect(s(p.estSlippageUsd)).toBe('0');
    expect(s(p.estSlippagePct)).toBe('0');
    expect(p.fee.asset).toBe('BTC');
    expect(s(p.fee.amount)).toBe('0.002');
    expect(s(p.fee.usd)).toBe('0.199');
    expect(s(p.total)).toBe('199');
    expect(s(p.receive)).toBe('1.998');
    expect(p.exhausted).toBe(false);
    expect(p.rejectReason).toBeNull();
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.state.orders.size).toBe(0);
  });

  it('marketable buy: taker part walked up to the limit, maker fee on the rest', () => {
    const { ctx, engine } = setup();
    ctx.fees = { maker: D('0.0002'), taker: D('0.0005') };
    const p = engine.preview(limitBuy('100.10', '2'), ctx);
    // taker 1.5 for 150.1 (fee 0.00075), maker 0.5 for 50.05 (fee 0.0001)
    expect(s(p.estAvgPrice)).toBe('100.075');
    expect(s(p.estSlippageUsd)).toBe('0.1');
    expect(s(p.fee.amount)).toBe('0.00085');
    expect(s(p.fee.usd)).toBe('0.08506');
    expect(s(p.total)).toBe('200.15');
    expect(s(p.receive)).toBe('1.99915');
  });

  it('resting sell: total and receive are USDT after the fee', () => {
    const { ctx, engine } = setup();
    const p = engine.preview(limitSell('101', '1'), ctx);
    expect(p.fee.asset).toBe('USDT');
    expect(s(p.fee.amount)).toBe('0.101');
    expect(s(p.total)).toBe('100.899');
    expect(s(p.receive)).toBe('100.899');
  });

  it('marketable post-only previews the post-only rejection', () => {
    const { ctx, engine } = setup();
    expect(engine.preview(req('buy', 'post_only', '100.00', { qty: '1' }), ctx).rejectReason).toBe(POST_ONLY);
    expect(engine.preview(req('buy', 'post_only', '99.95', { qty: '1' }), ctx).rejectReason).toBeNull();
  });

  it('reports the submit rejection and does not create balance rows', () => {
    const market = new FakeMarket();
    const ctx = testCtx(market, { now: NOW });
    const engine = new SpotEngine(emptySpotState(['USDT']));
    const p = engine.preview(limitSell('101', '1'), ctx);
    expect(p.rejectReason).toBe('Insufficient BTC: need 1, available 0');
    expect('BTC' in engine.state.balances.spot).toBe(false);
    market.setFresh('BTCUSDT', false);
    const stale = engine.preview(limitBuy('99.50', '1'), ctx);
    expect(stale.rejectReason).toBe('Live data interrupted for BTCUSDT');
    expect(stale.total).toBeNull();
  });
});
