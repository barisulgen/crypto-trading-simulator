import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { liquidationPrice } from '../src/perp/math.ts';
import { emptyPerpState, evictTerminal, putOrder, takeDirty } from '../src/perp/state.ts';
import type { PerpCtx, PerpEvent, PerpOrder, PerpOrderRequest } from '../src/perp/types.ts';
import { brackets, btcBrackets, FakePerpMarket, perpCtx } from './perpFixtures.ts';

const NOW = 1_000_000;

function setup(usdt = '1000', opts: { leverage?: number; rngValues?: number[] } = {}) {
  const market = new FakePerpMarket();
  const ctx = perpCtx(market, { now: NOW, rngValues: opts.rngValues });
  const ledger = emptyLedger(['USDT', 'BTC']);
  // Set directly: some tests need balances finer than a deposit's 2 decimals.
  ledger.balances.leverage.USDT = { free: D(usdt), locked: D(0) };
  const engine = new PerpEngine(emptyPerpState(ledger));
  if (opts.leverage !== undefined) {
    engine.state.settings.BTCUSDT = { leverage: opts.leverage, marginMode: 'isolated' };
  }
  const lev = () => engine.state.ledger.balances.leverage.USDT!;
  const position = () => engine.state.positions.BTCUSDT;
  return { market, ctx, engine, lev, position };
}

const long = (fields: Partial<PerpOrderRequest> = {}): PerpOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  ...fields,
});
const short = (fields: Partial<PerpOrderRequest> = {}): PerpOrderRequest => ({ ...long(fields), side: 'sell' });

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

function placed(events: PerpEvent[]): PerpOrder {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'order_placed') throw new Error(`expected order_placed, got ${e.type}`);
  expect(e.market).toBe('perp');
  return e.order;
}

function rejectReason(events: PerpEvent[]): string {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'order_rejected') throw new Error(`expected order_rejected, got ${e.type}`);
  expect(e.market).toBe('perp');
  expect(e.order.status).toBe('rejected');
  expect(e.order.rejectReason).toBe(e.reason);
  return e.reason;
}

function find<T extends PerpEvent['type']>(events: PerpEvent[], type: T): Extract<PerpEvent, { type: T }> {
  const e = events.find((x) => x.type === type);
  if (!e) throw new Error(`no ${type} event in ${events.map((x) => x.type).join(', ')}`);
  return e as Extract<PerpEvent, { type: T }>;
}

