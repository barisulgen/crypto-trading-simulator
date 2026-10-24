import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import type { PerpCtx, PerpEvent, PerpOrder, PerpOrderRequest } from '../src/perp/types.ts';
import type { AggTrade, BookSnapshot } from '../src/types.ts';
import { btcPerpRules, FakePerpMarket, perpCtx } from './perpFixtures.ts';

const NOW = 1_000_000;

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

const marketOrder = (side: 'buy' | 'sell', qty: string, more: Partial<PerpOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'market', qty, ...more }) as PerpOrderRequest;
const limit = (side: 'buy' | 'sell', price: string, qty: string, more: Partial<PerpOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'limit', price, qty, ...more }) as PerpOrderRequest;

let tradeId = 0;
function trade(price: string, sellerInitiated: boolean, qty = '1'): AggTrade {
  tradeId += 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

function bids(...levels: [string, string][]): BookSnapshot {
  return {
    asks: [{ price: D('80000'), qty: D('1') }],
    bids: levels.map(([price, qty]) => ({ price: D(price), qty: D(qty) })),
  };
}

function placedOrders(events: PerpEvent[]): PerpOrder[] {
  return events.map((e) => {
    if (e.type !== 'order_placed') throw new Error(`expected order_placed, got ${e.type}`);
    return e.order;
  });
}

function rejections(events: PerpEvent[]): string[] {
  return events.map((e) => {
    if (e.type !== 'order_rejected') throw new Error(`expected order_rejected, got ${e.type}`);
    expect(e.order.status).toBe('rejected');
    return e.reason;
  });
}

function rejectReason(events: PerpEvent[]): string {
  const reasons = rejections(events);
  expect(new Set(reasons).size).toBe(1);
  return reasons[0]!;
}

function find<T extends PerpEvent['type']>(events: PerpEvent[], type: T): Extract<PerpEvent, { type: T }> {
  const e = events.find((x) => x.type === type);
  if (!e) throw new Error(`no ${type} event in ${events.map((x) => x.type).join(', ')}`);
  return e as Extract<PerpEvent, { type: T }>;
}

function all<T extends PerpEvent['type']>(events: PerpEvent[], type: T): Extract<PerpEvent, { type: T }>[] {
  return events.filter((x) => x.type === type) as Extract<PerpEvent, { type: T }>[];
}

/** Arrive at the order's arrival time (arrive is a no-op before it). */
function arriveNow(engine: PerpEngine, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

/** Submit and arrive; returns the arrival's events. */
function execute(engine: PerpEngine, r: PerpOrderRequest, ctx: PerpCtx): PerpEvent[] {
  const [o] = placedOrders(engine.submit(r, ctx));
  return arriveNow(engine, o!, ctx);
}

/** Market long 0.1 at 80000, 20x: position margin 396, free 600 (of 1000). */
function openLong(engine: PerpEngine, ctx: PerpCtx): void {
  execute(engine, marketOrder('buy', '0.1'), ctx);
}

/** Set the position's legs and arm them; returns the armed legs. */
function armTpSl(engine: PerpEngine, input: { stopLoss?: string; takeProfit?: string }, ctx: PerpCtx): PerpOrder[] {
  const legs = placedOrders(engine.setPositionTpSl('BTCUSDT', input, ctx));
  ctx.now = Math.max(ctx.now, legs[0]!.arrivesAt!);
  for (const l of legs) engine.arrive(l.id, ctx);
  return legs.map((l) => engine.state.orders.get(l.id)!);
}

describe('setPositionTpSl (long 0.1 @80000, margin 396, free 600)', () => {
  it('places a close-position stop-loss and take-profit that share a group; both arm after the delay', () => {
    const { ctx, engine, lev, stored } = setup();
    openLong(engine, ctx);
    const events = engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000', takeProfit: '82000' }, ctx);
    const [sl, tp] = placedOrders(events);
    for (const leg of [sl!, tp!]) {
      expect(leg.closePosition).toBe(true);
      expect(leg.reduceOnly).toBe(true);
      expect(leg.side).toBe('sell');
      expect(leg.qty).toBeNull();
      expect(leg.status).toBe('pending');
      expect(leg.arrivesAt).toBe(ctx.now + 100);
      expect(leg.leverage).toBe(20);
      expect(s(leg.lockAmount)).toBe('0');
    }
    expect(sl!.type).toBe('stop_loss');
    expect(s(sl!.triggerPrice)).toBe('78000');
    expect(tp!.type).toBe('take_profit');
    expect(s(tp!.triggerPrice)).toBe('82000');
    expect(sl!.ocoGroupId).not.toBeNull();
    expect(tp!.ocoGroupId).toBe(sl!.ocoGroupId);
    expect(s(lev().free)).toBe('600');

    ctx.now = sl!.arrivesAt!;
    expect(engine.arrive(sl!.id, ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('open');
    expect(stored(tp!.id).status).toBe('open');
    expect(engine.arrive(tp!.id, ctx)).toEqual([]);
  });

  it('a single leg has no group', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    const [sl] = placedOrders(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000' }, ctx));
    expect(sl!.ocoGroupId).toBeNull();
  });

  it('a short gets buy legs', () => {
    const { ctx, engine } = setup();
    execute(engine, marketOrder('sell', '0.1'), ctx);
    const [sl, tp] = placedOrders(engine.setPositionTpSl('BTCUSDT', { stopLoss: '82000', takeProfit: '78000' }, ctx));
    expect(sl!.side).toBe('buy');
    expect(tp!.side).toBe('buy');
  });

  it('rejects a trigger price off the tick', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000.05' }, ctx))).toBe(
      'PRICE_FILTER: trigger price 78000.05 is not a multiple of tick size 0.1',
    );
    // Both legs go together.
    expect(
      rejections(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000', takeProfit: '82000.05' }, ctx)),
    ).toEqual([
      'PRICE_FILTER: trigger price 82000.05 is not a multiple of tick size 0.1',
      'PRICE_FILTER: trigger price 82000.05 is not a multiple of tick size 0.1',
    ]);
  });

  it('rejects a leg that would trigger now against the last price', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { stopLoss: '80100' }, ctx))).toBe(
      'Stop would trigger immediately (last 80000, trigger 80100)',
    );
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { takeProfit: '79000' }, ctx))).toBe(
      'Take-profit would trigger immediately (last 80000, trigger 79000)',
    );
  });

  it('one stop-loss and one take-profit per position; a cancelled one can be replaced', () => {
    const { ctx, engine, stored } = setup();
    openLong(engine, ctx);
    const [sl] = armTpSl(engine, { stopLoss: '78000', takeProfit: '82000' }, ctx);
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { stopLoss: '77000' }, ctx))).toBe(
      'This position already has a stop-loss; cancel it first',
    );
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { takeProfit: '83000' }, ctx))).toBe(
      'This position already has a take-profit; cancel it first',
    );

    expect(engine.cancel(sl!.id, ctx)).toEqual({ ok: true, events: [] });
    ctx.now = stored(sl!.id).cancelArrivesAt!;
    const cancelled = engine.arriveCancel(sl!.id, ctx);
    expect(cancelled.map((e) => e.type)).toEqual(['order_cancelled']);
    expect(find(cancelled, 'order_cancelled').reason).toBe('user');
    // The take-profit stays: cancelling one leg leaves the other in place.
    const tp = [...engine.state.orders.values()].find((o) => o.type === 'take_profit' && o.status === 'open');
    expect(tp).toBeDefined();
    expect(placedOrders(engine.setPositionTpSl('BTCUSDT', { stopLoss: '77000' }, ctx))).toHaveLength(1);
  });

  it('rejects without a position, while stale, and with no price given', () => {
    const { market, ctx, engine } = setup();
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000' }, ctx))).toBe(
      'No open position on BTCUSDT',
    );
    openLong(engine, ctx);
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000' }, ctx))).toBe(
      'Live data interrupted for BTCUSDT',
    );
    market.setFresh('BTCUSDT', true);
    market.setMarkFresh('BTCUSDT', false);
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000' }, ctx))).toBe(
      'Live data interrupted for BTCUSDT',
    );
    market.setMarkFresh('BTCUSDT', true);
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', {}, ctx))).toBe('Enter a stop-loss or a take-profit price');
  });

  it('a stop armed after its position closed is not placed: the close cancels it', () => {
    const { ctx, engine, stored } = setup();
    openLong(engine, ctx);
    const [sl, tp] = placedOrders(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000', takeProfit: '82000' }, ctx));
    const closed = execute(engine, marketOrder('sell', '0.1', { reduceOnly: true }), ctx);
    expect(find(closed, 'position_closed').reason).toBe('closed');
    const swept = all(closed, 'order_cancelled');
    expect(swept.map((e) => [e.order.id, e.reason])).toEqual([
      [sl!.id, 'position_closed'],
      [tp!.id, 'position_closed'],
    ]);
    expect(engine.arrive(sl!.id, ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('cancelled');
  });

  it('a stop that arrives on stale data is rejected (it has not triggered)', () => {
    const { market, ctx, engine } = setup();
    openLong(engine, ctx);
    const [sl] = placedOrders(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000' }, ctx));
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(arriveNow(engine, sl!, ctx))).toBe('Live data interrupted for BTCUSDT');
  });
});

describe('trigger and execution (long 0.1 @80000, margin 396, free 600)', () => {
  it('a sell at 78000 triggers the stop-loss, cancels the take-profit, and closes the whole position', () => {
    const { market, ctx, engine, lev, position, stored } = setup();
    openLong(engine, ctx);
    const [sl, tp] = armTpSl(engine, { stopLoss: '78000', takeProfit: '82000' }, ctx);

    market.setBook('BTCUSDT', bids(['77950', '0.05'], ['77900', '1']));
    market.setLastPrice('BTCUSDT', D('78000'));
    const triggered = engine.onTrade('BTCUSDT', trade('78000', true), ctx);
    expect(triggered.map((e) => e.type)).toEqual(['order_triggered', 'order_cancelled']);
    const t = find(triggered, 'order_triggered');
    expect(t.order.id).toBe(sl!.id);
    expect(t.order.status).toBe('triggered');
    expect(t.order.triggeredAt).toBe(ctx.now);
    expect(t.order.arrivesAt).toBe(ctx.now + 100);
    expect(s(t.order.bestAtSubmit)).toBe('77950');
    expect(s(t.lastPrice)).toBe('78000');
    const oco = find(triggered, 'order_cancelled');
    expect(oco.order.id).toBe(tp!.id);
    expect(oco.reason).toBe('oco');

    const events = arriveNow(engine, stored(sl!.id), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_closed']);
    const fill = find(events, 'fill');
    expect(s(fill.fill.qty)).toBe('0.1');
    expect(s(fill.fill.price)).toBe('77925');
    expect(s(fill.fill.realizedPnl)).toBe('-207.5');
    expect(s(fill.fill.fee)).toBe('3.89625');
    expect(fill.fill.liquidity).toBe('taker');
    expect(s(fill.fill.triggerPrice)).toBe('78000');
    expect(fill.consumed?.map((l) => [s(l.price), s(l.qty)])).toEqual([
      ['77950', '0.05'],
      ['77900', '0.05'],
    ]);
    expect(fill.order.status).toBe('filled');
    expect(s(lev().free)).toBe('784.60375');
    expect(s(lev().locked)).toBe('0');
    const closed = find(events, 'position_closed');
    expect(closed.reason).toBe('stop_loss');
    expect(s(closed.exitPrice)).toBe('77925');
    expect(position()).toBeUndefined();
  });

  it('a buy at 82000 triggers the take-profit and cancels the stop-loss', () => {
    const { market, ctx, engine, lev, position, stored } = setup();
    openLong(engine, ctx);
    const [sl, tp] = armTpSl(engine, { stopLoss: '78000', takeProfit: '82000' }, ctx);
    market.setBook('BTCUSDT', bids(['82000', '1']));
    const triggered = engine.onTrade('BTCUSDT', trade('82000', false), ctx);
    expect(find(triggered, 'order_triggered').order.id).toBe(tp!.id);
    expect(find(triggered, 'order_cancelled').order.id).toBe(sl!.id);

    const events = arriveNow(engine, stored(tp!.id), ctx);
    expect(s(find(events, 'fill').fill.realizedPnl)).toBe('200');
    expect(s(find(events, 'fill').fill.fee)).toBe('4.1');
    expect(find(events, 'position_closed').reason).toBe('take_profit');
    // 600 + 396 + 200 − 4.1
    expect(s(lev().free)).toBe('1191.9');
    expect(position()).toBeUndefined();
  });

  it('closes the current quantity: an add after the trigger is closed too', () => {
    const { market, ctx, engine, position, stored } = setup();
    openLong(engine, ctx);
    const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
    engine.onTrade('BTCUSDT', trade('78000', true), ctx);
    execute(engine, marketOrder('buy', '0.05'), ctx);
    expect(s(position()!.qty)).toBe('0.15');
    market.setBook('BTCUSDT', bids(['78000', '1']));
    const events = arriveNow(engine, stored(sl!.id), ctx);
    expect(s(find(events, 'fill').fill.qty)).toBe('0.15');
    expect(find(events, 'position_closed').reason).toBe('stop_loss');
  });

  it('a triggered stop that finds the position closed is cancelled position_closed and opens nothing', () => {
    const { ctx, engine, lev, position, stored } = setup();
    openLong(engine, ctx);
    const [sl, tp] = armTpSl(engine, { stopLoss: '78000', takeProfit: '82000' }, ctx);
    const [close] = placedOrders(engine.submit(marketOrder('sell', '0.1', { reduceOnly: true }), ctx));
    engine.onTrade('BTCUSDT', trade('78000', true), ctx);
    expect(stored(sl!.id).status).toBe('triggered');
    expect(stored(tp!.id).status).toBe('cancelled');

    const closed = arriveNow(engine, close!, ctx);
    expect(find(closed, 'position_closed').reason).toBe('closed');
    // The triggered stop is already executing: the close does not cancel it.
    expect(stored(sl!.id).status).toBe('triggered');
    const free = s(lev().free);

    const events = arriveNow(engine, stored(sl!.id), ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
    expect(find(events, 'order_cancelled').reason).toBe('position_closed');
    expect(position()).toBeUndefined();
    expect(s(lev().free)).toBe(free);
  });

  it('triggered while stale: waits, then executes on the first fresh trade against the fresh book', () => {
    const { market, ctx, engine, position, stored } = setup();
    openLong(engine, ctx);
    const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
    engine.onTrade('BTCUSDT', trade('78000', true), ctx);

    market.setFresh('BTCUSDT', false);
    expect(arriveNow(engine, stored(sl!.id), ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('triggered');
    expect(stored(sl!.id).arrivesAt).toBeNull();
    expect(engine.onTrade('BTCUSDT', trade('77000', true), ctx)).toEqual([]);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    // A stale mark holds it back too.
    market.setFresh('BTCUSDT', true);
    market.setMarkFresh('BTCUSDT', false);
    expect(engine.arrive(sl!.id, ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('triggered');

    market.setMarkFresh('BTCUSDT', true);
    market.setBook('BTCUSDT', bids(['77500', '1']));
    ctx.now += 5_000;
    const events = engine.onTrade('BTCUSDT', trade('77500', true), ctx);
    expect(s(find(events, 'fill').fill.price)).toBe('77500');
    expect(find(events, 'position_closed').reason).toBe('stop_loss');
    expect(position()).toBeUndefined();
  });

  it('what the book leaves is cancelled thin_book; what the price band leaves, price_band', () => {
    {
      const { market, ctx, engine, position, stored } = setup();
      openLong(engine, ctx);
      const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
      engine.onTrade('BTCUSDT', trade('78000', true), ctx);
      market.setBook('BTCUSDT', bids(['77950', '0.05']));
      const events = arriveNow(engine, stored(sl!.id), ctx);
      expect(events.map((e) => e.type)).toEqual(['fill', 'order_cancelled']);
      expect(s(find(events, 'fill').fill.qty)).toBe('0.05');
      const c = find(events, 'order_cancelled');
      expect(c.reason).toBe('thin_book');
      expect(s(c.cancelledQty)).toBe('0.05');
      expect(s(position()!.qty)).toBe('0.05');
    }
    {
      // Band: mark 80000 × 0.95 = 76000.
      const { market, ctx, engine, position, stored } = setup();
      openLong(engine, ctx);
      const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
      engine.onTrade('BTCUSDT', trade('78000', true), ctx);
      market.setBook('BTCUSDT', bids(['77950', '0.05'], ['75000', '1']));
      const events = arriveNow(engine, stored(sl!.id), ctx);
      expect(s(find(events, 'fill').fill.qty)).toBe('0.05');
      expect(find(events, 'order_cancelled').reason).toBe('price_band');
      expect(s(position()!.qty)).toBe('0.05');
    }
    {
      const { market, ctx, engine, position, stored } = setup();
      openLong(engine, ctx);
      const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
      engine.onTrade('BTCUSDT', trade('78000', true), ctx);
      market.setBook('BTCUSDT', bids(['75000', '1']));
      const events = arriveNow(engine, stored(sl!.id), ctx);
      expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
      const c = find(events, 'order_cancelled');
      expect(c.reason).toBe('price_band');
      expect(s(c.cancelledQty)).toBe('0.1');
      expect(s(position()!.qty)).toBe('0.1');
    }
  });

  it('the executed quantity is a market quantity: MARKET_LOT_SIZE applies, LOT_SIZE does not', () => {
    {
      const { market, ctx, engine, position, stored } = setup();
      openLong(engine, ctx);
      const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
      engine.onTrade('BTCUSDT', trade('78000', true), ctx);
      market.setRules('BTCUSDT', { ...btcPerpRules, marketMaxQty: D('0.05') });
      const events = arriveNow(engine, stored(sl!.id), ctx);
      expect(rejectReason(events)).toBe('MARKET_LOT_SIZE: quantity 0.1 is above the market maximum 0.05');
      const e = events[0]!;
      if (e.type !== 'order_rejected') throw new Error('expected order_rejected');
      expect(e.afterTrigger).toBe(true);
      expect(s(position()!.qty)).toBe('0.1');
    }
    {
      const { market, ctx, engine, position, stored } = setup();
      openLong(engine, ctx);
      const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
      engine.onTrade('BTCUSDT', trade('78000', true), ctx);
      market.setRules('BTCUSDT', { ...btcPerpRules, maxQty: D('0.05'), minQty: D('0.5') });
      const events = arriveNow(engine, stored(sl!.id), ctx);
      expect(find(events, 'position_closed').reason).toBe('stop_loss');
      expect(position()).toBeUndefined();
    }
  });

  it('two stops executing in one call: the second sees the book less what the first took', () => {
    const { market, ctx, engine, position, stored } = setup();
    openLong(engine, ctx);
    // Set separately, the legs are not linked: both can trigger.
    const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
    const [tp] = armTpSl(engine, { takeProfit: '82000' }, ctx);
    engine.onTrade('BTCUSDT', trade('78000', true), ctx);
    engine.onTrade('BTCUSDT', trade('82000', false), ctx);
    expect(stored(sl!.id).status).toBe('triggered');
    expect(stored(tp!.id).status).toBe('triggered');

    market.setBook('BTCUSDT', bids(['77950', '0.05']));
    ctx.now = Math.max(stored(sl!.id).arrivesAt!, stored(tp!.id).arrivesAt!);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(true);
    const events = engine.onFresh('BTCUSDT', ctx);
    const fills = all(events, 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.order.id).toBe(sl!.id);
    const cancels = all(events, 'order_cancelled');
    expect(cancels.map((c) => [c.order.id, c.reason, s(c.cancelledQty)])).toEqual([
      [sl!.id, 'thin_book', '0.05'],
      [tp!.id, 'thin_book', '0.05'],
    ]);
    expect(s(position()!.qty)).toBe('0.05');
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });

  it('a triggered stop cannot be cancelled; an armed one is cancelled alone', () => {
    const { ctx, engine, stored } = setup();
    openLong(engine, ctx);
    const [sl, tp] = armTpSl(engine, { stopLoss: '78000', takeProfit: '82000' }, ctx);
    expect(engine.cancel(tp!.id, ctx).ok).toBe(true);
    ctx.now = stored(tp!.id).cancelArrivesAt!;
    engine.arriveCancel(tp!.id, ctx);
    expect(stored(tp!.id).status).toBe('cancelled');
    expect(stored(sl!.id).status).toBe('open');
    engine.onTrade('BTCUSDT', trade('78000', true), ctx);
    expect(engine.cancel(sl!.id, ctx)).toEqual({
      ok: false,
      reason: 'Order is already executing and cannot be cancelled',
    });
  });

  it('nothing triggers while the legs are in flight', () => {
    const { ctx, engine, stored } = setup();
    openLong(engine, ctx);
    const [sl] = placedOrders(engine.setPositionTpSl('BTCUSDT', { stopLoss: '78000' }, ctx));
    expect(engine.onTrade('BTCUSDT', trade('77000', true), ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('pending');
  });
});

describe('liquidation and stops', () => {
  it('liquidation cancels the armed and the triggered stops', () => {
    const { market, ctx, engine, stored } = setup();
    openLong(engine, ctx);
    const [sl, tp] = armTpSl(engine, { stopLoss: '76500', takeProfit: '82000' }, ctx);
    engine.onTrade('BTCUSDT', trade('76500', true), ctx);
    expect(stored(sl!.id).status).toBe('triggered');
    market.setMarkPrice('BTCUSDT', D('76000'));
    const { events } = engine.onMark('BTCUSDT', D('76000'), ctx);
    const liq = find(events, 'liquidation');
    expect(liq.cancelledOrderIds).toEqual([sl!.id]);
    expect(all(events, 'order_cancelled').map((c) => [c.order.id, c.reason])).toEqual([[sl!.id, 'liquidation']]);
    expect(stored(tp!.id).status).toBe('cancelled');
    // Its arrival finds nothing to do.
    expect(arriveNow(engine, stored(sl!.id), ctx)).toEqual([]);
  });

  it('liquidation cancels both armed legs', () => {
    const { market, ctx, engine } = setup();
    openLong(engine, ctx);
    const [sl, tp] = armTpSl(engine, { stopLoss: '76500', takeProfit: '82000' }, ctx);
    market.setMarkPrice('BTCUSDT', D('76000'));
    const { events } = engine.onMark('BTCUSDT', D('76000'), ctx);
    expect(find(events, 'liquidation').cancelledOrderIds).toEqual([sl!.id, tp!.id]);
    expect(all(events, 'order_cancelled').map((c) => c.reason)).toEqual(['liquidation', 'liquidation']);
  });
});

describe('attached stop-loss and take-profit on an opening order', () => {
  it('market long 0.1 with both legs: placed for the new position after the fill, armed after the delay', () => {
    const { ctx, engine, stored } = setup();
    const [parent] = placedOrders(
      engine.submit(marketOrder('buy', '0.1', { attach: { stopLoss: '79000', takeProfit: '81000' } }), ctx),
    );
    expect(s(parent!.attach?.stopLoss)).toBe('79000');
    expect(s(parent!.attach?.takeProfit)).toBe('81000');

    const events = arriveNow(engine, parent!, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_opened', 'order_placed', 'order_placed']);
    const [sl, tp] = placedOrders(events.slice(2));
    for (const leg of [sl!, tp!]) {
      expect(leg.side).toBe('sell');
      expect(leg.closePosition).toBe(true);
      expect(leg.reduceOnly).toBe(true);
      expect(leg.qty).toBeNull();
      expect(leg.parentId).toBe(parent!.id);
      expect(leg.status).toBe('pending');
    }
    expect(sl!.type).toBe('stop_loss');
    expect(s(sl!.triggerPrice)).toBe('79000');
    expect(tp!.type).toBe('take_profit');
    expect(s(tp!.triggerPrice)).toBe('81000');
    expect(sl!.ocoGroupId).not.toBeNull();
    expect(tp!.ocoGroupId).toBe(sl!.ocoGroupId);

    arriveNow(engine, sl!, ctx);
    expect(stored(sl!.id).status).toBe('open');
    expect(stored(tp!.id).status).toBe('open');
  });

  it('a short gets buy legs, a stop-loss above and a take-profit below', () => {
    const { ctx, engine } = setup();
    const events = execute(
      engine,
      marketOrder('sell', '0.1', { attach: { stopLoss: '81000', takeProfit: '79000' } }),
      ctx,
    );
    const legs = placedOrders(all(events, 'order_placed'));
    expect(legs.map((l) => [l.type, l.side])).toEqual([
      ['stop_loss', 'buy'],
      ['take_profit', 'buy'],
    ]);
  });

  it('a bad leg rejects the whole order', () => {
    const { ctx, engine, lev } = setup();
    const reject = (r: PerpOrderRequest) => rejectReason(engine.submit(r, ctx));
    expect(reject(marketOrder('buy', '0.1', { attach: { stopLoss: '80500' } }))).toBe(
      'Attached stop-loss 80500 must be below the last price 80000',
    );
    expect(reject(marketOrder('buy', '0.1', { attach: { takeProfit: '79500' } }))).toBe(
      'Attached take-profit 79500 must be above the last price 80000',
    );
    expect(reject(marketOrder('sell', '0.1', { attach: { stopLoss: '79000' } }))).toBe(
      'Attached stop-loss 79000 must be above the last price 80000',
    );
    expect(reject(marketOrder('sell', '0.1', { attach: { takeProfit: '81000' } }))).toBe(
      'Attached take-profit 81000 must be below the last price 80000',
    );
    expect(reject(limit('buy', '79000', '0.1', { attach: { stopLoss: '79500' } }))).toBe(
      'Attached stop-loss 79500 must be below the limit price 79000',
    );
    expect(reject(limit('sell', '81000', '0.1', { attach: { takeProfit: '81500' } }))).toBe(
      'Attached take-profit 81500 must be below the limit price 81000',
    );
    expect(reject(marketOrder('buy', '0.1', { attach: { stopLoss: '79000.05' } }))).toBe(
      'PRICE_FILTER: trigger price 79000.05 is not a multiple of tick size 0.1',
    );
    expect(reject(marketOrder('buy', '0.1', { attach: { stopLoss: 'abc' } }))).toMatch(/./);
    expect(reject(marketOrder('buy', '0.1', { attach: {} }))).toBe('Enter a stop-loss or a take-profit price');
    expect(s(lev().free)).toBe('1000');
    expect(engine.state.orders.size).toBe(9);
  });

  it('only an opening order takes attached legs', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    expect(
      rejectReason(engine.submit(marketOrder('sell', '0.05', { reduceOnly: true, attach: { stopLoss: '81000' } }), ctx)),
    ).toBe('Attached stop-loss and take-profit are only for orders that open or add to a position');
  });

  it('one stop-loss and one take-profit per position: an add with a leg the position has is rejected', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    armTpSl(engine, { stopLoss: '78000' }, ctx);
    expect(rejectReason(engine.submit(marketOrder('buy', '0.01', { attach: { stopLoss: '79000' } }), ctx))).toBe(
      'This position already has a stop-loss; cancel it first',
    );
    // The take-profit is free.
    expect(placedOrders(engine.submit(marketOrder('buy', '0.01', { attach: { takeProfit: '81000' } }), ctx))).toHaveLength(1);
    // A second order attaching the same leg would collide when it fills.
    expect(rejectReason(engine.submit(marketOrder('buy', '0.01', { attach: { takeProfit: '81500' } }), ctx))).toBe(
      'An open order on BTCUSDT already attaches a take-profit; cancel it first',
    );
    expect(rejectReason(engine.setPositionTpSl('BTCUSDT', { takeProfit: '81500' }, ctx))).toBe(
      'An open order on BTCUSDT already attaches a take-profit; cancel it first',
    );
  });

  it('attached legs count toward MAX_NUM_ORDERS', () => {
    const { market, ctx, engine } = setup();
    market.setRules('BTCUSDT', { ...btcPerpRules, maxNumOrders: 2 });
    expect(
      rejectReason(
        engine.submit(marketOrder('buy', '0.1', { attach: { stopLoss: '79000', takeProfit: '81000' } }), ctx),
      ),
    ).toBe('MAX_NUM_ORDERS: an order with attached stop-loss/take-profit needs 3 slots but 0 of 2 are in use on BTCUSDT');
    placedOrders(engine.submit(marketOrder('buy', '0.1', { attach: { stopLoss: '79000' } }), ctx));
    // The pending order holds its leg's slot as well.
    expect(rejectReason(engine.submit(limit('buy', '79000', '0.01'), ctx))).toBe(
      'MAX_NUM_ORDERS: already 2 open orders on BTCUSDT (maximum 2)',
    );
  });

  it('a limit activates its legs at its first fill, once', () => {
    const { ctx, engine, stored } = setup();
    const [parent] = placedOrders(
      engine.submit(limit('buy', '79900', '0.1', { attach: { takeProfit: '81000' } }), ctx),
    );
    expect(arriveNow(engine, parent!, ctx)).toEqual([]);
    expect(stored(parent!.id).status).toBe('open');

    const first = engine.onTrade('BTCUSDT', trade('79800', true, '0.04'), ctx);
    expect(first.map((e) => e.type)).toEqual(['fill', 'position_opened', 'order_placed']);
    const [tp] = placedOrders(all(first, 'order_placed'));
    expect(tp!.parentId).toBe(parent!.id);
    expect(tp!.ocoGroupId).toBeNull();

    const second = engine.onTrade('BTCUSDT', trade('79800', true, '0.06'), ctx);
    expect(second.map((e) => e.type)).toEqual(['fill']);
    expect(stored(parent!.id).status).toBe('filled');
  });

  it('legs that would trigger at the fill are rejected together', () => {
    const { market, ctx, engine, position } = setup();
    const [parent] = placedOrders(
      engine.submit(marketOrder('buy', '0.1', { attach: { stopLoss: '79990', takeProfit: '81000' } }), ctx),
    );
    market.setLastPrice('BTCUSDT', D('79980'));
    const events = arriveNow(engine, parent!, ctx);
    expect(position()).toBeDefined();
    expect(rejections(all(events, 'order_rejected') as PerpEvent[])).toEqual([
      'Stop would trigger immediately (last 79980, trigger 79990)',
      'Stop would trigger immediately (last 79980, trigger 79990)',
    ]);
  });

  it('legs whose arrival finds stale data wait and arm on the first fresh data', () => {
    const { market, ctx, engine, stored } = setup();
    const events = execute(engine, marketOrder('buy', '0.1', { attach: { stopLoss: '79000', takeProfit: '81000' } }), ctx);
    const [sl, tp] = placedOrders(all(events, 'order_placed'));
    market.setFresh('BTCUSDT', false);
    expect(arriveNow(engine, sl!, ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('pending');
    expect(stored(sl!.id).arrivesAt).toBeNull();
    expect(stored(tp!.id).arrivesAt).toBeNull();
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);

    market.setFresh('BTCUSDT', true);
    market.setLastPrice('BTCUSDT', null);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    market.setLastPrice('BTCUSDT', D('80000'));
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(true);
    expect(engine.onFresh('BTCUSDT', ctx)).toEqual([]);
    expect(stored(sl!.id).status).toBe('open');
    expect(stored(tp!.id).status).toBe('open');
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });

  it('a waiting leg that would trigger when it arms is rejected with its partner', () => {
    const { market, ctx, engine, stored } = setup();
    const events = execute(engine, marketOrder('buy', '0.1', { attach: { stopLoss: '79000', takeProfit: '81000' } }), ctx);
    const [sl, tp] = placedOrders(all(events, 'order_placed'));
    market.setFresh('BTCUSDT', false);
    arriveNow(engine, sl!, ctx);
    market.setFresh('BTCUSDT', true);
    market.setLastPrice('BTCUSDT', D('81500'));
    expect(rejections(engine.onFresh('BTCUSDT', ctx))).toEqual([
      'Take-profit would trigger immediately (last 81500, trigger 81000)',
      'Take-profit would trigger immediately (last 81500, trigger 81000)',
    ]);
    expect(stored(sl!.id).status).toBe('rejected');
    expect(stored(tp!.id).status).toBe('rejected');
  });
});

describe('hasDeferredWork with stops', () => {
  it('a triggered stop is deferred work once its arrival time has passed, and while waiting for fresh data', () => {
    const { market, ctx, engine, stored } = setup();
    openLong(engine, ctx);
    const [sl] = armTpSl(engine, { stopLoss: '78000' }, ctx);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    engine.onTrade('BTCUSDT', trade('78000', true), ctx);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    ctx.now = stored(sl!.id).arrivesAt!;
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(true);
    expect(engine.hasDeferredWork('ETHUSDT', ctx)).toBe(false);

    market.setFresh('BTCUSDT', false);
    engine.arrive(sl!.id, ctx);
    expect(stored(sl!.id).arrivesAt).toBeNull();
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(true);
    market.setFresh('BTCUSDT', true);
    const events = engine.onFresh('BTCUSDT', ctx);
    expect(find(events, 'position_closed').reason).toBe('stop_loss');
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });

  it('an armed stop alone is not deferred work', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    armTpSl(engine, { stopLoss: '78000', takeProfit: '82000' }, ctx);
    ctx.now += 60_000;
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });
});
