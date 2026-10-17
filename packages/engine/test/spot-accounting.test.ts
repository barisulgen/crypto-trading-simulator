import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { applyBuyToBasis, applySellToBasis, emptyBasis, valueAccount } from '../src/spot/accounting.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import type { AggTrade, Basis, EngineCtx, EngineEvent, Fill, MarketView, SpotOrder } from '../src/types.ts';
import { FakeMarket, testCtx } from './fixtures.ts';

const NOW = 1_000_000;
const MIN_NOTIONAL = D('5');
const s = (d: Decimal | null | undefined) => (d == null ? null : d.toString());

describe('average-cost basis (pure)', () => {
  const ids = () => {
    let n = 0;
    return () => `rt${++n}`;
  };

  it('buy 1 @ 100 taker → 0.999 BTC for 100 USDT, round trip opened', () => {
    const b = applyBuyToBasis(emptyBasis(), D('0.999'), D('100'), NOW, ids());
    expect(s(b.qty)).toBe('0.999');
    expect(s(b.cost)).toBe('100');
    expect(b.roundTripId).toBe('rt1');
    expect(b.openedAt).toBe(NOW);
    expect(s(b.tripRealized)).toBe('0');
  });

  it('sell 0.5 @ 110 then 0.499 @ 90: realised at average cost, trip closes flat', () => {
    const newId = ids();
    const bought = applyBuyToBasis(emptyBasis(), D('0.999'), D('100'), NOW, newId);

    // 55 − 0.055 fee = 54.945 net; 0.499 left is worth 54.89 at 110.
    const first = applySellToBasis(bought, D('0.5'), D('54.945'), D('54.89'), MIN_NOTIONAL, NOW + 1, 'BTCUSDT');
    expect(first.realized.toFixed(8)).toBe('4.89494995');
    expect(first.basis.cost.toFixed(8)).toBe('49.94994995');
    expect(s(first.basis.qty)).toBe('0.499');
    expect(first.closed).toBeNull();
    expect(first.basis.roundTripId).toBe('rt1');

    // 44.91 − 0.04491 fee = 44.86509 net; nothing left.
    const second = applySellToBasis(first.basis, D('0.499'), D('44.86509'), D('0'), MIN_NOTIONAL, NOW + 2, 'BTCUSDT');
    expect(second.realized.toFixed(8)).toBe('-5.08485995');
    expect(second.closed).not.toBeNull();
    // Exactly −0.18991 at full precision (toFixed(8) would print '-0.18991000').
    expect(s(second.closed!.pnl)).toBe('-0.18991');
    expect({ ...second.closed!, pnl: null }).toEqual({
      id: 'rt1',
      symbol: 'BTCUSDT',
      openedAt: NOW,
      closedAt: NOW + 2,
      pnl: null,
    });
    expect(s(second.basis.qty)).toBe('0');
    expect(s(second.basis.cost)).toBe('0');
    expect(second.basis.roundTripId).toBeNull();
    expect(second.basis.openedAt).toBeNull();
    expect(s(second.basis.tripRealized)).toBe('0');
  });

  it('dust: 0.00004 BTC left after a sell at 100 (worth 0.004 < 5) closes the trip; dust carries over', () => {
    const newId = ids();
    const bought = applyBuyToBasis(emptyBasis(), D('0.10004'), D('10.004'), NOW, newId);
    // 10 − 0.01 fee = 9.99 net; 0.00004 × 100 = 0.004 left.
    const sold = applySellToBasis(bought, D('0.1'), D('9.99'), D('0.004'), MIN_NOTIONAL, NOW + 1, 'BTCUSDT');
    expect(s(sold.realized)).toBe('-0.01');
    expect(sold.closed?.id).toBe('rt1');
    expect(s(sold.closed?.pnl)).toBe('-0.01');
    expect(s(sold.basis.qty)).toBe('0.00004');
    expect(s(sold.basis.cost)).toBe('0.004');
    expect(sold.basis.roundTripId).toBeNull();

    // The next buy opens a new trip whose cost includes the dust.
    const again = applyBuyToBasis(sold.basis, D('0.999'), D('100'), NOW + 2, newId);
    expect(again.roundTripId).toBe('rt2');
    expect(again.openedAt).toBe(NOW + 2);
    expect(s(again.qty)).toBe('0.99904');
    expect(s(again.cost)).toBe('100.004');
    const out = applySellToBasis(again, D('0.99904'), D('109.7845056'), D('0'), MIN_NOTIONAL, NOW + 3, 'BTCUSDT');
    expect(s(out.realized)).toBe('9.7805056');
    expect(out.closed?.id).toBe('rt2');
    expect(s(out.closed?.pnl)).toBe('9.7805056');
  });

  it('a second buy inside an open trip averages the cost and keeps the trip', () => {
    const newId = ids();
    const b1 = applyBuyToBasis(emptyBasis(), D('1'), D('100'), NOW, newId);
    const b2 = applyBuyToBasis(b1, D('1'), D('120'), NOW + 1, newId);
    expect(b2.roundTripId).toBe('rt1');
    expect(b2.openedAt).toBe(NOW);
    expect(s(b2.qty)).toBe('2');
    expect(s(b2.cost)).toBe('220');
    const sold = applySellToBasis(b2, D('1'), D('115'), D('115'), MIN_NOTIONAL, NOW + 2, 'BTCUSDT');
    expect(s(sold.realized)).toBe('5'); // 115 − 220 × 1/2
    expect(s(sold.basis.tripRealized)).toBe('5');
  });

  it('selling more than the basis holds is an invariant breach and throws', () => {
    const b: Basis = applyBuyToBasis(emptyBasis(), D('1'), D('100'), NOW, () => 'rt1');
    expect(() => applySellToBasis(b, D('1.5'), D('150'), D('0'), MIN_NOTIONAL, NOW, 'BTCUSDT')).toThrow(
      'BTCUSDT: cannot sell 1.5 against a cost basis of 1',
    );
  });
});

