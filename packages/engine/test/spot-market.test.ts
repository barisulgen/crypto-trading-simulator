import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import type { EngineCtx, EngineEvent, SpotOrder, SpotOrderRequest } from '../src/types.ts';
import { FakeMarket, testCtx } from './fixtures.ts';

const NOW = 1_000_000;

function setup(usdt: string, opts: { btc?: string; rngValues?: number[] } = {}) {
  const market = new FakeMarket();
  const ctx = testCtx(market, { now: NOW, rngValues: opts.rngValues });
  const engine = new SpotEngine(emptySpotState(['USDT', 'BTC']));
  if (D(usdt).gt(0)) engine.deposit('spot', D(usdt), ctx);
  if (opts.btc) engine.state.balances.spot.BTC!.free = D(opts.btc);
  const bal = (asset: string) => engine.state.balances.spot[asset]!;
  return { market, ctx, engine, bal };
}

const buy = (fields: Partial<SpotOrderRequest>): SpotOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  ...fields,
});
const sell = (fields: Partial<SpotOrderRequest>): SpotOrderRequest => ({ ...buy(fields), side: 'sell' });

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
  expect(e.order.status).toBe('rejected');
  expect(e.order.rejectReason).toBe(e.reason);
  return e.reason;
}

function fillOf(events: EngineEvent[]) {
  const e = events.find((x) => x.type === 'fill');
  if (!e || e.type !== 'fill') throw new Error('no fill event');
  return e.fill;
}

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

