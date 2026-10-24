import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { liquidationPrice } from '../src/perp/math.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import type { PerpCtx, PerpEvent, PerpOrderRequest } from '../src/perp/types.ts';
import type { AggTrade } from '../src/types.ts';
import { btcBrackets, FakePerpMarket, perpCtx } from './perpFixtures.ts';

const NOW = 1_000_000;
/** The funding time: its window runs from T − 15 s to T + 15 s. */
const T = NOW + 60_000;
const WINDOW = 15_000;

function setup(usdt = '1000') {
  const market = new FakePerpMarket();
  const ctx = perpCtx(market, { now: NOW });
  const ledger = emptyLedger(['USDT', 'BTC']);
  ledger.balances.leverage.USDT = { free: D(usdt), locked: D(0) };
  const engine = new PerpEngine(emptyPerpState(ledger));
  const lev = () => engine.state.ledger.balances.leverage.USDT!;
  const position = () => engine.state.positions.BTCUSDT;
  return { market, ctx, engine, lev, position };
}

const marketOrder = (side: 'buy' | 'sell', qty: string, more: Partial<PerpOrderRequest> = {}): PerpOrderRequest => ({
  symbol: 'BTCUSDT',
  side,
  type: 'market',
  qty,
  ...more,
});

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

/** Submit and arrive at the order's arrival time; the order must fill. */
function execute(engine: PerpEngine, r: PerpOrderRequest, ctx: PerpCtx): void {
  const placed = engine.submit(r, ctx);
  const e = placed[0];
  if (placed.length !== 1 || e?.type !== 'order_placed') throw new Error('expected one order_placed');
  ctx.now = Math.max(ctx.now, e.order.arrivesAt!);
  engine.arrive(e.order.id, ctx);
  if (engine.state.orders.get(e.order.id)!.status !== 'filled') throw new Error('expected the order to fill');
}

/** Run `fn` with the clock at `t`. */
function at(ctx: PerpCtx, t: number, fn: () => void = () => {}): void {
  ctx.now = t;
  fn();
}

function openWindow(engine: PerpEngine, ctx: PerpCtx): void {
  at(ctx, T - WINDOW, () => engine.openFundingWindow('BTCUSDT', T, ctx));
}

function closeWindow(engine: PerpEngine, ctx: PerpCtx): void {
  at(ctx, T + WINDOW, () => engine.closeFundingWindow('BTCUSDT', T, ctx));
}

/** The settlement is published a minute after the funding time. */
function settle(engine: PerpEngine, ctx: PerpCtx, rate: string, markPrice = '80000'): PerpEvent[] {
  ctx.now = T + 60_000;
  return engine.applyFunding('BTCUSDT', T, D(rate), D(markPrice), ctx);
}

function fundingOf(events: PerpEvent[]): Extract<PerpEvent, { type: 'funding' }> {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'funding') throw new Error(`expected funding, got ${e.type}`);
  return e;
}