/** Arrive at the order's arrival time (arrive is a no-op before it). */
function arriveNow(engine: PerpEngine, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

/** Submit and arrive; the order must be placed. */
function execute(engine: PerpEngine, req: PerpOrderRequest, ctx: PerpCtx): PerpEvent[] {
  return arriveNow(engine, placed(engine.submit(req, ctx)), ctx);
}

/** The long 0.1 @80000 every position test starts from: margin 396, free 600. */
function openLong(engine: PerpEngine, ctx: PerpCtx): void {
  execute(engine, long({ qty: '0.1' }), ctx);
}

describe('market long 0.1 at 20x', () => {
  it('preview: walk average, fee, notional, margin required and liquidation price', () => {
    const { ctx, engine, lev } = setup();
    const p = engine.preview(long({ qty: '0.1' }), ctx);
    expect(p.rejectReason).toBeNull();
    expect(s(p.estAvgPrice)).toBe('80000');
    expect(s(p.estSlippageUsd)).toBe('0');
    expect(s(p.estSlippagePct)).toBe('0');
    expect(s(p.fee)).toBe('4');
    expect(s(p.notional)).toBe('8000');
    // Assumed price 80120 (last × 1.0015): IM 400.6 + taker fee 4.006.
    expect(s(p.marginRequired)).toBe('404.606');
    expect(p.estLiquidationPrice?.toFixed(8)).toBe('76345.38152610');
    expect(p.leverage).toBe(20);
    expect(p.maxLeverage).toBe(150);
    expect(p.exhausted).toBe(false);
    expect(p.bandLimited).toBe(false);
    expect(p.note).toBeNull();
    // Preview never changes state.
    expect(engine.state.orders.size).toBe(0);
    expect(s(lev().free)).toBe('1000');
  });

  it('submit locks the order cost and records the order', () => {
    const { ctx, engine, lev } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(order.id).toBe('o1');
    expect(order.status).toBe('pending');
    expect(order.type).toBe('market');
    expect(s(order.qty)).toBe('0.1');
    expect(order.quoteQty).toBeNull();
    expect(order.reduceOnly).toBe(false);
    expect(order.closePosition).toBe(false);
    expect(order.leverage).toBe(20);
    expect(s(order.lockAmount)).toBe('404.606');
    expect(s(order.bestAtSubmit)).toBe('80000');
    expect(order.createdAt).toBe(NOW);
    expect(order.arrivesAt).toBe(NOW + 100);
    expect(s(order.realizedPnl)).toBe('0');
    expect(s(lev().free)).toBe('595.394');
    expect(s(lev().locked)).toBe('404.606');
  });

  it('arrive fills, moves the margin into a new position and releases the rest of the lock', () => {
    const { ctx, engine, lev, position } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_opened']);
    expect(events.every((e) => e.market === 'perp')).toBe(true);

    const f = find(events, 'fill');
    expect(f.fill.market).toBe('perp');
    expect(f.fill.id).toBe('f1');
    expect(f.fill.orderId).toBe('o1');
    expect(f.fill.side).toBe('buy');
    expect(s(f.fill.qty)).toBe('0.1');
    expect(s(f.fill.price)).toBe('80000');
    expect(s(f.fill.quote)).toBe('8000');
    expect(f.fill.liquidity).toBe('taker');
    expect(f.fill.feeAsset).toBe('USDT');
    expect(s(f.fill.fee)).toBe('4');
    expect(s(f.fill.marginIn)).toBe('400');
    expect(f.fill.realizedPnl).toBeNull();
    expect(f.fill.uncovered).toBeNull();
    expect(f.fill.positionId).toBe('p1');
    expect(s(f.fill.bestAtArrival)).toBe('80000');
    expect(s(f.fill.bestAtSubmit)).toBe('80000');
    expect(s(f.fill.slippageUsd)).toBe('0');
    expect(s(f.fill.driftUsd)).toBe('0');
    expect(f.fill.time).toBe(ctx.now);
    expect(f.consumed?.map((l) => [s(l.price), s(l.qty)])).toEqual([['80000', '0.1']]);
    expect(f.order.status).toBe('filled');

    const opened = find(events, 'position_opened');
    expect(opened.position.id).toBe('p1');

    const p = position()!;
    expect(p).toEqual(opened.position);
    expect(p.side).toBe('long');
    expect(s(p.qty)).toBe('0.1');
    expect(s(p.entryPrice)).toBe('80000');
    expect(s(p.margin)).toBe('396');
    expect(p.leverage).toBe(20);
    expect(p.openedAt).toBe(ctx.now);
    expect(s(p.fees)).toBe('4');
    expect(s(p.realizedPnl)).toBe('0');
    expect(s(p.funding)).toBe('0');
    expect(p.warnLevel).toBe(0);

    expect(s(lev().free)).toBe('600');
    expect(s(lev().locked)).toBe('0');
    const stored = engine.state.orders.get('o1')!;
    expect(stored.status).toBe('filled');
    expect(s(stored.filledQty)).toBe('0.1');
    expect(s(stored.filledQuote)).toBe('8000');
    expect(s(stored.fee)).toBe('4');
    expect(s(stored.lockAmount)).toBe('0');
  });

  it('arrive before arrivesAt, a second time, or for an unknown id is a no-op', () => {
    const { ctx, engine, lev } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    ctx.now = order.arrivesAt! - 1;
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(s(lev().locked)).toBe('404.606');
    arriveNow(engine, order, ctx);
    expect(engine.arrive(order.id, ctx)).toEqual([]);
    expect(engine.arrive('nope', ctx)).toEqual([]);
    expect(s(lev().free)).toBe('600');
  });

  it('the arrival delay is 100–300 ms', () => {
    const { ctx, engine } = setup('1000', { rngValues: [0.999999] });
    expect(placed(engine.submit(long({ qty: '0.1' }), ctx)).arrivesAt).toBe(NOW + 300);
  });

  it('records the delay drift when the book moves before arrival', () => {
    const { market, ctx, engine } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    market.setBook('BTCUSDT', { asks: [{ price: D('80100'), qty: D('1') }], bids: [] });
    const f = find(arriveNow(engine, order, ctx), 'fill').fill;
    expect(s(f.price)).toBe('80100');
    expect(s(f.bestAtArrival)).toBe('80100');
    expect(s(f.driftUsd)).toBe('10');
  });
});

describe('walk average and adding to a position', () => {
  it('market long 0.3 walks two levels', () => {
    const { ctx, engine } = setup('2000');
    const p = engine.preview(long({ qty: '0.3' }), ctx);
    expect(p.estAvgPrice?.toFixed(8)).toBe('80003.33333333');
    expect(s(p.estSlippageUsd)).toBe('1'); // 24001 − 24000
    const events = execute(engine, long({ qty: '0.3' }), ctx);
    const f = find(events, 'fill');
    expect(f.fill.price.toFixed(8)).toBe('80003.33333333');
    expect(s(f.fill.quote)).toBe('24001');
    expect(s(f.fill.slippageUsd)).toBe('1');
    expect(f.consumed?.map((l) => [s(l.price), s(l.qty)])).toEqual([
      ['80000', '0.2'],
      ['80010', '0.1'],
    ]);
  });

  it('a second opening fill averages the entry and adds its margin net of its fee', () => {
    const { market, ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    market.setBook('BTCUSDT', { asks: [{ price: D('80100'), qty: D('1') }], bids: [] });
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    // Assumed 80120: IM 400.6, open loss 0.1 × (80100 − 80000) = 10, fee 4.006.
    expect(s(order.lockAmount)).toBe('414.606');
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    expect(s(find(events, 'fill').fill.marginIn)).toBe('400.5');
    const p = position()!;
    expect(p.id).toBe('p1');
    expect(s(p.qty)).toBe('0.2');
    expect(s(p.entryPrice)).toBe('80050');
    expect(s(p.margin)).toBe('792.495'); // 396 + 400.5 − 4.005
    expect(s(p.fees)).toBe('8.005');
    expect(s(lev().free)).toBe('199.5');
    expect(s(lev().locked)).toBe('0');
  });
});

describe('reduce-only', () => {
  it('reduce-only sell 0.04 realises P&L, pays the fee and releases margin pro rata', () => {
    const { ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    const order = placed(engine.submit(short({ qty: '0.04', reduceOnly: true }), ctx));
    expect(order.reduceOnly).toBe(true);
    expect(s(order.lockAmount)).toBe('0');
    expect(s(lev().locked)).toBe('0');
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const f = find(events, 'fill').fill;
    expect(s(f.price)).toBe('79990');
    expect(s(f.realizedPnl)).toBe('-0.4');
    expect(s(f.fee)).toBe('1.5998');
    expect(f.marginIn).toBeNull();
    expect(f.uncovered).toBeNull();
    expect(f.positionId).toBe('p1');
    // Released 158.4 − 0.4 − 1.5998 goes to the wallet.
    expect(s(lev().free)).toBe('756.4002');
    const p = position()!;
    expect(s(p.qty)).toBe('0.06');
    expect(s(p.margin)).toBe('237.6');
    expect(s(p.realizedPnl)).toBe('-0.4');
    expect(s(p.fees)).toBe('5.5998');
    expect(liquidationPrice(btcBrackets, p.side, p.qty, p.entryPrice, p.margin)?.toFixed(8)).toBe('76345.38152610');
    const stored = engine.state.orders.get(order.id)!;
    expect(stored.status).toBe('filled');
    expect(s(stored.realizedPnl)).toBe('-0.4');
  });

  it('preview of a reduce-only order: no margin, the remaining position’s liquidation price', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    const p = engine.preview(short({ qty: '0.04', reduceOnly: true }), ctx);
    expect(p.rejectReason).toBeNull();
    expect(s(p.estAvgPrice)).toBe('79990');
    expect(s(p.marginRequired)).toBe('0');
    expect(s(p.fee)).toBe('1.5998');
    expect(p.estLiquidationPrice?.toFixed(8)).toBe('76345.38152610');
    // Closing the whole position leaves nothing to liquidate.
    expect(engine.preview(short({ qty: '0.2', reduceOnly: true }), ctx).estLiquidationPrice).toBeNull();
  });

  it('a loss rounds against the owner (down to 8 decimals)', () => {
    const { ctx, engine, lev, position } = setup('2000');
    execute(engine, long({ qty: '0.3' }), ctx); // entry 80003.333…, margin 1200.05 − 12.0005
    expect(s(position()!.margin)).toBe('1188.0495');
    expect(s(lev().free)).toBe('799.95');
    const f = find(execute(engine, short({ qty: '0.1', reduceOnly: true }), ctx), 'fill').fill;
    // 0.1 × (79990 − 80003.333…) = −1.3333…
    expect(s(f.realizedPnl)).toBe('-1.33333334');
    expect(s(f.fee)).toBe('3.9995');
    expect(s(position()!.margin)).toBe('792.033');
    expect(s(lev().free)).toBe('1190.63366666'); // + 396.0165 − 1.33333334 − 3.9995
  });

  it('larger than the position: trimmed to it, the position closes and other reduce-only orders are cancelled', () => {
    const { ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    execute(engine, short({ qty: '0.04', reduceOnly: true }), ctx);
    const big = placed(engine.submit(short({ qty: '0.2', reduceOnly: true }), ctx));
    const other = placed(engine.submit(short({ qty: '0.01', reduceOnly: true }), ctx));
    const openedAt = position()!.openedAt;
    ctx.now += 5_000;
    const events = engine.arrive(big.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'order_cancelled', 'position_closed', 'order_cancelled']);

    const f = find(events, 'fill').fill;
    expect(s(f.qty)).toBe('0.06');
    expect(s(f.realizedPnl)).toBe('-0.6');
    expect(s(f.fee)).toBe('2.3997');

    const trimmed = events[1]!;
    if (trimmed.type !== 'order_cancelled') throw new Error('expected order_cancelled');
    expect(trimmed.order.id).toBe(big.id);
    expect(trimmed.reason).toBe('reduce_only');
    expect(s(trimmed.cancelledQty)).toBe('0.14');
    expect(s(trimmed.order.filledQty)).toBe('0.06');

    const closed = find(events, 'position_closed');
    expect(closed.reason).toBe('closed');
    expect(s(closed.exitPrice)).toBe('79990');
    expect(s(closed.realizedPnl)).toBe('-1');
    expect(s(closed.fees)).toBe('7.9995');
    expect(s(closed.funding)).toBe('0');
    expect(closed.holdMs).toBe(ctx.now - openedAt);
    expect(s(closed.position.qty)).toBe('0');
    expect(s(closed.position.margin)).toBe('0');

    const swept = events[3]!;
    if (swept.type !== 'order_cancelled') throw new Error('expected order_cancelled');
    expect(swept.order.id).toBe(other.id);
    expect(swept.reason).toBe('position_closed');
    expect(s(swept.cancelledQty)).toBe('0.01');

    expect(position()).toBeUndefined();
    expect(engine.state.orders.get(big.id)!.status).toBe('cancelled');
    expect(engine.state.orders.get(other.id)!.status).toBe('cancelled');
    expect(engine.arrive(other.id, ctx)).toEqual([]);
    // 756.4002 + 237.6 − 0.6 − 2.3997
    expect(s(lev().free)).toBe('991.0005');
    expect(s(lev().locked)).toBe('0');
  });

  it('closes a short', () => {
    const { ctx, engine, lev, position } = setup();
    const order = placed(engine.submit(short({ qty: '0.1' }), ctx));
    // Assumed max(79990, mark 80000, 80120) = 80120: IM 400.6 + open loss 1 + fee 4.006.
    expect(s(order.lockAmount)).toBe('405.606');
    arriveNow(engine, order, ctx);
    const p = position()!;
    expect(p.side).toBe('short');
    expect(s(p.entryPrice)).toBe('79990');
    expect(s(p.margin)).toBe('395.9505'); // 399.95 − 3.9995
    expect(s(lev().free)).toBe('600.05');
    const events = execute(engine, long({ qty: '0.1', reduceOnly: true }), ctx);
    expect(s(find(events, 'fill').fill.realizedPnl)).toBe('-1');
    expect(find(events, 'position_closed').reason).toBe('closed');
    expect(s(lev().free)).toBe('991.0005');
  });

  it('a loss beyond the released margin comes from the remaining margin first', () => {
    const { market, ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('78000')); // band floor 74100
    market.setBook('BTCUSDT', { asks: [], bids: [{ price: D('75000'), qty: D('1') }] });
    const f = find(execute(engine, short({ qty: '0.05', reduceOnly: true }), ctx), 'fill').fill;
    // Released 198, P&L −250, fee 1.875: short 53.875, taken from the 198 still in the position.
    expect(s(f.realizedPnl)).toBe('-250');
    expect(s(f.fee)).toBe('1.875');
    expect(f.uncovered).toBeNull();
    expect(s(position()!.margin)).toBe('144.125');
    expect(s(lev().free)).toBe('600');
  });

  it('a closing loss beyond the margin comes from free USDT, and what free cannot cover is uncovered', () => {
    const { market, ctx, engine, lev, position } = setup('404.606');
    openLong(engine, ctx);
    expect(s(lev().free)).toBe('4.606');
    market.setMarkPrice('BTCUSDT', D('78000'));
    market.setBook('BTCUSDT', { asks: [], bids: [{ price: D('75000'), qty: D('1') }] });
    const events = execute(engine, short({ qty: '0.1', reduceOnly: true }), ctx);
    // Released 396, P&L −500, fee 3.75: short 107.75; free pays 4.606.
    const f = find(events, 'fill').fill;
    expect(s(f.uncovered)).toBe('103.144');
    expect(find(events, 'position_closed').reason).toBe('closed');
    expect(position()).toBeUndefined();
    expect(s(lev().free)).toBe('0');
  });

  it('with free USDT enough, a closing loss beyond the margin is taken from it', () => {
    const { market, ctx, engine, lev } = setup();
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('78000'));
    market.setBook('BTCUSDT', { asks: [], bids: [{ price: D('75000'), qty: D('1') }] });
    const f = find(execute(engine, short({ qty: '0.1', reduceOnly: true }), ctx), 'fill').fill;
    expect(f.uncovered).toBeNull();
    expect(s(lev().free)).toBe('492.25');
  });

  it('without a position to reduce', () => {
    const { ctx, engine } = setup();
    expect(rejectReason(engine.submit(short({ qty: '0.01', reduceOnly: true }), ctx))).toBe(
      'Reduce-only order would not reduce a position on BTCUSDT',
    );
    openLong(engine, ctx);
    // A reduce-only buy would add to the long.
    expect(rejectReason(engine.submit(long({ qty: '0.01', reduceOnly: true }), ctx))).toBe(
      'Reduce-only order would not reduce a position on BTCUSDT',
    );
  });

  it('a reduce-only order that arrives to no position is rejected', () => {
    const { ctx, engine, lev } = setup();
    openLong(engine, ctx);
    const order = placed(engine.submit(short({ qty: '0.01', reduceOnly: true }), ctx));
    delete engine.state.positions.BTCUSDT;
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe('No position to reduce on BTCUSDT');
    expect(s(lev().locked)).toBe('0');
  });
});

describe('one-way mode', () => {
  it('an opening order opposite a position is refused', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    expect(rejectReason(engine.submit(short({ qty: '0.1' }), ctx))).toBe(
      'One-way mode: you hold a long position on BTCUSDT; use reduce-only to reduce it',
    );
  });

  it('an order opposite a short position is refused the same way', () => {
    const { ctx, engine } = setup();
    execute(engine, short({ qty: '0.1' }), ctx);
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
      'One-way mode: you hold a short position on BTCUSDT; use reduce-only to reduce it',
    );
  });

  it('an opening order opposite open opening orders is refused', () => {
    const { ctx, engine } = setup('2000');
    placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(rejectReason(engine.submit(short({ qty: '0.1' }), ctx))).toBe(
      'One-way mode: you have open orders to go long on BTCUSDT',
    );
  });

  it('a reduce-only order may face an open opening order', () => {
    const { ctx, engine } = setup('2000');
    openLong(engine, ctx);
    placed(engine.submit(long({ qty: '0.1' }), ctx));
    placed(engine.submit(short({ qty: '0.05', reduceOnly: true }), ctx));
  });
});