/** Arrive at the order's arrival time (arrive is a no-op before it). */
function arriveNow(engine: SpotEngine, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

describe('arrival delay', () => {
  it('rng 0 → now + 100', () => {
    const { ctx, engine } = setup('1000', { rngValues: [0] });
    expect(placed(engine.submit(buy({ qty: '1.2' }), ctx)).arrivesAt).toBe(NOW + 100);
  });
  it('rng 0.999999 → now + 300', () => {
    const { ctx, engine } = setup('1000', { rngValues: [0.999999] });
    expect(placed(engine.submit(buy({ qty: '1.2' }), ctx)).arrivesAt).toBe(NOW + 300);
  });
});

describe('market buy by quantity', () => {
  it('submit locks the preview cost and records the best ask', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    expect(order.id).toBe('o1');
    expect(order.status).toBe('pending');
    expect(order.createdAt).toBe(NOW);
    expect(order.lockAsset).toBe('USDT');
    expect(s(order.lockAmount)).toBe('120.07');
    expect(s(order.bestAtSubmit)).toBe('100');
    expect(s(order.qty)).toBe('1.2');
    expect(order.quoteQty).toBeNull();
    expect(s(bal('USDT').free)).toBe('879.93');
    expect(s(bal('USDT').locked)).toBe('120.07');
    expect(engine.state.orders.get('o1')!.status).toBe('pending');
  });

  it('arrive fills against the book and settles balances', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    const events = arriveNow(engine, order, ctx);
    expect(events).toHaveLength(1);
    const fill = fillOf(events);
    expect(fill.id).toBe('f1');
    expect(fill.orderId).toBe('o1');
    expect(fill.time).toBe(ctx.now);
    expect(s(fill.qty)).toBe('1.2');
    expect(fill.price.toFixed(8)).toBe('100.05833333');
    expect(s(fill.quote)).toBe('120.07');
    expect(fill.liquidity).toBe('taker');
    expect(fill.feeAsset).toBe('BTC');
    expect(s(fill.fee)).toBe('0.0012');
    expect(s(fill.feeUsd)).toBe('0.12007');
    expect(s(fill.slippageUsd)).toBe('0.07');
    expect(s(fill.driftUsd)).toBe('0');
    expect(s(fill.bestAtArrival)).toBe('100');
    expect(s(fill.bestAtSubmit)).toBe('100');
    expect(fill.triggerPrice).toBeNull();
    expect(fill.realizedPnl).toBeNull();
    expect(fill.roundTripId).toBeNull();

    expect(s(bal('USDT').free)).toBe('879.93');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('1.1988');
    const stored = engine.state.orders.get('o1')!;
    expect(stored.status).toBe('filled');
    expect(s(stored.filledQty)).toBe('1.2');
    expect(s(stored.filledQuote)).toBe('120.07');
    expect(s(stored.fee)).toBe('0.0012');
    expect(stored.feeAsset).toBe('BTC');
    expect(s(stored.lockAmount)).toBe('0');
    const e = events[0]!;
    if (e.type === 'fill') expect(e.order.status).toBe('filled');
  });

  it('arrive a second time, or for an unknown id, is a no-op', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    arriveNow(engine, order, ctx);
    expect(arriveNow(engine, order, ctx)).toEqual([]);
    expect(engine.arrive('nope', ctx)).toEqual([]);
    expect(s(bal('BTC').free)).toBe('1.1988');
  });

  it('arrive before arrivesAt is a no-op (the delay is enforced by the engine)', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    ctx.now = order.arrivesAt! - 1;
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(engine.state.orders.get(order.id)!.status).toBe('pending');
    expect(s(bal('USDT').locked)).toBe('120.07');
    ctx.now = order.arrivesAt!;
    expect(fillOf(engine.arrive(order.id, ctx)).qty.toString()).toBe('1.2');
  });

  it('delay drift: book moves up between submit and arrival', () => {
    const { market, ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    market.setBook('BTCUSDT', { asks: [{ price: D('100.10'), qty: D('5') }], bids: [] });
    const fill = fillOf(arriveNow(engine, order, ctx));
    expect(s(fill.price)).toBe('100.1');
    expect(s(fill.quote)).toBe('120.12');
    expect(s(fill.driftUsd)).toBe('0.12');
    expect(s(fill.slippageUsd)).toBe('0');
    expect(s(fill.bestAtArrival)).toBe('100.1');
    // 120.07 locked + 0.05 taken from free
    expect(s(bal('USDT').free)).toBe('879.88');
    expect(s(bal('USDT').locked)).toBe('0');
  });

  it('thin book: fills what the book has, cancels the rest', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '5.0' }), ctx));
    expect(s(order.lockAmount)).toBe('351.1');
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_cancelled']);
    expect(s(fillOf(events).qty)).toBe('3.5');
    const c = events[1]!;
    if (c.type !== 'order_cancelled') throw new Error('expected order_cancelled');
    expect(c.reason).toBe('thin_book');
    expect(s(c.cancelledQty)).toBe('1.5');
    expect(c.order.status).toBe('cancelled');
    expect(engine.state.orders.get(order.id)!.status).toBe('cancelled');
    expect(s(engine.state.orders.get(order.id)!.filledQty)).toBe('3.5');
    expect(s(bal('USDT').free)).toBe('648.9');
    expect(s(bal('USDT').locked)).toBe('0');
  });

  it('empty book at arrival: only order_cancelled, lock released', () => {
    const { market, ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    market.setBook('BTCUSDT', { asks: [], bids: [] });
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
    const c = events[0]!;
    if (c.type !== 'order_cancelled') throw new Error('expected order_cancelled');
    expect(c.reason).toBe('thin_book');
    expect(s(c.cancelledQty)).toBe('1.2');
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.state.orders.get(order.id)!.status).toBe('cancelled');
  });
});