describe('funding through the ±15 s window', () => {
  it('a long pays from its isolated margin: the liquidation price moves closer', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    expect(s(position()!.margin)).toBe('396');
    const id = position()!.id;
    openWindow(engine, ctx);
    closeWindow(engine, ctx);
    expect(engine.state.funding.windows).toEqual({});
    expect(engine.state.funding.pending).toHaveLength(1);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(f).toMatchObject({ market: 'perp', time: T + 60_000, symbol: 'BTCUSDT', positionId: id, fundingTime: T });
    expect(f.side).toBe('long');
    expect(s(f.rate)).toBe('0.0001');
    expect(s(f.markPrice)).toBe('80000');
    expect(s(f.qty)).toBe('0.1');
    expect(s(f.amount)).toBe('-0.8');
    expect(f.target).toBe('margin');
    expect(f.uncollected).toBeNull();

    const p = position()!;
    expect(s(p.margin)).toBe('395.2');
    expect(s(p.funding)).toBe('-0.8');
    expect(s(lev().free)).toBe('600');
    const liq = liquidationPrice(btcBrackets, p.side, p.qty, p.entryPrice, p.margin)!;
    expect(liq.toDecimalPlaces(8).toString()).toBe('76353.41365462');
    expect(engine.state.funding.pending).toEqual([]);
    expect(engine.state.funding.applied).toEqual({ BTCUSDT: [T] });
  });

  it('a short receives into free leverage USDT; its margin is untouched', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('sell', '0.1'), ctx);
    const margin = s(position()!.margin);
    const free = lev().free;
    openWindow(engine, ctx);
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(f.side).toBe('short');
    expect(s(f.amount)).toBe('0.8');
    expect(f.target).toBe('wallet');
    expect(s(lev().free)).toBe(s(free.plus('0.8')));
    expect(s(position()!.margin)).toBe(margin);
    expect(s(position()!.funding)).toBe('0.8');
  });

  it('a negative rate: the long receives', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '-0.00005'));
    expect(s(f.amount)).toBe('0.4');
    expect(f.target).toBe('wallet');
    expect(s(lev().free)).toBe('600.4');
    expect(s(position()!.margin)).toBe('396');
    expect(s(position()!.funding)).toBe('0.4');
  });

  it('a payer pays on the largest size held in the window', () => {
    const { ctx, engine, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    at(ctx, T + 5_000, () => execute(engine, marketOrder('buy', '0.1'), ctx));
    expect(s(position()!.qty)).toBe('0.2');
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(s(f.qty)).toBe('0.2');
    expect(s(f.amount)).toBe('-1.6');
  });

  it('a receiver receives on the smallest size held throughout the window', () => {
    const { ctx, engine, position } = setup();
    execute(engine, marketOrder('sell', '0.1'), ctx);
    openWindow(engine, ctx);
    at(ctx, T + 5_000, () => execute(engine, marketOrder('buy', '0.05', { reduceOnly: true }), ctx));
    expect(s(position()!.qty)).toBe('0.05');
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(s(f.qty)).toBe('0.05');
    expect(s(f.amount)).toBe('0.4');
  });

  it('a long closed inside the window still pays, from free leverage USDT', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    const id = position()!.id;
    openWindow(engine, ctx);
    at(ctx, T - 5_000, () => execute(engine, marketOrder('sell', '0.1', { reduceOnly: true }), ctx));
    expect(position()).toBeUndefined();
    closeWindow(engine, ctx);
    const free = lev().free;

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(f.positionId).toBe(id);
    expect(s(f.qty)).toBe('0.1');
    expect(s(f.amount)).toBe('-0.8');
    expect(f.target).toBe('wallet');
    expect(f.uncollected).toBeNull();
    expect(s(lev().free)).toBe(s(free.minus('0.8')));
  });

  it('a long liquidated inside the window still pays, from free leverage USDT', () => {
    const { market, ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    at(ctx, T - 5_000, () => {
      market.setMarkPrice('BTCUSDT', D('76340'));
      engine.onMark('BTCUSDT', D('76340'), ctx);
    });
    expect(position()).toBeUndefined();
    closeWindow(engine, ctx);
    const free = lev().free;

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(s(f.amount)).toBe('-0.8');
    expect(f.target).toBe('wallet');
    expect(s(lev().free)).toBe(s(free.minus('0.8')));
  });

  it('a long opened inside the window pays on it', () => {
    const { ctx, engine, position } = setup();
    openWindow(engine, ctx);
    at(ctx, T + 10_000, () => execute(engine, marketOrder('buy', '0.1'), ctx));
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(f.positionId).toBe(position()!.id);
    expect(s(f.amount)).toBe('-0.8');
    expect(f.target).toBe('margin');
    expect(s(position()!.margin)).toBe('395.2');
  });

  it('a short opened inside the window receives nothing', () => {
    const { ctx, engine, lev, position } = setup();
    openWindow(engine, ctx);
    at(ctx, T + 10_000, () => execute(engine, marketOrder('sell', '0.1'), ctx));
    closeWindow(engine, ctx);
    const free = s(lev().free);

    expect(settle(engine, ctx, '0.0001')).toEqual([]);
    expect(s(lev().free)).toBe(free);
    expect(s(position()!.funding)).toBe('0');
    expect(engine.state.funding.applied).toEqual({ BTCUSDT: [T] });
  });

  it('a settlement that comes while the window is still open uses what the window has seen', () => {
    const { ctx, engine } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    at(ctx, T + 5_000, () => execute(engine, marketOrder('buy', '0.1'), ctx));
    at(ctx, T + 6_000, () => execute(engine, marketOrder('sell', '0.15', { reduceOnly: true }), ctx));

    const f = fundingOf(engine.applyFunding('BTCUSDT', T, D('0.0001'), D('80000'), ctx));
    expect(s(f.qty)).toBe('0.2');
    expect(engine.state.funding.windows).toEqual({});
  });
});

