import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import type { PerpOrderRequest } from '../src/perp/types.ts';
import { ctxFor, SimEngine } from '../src/sim.ts';
import type { SimCtx } from '../src/sim.ts';
import { valueAccount } from '../src/spot/accounting.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import type { SpotOrderRequest } from '../src/types.ts';
import { FakeMarket, testCtx } from './fixtures.ts';
import { FakePerpMarket } from './perpFixtures.ts';

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

function newSim() {
  const ledger = emptyLedger(['USDT', 'BTC']);
  return new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));
}

function setup() {
  const spotMarket = new FakeMarket();
  const perpMarket = new FakePerpMarket();
  const { rng, newId } = testCtx(spotMarket, { now: 1_000_000 });
  const ctx: SimCtx = {
    now: 1_000_000,
    rng,
    newId,
    spotMarket,
    perpMarket,
    fees: { spot: { maker: D('0.001'), taker: D('0.001') }, perp: { maker: D('0.0002'), taker: D('0.0005') } },
  };
  return { spotMarket, perpMarket, ctx, sim: newSim() };
}

const btcLong = (qty: string): PerpOrderRequest => ({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty });

/** Submit to the market's engine and arrive at the order's arrival time; returns the order id. */
function execute(sim: SimEngine, ctx: SimCtx, ...order: ['spot', SpotOrderRequest] | ['perp', PerpOrderRequest]) {
  const placed = order[0] === 'spot' ? sim.submit('spot', order[1], ctx) : sim.submit('perp', order[1], ctx);
  const e = placed[0];
  if (placed.length !== 1 || e?.type !== 'order_placed') throw new Error('expected one order_placed');
  ctx.now = Math.max(ctx.now, e.order.arrivesAt!);
  sim.arrive(order[0], e.order.id, ctx);
  return e.order.id;
}

/**
 * Spot USDT 500 and a BTC long 0.1 @80000 with margin 396 (400 less the 4 USDT taker fee) and 600
 * free in the leverage wallet.
 */
function withLong() {
  const t = setup();
  expect(t.sim.deposit('spot', D('1500'), t.ctx, D('100')).ok).toBe(true);
  expect(t.sim.transfer('spot', 'leverage', D('1000'), t.ctx).ok).toBe(true);
  execute(t.sim, t.ctx, 'perp', btcLong('0.1'));
  return t;
}

const markAt = (price: string, fresh = true, at = 7000) => ({ mark: () => ({ price: D(price), fresh, at }) });