describe('staleness', () => {
  it('stale at submit → rejected, nothing locked', () => {
    const { market, ctx, engine, bal } = setup('1000');
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(engine.submit(buy({ qty: '1.2' }), ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.state.orders.get('o1')!.status).toBe('rejected');
  });

  it('stale at arrival → rejected, lock released', () => {
    const { market, ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    market.setFresh('BTCUSDT', false);
    const events = arriveNow(engine, order, ctx);
    expect(rejectReason(events)).toBe('Live data interrupted for BTCUSDT');
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
    const stored = engine.state.orders.get(order.id)!;
    expect(stored.status).toBe('rejected');
    expect(s(stored.lockAmount)).toBe('0');
  });

  it('stale at arrival is decided before asking for the symbol rules', () => {
    const { market, ctx, engine } = setup('1000');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    market.setFresh('BTCUSDT', false);
    market.rules = () => {
      throw new Error('rules unavailable while stale');
    };
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe('Live data interrupted for BTCUSDT');
  });
});

describe('funds', () => {
  it('insufficient at submit', () => {
    const { ctx, engine, bal } = setup('100');
    expect(rejectReason(engine.submit(buy({ qty: '1.2' }), ctx))).toBe(
      'Insufficient USDT: need 120.07, available 100',
    );
    expect(s(bal('USDT').free)).toBe('100');
    expect(s(bal('USDT').locked)).toBe('0');
  });

  it('price moved at arrival beyond free + locked → rejected, no fill, lock released', () => {
    const { market, ctx, engine, bal } = setup('125');
    const order = placed(engine.submit(buy({ qty: '1.2' }), ctx));
    market.setBook('BTCUSDT', { asks: [{ price: D('105'), qty: D('5') }], bids: [] });
    const events = arriveNow(engine, order, ctx);
    expect(rejectReason(events)).toBe('Insufficient funds at execution: price moved (need 126, available 125)');
    expect(s(bal('USDT').free)).toBe('125');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('0');
  });

  it('second market buy rejected while first is in flight (double spend)', () => {
    const { ctx, engine } = setup('200');
    placed(engine.submit(buy({ qty: '1.2' }), ctx));
    expect(rejectReason(engine.submit(buy({ qty: '1.2' }), ctx))).toBe(
      'Insufficient USDT: need 120.07, available 79.93',
    );
  });

  it('insufficient coins for a sell', () => {
    const { ctx, engine } = setup('0', { btc: '1' });
    expect(rejectReason(engine.submit(sell({ qty: '1.5' }), ctx))).toBe('Insufficient BTC: need 1.5, available 1');
  });
});

describe('market sell', () => {
  it('sell 1.5 holding 2 BTC', () => {
    const { ctx, engine, bal } = setup('0', { btc: '2' });
    const order = placed(engine.submit(sell({ qty: '1.5' }), ctx));
    expect(order.lockAsset).toBe('BTC');
    expect(s(order.lockAmount)).toBe('1.5');
    expect(s(order.bestAtSubmit)).toBe('99.9');
    expect(s(bal('BTC').locked)).toBe('1.5');
    const fill = fillOf(arriveNow(engine, order, ctx));
    expect(s(fill.quote)).toBe('149.66');
    expect(fill.feeAsset).toBe('USDT');
    expect(s(fill.fee)).toBe('0.14966');
    expect(s(fill.slippageUsd)).toBe('0.19');
    expect(s(bal('USDT').free)).toBe('149.51034');
    expect(s(bal('BTC').free)).toBe('0.5');
    expect(s(bal('BTC').locked)).toBe('0');
  });

  it('sell drift is positive when the bid falls', () => {
    const { market, ctx, engine } = setup('0', { btc: '2' });
    const order = placed(engine.submit(sell({ qty: '1' }), ctx));
    market.setBook('BTCUSDT', { asks: [], bids: [{ price: D('99.5'), qty: D('5') }] });
    const fill = fillOf(arriveNow(engine, order, ctx));
    expect(s(fill.driftUsd)).toBe('0.4');
    expect(s(fill.slippageUsd)).toBe('0');
  });

  it('sell by dollar amount locks the walked quantity', () => {
    const { ctx, engine, bal } = setup('0', { btc: '2' });
    const order = placed(engine.submit(sell({ quoteQty: '50' }), ctx));
    expect(s(order.lockAmount)).toBe('0.5006');
    const fill = fillOf(arriveNow(engine, order, ctx));
    expect(s(fill.qty)).toBe('0.5006');
    expect(s(fill.quote)).toBe('49.99988');
    expect(s(fill.fee)).toBe('0.04999988');
    expect(s(bal('USDT').free)).toBe('49.94988012');
    expect(s(bal('BTC').free)).toBe('1.4994');
    expect(s(bal('BTC').locked)).toBe('0');
  });
});

describe('market buy by dollar amount', () => {
  it('locks quoteQty and releases the unspent remainder', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ quoteQty: '100.10' }), ctx));
    expect(s(order.lockAmount)).toBe('100.1');
    expect(s(order.quoteQty)).toBe('100.1');
    expect(order.qty).toBeNull();
    expect(s(bal('USDT').free)).toBe('899.9');
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const fill = fillOf(events);
    expect(s(fill.qty)).toBe('1.00049');
    expect(s(fill.quote)).toBe('100.099049');
    // unspent lock 100.1 − 100.099049 = 0.000951 goes back to free
    expect(s(bal('USDT').free)).toBe('899.900951');
    expect(s(bal('USDT').free.minus(D('899.9')))).toBe('0.000951');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').free)).toBe('0.99948951');
    expect(engine.state.orders.get(order.id)!.status).toBe('filled');
  });

  it('thin book: the unfilled dollars are cancelled at the last walked price', () => {
    const { ctx, engine, bal } = setup('1000');
    const order = placed(engine.submit(buy({ quoteQty: '400' }), ctx));
    expect(s(order.lockAmount)).toBe('400');
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_cancelled']);
    expect(s(fillOf(events).qty)).toBe('3.5');
    const c = events[1]!;
    if (c.type !== 'order_cancelled') throw new Error('expected order_cancelled');
    // 48.9 unspent at 100.50, floored to step 0.00001
    expect(s(c.cancelledQty)).toBe('0.48656');
    expect(s(bal('USDT').free)).toBe('648.9');
    expect(s(bal('USDT').locked)).toBe('0');
  });
});