describe('maximum notional at the leverage', () => {
  it('rejects an order that takes the position past the leverage’s maximum', () => {
    const { ctx, engine } = setup('1000', { leverage: 150 });
    expect(rejectReason(engine.submit(long({ qty: '4' }), ctx))).toBe(
      'Position would exceed 300000 USDT, the maximum at 150x on BTCUSDT; lower the leverage',
    );
  });

  it('counts the position and the open opening orders', () => {
    const { ctx, engine } = setup('10000', { leverage: 150 });
    openLong(engine, ctx); // 0.1
    placed(engine.submit(long({ qty: '1.4' }), ctx)); // pending
    // 80000 × (0.1 + 1.4 + 2.25) = 300000: at the maximum, accepted.
    placed(engine.submit(long({ qty: '2.25' }), ctx));
    expect(rejectReason(engine.submit(long({ qty: '0.001' }), ctx))).toBe(
      'Position would exceed 300000 USDT, the maximum at 150x on BTCUSDT; lower the leverage',
    );
    // Reduce-only orders do not open anything.
    placed(engine.submit(short({ qty: '0.05', reduceOnly: true }), ctx));
  });
});

describe('leverage', () => {
  it('defaults to 20x', () => {
    const { ctx, engine } = setup();
    expect(placed(engine.submit(long({ qty: '0.1' }), ctx)).leverage).toBe(20);
  });

  it('the default is capped at the symbol’s maximum', () => {
    const { market, ctx, engine } = setup();
    market.setBrackets('BTCUSDT', brackets([['0', '1000000', '0.01', '0', 10]]));
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(order.leverage).toBe(10);
  });

  it('the capped default holds on every path: limits, previews and a rejected unknown type', () => {
    const { market, ctx, engine } = setup();
    market.setBrackets('BTCUSDT', brackets([['0', '1000000', '0.01', '0', 10]]));
    const limit = long({ type: 'limit', price: '79000', qty: '0.01' });
    expect(placed(engine.submit(limit, ctx)).leverage).toBe(10);
    expect(engine.preview(limit, ctx).leverage).toBe(10);
    expect(engine.preview(long({ qty: '0.01' }), ctx).leverage).toBe(10);
    const unknown = { ...long({ qty: '0.1' }), type: 'iceberg' } as unknown as PerpOrderRequest;
    expect(engine.preview(unknown, ctx).leverage).toBe(10);
    const [rejected] = engine.submit(unknown, ctx);
    if (rejected?.type !== 'order_rejected') throw new Error('expected order_rejected');
    expect(rejected.order.leverage).toBe(10);
  });

  it('uses the symbol’s setting', () => {
    const { ctx, engine } = setup('1000', { leverage: 10 });
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(order.leverage).toBe(10);
    // IM 801.2 + fee 4.006
    expect(s(order.lockAmount)).toBe('805.206');
  });

  it('a setting that is not a whole number from 1 to the maximum is refused', () => {
    for (const leverage of [0, 2.5, 151, -1]) {
      const { ctx, engine } = setup('1000', { leverage });
      expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
        'Leverage must be a whole number from 1 to 150',
      );
    }
  });
});