describe('applyFunding', () => {
  it('is idempotent per (symbol, fundingTime)', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    closeWindow(engine, ctx);
    fundingOf(settle(engine, ctx, '0.0001'));

    expect(settle(engine, ctx, '0.0001')).toEqual([]);
    expect(engine.applyFunding('BTCUSDT', T, D('0.0002'), D('81000'), ctx)).toEqual([]);
    expect(s(position()!.margin)).toBe('395.2');
    expect(s(lev().free)).toBe('600');
    expect(engine.state.funding.applied).toEqual({ BTCUSDT: [T] });
  });

  it('a window opened again after its funding was applied is ignored', () => {
    const { ctx, engine } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    closeWindow(engine, ctx);
    fundingOf(settle(engine, ctx, '0.0001'));
    openWindow(engine, ctx);
    closeWindow(engine, ctx);
    expect(engine.state.funding.windows).toEqual({});
    expect(engine.state.funding.pending).toEqual([]);
  });

  it('with no window (the server was down at the funding time) uses the position as it is', () => {
    const { ctx, engine, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    ctx.now = T;

    const f = fundingOf(engine.applyFunding('BTCUSDT', T, D('0.0001'), D('80000'), ctx));
    expect(s(f.qty)).toBe('0.1');
    expect(s(f.amount)).toBe('-0.8');
    expect(f.target).toBe('margin');
    expect(s(position()!.margin)).toBe('395.2');
    expect(engine.applyFunding('BTCUSDT', T, D('0.0001'), D('80000'), ctx)).toEqual([]);
  });

  it('with no window and no position does nothing but records the time', () => {
    const { ctx, engine, lev } = setup();
    expect(engine.applyFunding('BTCUSDT', T, D('0.0001'), D('80000'), ctx)).toEqual([]);
    expect(s(lev().free)).toBe('1000');
    expect(engine.state.funding.applied).toEqual({ BTCUSDT: [T] });
  });

  it('a zero rate moves nothing', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    closeWindow(engine, ctx);
    expect(settle(engine, ctx, '0')).toEqual([]);
    expect(s(position()!.margin)).toBe('396');
    expect(s(lev().free)).toBe('600');
  });

  it('a payment rounds up and a receipt rounds down to 8 decimals', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    ctx.now = T;
    // 0.1 × 80000.1 × 0.000012345 = 0.09876012345
    const paid = fundingOf(engine.applyFunding('BTCUSDT', T, D('0.000012345'), D('80000.1'), ctx));
    expect(s(paid.amount)).toBe('-0.09876013');
    expect(s(position()!.margin)).toBe('395.90123987');

    const received = fundingOf(engine.applyFunding('BTCUSDT', T + 1, D('-0.000012345'), D('80000.1'), ctx));
    expect(s(received.amount)).toBe('0.09876012');
    expect(s(lev().free)).toBe('600.09876012');
  });

  it('a payment beyond the margin comes from free USDT; what neither covers is uncollected', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    engine.state.positions.BTCUSDT = { ...position()!, margin: D('0.5') };
    lev().free = D('0.2');
    ctx.now = T;

    const f = fundingOf(engine.applyFunding('BTCUSDT', T, D('0.0001'), D('80000'), ctx));
    expect(s(f.amount)).toBe('-0.8');
    expect(f.target).toBe('margin');
    expect(s(f.uncollected)).toBe('0.1');
    expect(s(position()!.margin)).toBe('0');
    expect(s(position()!.funding)).toBe('-0.8');
    expect(s(lev().free)).toBe('0');
  });

  it('a payer whose position is gone and whose wallet is short records the rest as uncollected', () => {
    const { ctx, engine, lev } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    openWindow(engine, ctx);
    at(ctx, T - 5_000, () => execute(engine, marketOrder('sell', '0.1', { reduceOnly: true }), ctx));
    closeWindow(engine, ctx);
    lev().free = D('0.3');

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(f.target).toBe('wallet');
    expect(s(f.uncollected)).toBe('0.5');
    expect(s(lev().free)).toBe('0');
  });

  it('a position reopened on the same side after the window pays from the wallet, not from the new margin', () => {
    const { ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    const first = position()!.id;
    openWindow(engine, ctx);
    closeWindow(engine, ctx);
    at(ctx, T + 20_000, () => execute(engine, marketOrder('sell', '0.1', { reduceOnly: true }), ctx));
    at(ctx, T + 30_000, () => execute(engine, marketOrder('buy', '0.1'), ctx));
    const margin = s(position()!.margin);
    const free = lev().free;

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect(f.positionId).toBe(first);
    expect(f.target).toBe('wallet');
    expect(s(lev().free)).toBe(s(free.minus('0.8')));
    expect(s(position()!.margin)).toBe(margin);
    expect(s(position()!.funding)).toBe('0');
  });
  it('fundingTime must be a safe integer (epoch ms)', () => {
    const { ctx, engine, lev } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    for (const bad of [T + 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => engine.applyFunding('BTCUSDT', bad, D('0.0001'), D('80000'), ctx)).toThrow(/funding time/);
    }
    expect(engine.state.funding.applied).toEqual({});
    expect(s(lev().free)).toBe('600');
  });
});

