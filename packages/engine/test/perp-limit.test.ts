import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { liquidationPrice } from '../src/perp/math.ts';
import { applyOpeningFill, reduceOutcome } from '../src/perp/position.ts';
import { emptyPerpState, evictTerminal, takeDirty } from '../src/perp/state.ts';
import type { PerpCtx, PerpEvent, PerpFill, PerpOrder, PerpOrderRequest, Position } from '../src/perp/types.ts';
import type { AggTrade } from '../src/types.ts';
import { btcBrackets, FakePerpMarket, perpCtx } from './perpFixtures.ts';

const NOW = 1_000_000;
const POST_ONLY = 'Post-only order would immediately match; rejected';
const TIERS_NOT_LOADED = 'Leverage tiers not loaded yet; try again in a moment';

function setup(usdt = '1000') {
  const market = new FakePerpMarket();
  const ctx = perpCtx(market, { now: NOW });
  const ledger = emptyLedger(['USDT', 'BTC']);
  ledger.balances.leverage.USDT = { free: D(usdt), locked: D(0) };
  const engine = new PerpEngine(emptyPerpState(ledger));
  const lev = () => engine.state.ledger.balances.leverage.USDT!;
  const position = () => engine.state.positions.BTCUSDT;
  const stored = (id: string) => engine.state.orders.get(id)!;
  return { market, ctx, engine, lev, position, stored };
}

const limit = (side: 'buy' | 'sell', price: string, qty: string, more: Partial<PerpOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'limit', price, qty, ...more }) as PerpOrderRequest;
const postOnly = (side: 'buy' | 'sell', price: string, qty: string) =>
  ({ symbol: 'BTCUSDT', side, type: 'post_only', price, qty }) as PerpOrderRequest;
const marketOrder = (side: 'buy' | 'sell', qty: string, more: Partial<PerpOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'market', qty, ...more }) as PerpOrderRequest;

let tradeId = 0;
function trade(price: string, qty: string, sellerInitiated: boolean, id?: number): AggTrade {
  tradeId = id ?? tradeId + 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

function placed(events: PerpEvent[]): PerpOrder {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'order_placed') throw new Error(`expected order_placed, got ${e.type}`);
  return e.order;
}

function rejectReason(events: PerpEvent[]): string {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'order_rejected') throw new Error(`expected order_rejected, got ${e.type}`);
  expect(e.order.status).toBe('rejected');
  return e.reason;
}

function only<T extends PerpEvent['type']>(events: PerpEvent[], type: T): Extract<PerpEvent, { type: T }> {
  expect(events.map((e) => e.type)).toEqual([type]);
  return events[0] as Extract<PerpEvent, { type: T }>;
}

function find<T extends PerpEvent['type']>(events: PerpEvent[], type: T): Extract<PerpEvent, { type: T }> {
  const e = events.find((x) => x.type === type);
  if (!e) throw new Error(`no ${type} event in ${events.map((x) => x.type).join(', ')}`);
  return e as Extract<PerpEvent, { type: T }>;
}

function fillOf(events: PerpEvent[]): { fill: PerpFill; order: PerpOrder; consumed: unknown } {
  const e = find(events, 'fill');
  return { fill: e.fill, order: e.order, consumed: e.consumed };
}