describe('SimEngine', () => {
  it('needs one ledger shared by both engines', () => {
    const ledger = emptyLedger(['USDT', 'BTC']);
    const other = emptyLedger(['USDT', 'BTC']);
    const spot = new SpotEngine(emptySpotState(ledger));
    const perp = new PerpEngine(emptyPerpState(ledger));
    expect(() => new SimEngine(ledger, new SpotEngine(emptySpotState(other)), perp)).toThrow(/one ledger/);
    expect(() => new SimEngine(ledger, spot, new PerpEngine(emptyPerpState(other)))).toThrow(/one ledger/);
    expect(() => new SimEngine(other, spot, perp)).toThrow(/one ledger/);
    expect(new SimEngine(ledger, spot, perp).perp).toBe(perp);
  });

  it('ctxFor gives each engine its own market and fees', () => {
    const { ctx, spotMarket, perpMarket } = setup();
    const spot = ctxFor(ctx, 'spot');
    const perp = ctxFor(ctx, 'perp');
    expect(spot.market).toBe(spotMarket);
    expect(perp.market).toBe(perpMarket);
    expect(s(spot.fees.taker)).toBe('0.001');
    expect(s(perp.fees.taker)).toBe('0.0005');
    expect([spot.now, perp.now]).toEqual([ctx.now, ctx.now]);
    expect(spot.newId('x')).not.toBe(perp.newId('x'));
  });

  it('dispatches orders to the engine of their market', () => {
    const { ctx, sim } = setup();
    sim.deposit('spot', D('1500'), ctx, D('100'));
    sim.transfer('spot', 'leverage', D('1000'), ctx);

    execute(sim, ctx, 'spot', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
    expect(s(sim.ledger.balances.spot.BTC!.free)).toBe('0.999');
    expect(sim.perp.state.positions).toEqual({});

    execute(sim, ctx, 'perp', btcLong('0.1'));
    const p = sim.perp.state.positions.BTCUSDT!;
    expect([p.side, s(p.qty), s(p.entryPrice), s(p.margin)]).toEqual(['long', '0.1', '80000', '396']);
    expect(s(sim.ledger.balances.leverage.USDT!.free)).toBe('600');

    expect(sim.preview('perp', btcLong('0.1'), ctx).leverage).toBe(20);
    expect(sim.preview('spot', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' }, ctx).rejectReason).toBeNull();
  });

  it('cancels on the engine of the market', () => {
    const { ctx, sim } = setup();
    sim.deposit('spot', D('1500'), ctx, D('100'));
    sim.transfer('spot', 'leverage', D('1000'), ctx);
    const id = execute(sim, ctx, 'perp', { symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: '79000', qty: '0.1' });
    expect(sim.perp.state.orders.get(id)!.status).toBe('open');
    expect(sim.cancel('spot', id, ctx)).toEqual({ ok: false, reason: 'Order not found' });
    expect(sim.cancel('perp', id, ctx).ok).toBe(true);
    ctx.now = sim.perp.state.orders.get(id)!.cancelArrivesAt!;
    const events = sim.arriveCancel('perp', id, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
    expect(s(sim.ledger.balances.leverage.USDT!.locked)).toBe('0');
  });

  it('a transfer out of the leverage wallet moves free USDT only; margin never moves', () => {
    const { ctx, sim } = withLong();
    expect(sim.transfer('leverage', 'spot', D('700'), ctx)).toEqual({
      ok: false,
      reason: 'Insufficient free USDT in leverage wallet: need 700, available 600',
    });
    expect(s(sim.perp.state.positions.BTCUSDT!.margin)).toBe('396');
    expect(s(sim.ledger.balances.leverage.USDT!.free)).toBe('600');
    expect(s(sim.ledger.balances.spot.USDT!.free)).toBe('500');
  });
});

describe('valueAccount with positions', () => {
  it('spot 500 + a long 0.1 @80000 (margin 396) with 600 free, at mark 81000: leverage 1096, total 1596', () => {
    const { sim } = withLong();
    const v = valueAccount(sim, () => null, markAt('81000'), ['BTCUSDT']);
    expect(s(v.spotUsdtFree)).toBe('500');
    expect(s(v.leverage.free)).toBe('600');
    expect(s(v.leverage.locked)).toBe('0');
    expect(v.leverage.positions).toHaveLength(1);
    const [p] = v.leverage.positions as [(typeof v.leverage.positions)[number]];
    expect([p.symbol, p.side, s(p.qty), s(p.margin), s(p.markPrice), p.markFresh, p.markAt, s(p.unrealizedPnl)]).toEqual([
      'BTCUSDT',
      'long',
      '0.1',
      '396',
      '81000',
      true,
      7000,
      '100',
    ]);
    expect(s(v.leverage.value)).toBe('1096');
    expect(s(v.total)).toBe('1596');
    expect(s(v.totalDeposited)).toBe('1500');
    expect(s(v.netPnl)).toBe('96');
    expect(v.pricesLoading).toBe(false);
  });

  it('a short loses as the mark rises', () => {
    const t = setup();
    t.sim.deposit('spot', D('1000'), t.ctx, D('100'));
    t.sim.transfer('spot', 'leverage', D('1000'), t.ctx);
    execute(t.sim, t.ctx, 'perp', { ...btcLong('0.1'), side: 'sell' });
    const p = t.sim.perp.state.positions.BTCUSDT!;
    const v = valueAccount(t.sim, () => null, markAt('81000'), ['BTCUSDT']);
    const pos = v.leverage.positions[0]!;
    expect(pos.side).toBe('short');
    // Entry 79990 (the best bid): (79990 − 81000) × 0.1 = −101.
    expect(s(pos.unrealizedPnl)).toBe('-101');
    expect(s(v.leverage.value)).toBe(s(t.sim.ledger.balances.leverage.USDT!.free.plus(p.margin).minus(101)));
  });

  it('leverage USDT locked by an open order counts, as it is still the owner’s', () => {
    const { ctx, sim } = withLong();
    sim.submit('perp', { symbol: 'BTCUSDT', side: 'sell', type: 'limit', price: '82000', qty: '0.1', reduceOnly: true }, ctx);
    sim.submit('perp', { symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: '79000', qty: '0.05' }, ctx);
    const lev = sim.ledger.balances.leverage.USDT!;
    expect(lev.locked.gt(0)).toBe(true);
    const v = valueAccount(sim, () => null, markAt('81000'), ['BTCUSDT']);
    expect(s(v.leverage.locked)).toBe(s(lev.locked));
    expect(s(v.leverage.value)).toBe('1096');
    expect(s(v.total)).toBe('1596');
  });

  it('a stale mark: the position is valued at the last mark and flagged', () => {
    const { sim } = withLong();
    const v = valueAccount(sim, () => null, markAt('81000', false, 6000), ['BTCUSDT']);
    const p = v.leverage.positions[0]!;
    expect([s(p.markPrice), p.markFresh, p.markAt, s(p.unrealizedPnl)]).toEqual(['81000', false, 6000, '100']);
    expect(s(v.total)).toBe('1596');
    expect(v.pricesLoading).toBe(false);
    // The account-level signal: total value and net P&L are not live while a position's mark is stale.
    expect(v.marksPaused).toEqual(['BTCUSDT']);
    expect(valueAccount(sim, () => null, markAt('81000'), ['BTCUSDT']).marksPaused).toEqual([]);
  });

  it('never priced: the position counts as its margin only and prices are loading', () => {
    const { sim } = withLong();
    const v = valueAccount(sim, () => null, { mark: () => null }, ['BTCUSDT']);
    const p = v.leverage.positions[0]!;
    expect([p.markPrice, p.markFresh, p.markAt, p.unrealizedPnl]).toEqual([null, false, null, null]);
    expect(s(v.leverage.value)).toBe('996');
    expect(s(v.total)).toBe('1496');
    expect(v.pricesLoading).toBe(true);
    expect(v.marksPaused).toEqual(['BTCUSDT']);
  });

  it('a held coin never priced sets pricesLoading; one priced earlier and now stale does not', () => {
    const { ctx, sim } = setup();
    sim.deposit('spot', D('1000'), ctx, D('100'));
    execute(sim, ctx, 'spot', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
    const none = { mark: () => null };
    expect(valueAccount(sim, () => null, none, ['BTCUSDT']).pricesLoading).toBe(true);
    const stale = valueAccount(sim, () => ({ price: D('99.9'), fresh: false, at: 1 }), none, ['BTCUSDT']);
    expect(stale.pricesLoading).toBe(false);
    expect(stale.pricesPaused).toEqual(['BTC']);
  });

  it('with no positions the leverage value is its USDT', () => {
    const { ctx, sim } = setup();
    sim.deposit('leverage', D('250'), ctx, D('100'));
    const v = valueAccount(sim, () => null, { mark: () => null }, ['BTCUSDT']);
    expect(v.leverage.positions).toEqual([]);
    expect(s(v.leverage.value)).toBe('250');
    expect(s(v.leverageUsdt)).toBe('250');
    expect(s(v.total)).toBe('250');
    expect(v.pricesLoading).toBe(false);
  });
});