// ---- engine integration ----

let tradeId = 0;
function trade(price: string, qty = '1', sellerInitiated = true): AggTrade {
  tradeId += 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

function setup() {
  const market = new FakeMarket();
  const ctx = testCtx(market, { now: NOW });
  const engine = new SpotEngine(emptySpotState(['USDT', 'BTC']));
  engine.deposit('spot', D('1000'), ctx);
  return { market, ctx, engine };
}

function placedOrder(events: EngineEvent[]): SpotOrder {
  const e = events.find((x) => x.type === 'order_placed');
  if (!e || e.type !== 'order_placed') throw new Error(`no order_placed in ${events.map((x) => x.type).join(', ')}`);
  return e.order;
}

function arriveNow(engine: SpotEngine, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

const fills = (events: EngineEvent[]): Fill[] => events.flatMap((e) => (e.type === 'fill' ? [e.fill] : []));

/** Spot holdings of BTC (free + locked); the basis quantity must always equal it. */
function holdings(engine: SpotEngine): Decimal {
  const b = engine.state.balances.spot.BTC!;
  return b.free.plus(b.locked);
}

function marketBuy12(engine: SpotEngine, ctx: EngineCtx): EngineEvent[] {
  const order = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1.2' }, ctx));
  return arriveNow(engine, order, ctx);
}

function bestBidOf(market: MarketView) {
  return (symbol: string) => {
    const bid = market.book(symbol).bids[0];
    return bid ? { price: bid.price, fresh: market.isFresh(symbol) } : null;
  };
}

describe('accounting on engine fills', () => {
  it('market buy 1.2 on sampleBook → basis 1.1988 BTC for 120.07; buys carry no realised P&L', () => {
    const { ctx, engine } = setup();
    const events = marketBuy12(engine, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    const [fill] = fills(events) as [Fill];
    expect(fill.realizedPnl).toBeNull();
    expect(fill.roundTripId).toBe('rt1');
    const basis = engine.state.basis.BTC!;
    expect(s(basis.qty)).toBe('1.1988');
    expect(s(basis.cost)).toBe('120.07');
    expect(basis.roundTripId).toBe('rt1');
    expect(basis.openedAt).toBe(ctx.now);
    expect(s(basis.qty)).toBe(s(holdings(engine)));
  });

  it('market, limit (maker) and stop sells carry realised P&L and the trip id; the last closes the trip', () => {
    const { ctx, engine } = setup();
    marketBuy12(engine, ctx);

    // Market sell 0.5: 0.4 @ 99.90 + 0.1 @ 99.80 = 49.94, fee 0.04994.
    const order = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.5' }, ctx));
    const [m] = fills(arriveNow(engine, order, ctx)) as [Fill];
    expect(m.realizedPnl!.toFixed(8)).toBe('-0.18918591');
    expect(m.roundTripId).toBe('rt1');
    expect(s(engine.state.basis.BTC!.qty)).toBe('0.6988');

    // Limit sell 0.3 @ 101 rests, then fills as a maker on a trade through 101.
    const lim = placedOrder(
      engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', price: '101', qty: '0.3' }, ctx),
    );
    expect(arriveNow(engine, lim, ctx)).toEqual([]);
    const limitEvents = engine.onTrade('BTCUSDT', trade('101.01', '1', false), ctx);
    expect(limitEvents.map((e) => e.type)).toEqual(['fill']);
    const [l] = fills(limitEvents) as [Fill];
    expect(l.liquidity).toBe('maker');
    expect(l.realizedPnl!.toFixed(8)).toBe('0.22215245');
    expect(l.roundTripId).toBe('rt1');
    expect(s(engine.state.basis.BTC!.qty)).toBe(s(holdings(engine)));

    // Stop-loss for the remaining 0.3988 triggers at 99 and fills 0.3988 @ 99.90.
    const stop = placedOrder(
      engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'stop_loss', triggerPrice: '99', qty: '0.3988' }, ctx),
    );
    arriveNow(engine, stop, ctx);
    const trig = engine.onTrade('BTCUSDT', trade('99'), ctx);
    expect(trig.map((e) => e.type)).toEqual(['order_triggered']);
    const triggered = engine.state.orders.get(stop.id)!;
    const closing = arriveNow(engine, triggered, ctx);
    expect(closing.map((e) => e.type)).toEqual(['fill', 'round_trip_closed']);
    const [st] = fills(closing) as [Fill];
    expect(st.realizedPnl!.toFixed(8)).toBe('-0.14292666');
    expect(st.roundTripId).toBe('rt1');

    const closed = closing[1]!;
    if (closed.type !== 'round_trip_closed') throw new Error('expected round_trip_closed');
    expect(closed.roundTrip.id).toBe('rt1');
    expect(closed.roundTrip.symbol).toBe('BTCUSDT');
    expect(closed.roundTrip.openedAt).toBe(NOW + 100);
    expect(closed.roundTrip.closedAt).toBe(ctx.now);
    expect(closed.time).toBe(ctx.now);
    // The trip's result is the sum of its sells: total net proceeds 119.96003988 − cost 120.07.
    expect(closed.roundTrip.pnl.toFixed(8)).toBe('-0.10996012');
    expect(s(closed.roundTrip.pnl)).toBe(s(m.realizedPnl!.plus(l.realizedPnl!).plus(st.realizedPnl!)));

    const basis = engine.state.basis.BTC!;
    expect(s(basis.qty)).toBe('0');
    expect(s(basis.cost)).toBe('0');
    expect(basis.roundTripId).toBeNull();

    // The next buy starts a new trip.
    const [next] = fills(marketBuy12(engine, ctx)) as [Fill];
    expect(next.roundTripId).toBe('rt2');
  });
});

describe('accounting on engine fills: dust and invariant', () => {
  it('a sell leaving 0.00004 BTC closes the trip; the dust stays in the basis and joins the next trip', () => {
    const { ctx, engine } = setup();
    const buy = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' }, ctx));
    arriveNow(engine, buy, ctx); // 0.5 @ 100 + 0.5 @ 100.10 = 100.05 for a net 0.999 BTC
    expect(s(engine.state.basis.BTC!.cost)).toBe('100.05');

    const sell = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.99896' }, ctx));
    const events = arriveNow(engine, sell, ctx);
    expect(events.map((e) => e.type)).toEqual(['fill', 'round_trip_closed']);
    const closed = events[1]!;
    if (closed.type !== 'round_trip_closed') throw new Error('expected round_trip_closed');
    expect(closed.roundTrip.id).toBe('rt1');
    expect(s(closed.roundTrip.pnl)).toBe(s(fills(events)[0]!.realizedPnl));

    const dust = engine.state.basis.BTC!;
    expect(s(dust.qty)).toBe('0.00004');
    expect(s(holdings(engine))).toBe('0.00004');
    expect(dust.cost.toFixed(8)).toBe('0.00400601'); // 100.05 × 0.00004 / 0.999
    expect(dust.roundTripId).toBeNull();

    const again = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' }, ctx));
    const [f] = fills(arriveNow(engine, again, ctx)) as [Fill];
    expect(f.roundTripId).toBe('rt2');
    const next = engine.state.basis.BTC!;
    expect(next.roundTripId).toBe('rt2');
    expect(s(next.qty)).toBe('0.99904');
    expect(s(next.cost)).toBe(s(dust.cost.plus('100.05')));
  });

  it('a sell with no cost basis behind it throws before any balance or order changes', () => {
    const { ctx, engine } = setup();
    engine.state.balances.spot.BTC!.free = D('2'); // coins that never came through a buy
    const sell = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.5' }, ctx));
    const before = JSON.stringify([engine.state.balances, [...engine.state.orders.values()]]);
    expect(() => arriveNow(engine, sell, ctx)).toThrow('BTCUSDT: cannot sell 0.5 against a cost basis of 0');
    expect(JSON.stringify([engine.state.balances, [...engine.state.orders.values()]])).toBe(before);

    // Same for a maker fill of a resting limit sell.
    const lim = placedOrder(
      engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', price: '101', qty: '0.5' }, ctx),
    );
    arriveNow(engine, lim, ctx);
    const beforeMaker = JSON.stringify([engine.state.balances, [...engine.state.orders.values()]]);
    expect(() => engine.onTrade('BTCUSDT', trade('101.01', '1', false), ctx)).toThrow('cannot sell 0.5');
    expect(JSON.stringify([engine.state.balances, [...engine.state.orders.values()]])).toBe(beforeMaker);
  });
});

describe('valueAccount', () => {
  it('USDT 879.93, BTC 1.1988 at bid 99.90 → total 999.69012, net P&L −0.30988 on 1000 deposited', () => {
    const { market, ctx, engine } = setup();
    marketBuy12(engine, ctx);
    const v = valueAccount(engine.state, bestBidOf(market), ['BTCUSDT']);
    expect(s(v.spotUsdtFree)).toBe('879.93');
    expect(s(v.spotUsdtLocked)).toBe('0');
    expect(s(v.leverageUsdt)).toBe('0');
    expect(v.coins).toHaveLength(1);
    const [c] = v.coins as [(typeof v.coins)[number]];
    expect([c.asset, s(c.qty), s(c.bid), s(c.value), c.fresh]).toEqual(['BTC', '1.1988', '99.9', '119.76012', true]);
    expect(s(v.total)).toBe('999.69012');
    expect(s(v.totalDeposited)).toBe('1000');
    expect(s(v.netPnl)).toBe('-0.30988');
    expect(s(v.netPnlPct)).toBe('-0.030988');
  });

  it('locked funds and the leverage wallet count; a transfer is not P&L', () => {
    const { market, ctx, engine } = setup();
    marketBuy12(engine, ctx);
    engine.transfer('spot', 'leverage', D('100'), ctx);
    // A resting sell locks 0.5 BTC; a resting buy locks 90 USDT.
    engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', price: '105', qty: '0.5' }, ctx);
    engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: '90', qty: '1' }, ctx);
    const v = valueAccount(engine.state, bestBidOf(market), ['BTCUSDT']);
    expect(s(v.spotUsdtFree)).toBe('689.93');
    expect(s(v.spotUsdtLocked)).toBe('90');
    expect(s(v.leverageUsdt)).toBe('100');
    expect(s(v.coins[0]!.qty)).toBe('1.1988');
    expect(s(v.total)).toBe('999.69012');
    expect(s(v.netPnl)).toBe('-0.30988');
  });

  it('a stale bid is used but flagged; a missing bid values the coin at 0 (never invented)', () => {
    const { market, ctx, engine } = setup();
    marketBuy12(engine, ctx);
    market.setFresh('BTCUSDT', false);
    const stale = valueAccount(engine.state, bestBidOf(market), ['BTCUSDT']);
    expect([s(stale.coins[0]!.value), stale.coins[0]!.fresh]).toEqual(['119.76012', false]);

    const none = valueAccount(engine.state, () => null, ['BTCUSDT']);
    expect([s(none.coins[0]!.bid), s(none.coins[0]!.value), none.coins[0]!.fresh]).toEqual(['0', '0', false]);
    expect(s(none.total)).toBe('879.93');
  });

  it('coins with a zero balance are left out and the rest follow the symbol order', () => {
    const state = emptySpotState(['USDT', 'BTC', 'ETH', 'SOL']);
    state.balances.spot.SOL!.free = D('2');
    state.balances.spot.BTC!.locked = D('0.1');
    const bid = (symbol: string) => ({ price: D(symbol === 'BTCUSDT' ? '100' : '10'), fresh: true });
    const v = valueAccount(state, bid, ['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(v.coins.map((c) => [c.asset, s(c.value)])).toEqual([
      ['SOL', '20'],
      ['BTC', '10'],
    ]);
  });

  it('nothing deposited → net P&L % is null', () => {
    const v = valueAccount(emptySpotState(['USDT', 'BTC']), () => null, ['BTCUSDT']);
    expect(s(v.total)).toBe('0');
    expect(s(v.netPnl)).toBe('0');
    expect(v.netPnlPct).toBeNull();
  });
});