/** The funding events of a settlement, in order; every event must be one. */
function fundingEvents(events: PerpEvent[]): Extract<PerpEvent, { type: 'funding' }>[] {
  return events.map((e) => {
    if (e.type !== 'funding') throw new Error(`expected funding, got ${e.type}`);
    return e;
  });
}

describe('funding when the window max came from an earlier position', () => {
  /** Long A 0.1 held at the window's open and closed inside it; long B `qtyB` opened inside it. */
  function closedThenReopened(qtyB: string) {
    const t = setup();
    execute(t.engine, marketOrder('buy', '0.1'), t.ctx);
    const a = t.position()!.id;
    openWindow(t.engine, t.ctx);
    at(t.ctx, T - 5_000, () => execute(t.engine, marketOrder('sell', '0.1', { reduceOnly: true }), t.ctx));
    at(t.ctx, T + 5_000, () => execute(t.engine, marketOrder('buy', qtyB), t.ctx));
    const b = t.position()!.id;
    closeWindow(t.engine, t.ctx);
    return { ...t, a, b };
  }

  it('the open position pays from its margin on its own size only; the rest is charged to the wallet for the earlier one', () => {
    const { ctx, engine, lev, position, a, b } = closedThenReopened('0.05');
    expect(s(position()!.margin)).toBe('198');
    const free = lev().free;

    const [own, earlier, ...more] = fundingEvents(settle(engine, ctx, '0.0001'));
    expect(more).toEqual([]);
    expect([own!.positionId, s(own!.qty), s(own!.amount), own!.target, own!.uncollected]).toEqual([
      b,
      '0.05',
      '-0.4',
      'margin',
      null,
    ]);
    expect([earlier!.positionId, s(earlier!.qty), s(earlier!.amount), earlier!.target, earlier!.uncollected]).toEqual([
      a,
      '0.05',
      '-0.4',
      'wallet',
      null,
    ]);
    // The total is what the window's largest size (0.1) pays: 0.1 × 80000 × 0.0001 = 0.8.
    expect(s(own!.amount.plus(earlier!.amount))).toBe('-0.8');
    expect(s(position()!.margin)).toBe('197.6');
    expect(s(position()!.funding)).toBe('-0.4');
    expect(s(lev().free)).toBe(s(free.minus('0.4')));
  });

  it('each charge is capped by what can pay it; the total paid and uncollected is unchanged', () => {
    const { ctx, engine, lev, position, a, b } = closedThenReopened('0.05');
    engine.state.positions.BTCUSDT = { ...position()!, margin: D('0.1') };
    lev().free = D('0.5');

    const [own, earlier] = fundingEvents(settle(engine, ctx, '0.0001'));
    // B's 0.4: 0.1 from its margin, 0.3 from free. A's 0.4: the 0.2 left in free, 0.2 uncollected.
    expect([own!.positionId, s(own!.amount), own!.target, own!.uncollected]).toEqual([b, '-0.4', 'margin', null]);
    expect([earlier!.positionId, s(earlier!.amount), earlier!.target, s(earlier!.uncollected)]).toEqual([
      a,
      '-0.4',
      'wallet',
      '0.2',
    ]);
    expect(s(position()!.margin)).toBe('0');
    expect(s(lev().free)).toBe('0');
  });

  it('the split keeps the rounded-up total: the earlier position takes the total less the open one’s share', () => {
    const { ctx, engine, lev } = closedThenReopened('0.05');
    lev().free = D('100');
    ctx.now = T + 60_000;
    // Total 0.1 × 80000.1 × 0.000012345 = 0.09876012345 → 0.09876013; B 0.049380061725 → 0.04938007.
    const [own, earlier] = fundingEvents(engine.applyFunding('BTCUSDT', T, D('0.000012345'), D('80000.1'), ctx));
    expect(s(own!.amount)).toBe('-0.04938007');
    expect(s(earlier!.amount)).toBe('-0.04938006');
  });

  it('when the open position itself reached the window max, it pays all of it from its margin', () => {
    const t = setup();
    execute(t.engine, marketOrder('buy', '0.05'), t.ctx);
    openWindow(t.engine, t.ctx);
    at(t.ctx, T - 5_000, () => execute(t.engine, marketOrder('sell', '0.05', { reduceOnly: true }), t.ctx));
    at(t.ctx, T + 5_000, () => execute(t.engine, marketOrder('buy', '0.1'), t.ctx));
    closeWindow(t.engine, t.ctx);

    const f = fundingOf(settle(t.engine, t.ctx, '0.0001'));
    expect([f.positionId, s(f.qty), s(f.amount), f.target]).toEqual([t.position()!.id, '0.1', '-0.8', 'margin']);
  });

  it('both positions gone: each pays from the wallet on its own part', () => {
    const { ctx, engine, lev, position, a, b } = closedThenReopened('0.05');
    at(ctx, T + 20_000, () => execute(engine, marketOrder('sell', '0.05', { reduceOnly: true }), ctx));
    expect(position()).toBeUndefined();
    const free = lev().free;
    const [own, earlier] = fundingEvents(settle(engine, ctx, '0.0001'));
    expect([own!.positionId, s(own!.qty), own!.target]).toEqual([b, '0.05', 'wallet']);
    expect([earlier!.positionId, s(earlier!.qty), earlier!.target]).toEqual([a, '0.05', 'wallet']);
    expect(s(lev().free)).toBe(s(free.minus('0.8')));
  });
});