describe('funds', () => {
  it('rejects when the order cost exceeds free leverage USDT', () => {
    const { ctx, engine, lev } = setup('300');
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
      'Insufficient margin: need 404.606, available 300',
    );
    expect(s(lev().free)).toBe('300');
    expect(s(lev().locked)).toBe('0');
  });

  it('exactly the order cost is enough', () => {
    const { ctx, engine, lev } = setup('404.606');
    placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(s(lev().free)).toBe('0');
  });

  it('the preview shows the rejection with its estimate', () => {
    const { ctx, engine } = setup('300');
    const p = engine.preview(long({ qty: '0.1' }), ctx);
    expect(p.rejectReason).toBe('Insufficient margin: need 404.606, available 300');
    expect(s(p.marginRequired)).toBe('404.606');
    expect(s(p.estAvgPrice)).toBe('80000');
  });

  it('rejects at arrival when the price moved and the cost exceeds lock plus free', () => {
    const { market, ctx, engine, lev } = setup('405');
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    market.setBook('BTCUSDT', { asks: [{ price: D('80100'), qty: D('1') }], bids: [] });
    // IM 400.6 + open loss 10 + fee 4.006
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe(
      'Insufficient margin at execution (need 414.606, available 405)',
    );
    expect(s(lev().free)).toBe('405');
    expect(s(lev().locked)).toBe('0');
    expect(engine.state.positions.BTCUSDT).toBeUndefined();
  });
});