describe('request validation', () => {
  it('needs exactly one of qty and quoteQty', () => {
    const { ctx, engine } = setup('1000');
    const msg = 'Enter either a coin amount or a dollar amount';
    expect(rejectReason(engine.submit(buy({}), ctx))).toBe(msg);
    expect(rejectReason(engine.submit(buy({ qty: '1', quoteQty: '100' }), ctx))).toBe(msg);
  });

  it('parse errors become the reject reason; comma decimals accepted', () => {
    const { ctx, engine } = setup('1000');
    expect(rejectReason(engine.submit(buy({ qty: '1.000,5' }), ctx))).toMatch(/^Invalid amount "1\.000,5"/);
    expect(s(placed(engine.submit(buy({ qty: '0,5' }), ctx)).qty)).toBe('0.5');
  });

  it('exchange filters reject', () => {
    const { ctx, engine } = setup('1000');
    expect(rejectReason(engine.submit(buy({ qty: '0.000015' }), ctx))).toBe(
      'MARKET_LOT_SIZE: quantity 0.000015 is not a multiple of step size 0.00001',
    );
    expect(rejectReason(engine.submit(buy({ quoteQty: '4' }), ctx))).toBe(
      'NOTIONAL: order value 4 is below the minimum 5',
    );
  });

  it('missing average price rejects (never guessed)', () => {
    const { market, ctx, engine } = setup('1000');
    market.setAvgPrice('BTCUSDT', null);
    expect(rejectReason(engine.submit(buy({ qty: '1' }), ctx))).toBe(
      'Average price unavailable; order rejected (never guessed)',
    );
  });

  it('stop and take-profit types are not supported yet', () => {
    const { ctx, engine } = setup('1000');
    expect(rejectReason(engine.submit(buy({ type: 'stop_loss', qty: '1', triggerPrice: '99' }), ctx))).toBe(
      'Order type not supported yet',
    );
  });

  it('empty book side at submit → rejected, nothing locked (no zero-lock orders)', () => {
    const { market, ctx, engine, bal } = setup('1000', { btc: '1' });
    market.setBook('BTCUSDT', { asks: [], bids: [] });
    expect(rejectReason(engine.submit(buy({ qty: '1' }), ctx))).toBe('Order book empty for BTCUSDT');
    expect(rejectReason(engine.submit(buy({ quoteQty: '50' }), ctx))).toBe('Order book empty for BTCUSDT');
    expect(rejectReason(engine.submit(sell({ qty: '0.5' }), ctx))).toBe('Order book empty for BTCUSDT');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(s(bal('BTC').locked)).toBe('0');
    expect(engine.preview(buy({ qty: '1' }), ctx).rejectReason).toBe('Order book empty for BTCUSDT');
  });

  it('dollar amount below one step at the best price → rejected, nothing locked', () => {
    const { market, ctx, engine, bal } = setup('1000');
    market.setBook('BTCUSDT', { asks: [{ price: D('600000'), qty: D('1') }], bids: [] });
    expect(rejectReason(engine.submit(buy({ quoteQty: '5' }), ctx))).toBe(
      'Amount too small: 5 USDT does not reach one step of 0.00001 BTC',
    );
    expect(s(bal('USDT').locked)).toBe('0');
  });
});