/** Arrive at the order's arrival time (arrive is a no-op before it). */
function arriveNow(engine: PerpEngine, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

/** Submit and arrive; the order must rest. Returns its id. */
function rest(engine: PerpEngine, r: PerpOrderRequest, ctx: PerpCtx): string {
  const order = placed(engine.submit(r, ctx));
  expect(arriveNow(engine, order, ctx)).toEqual([]);
  expect(engine.state.orders.get(order.id)!.status).toBe('open');
  return order.id;
}

/** Market long 0.1 at 80000, 20x: position margin 396, free 600 (of 1000). */
function openLong(engine: PerpEngine, ctx: PerpCtx): void {
  const order = placed(engine.submit(marketOrder('buy', '0.1'), ctx));
  arriveNow(engine, order, ctx);
}

/** Request a cancel and deliver it at its arrival time; returns what its arrival did. */
function cancelNow(engine: PerpEngine, id: string, ctx: PerpCtx): PerpEvent[] {
  const r = engine.cancel(id, ctx);
  if (!r.ok) throw new Error(r.reason);
  expect(r.events).toEqual([]);
  ctx.now = Math.max(ctx.now, engine.state.orders.get(id)!.cancelArrivesAt!);
  return engine.arriveCancel(id, ctx);
}

describe('limit long 0.1 @79900 (mark 80000, last 80000)', () => {
  it('locks IM 399.5 + taker fee 3.995 = 403.495 and rests open at arrival', () => {
    const { ctx, engine, lev, stored } = setup();
    const order = placed(engine.submit(limit('buy', '79900', '0.1'), ctx));
    expect(order.type).toBe('limit');
    expect(order.status).toBe('pending');
    expect(s(order.price)).toBe('79900');
    expect(s(order.qty)).toBe('0.1');
    expect(order.leverage).toBe(20);
    expect(s(order.lockAmount)).toBe('403.495');
    expect(order.arrivesAt).toBe(NOW + 100);
    expect(s(lev().free)).toBe('596.505');
    expect(s(lev().locked)).toBe('403.495');

    expect(arriveNow(engine, order, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('open');
    expect(s(stored(order.id).lockAmount)).toBe('403.495');
  });

  it('a seller-initiated trade through it fills 0.05 as maker: fee from margin, lock share rest released', () => {
    const { ctx, engine, lev, position, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const events = engine.onTrade('BTCUSDT', trade('79800', '0.05', true), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_opened']);
    expect(events.every((e) => e.market === 'perp')).toBe(true);

    const { fill, order, consumed } = fillOf(events);
    expect(consumed).toBeUndefined();
    expect(fill.market).toBe('perp');
    expect(fill.orderId).toBe(id);
    expect(fill.side).toBe('buy');
    expect(s(fill.qty)).toBe('0.05');
    expect(s(fill.price)).toBe('79900');
    expect(s(fill.quote)).toBe('3995');
    expect(fill.liquidity).toBe('maker');
    expect(fill.feeAsset).toBe('USDT');
    expect(s(fill.fee)).toBe('0.799');
    expect(s(fill.marginIn)).toBe('199.75');
    expect(fill.realizedPnl).toBeNull();
    expect(fill.uncovered).toBeNull();
    expect(s(fill.slippageUsd)).toBe('0');
    expect(s(fill.driftUsd)).toBe('0');
    expect(s(fill.bestAtArrival)).toBe('80000');

    expect(order.status).toBe('partially_filled');
    expect(s(order.filledQty)).toBe('0.05');
    expect(s(order.filledQuote)).toBe('3995');
    expect(s(order.fee)).toBe('0.799');
    expect(s(order.lockAmount)).toBe('201.7475');
    expect(stored(id)).toEqual(order);

    const p = position()!;
    expect(p.side).toBe('long');
    expect(s(p.qty)).toBe('0.05');
    expect(s(p.entryPrice)).toBe('79900');
    expect(s(p.margin)).toBe('198.951');
    expect(s(p.fees)).toBe('0.799');
    // Released 201.7475 − 199.75 = 1.9975.
    expect(s(lev().free)).toBe('598.5025');
    expect(s(lev().locked)).toBe('201.7475');
  });

  it('the rest fills on a later trade-through; the whole lock is used up or released', () => {
    const { ctx, engine, lev, position } = setup();
    rest(engine, limit('buy', '79900', '0.1'), ctx);
    engine.onTrade('BTCUSDT', trade('79800', '0.05', true), ctx);
    const events = engine.onTrade('BTCUSDT', trade('79899.9', '1', true), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const { fill, order } = fillOf(events);
    expect(s(fill.qty)).toBe('0.05');
    expect(order.status).toBe('filled');
    expect(s(order.lockAmount)).toBe('0');
    expect(s(position()!.qty)).toBe('0.1');
    expect(s(position()!.margin)).toBe('397.902');
    expect(s(lev().free)).toBe('600.5');
    expect(s(lev().locked)).toBe('0');
  });

  it('a touch at exactly 79900 and a buyer-initiated trade below never fill', () => {
    const { ctx, engine, lev, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    expect(engine.onTrade('BTCUSDT', trade('79900', '5', true), ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('79800', '5', false), ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
    expect(s(stored(id).filledQty)).toBe('0');
    expect(s(lev().locked)).toBe('403.495');
  });
});

describe('trade-through matching', () => {
  it('trades before arrival do not count', () => {
    const { ctx, engine, stored } = setup();
    const order = placed(engine.submit(limit('buy', '79900', '0.1'), ctx));
    expect(engine.onTrade('BTCUSDT', trade('79000', '5', true), ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('pending');
  });

  it('a trade id at or below the last processed is a replay and is ignored', () => {
    const { ctx, engine } = setup();
    rest(engine, limit('buy', '79900', '0.1'), ctx);
    expect(engine.onTrade('BTCUSDT', trade('79800', '0.05', true, 500), ctx)).toHaveLength(2);
    expect(engine.state.lastTradeId.BTCUSDT).toBe(500);
    expect(engine.onTrade('BTCUSDT', trade('79800', '0.05', true, 500), ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('79800', '0.05', true, 499), ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('79800', '0.05', true, 501), ctx)).toHaveLength(1);
  });

  it('while the book, trades or mark are stale a trade is skipped without moving the cursor; its replay fills', () => {
    for (const what of ['data', 'mark'] as const) {
      const { market, ctx, engine, stored } = setup();
      const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
      engine.onTrade('BTCUSDT', trade('80000', '1', true, 10), ctx);
      if (what === 'data') market.setFresh('BTCUSDT', false);
      else market.setMarkFresh('BTCUSDT', false);
      expect(engine.onTrade('BTCUSDT', trade('79800', '0.1', true, 11), ctx)).toEqual([]);
      expect(engine.state.lastTradeId.BTCUSDT).toBe(10);
      expect(s(stored(id).filledQty)).toBe('0');

      market.setFresh('BTCUSDT', true);
      market.setMarkFresh('BTCUSDT', true);
      expect(fillOf(engine.onTrade('BTCUSDT', trade('79800', '0.1', true, 11), ctx)).order.status).toBe('filled');
      expect(engine.state.lastTradeId.BTCUSDT).toBe(11);
    }
  });

  it('one trade’s volume is shared: the higher buy first, then the earlier at the same price', () => {
    const { ctx, engine } = setup('5000');
    const a = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const b = rest(engine, limit('buy', '79950', '0.1'), ctx);
    ctx.now += 1;
    const c = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const events = engine.onTrade('BTCUSDT', trade('79800', '0.15', true), ctx);
    const fills = events.flatMap((e) => (e.type === 'fill' ? [[e.fill.orderId, s(e.fill.qty)]] : []));
    expect(fills).toEqual([
      [b, '0.1'],
      [a, '0.05'],
    ]);
    expect(engine.state.orders.get(c)!.status).toBe('open');
  });

  it('orders on another symbol are not matched', () => {
    const { ctx, engine, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    expect(engine.onTrade('ETHUSDT', trade('79000', '5', true), ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
  });

  it('a maker fill marks the order changed', () => {
    const { ctx, engine } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    takeDirty(engine.state);
    engine.onTrade('BTCUSDT', trade('79800', '0.05', true), ctx);
    expect(takeDirty(engine.state)).toEqual([id]);
  });
});

describe('limit short 0.1 @80100', () => {
  it('locks at the assumed price max(80100, mark 80000, last × 1.0015 = 80120): 404.606', () => {
    const { ctx, engine, lev } = setup();
    const order = placed(engine.submit(limit('sell', '80100', '0.1'), ctx));
    expect(s(order.lockAmount)).toBe('404.606');
    expect(s(lev().free)).toBe('595.394');
  });

  it('fills on a buyer-initiated trade strictly above, never on a touch or a seller-initiated trade', () => {
    const { ctx, engine, lev, position } = setup();
    const id = rest(engine, limit('sell', '80100', '0.1'), ctx);
    expect(engine.onTrade('BTCUSDT', trade('80100', '1', false), ctx)).toEqual([]);
    expect(engine.onTrade('BTCUSDT', trade('80200', '1', true), ctx)).toEqual([]);
    const { fill, order } = fillOf(engine.onTrade('BTCUSDT', trade('80100.1', '0.1', false), ctx));
    expect(fill.orderId).toBe(id);
    expect(s(fill.price)).toBe('80100');
    expect(s(fill.quote)).toBe('8010');
    expect(s(fill.fee)).toBe('1.602');
    expect(s(fill.marginIn)).toBe('400.5');
    expect(order.status).toBe('filled');
    expect(position()!.side).toBe('short');
    expect(s(position()!.margin)).toBe('398.898');
    expect(s(lev().free)).toBe('599.5');
    expect(s(lev().locked)).toBe('0');
  });
});

describe('marketable limit', () => {
  it('long 0.3 @80005: takes 0.2 @80000 as taker at arrival, 0.1 rests at 80005 and fills as maker', () => {
    const { ctx, engine, lev, position } = setup('2000');
    const order = placed(engine.submit(limit('buy', '80005', '0.3'), ctx));
    // IM 1200.075 + open loss 0.3 × 5 = 1.5 + taker fee 12.00075.
    expect(s(order.lockAmount)).toBe('1213.57575');

    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_opened']);
    const taker = fillOf(events);
    expect(taker.fill.liquidity).toBe('taker');
    expect(s(taker.fill.qty)).toBe('0.2');
    expect(s(taker.fill.price)).toBe('80000');
    expect(s(taker.fill.fee)).toBe('8');
    expect(s(taker.fill.marginIn)).toBe('800');
    expect(s(taker.fill.bestAtArrival)).toBe('80000');
    expect(taker.consumed).toEqual([{ price: D('80000.0'), qty: D('0.2') }]);
    expect(taker.order.status).toBe('partially_filled');
    // The taker part's share: 1213.57575 × 0.2 ÷ 0.3 = 809.0505; 9.0505 of it released.
    expect(s(taker.order.lockAmount)).toBe('404.52525');
    expect(s(lev().free)).toBe('795.47475');
    expect(s(lev().locked)).toBe('404.52525');
    expect(s(position()!.margin)).toBe('792');

    const maker = fillOf(engine.onTrade('BTCUSDT', trade('80000', '1', true), ctx));
    expect(maker.fill.liquidity).toBe('maker');
    expect(s(maker.fill.qty)).toBe('0.1');
    expect(s(maker.fill.price)).toBe('80005');
    expect(s(maker.fill.fee)).toBe('1.6001');
    expect(s(maker.fill.marginIn)).toBe('400.025');
    expect(maker.order.status).toBe('filled');
    expect(s(maker.order.lockAmount)).toBe('0');
    expect(s(position()!.qty)).toBe('0.3');
    expect(s(position()!.margin)).toBe('1190.4249');
    expect(s(lev().free)).toBe('799.975');
    expect(s(lev().locked)).toBe('0');
  });

  it('fully marketable: fills at arrival and the unused lock is released', () => {
    const { ctx, engine, lev, position } = setup();
    const order = placed(engine.submit(limit('buy', '80005', '0.1'), ctx));
    const { fill, order: after } = fillOf(arriveNow(engine, order, ctx));
    expect(s(fill.qty)).toBe('0.1');
    expect(s(fill.price)).toBe('80000');
    expect(after.status).toBe('filled');
    expect(s(after.lockAmount)).toBe('0');
    expect(s(lev().locked)).toBe('0');
    expect(s(position()!.margin)).toBe('396');
    expect(s(lev().free)).toBe('600');
  });

  it('short 0.3 @79985: hits the 79990 bid for 0.2, 0.1 rests', () => {
    const { ctx, engine, lev } = setup('2000');
    const order = placed(engine.submit(limit('sell', '79985', '0.3'), ctx));
    // Assumed price 80120: IM 1201.8 + open loss 0.3 × 15 = 4.5 + taker fee 12.018.
    expect(s(order.lockAmount)).toBe('1218.318');
    const { fill, order: after } = fillOf(arriveNow(engine, order, ctx));
    expect(s(fill.qty)).toBe('0.2');
    expect(s(fill.price)).toBe('79990');
    expect(fill.liquidity).toBe('taker');
    expect(after.status).toBe('partially_filled');
    expect(s(after.lockAmount)).toBe('406.106');
    expect(s(lev().locked)).toBe('406.106');
  });
});

describe('post-only', () => {
  it('long @80000 with best ask 80000 is rejected at arrival and the lock released', () => {
    const { ctx, engine, lev } = setup();
    const order = placed(engine.submit(postOnly('buy', '80000', '0.1'), ctx));
    expect(order.type).toBe('post_only');
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe(POST_ONLY);
    expect(s(lev().free)).toBe('1000');
    expect(s(lev().locked)).toBe('0');
  });

  it('short at the best bid is rejected at arrival', () => {
    const { ctx, engine } = setup();
    const order = placed(engine.submit(postOnly('sell', '79990', '0.1'), ctx));
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe(POST_ONLY);
  });

  it('long @79995 rests and its trade-through fill is maker', () => {
    const { ctx, engine } = setup();
    rest(engine, postOnly('buy', '79995', '0.1'), ctx);
    const { fill } = fillOf(engine.onTrade('BTCUSDT', trade('79990', '1', true), ctx));
    expect(fill.liquidity).toBe('maker');
    expect(s(fill.price)).toBe('79995');
  });
});

describe('limit submit checks', () => {
  it('PERCENT_PRICE against the mark', () => {
    const { ctx, engine, lev } = setup();
    expect(rejectReason(engine.submit(limit('buy', '84001', '0.01'), ctx))).toBe(
      'PERCENT_PRICE: buy price 84001 is above the allowed maximum 84000 (1.05 × mark price 80000)',
    );
    expect(rejectReason(engine.submit(limit('sell', '75999', '0.01'), ctx))).toBe(
      'PERCENT_PRICE: sell price 75999 is below the allowed minimum 76000 (0.95 × mark price 80000)',
    );
    expect(s(lev().free)).toBe('1000');
  });

  it('a dollar amount is converted at the limit price, floored to the step', () => {
    const { ctx, engine } = setup();
    const order = placed(engine.submit(limit('buy', '79900', '', { qty: undefined, quoteQty: '8000' }), ctx));
    expect(s(order.qty)).toBe('0.1');
    expect(s(order.quoteQty)).toBe('8000');
    expect(rejectReason(engine.submit(limit('buy', '79900', '', { qty: undefined, quoteQty: '50' }), ctx))).toBe(
      'Amount too small: 50 USDT does not reach one step of 0.001 BTC',
    );
  });

  it('request problems are rejected with clear reasons', () => {
    const { ctx, engine } = setup();
    expect(rejectReason(engine.submit(limit('buy', '', '0.1'), ctx))).toBe('Enter a limit price');
    const reason = (price: string, qty: string) => rejectReason(engine.submit(limit('buy', price, qty), ctx));
    expect(reason('79900.05', '0.1')).toBe('PRICE_FILTER: price 79900.05 is not a multiple of tick size 0.1');
    expect(reason('79900', '0.0005')).toBe('LOT_SIZE: quantity 0.0005 is below the minimum 0.001');
    expect(reason('79900', '0.0015')).toBe('LOT_SIZE: quantity 0.0015 is not a multiple of step size 0.001');
    expect(reason('40000', '0.001')).toBe('MIN_NOTIONAL: order value 40 is below the minimum 50');
  });

  it('insufficient margin', () => {
    const { ctx, engine, lev } = setup('400');
    expect(rejectReason(engine.submit(limit('buy', '79900', '0.1'), ctx))).toBe(
      'Insufficient margin: need 403.495, available 400',
    );
    expect(s(lev().free)).toBe('400');
  });

  it('stale at submit → rejected; stale at arrival → rejected, lock released', () => {
    const { market, ctx, engine, lev } = setup();
    market.setMarkFresh('BTCUSDT', false);
    expect(rejectReason(engine.submit(limit('buy', '79900', '0.1'), ctx))).toBe('Live data interrupted for BTCUSDT');
    market.setMarkFresh('BTCUSDT', true);
    const order = placed(engine.submit(limit('buy', '79900', '0.1'), ctx));
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(s(lev().free)).toBe('1000');
    expect(s(lev().locked)).toBe('0');
  });

  it('one-way mode: an opening limit opposite a position or opposite opening orders is refused', () => {
    const { ctx, engine } = setup('3000');
    rest(engine, limit('buy', '79900', '0.1'), ctx);
    expect(rejectReason(engine.submit(limit('sell', '80100', '0.1'), ctx))).toBe(
      'One-way mode: you have open orders to go long on BTCUSDT',
    );
    expect(rejectReason(engine.submit(marketOrder('sell', '0.1'), ctx))).toBe(
      'One-way mode: you have open orders to go long on BTCUSDT',
    );
    engine.onTrade('BTCUSDT', trade('79800', '1', true), ctx);
    expect(rejectReason(engine.submit(limit('sell', '80100', '0.1'), ctx))).toBe(
      'One-way mode: you hold a long position on BTCUSDT; use reduce-only to reduce it',
    );
  });

  it('open limits count toward the maximum notional at the leverage', () => {
    const { ctx, engine } = setup('100000');
    engine.state.settings.BTCUSDT = { leverage: 100, marginMode: 'isolated' };
    // At 100x the cap is 800 000 USDT at the mark: 10 BTC.
    rest(engine, limit('buy', '79000', '9.99'), ctx);
    expect(rejectReason(engine.submit(limit('buy', '79000', '0.02'), ctx))).toBe(
      'Position would exceed 800000 USDT, the maximum at 100x on BTCUSDT; lower the leverage',
    );
  });

  it('leverage tiers not loaded yet: submit and preview refuse instead of throwing', () => {
    const { market, ctx, engine, lev } = setup();
    market.clearBrackets('BTCUSDT');
    for (const r of [limit('buy', '79900', '0.1'), marketOrder('buy', '0.1'), postOnly('buy', '79900', '0.1')]) {
      expect(rejectReason(engine.submit(r, ctx))).toBe(TIERS_NOT_LOADED);
      const p = engine.preview(r, ctx);
      expect(p.rejectReason).toBe(TIERS_NOT_LOADED);
      expect(p.maxLeverage).toBe(0);
      expect(p.leverage).toBe(20);
    }
    expect(s(lev().free)).toBe('1000');
  });
});

describe('reduce-only limits', () => {
  it('open reduce-only limit quantity plus the new one may not exceed the position', () => {
    const { ctx, engine, lev } = setup();
    openLong(engine, ctx);
    const first = placed(engine.submit(limit('sell', '81000', '0.06', { reduceOnly: true }), ctx));
    expect(first.reduceOnly).toBe(true);
    expect(s(first.lockAmount)).toBe('0');
    expect(rejectReason(engine.submit(limit('sell', '82000', '0.05', { reduceOnly: true }), ctx))).toBe(
      'Reduce-only orders would exceed your position (open 0.06 + new 0.05 > 0.1 BTC)',
    );
    placed(engine.submit(limit('sell', '82000', '0.04', { reduceOnly: true }), ctx));
    expect(s(lev().free)).toBe('600');
  });

  it('without a position to reduce', () => {
    const { ctx, engine } = setup();
    expect(rejectReason(engine.submit(limit('sell', '81000', '0.01', { reduceOnly: true }), ctx))).toBe(
      'Reduce-only order would not reduce a position on BTCUSDT',
    );
  });

  it('a maker fill realises P&L, pays the maker fee and releases margin pro rata', () => {
    const { ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    const id = rest(engine, limit('sell', '81000', '0.06', { reduceOnly: true }), ctx);
    const { fill, order } = fillOf(engine.onTrade('BTCUSDT', trade('81000.1', '1', false), ctx));
    expect(fill.orderId).toBe(id);
    expect(fill.liquidity).toBe('maker');
    expect(s(fill.qty)).toBe('0.06');
    expect(s(fill.price)).toBe('81000');
    expect(s(fill.fee)).toBe('0.972');
    expect(s(fill.realizedPnl)).toBe('60');
    expect(fill.marginIn).toBeNull();
    expect(order.status).toBe('filled');
    expect(s(position()!.qty)).toBe('0.04');
    expect(s(position()!.margin)).toBe('158.4');
    // Released 237.6 + P&L 60 − fee 0.972.
    expect(s(lev().free)).toBe('896.628');
  });

  it('a fill takes min(allocation, position qty); the close cancels what is left of reduce-only orders', () => {
    const { ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    const a = rest(engine, limit('sell', '81000', '0.06', { reduceOnly: true }), ctx);
    const b = rest(engine, limit('sell', '82000', '0.04', { reduceOnly: true }), ctx);
    const cut = placed(engine.submit(marketOrder('sell', '0.05', { reduceOnly: true }), ctx));
    arriveNow(engine, cut, ctx);
    expect(s(position()!.qty)).toBe('0.05');

    const events = engine.onTrade('BTCUSDT', trade('82000.1', '1', false), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_closed', 'order_cancelled', 'order_cancelled']);
    const { fill } = fillOf(events);
    expect(fill.orderId).toBe(a);
    expect(s(fill.qty)).toBe('0.05');
    const closed = find(events, 'position_closed');
    expect(s(closed.position.margin)).toBe('0');
    const cancels = events.flatMap((e) =>
      e.type === 'order_cancelled' ? [[e.order.id, e.reason, s(e.cancelledQty)]] : [],
    );
    expect(cancels).toEqual([
      [a, 'position_closed', '0.01'],
      [b, 'position_closed', '0.04'],
    ]);
    expect(position()).toBeUndefined();
    expect(s(lev().locked)).toBe('0');
  });

  it('a marketable reduce-only limit takes the book as a taker and closes the position', () => {
    const { ctx, engine, position } = setup();
    openLong(engine, ctx);
    const order = placed(engine.submit(limit('sell', '79980', '0.1', { reduceOnly: true }), ctx));
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_closed']);
    const { fill, order: after } = fillOf(events);
    expect(fill.liquidity).toBe('taker');
    expect(s(fill.price)).toBe('79990');
    expect(s(fill.qty)).toBe('0.1');
    expect(after.status).toBe('filled');
    expect(position()).toBeUndefined();
  });
});

describe('limit preview', () => {
  it('resting long: the limit price, maker fee, the lock and the liquidation price', () => {
    const { ctx, engine, lev } = setup();
    const p = engine.preview(limit('buy', '79900', '0.1'), ctx);
    expect(p.rejectReason).toBeNull();
    expect(s(p.estAvgPrice)).toBe('79900');
    expect(s(p.estSlippageUsd)).toBe('0');
    expect(s(p.estSlippagePct)).toBe('0');
    expect(s(p.notional)).toBe('7990');
    expect(s(p.fee)).toBe('1.598');
    expect(s(p.marginRequired)).toBe('403.495');
    expect(s(p.estLiquidationPrice)).toBe(s(liquidationPrice(btcBrackets, 'long', D('0.1'), D('79900'), D('397.902'))));
    expect(p.leverage).toBe(20);
    expect(p.maxLeverage).toBe(150);
    expect(p.exhausted).toBe(false);
    expect(p.bandLimited).toBe(false);
    expect(engine.state.orders.size).toBe(0);
    expect(s(lev().free)).toBe('1000');
  });

  it('marketable long: the taker part walked up to the limit, maker fee on the rest', () => {
    const { ctx, engine } = setup('2000');
    const p = engine.preview(limit('buy', '80005', '0.3'), ctx);
    expect(p.rejectReason).toBeNull();
    expect(s(p.notional)).toBe('24000.5');
    expect(s(p.fee)).toBe('9.6001');
    expect(p.estAvgPrice?.toFixed(8)).toBe('80001.66666667');
    expect(s(p.marginRequired)).toBe('1213.57575');
  });

  it('a marketable post-only previews its rejection', () => {
    const { ctx, engine } = setup();
    expect(engine.preview(postOnly('buy', '80000', '0.1'), ctx).rejectReason).toBe(POST_ONLY);
  });

  it('reports the submit rejection', () => {
    const { ctx, engine } = setup('400');
    expect(engine.preview(limit('buy', '79900', '0.1'), ctx).rejectReason).toBe(
      'Insufficient margin: need 403.495, available 400',
    );
  });
});

describe('cancel', () => {
  it('open limit: order_cancelled reason user when the cancel arrives, lock released', () => {
    const { ctx, engine, lev, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const e = only(cancelNow(engine, id, ctx), 'order_cancelled');
    expect(e.market).toBe('perp');
    expect(e.reason).toBe('user');
    expect(s(e.cancelledQty)).toBe('0.1');
    expect(e.order.status).toBe('cancelled');
    expect(e.order.cancelArrivesAt).toBeNull();
    expect(s(e.order.lockAmount)).toBe('0');
    expect(stored(id)).toEqual(e.order);
    expect(s(lev().free)).toBe('1000');
    expect(s(lev().locked)).toBe('0');
    expect(engine.onTrade('BTCUSDT', trade('79000', '5', true), ctx)).toEqual([]);
  });

  it('requesting a cancel only sets its arrival time: the order stays open with its lock', () => {
    const { ctx, engine, lev, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const t = ctx.now;
    expect(engine.cancel(id, ctx)).toEqual({ ok: true, events: [] });
    expect(stored(id).status).toBe('open');
    expect(stored(id).cancelArrivesAt).toBe(t + 100);
    expect(s(lev().locked)).toBe('403.495');
  });

  it('a trade-through 1 ms after the cancel request still fills; the late cancel is recorded, nothing else', () => {
    const { ctx, engine, lev, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const t = ctx.now;
    engine.cancel(id, ctx);
    ctx.now = t + 1;
    const { fill, order } = fillOf(engine.onTrade('BTCUSDT', trade('79800', '1', true), ctx));
    expect(s(fill.qty)).toBe('0.1');
    expect(order.status).toBe('filled');
    const balances = JSON.stringify(engine.state.ledger.balances);
    const positions = JSON.stringify(engine.state.positions);

    ctx.now = t + 100;
    const e = only(engine.arriveCancel(id, ctx), 'cancel_rejected');
    expect(e.market).toBe('perp');
    expect(e.reason).toBe('Cancel arrived too late: order already filled');
    expect(e.order.status).toBe('filled');
    expect(e.order.cancelArrivesAt).toBeNull();
    expect(stored(id)).toEqual(e.order);
    expect(JSON.stringify(engine.state.ledger.balances)).toBe(balances);
    expect(JSON.stringify(engine.state.positions)).toBe(positions);
    expect(s(lev().locked)).toBe('0');
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
  });

  it('nothing happens before the cancel arrival time', () => {
    const { ctx, engine, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    const t = ctx.now;
    engine.cancel(id, ctx);
    ctx.now = t + 99;
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
    ctx.now = t + 100;
    expect(only(engine.arriveCancel(id, ctx), 'order_cancelled').time).toBe(t + 100);
  });

  it('a partial fill during the delay: the cancel cancels the rest and releases the rest of the lock', () => {
    const { ctx, engine, lev } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    engine.cancel(id, ctx);
    ctx.now += 1;
    engine.onTrade('BTCUSDT', trade('79800', '0.05', true), ctx);
    ctx.now += 99;
    const e = only(engine.arriveCancel(id, ctx), 'order_cancelled');
    expect(s(e.cancelledQty)).toBe('0.05');
    expect(s(e.order.filledQty)).toBe('0.05');
    expect(s(lev().locked)).toBe('0');
    expect(s(lev().free)).toBe('800.25');
  });

  it('refusals: unknown, finished, market in flight, a second cancel in flight', () => {
    const { ctx, engine, stored } = setup();
    expect(engine.cancel('nope', ctx)).toEqual({ ok: false, reason: 'Order not found' });
    const m = placed(engine.submit(marketOrder('buy', '0.01'), ctx));
    expect(engine.cancel(m.id, ctx)).toEqual({
      ok: false,
      reason: 'Order is already executing and cannot be cancelled',
    });
    const id = rest(engine, limit('buy', '79900', '0.01'), ctx);
    const t = ctx.now;
    expect(engine.cancel(id, ctx).ok).toBe(true);
    ctx.now = t + 50;
    expect(engine.cancel(id, ctx)).toEqual({ ok: false, reason: 'Cancel already requested' });
    expect(stored(id).cancelArrivesAt).toBe(t + 100);
    ctx.now = t + 100;
    engine.arriveCancel(id, ctx);
    expect(engine.cancel(id, ctx)).toEqual({ ok: false, reason: 'Order is not open' });
  });

  it('a pending order whose cancel arrives first is cancelled before it arrives', () => {
    const { ctx, engine, lev, stored } = setup();
    const t = ctx.now;
    const rng = [0.9999, 0]; // 300 ms for the order, then 100 ms for the cancel
    ctx.rng = () => rng.shift() ?? 0;
    const order = placed(engine.submit(limit('buy', '80005', '0.1'), ctx));
    expect(order.arrivesAt).toBe(t + 300);
    ctx.now = t + 10;
    engine.cancel(order.id, ctx);
    ctx.now = t + 110;
    expect(only(engine.arriveCancel(order.id, ctx), 'order_cancelled').reason).toBe('user');
    ctx.now = t + 300;
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(stored(order.id).status).toBe('cancelled');
    expect(s(lev().free)).toBe('1000');
  });

  it('a pending order whose own arrival comes first arrives first, whichever timer runs first', () => {
    const { ctx, engine, stored } = setup();
    const t = ctx.now;
    const rng = [0.5, 0]; // 200 ms for the order, then 100 ms for the cancel
    ctx.rng = () => rng.shift() ?? 0;
    const order = placed(engine.submit(limit('buy', '80005', '0.1'), ctx));
    ctx.now = t + 100;
    engine.cancel(order.id, ctx);
    expect(stored(order.id).cancelArrivesAt).toBe(t + 200);
    ctx.now = t + 200;
    const events = engine.arriveCancel(order.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_opened', 'cancel_rejected']);
    expect(find(events, 'fill').fill.liquidity).toBe('taker');
    expect(find(events, 'cancel_rejected').reason).toBe('Cancel arrived too late: order already filled');
    expect(engine.arrive(order.id, ctx)).toEqual([]);
  });

  it('a trade at or after the cancel arrival time never fills the order: it delivers the cancel first', () => {
    const { ctx, engine, lev, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    engine.cancel(id, ctx);
    ctx.now = stored(id).cancelArrivesAt!;
    const e = only(engine.onTrade('BTCUSDT', trade('79000', '5', true), ctx), 'order_cancelled');
    expect(e.reason).toBe('user');
    expect(s(stored(id).filledQty)).toBe('0');
    expect(s(lev().free)).toBe('1000');
    expect(engine.arriveCancel(id, ctx)).toEqual([]);
  });

  it('a trade past both due times leaves a pending order whose own arrival comes first to its arrival', () => {
    const { ctx, engine, stored } = setup();
    const t = ctx.now;
    const order = placed(engine.submit(limit('buy', '80005', '0.1'), ctx));
    ctx.now = t + 50;
    engine.cancel(order.id, ctx); // arrives t+100, cancel t+150
    ctx.now = t + 160;
    expect(engine.onTrade('BTCUSDT', trade('80000', '0.1', false), ctx)).toEqual([]);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    expect(stored(order.id).status).toBe('pending');
    expect(fillOf(engine.arrive(order.id, ctx)).order.status).toBe('filled');
    expect(only(engine.arriveCancel(order.id, ctx), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already filled',
    );
  });

  it('arriveCancelBeforeResend cancels a pending order whose old arrival came first', () => {
    const { ctx, engine, lev, stored } = setup();
    const order = placed(engine.submit(limit('buy', '80005', '0.1'), ctx));
    engine.cancel(order.id, ctx);
    ctx.now = order.arrivesAt! + 60_000;
    expect(only(engine.arriveCancelBeforeResend(order.id, ctx), 'order_cancelled').reason).toBe('user');
    expect(stored(order.id).status).toBe('cancelled');
    expect(s(lev().locked)).toBe('0');
    expect(engine.arriveCancelBeforeResend(order.id, ctx)).toEqual([]);
  });

  it('a reduce-only limit swept by its position closing: the cancel arriving later says so', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    const id = rest(engine, limit('sell', '82000', '0.05', { reduceOnly: true }), ctx);
    const t = ctx.now;
    engine.cancel(id, ctx);
    ctx.now = t + 1;
    const close = placed(engine.submit(marketOrder('sell', '0.1', { reduceOnly: true }), ctx));
    const events = engine.arrive(close.id, { ...ctx, now: close.arrivesAt! });
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_closed', 'order_cancelled']);
    // Kept until its cancel is answered.
    evictTerminal(engine.state);
    expect(engine.state.orders.has(id)).toBe(true);
    ctx.now = t + 100;
    expect(only(engine.arriveCancel(id, ctx), 'cancel_rejected').reason).toBe(
      'Cancel arrived too late: order already cancelled',
    );
    evictTerminal(engine.state);
    expect(engine.state.orders.has(id)).toBe(false);
  });
});

describe('hasDeferredWork and onFresh', () => {
  it('a cancel past its arrival time is deferred work until delivered; onFresh delivers it', () => {
    const { market, ctx, engine, stored } = setup();
    const id = rest(engine, limit('buy', '79900', '0.1'), ctx);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    engine.cancel(id, ctx);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    ctx.now = stored(id).cancelArrivesAt!;
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(true);
    expect(engine.hasDeferredWork('ETHUSDT', ctx)).toBe(false);

    market.setFresh('BTCUSDT', false);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(stored(id).status).toBe('open');
    market.setFresh('BTCUSDT', true);
    expect(only(engine.onFresh('BTCUSDT', ctx), 'order_cancelled').reason).toBe('user');
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });

  it('a resting limit alone is not deferred work', () => {
    const { ctx, engine } = setup();
    rest(engine, limit('buy', '79900', '0.1'), ctx);
    ctx.now += 60_000;
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });
});

describe('position invariants', () => {
  it('an opening fill against a position on the other side throws: a flip is impossible', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    const sell: PerpOrder = { ...placed(engine.submit(limit('sell', '82000', '0.01', { reduceOnly: true }), ctx)) };
    const terms = {
      qty: D('0.01'),
      price: D('82000'),
      quote: D('820'),
      liquidity: 'maker' as const,
      rate: D('0.0002'),
      bestAtArrival: null,
      slippageUsd: D(0),
      driftUsd: D(0),
    };
    expect(() => applyOpeningFill(engine.state, sell, terms, D(0), 'filled', ctx)).toThrow(
      'Order o2: opening fill on the other side of the long position',
    );
  });

  it('a full close releases exactly the margin, whatever the precision', () => {
    const margin = D('95752814599536.578125');
    const qty = D('865.046185287344314929');
    const p: Position = {
      id: 'p1',
      symbol: 'BTCUSDT',
      side: 'long',
      qty,
      entryPrice: D('80000'),
      leverage: 20,
      margin,
      openedAt: 0,
      realizedPnl: D(0),
      fees: D(0),
      funding: D(0),
      warnLevel: 0,
    };
    const out = reduceOutcome(p, qty, qty.mul(80000), D(0));
    expect(s(out.released)).toBe('95752814599536.578125');
    expect(s(out.marginLeft)).toBe('0');
  });
});