describe('market price band', () => {
  it('rejects at arrival when the best price is already outside the band', () => {
    const { market, ctx, engine, lev } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    market.setBook('BTCUSDT', { asks: [{ price: D('84500.0'), qty: D('1') }], bids: [] });
    expect(rejectReason(arriveNow(engine, order, ctx))).toBe(
      'Best price 84500 is outside the market price band (mark 80000 ± 5%)',
    );
    expect(s(lev().free)).toBe('1000');
    expect(s(lev().locked)).toBe('0');
  });

  it('fills within the band and cancels the rest with reason price_band', () => {
    const { market, ctx, engine, lev, position } = setup();
    market.setBook('BTCUSDT', {
      asks: [
        { price: D('80000.0'), qty: D('0.05') },
        { price: D('84500.0'), qty: D('1') },
      ],
      bids: [],
    });
    const p = engine.preview(long({ qty: '0.1' }), ctx);
    expect(p.bandLimited).toBe(true);
    expect(p.exhausted).toBe(true);
    expect(s(p.estAvgPrice)).toBe('80000');
    const events = execute(engine, long({ qty: '0.1' }), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'position_opened', 'order_cancelled']);
    expect(s(find(events, 'fill').fill.qty)).toBe('0.05');
    expect(find(events, 'fill').order.status).toBe('partially_filled');
    const c = find(events, 'order_cancelled');
    expect(c.reason).toBe('price_band');
    expect(s(c.cancelledQty)).toBe('0.05');
    expect(c.order.status).toBe('cancelled');
    expect(s(position()!.qty)).toBe('0.05');
    expect(s(position()!.margin)).toBe('198'); // 200 − fee 2
    expect(s(lev().free)).toBe('800');
    expect(s(lev().locked)).toBe('0');
  });

  it('a sell is bounded below the mark', () => {
    const { market, ctx, engine } = setup();
    market.setBook('BTCUSDT', {
      asks: [],
      bids: [
        { price: D('76000'), qty: D('0.05') },
        { price: D('75999.9'), qty: D('1') },
      ],
    });
    const events = execute(engine, short({ qty: '0.1' }), ctx);
    expect(s(find(events, 'fill').fill.qty)).toBe('0.05');
    expect(find(events, 'order_cancelled').reason).toBe('price_band');
  });

  it('a book that runs out inside the band cancels the rest with reason thin_book', () => {
    const { market, ctx, engine } = setup();
    market.setBook('BTCUSDT', { asks: [{ price: D('80000'), qty: D('0.05') }], bids: [] });
    const p = engine.preview(long({ qty: '0.1' }), ctx);
    expect(p.exhausted).toBe(true);
    expect(p.bandLimited).toBe(false);
    const events = execute(engine, long({ qty: '0.1' }), ctx);
    const c = find(events, 'order_cancelled');
    expect(c.reason).toBe('thin_book');
    expect(s(c.cancelledQty)).toBe('0.05');
  });

  it('an empty book at arrival cancels the order and releases the lock', () => {
    const { market, ctx, engine, lev } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    market.setBook('BTCUSDT', { asks: [], bids: [] });
    const events = arriveNow(engine, order, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
    const c = find(events, 'order_cancelled');
    expect(c.reason).toBe('thin_book');
    expect(s(c.cancelledQty)).toBe('0.1');
    expect(s(lev().free)).toBe('1000');
    expect(s(lev().locked)).toBe('0');
  });

  it('at submit, a best price outside the band or an empty book is refused', () => {
    const { market, ctx, engine } = setup();
    market.setBook('BTCUSDT', { asks: [{ price: D('84500.0'), qty: D('1') }], bids: [] });
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
      'Best price 84500 is outside the market price band (mark 80000 ± 5%)',
    );
    market.setBook('BTCUSDT', { asks: [], bids: [] });
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe('Order book empty for BTCUSDT');
  });

  it('uses the live rules’ band', () => {
    const { market, ctx, engine } = setup();
    market.setRules('BTCUSDT', { ...market.rules('BTCUSDT'), marketTakeBound: D('0.03') });
    market.setBook('BTCUSDT', { asks: [{ price: D('82500'), qty: D('1') }], bids: [] });
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
      'Best price 82500 is outside the market price band (mark 80000 ± 3%)',
    );
  });
});