describe('preview', () => {
  it('market buy 1.2: estimates without locking', () => {
    const { ctx, engine, bal } = setup('1000');
    const p = engine.preview(buy({ qty: '1.2' }), ctx);
    expect(p.estAvgPrice!.toFixed(8)).toBe('100.05833333');
    expect(s(p.estSlippageUsd)).toBe('0.07');
    expect(p.estSlippagePct!.toFixed(6)).toBe('0.058333');
    expect(p.fee.asset).toBe('BTC');
    expect(s(p.fee.amount)).toBe('0.0012');
    expect(s(p.fee.usd)).toBe('0.12007');
    expect(s(p.total)).toBe('120.07');
    expect(s(p.receive)).toBe('1.1988');
    expect(p.exhausted).toBe(false);
    expect(p.rejectReason).toBeNull();
    expect(s(bal('USDT').free)).toBe('1000');
    expect(s(bal('USDT').locked)).toBe('0');
    expect(engine.state.orders.size).toBe(0);
  });

  it('market sell 1.5: total and receive are USDT after the fee', () => {
    const { ctx, engine } = setup('0', { btc: '2' });
    const p = engine.preview(sell({ qty: '1.5' }), ctx);
    expect(p.fee.asset).toBe('USDT');
    expect(s(p.fee.amount)).toBe('0.14966');
    expect(s(p.total)).toBe('149.51034');
    expect(s(p.receive)).toBe('149.51034');
  });

  it('reports what submit would reject with', () => {
    const { market, ctx, engine } = setup('100');
    const p = engine.preview(buy({ qty: '1.2' }), ctx);
    expect(p.rejectReason).toBe('Insufficient USDT: need 120.07, available 100');
    expect(s(p.total)).toBe('120.07');
    expect(engine.preview(buy({ qty: '5' }), ctx).exhausted).toBe(true);
    market.setFresh('BTCUSDT', false);
    const stale = engine.preview(buy({ qty: '1.2' }), ctx);
    expect(stale.rejectReason).toBe('Live data interrupted for BTCUSDT');
    expect(stale.estAvgPrice).toBeNull();
    expect(stale.total).toBeNull();
    expect(engine.state.orders.size).toBe(0);
  });

  it('does not create balance rows for an asset the wallet has never held', () => {
    const ctx = testCtx(new FakeMarket(), { now: NOW });
    const engine = new SpotEngine(emptySpotState(['USDT']));
    const before = JSON.stringify(engine.state.balances);
    expect(engine.preview(sell({ qty: '1' }), ctx).rejectReason).toBe('Insufficient BTC: need 1, available 0');
    expect(JSON.stringify(engine.state.balances)).toBe(before);
    expect('BTC' in engine.state.balances.spot).toBe(false);
  });
});