describe('fills inside the window made by a trade or a trigger (rate 0.0001, mark 80000)', () => {
  let tradeId = 0;
  const trade = (price: string, sellerInitiated: boolean, qty = '1'): AggTrade => ({
    id: ++tradeId,
    price: D(price),
    qty: D(qty),
    sellerInitiated,
    time: 0,
  });

  /** A live trade at `price` at time `t`, as the market reports it. */
  function tradeAt(market: FakePerpMarket, engine: PerpEngine, ctx: PerpCtx, t: number, price: string, sellerInitiated: boolean): PerpEvent[] {
    let events: PerpEvent[] = [];
    at(ctx, t, () => {
      market.setLastPrice('BTCUSDT', D(price));
      events = engine.onTrade('BTCUSDT', trade(price, sellerInitiated), ctx);
    });
    return events;
  }

  /** Place a limit and let it arrive (resting). */
  function rest(engine: PerpEngine, ctx: PerpCtx, r: Omit<PerpOrderRequest, 'symbol' | 'type'> & { price: string }): void {
    const [placed] = engine.submit({ symbol: 'BTCUSDT', type: 'limit', ...r }, ctx);
    if (placed?.type !== 'order_placed') throw new Error('expected order_placed');
    ctx.now = placed.order.arrivesAt!;
    expect(engine.arrive(placed.order.id, ctx)).toEqual([]);
  }

  /** Set the position's stop-loss and let it arrive (armed). */
  function armStop(engine: PerpEngine, ctx: PerpCtx, stopLoss: string): string {
    const [placed] = engine.setPositionTpSl('BTCUSDT', { stopLoss }, ctx);
    if (placed?.type !== 'order_placed') throw new Error('expected order_placed');
    ctx.now = placed.order.arrivesAt!;
    engine.arrive(placed.order.id, ctx);
    expect(engine.state.orders.get(placed.order.id)!.status).toBe('open');
    return placed.order.id;
  }

  it('a resting buy limit a trade fills inside the window: the long pays on the largest size it reached', () => {
    const { market, ctx, engine, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    rest(engine, ctx, { side: 'buy', price: '79000', qty: '0.1' });
    openWindow(engine, ctx);
    expect(tradeAt(market, engine, ctx, T + 5_000, '78950', true).map((e) => e.type)).toEqual(['fill']);
    expect(s(position()!.qty)).toBe('0.2');
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect([s(f.qty), s(f.amount), f.target]).toEqual(['0.2', '-1.6', 'margin']);
  });

  it('a reduce-only buy limit a trade fills inside the window: the short receives on the smallest size it held throughout', () => {
    const { market, ctx, engine, position } = setup();
    execute(engine, marketOrder('sell', '0.1'), ctx);
    rest(engine, ctx, { side: 'buy', price: '79000', qty: '0.05', reduceOnly: true });
    openWindow(engine, ctx);
    expect(tradeAt(market, engine, ctx, T - 5_000, '78950', true).map((e) => e.type)).toEqual(['fill']);
    expect(s(position()!.qty)).toBe('0.05');
    closeWindow(engine, ctx);

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect([f.side, s(f.qty), s(f.amount), f.target]).toEqual(['short', '0.05', '0.4', 'wallet']);
  });

  it('a stop-loss that triggers and fills inside the window: the long still pays on the size it held, from free USDT', () => {
    const { market, ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('buy', '0.1'), ctx);
    const id = position()!.id;
    const stop = armStop(engine, ctx, '79500');
    openWindow(engine, ctx);
    expect(tradeAt(market, engine, ctx, T - 5_000, '79400', true).map((e) => e.type)).toEqual(['order_triggered']);
    at(ctx, engine.state.orders.get(stop)!.arrivesAt!, () => engine.arrive(stop, ctx));
    expect(position()).toBeUndefined();
    closeWindow(engine, ctx);
    const free = lev().free;

    const f = fundingOf(settle(engine, ctx, '0.0001'));
    expect([f.positionId, s(f.qty), s(f.amount), f.target]).toEqual([id, '0.1', '-0.8', 'wallet']);
    expect(s(lev().free)).toBe(s(free.minus('0.8')));
  });

  it('a short closed by its stop-loss inside the window receives nothing: it did not hold through the window', () => {
    const { market, ctx, engine, lev, position } = setup();
    execute(engine, marketOrder('sell', '0.1'), ctx);
    const stop = armStop(engine, ctx, '80500');
    openWindow(engine, ctx);
    expect(tradeAt(market, engine, ctx, T + 5_000, '80600', false).map((e) => e.type)).toEqual(['order_triggered']);
    at(ctx, engine.state.orders.get(stop)!.arrivesAt!, () => engine.arrive(stop, ctx));
    expect(position()).toBeUndefined();
    closeWindow(engine, ctx);
    const free = s(lev().free);

    expect(settle(engine, ctx, '0.0001')).toEqual([]);
    expect(s(lev().free)).toBe(free);
  });
});