describe('exchange filters', () => {
  it('MIN_NOTIONAL at the mark price; reduce-only orders are exempt', () => {
    const { market, ctx, engine } = setup();
    market.setMarkPrice('BTCUSDT', D('40000'));
    expect(rejectReason(engine.submit(long({ qty: '0.001' }), ctx))).toBe(
      'MIN_NOTIONAL: order value 40 is below the minimum 50',
    );
    market.setMarkPrice('BTCUSDT', D('80000'));
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('40000'));
    placed(engine.submit(short({ qty: '0.001', reduceOnly: true }), ctx));
  });

  it('MARKET_LOT_SIZE', () => {
    const { ctx, engine } = setup();
    expect(rejectReason(engine.submit(long({ qty: '0.0015' }), ctx))).toBe(
      'MARKET_LOT_SIZE: quantity 0.0015 is not a multiple of step size 0.001',
    );
  });

  it('a missing or non-positive mark price is never guessed', () => {
    const { market, ctx, engine } = setup();
    market.setMarkPrice('BTCUSDT', null);
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
      'Mark price unavailable; order rejected (never guessed)',
    );
    market.setMarkPrice('BTCUSDT', D(0));
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe(
      'Mark price unavailable; order rejected (never guessed)',
    );
  });

  it('MAX_NUM_ORDERS counts live orders on the symbol', () => {
    const { market, ctx, engine } = setup('100000');
    market.setRules('BTCUSDT', { ...market.rules('BTCUSDT'), maxNumOrders: 2 });
    placed(engine.submit(long({ qty: '0.01' }), ctx));
    placed(engine.submit(long({ qty: '0.01' }), ctx));
    expect(rejectReason(engine.submit(long({ qty: '0.01' }), ctx))).toBe(
      'MAX_NUM_ORDERS: already 2 open orders on BTCUSDT (maximum 2)',
    );
  });
});

describe('amounts', () => {
  it('needs exactly one of a coin amount and a dollar amount', () => {
    const { ctx, engine } = setup();
    expect(rejectReason(engine.submit(long({}), ctx))).toBe('Enter either a coin amount or a dollar amount');
    expect(rejectReason(engine.submit(long({ qty: '0.1', quoteQty: '8000' }), ctx))).toBe(
      'Enter either a coin amount or a dollar amount',
    );
    expect(rejectReason(engine.submit(long({ qty: 'abc' }), ctx))).toMatch(/^Invalid amount "abc"/);
  });

  it('accepts a decimal comma', () => {
    const { ctx, engine } = setup();
    expect(s(placed(engine.submit(long({ qty: '0,1' }), ctx)).qty)).toBe('0.1');
  });

  it('a USDT notional converts to a quantity at the mark price, floored to the step', () => {
    const { ctx, engine } = setup();
    const order = placed(engine.submit(long({ quoteQty: '8079.99' }), ctx));
    expect(s(order.qty)).toBe('0.1');
    expect(s(order.quoteQty)).toBe('8079.99');
    expect(s(order.lockAmount)).toBe('404.606');
  });

  it('a USDT notional below one step is refused', () => {
    const { ctx, engine } = setup();
    expect(rejectReason(engine.submit(long({ quoteQty: '79' }), ctx))).toBe(
      'Amount too small: 79 USDT does not reach one step of 0.001 BTC',
    );
  });

  it('unknown order types are rejected', () => {
    const { ctx, engine } = setup();
    const req = { ...long({ qty: '0.1' }), type: 'iceberg' } as unknown as PerpOrderRequest;
    expect(rejectReason(engine.submit(req, ctx))).toBe('Unknown order type');
  });
});

describe('live data', () => {
  it('stale book or stale mark at submit → rejected, nothing locked', () => {
    const { market, ctx, engine, lev } = setup();
    market.setFresh('BTCUSDT', false);
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(engine.preview(long({ qty: '0.1' }), ctx).rejectReason).toBe('Live data interrupted for BTCUSDT');
    market.setFresh('BTCUSDT', true);
    market.setMarkFresh('BTCUSDT', false);
    expect(rejectReason(engine.submit(long({ qty: '0.1' }), ctx))).toBe('Live data interrupted for BTCUSDT');
    expect(s(lev().free)).toBe('1000');
    expect(s(lev().locked)).toBe('0');
  });

  it('stale book or stale mark at arrival → rejected, lock released', () => {
    for (const stale of ['book', 'mark'] as const) {
      const { market, ctx, engine, lev } = setup();
      const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
      if (stale === 'book') market.setFresh('BTCUSDT', false);
      else market.setMarkFresh('BTCUSDT', false);
      expect(rejectReason(arriveNow(engine, order, ctx))).toBe('Live data interrupted for BTCUSDT');
      expect(s(lev().free)).toBe('1000');
      expect(s(lev().locked)).toBe('0');
    }
  });
});

describe('hasDeferredWork', () => {
  it('a market order never waits for fresh data: it arrives on its own timer', () => {
    const { market, ctx, engine } = setup();
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    ctx.now = order.arrivesAt! + 10_000;
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    market.setFresh('BTCUSDT', false);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
    market.setFresh('BTCUSDT', true);
    engine.arrive(order.id, ctx);
    expect(engine.hasDeferredWork('BTCUSDT', ctx)).toBe(false);
  });
});

describe('perp state', () => {
  it('every order change is marked dirty; takeDirty clears the set', () => {
    const { ctx, engine } = setup();
    const order = placed(engine.submit(long({ qty: '0.1' }), ctx));
    expect(takeDirty(engine.state)).toEqual([order.id]);
    expect(takeDirty(engine.state)).toEqual([]);
    arriveNow(engine, order, ctx);
    expect(takeDirty(engine.state)).toEqual([order.id]);
  });

  it('evictTerminal drops finished orders but keeps one whose cancel is in flight', () => {
    const { ctx, engine } = setup();
    openLong(engine, ctx);
    const pending = placed(engine.submit(long({ qty: '0.01' }), ctx));
    const rejected = engine.submit(long({ qty: '100' }), ctx)[0]!;
    if (rejected.type !== 'order_rejected') throw new Error('expected order_rejected');
    putOrder(engine.state, { ...rejected.order, id: 'late', cancelArrivesAt: ctx.now + 100 });
    evictTerminal(engine.state);
    expect([...engine.state.orders.keys()].sort()).toEqual(['late', pending.id].sort());
  });

  it('restart: a market order still in flight is rejected and its lock released; any other order is left as it is', () => {
    const { ctx, engine, lev } = setup();
    const market = placed(engine.submit(long({ qty: '0.1' }), ctx));
    const limit = placed(engine.submit(long({ type: 'limit', price: '79000', qty: '0.01' }), ctx));
    const lockedBefore = lev().locked;
    expect(engine.rejectRestartedMarket(limit.id, ctx)).toEqual([]);
    const events = engine.rejectRestartedMarket(market.id, ctx);
    expect(rejectReason(events)).toBe('Server restarted before execution');
    expect(engine.state.orders.get(market.id)!.status).toBe('rejected');
    expect(s(lev().locked)).toBe(s(lockedBefore.minus(market.lockAmount)));
    expect(s(lev().locked)).toBe(s(limit.lockAmount));
    expect(engine.rejectRestartedMarket(market.id, ctx)).toEqual([]);
    expect(engine.rejectRestartedMarket('unknown', ctx)).toEqual([]);
  });

  it('starts with empty positions, settings, cursors and funding', () => {
    const state = emptyPerpState(emptyLedger(['USDT']));
    expect(state.positions).toEqual({});
    expect(state.settings).toEqual({});
    expect(state.lastTradeId).toEqual({});
    expect(state.funding).toEqual({ windows: {}, pending: [], applied: {} });
    expect(state.orders.size).toBe(0);
    expect(state.dirty.size).toBe(0);
  });
});
