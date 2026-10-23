import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { isolatedModel, nextWarning } from '../src/perp/liquidation.ts';
import { liquidationPrice } from '../src/perp/math.ts';
import { emptyPerpState, putOrder } from '../src/perp/state.ts';
import type { MarginWarning, PerpCtx, PerpEvent, PerpOrder, PerpOrderRequest } from '../src/perp/types.ts';
import { btcBrackets, FakePerpMarket, perpCtx } from './perpFixtures.ts';

const NOW = 1_000_000;

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

const order = (fields: Partial<PerpOrderRequest> = {}): PerpOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  ...fields,
});

const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

function placed(events: PerpEvent[]): PerpOrder {
  const e = events[0];
  if (events.length !== 1 || e?.type !== 'order_placed') throw new Error('expected one order_placed');
  return e.order;
}

/** Submit and arrive at the order's arrival time. */
function execute(engine: PerpEngine, r: PerpOrderRequest, ctx: PerpCtx): PerpOrder {
  const o = placed(engine.submit(r, ctx));
  ctx.now = Math.max(ctx.now, o.arrivesAt!);
  engine.arrive(o.id, ctx);
  return engine.state.orders.get(o.id)!;
}

/** Market long 0.1 at 80000, 20x: position margin 396, free 600 (of 1000). */
function openLong(engine: PerpEngine, ctx: PerpCtx): void {
  execute(engine, order({ qty: '0.1' }), ctx);
}

/** onMark with the market's mark moved there too, as the feed would. */
function mark(market: FakePerpMarket, engine: PerpEngine, price: string, ctx: PerpCtx) {
  market.setMarkPrice('BTCUSDT', D(price));
  return engine.onMark('BTCUSDT', D(price), ctx);
}

function warningOf(r: { events: PerpEvent[]; warnings: MarginWarning[] }): MarginWarning {
  expect(r.events).toEqual([]);
  expect(r.warnings).toHaveLength(1);
  return r.warnings[0]!;
}

function find<T extends PerpEvent['type']>(events: PerpEvent[], type: T): Extract<PerpEvent, { type: T }> {
  const e = events.find((x) => x.type === type);
  if (!e) throw new Error(`no ${type} event in ${events.map((x) => x.type).join(', ')}`);
  return e as Extract<PerpEvent, { type: T }>;
}

describe('margin warnings (long 0.1 @80000, margin 396)', () => {
  it('escalate at 0.5, 0.8 and 0.9, each once', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    const id = position()!.id;

    expect(mark(market, engine, '78000', ctx)).toEqual({ events: [], warnings: [] });

    // MM 30.64, MB 56
    const half = warningOf(mark(market, engine, '76600', ctx));
    expect(half.symbol).toBe('BTCUSDT');
    expect(half.positionId).toBe(id);
    expect(half.level).toBe(0.5);
    expect(half.ratio.toFixed(6)).toBe('0.547143');
    expect(s(half.markPrice)).toBe('76600');
    expect(s(half.liquidationPrice)).toBe(s(liquidationPrice(btcBrackets, 'long', D('0.1'), D('80000'), D('396'))));
    expect(position()!.warnLevel).toBe(0.5);

    // MM 30.56, MB 36: 0.8489
    expect(warningOf(mark(market, engine, '76400', ctx)).level).toBe(0.8);
    // MM 30.548, MB 33: 0.9257
    expect(warningOf(mark(market, engine, '76370', ctx)).level).toBe(0.9);
    expect(mark(market, engine, '76370', ctx)).toEqual({ events: [], warnings: [] });
    expect(position()!.warnLevel).toBe(0.9);
  });

  it('a level re-arms once the ratio falls 0.05 below it', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    mark(market, engine, '76600', ctx);
    mark(market, engine, '76400', ctx);
    mark(market, engine, '76370', ctx);

    expect(mark(market, engine, '76600', ctx)).toEqual({ events: [], warnings: [] });
    expect(position()!.warnLevel).toBe(0.5);
    expect(warningOf(mark(market, engine, '76370', ctx)).level).toBe(0.9);
  });

  it('a ratio that jumps past several levels gives one warning, at the highest', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    expect(warningOf(mark(market, engine, '76370', ctx)).level).toBe(0.9);
    expect(position()!.warnLevel).toBe(0.9);
  });

  it('within 0.05 below a level, nothing re-arms', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    mark(market, engine, '76370', ctx);
    // MM 30.552, MB 34: 0.8986, still within 0.05 of 0.9
    expect(mark(market, engine, '76380', ctx)).toEqual({ events: [], warnings: [] });
    expect(position()!.warnLevel).toBe(0.9);
    expect(mark(market, engine, '76370', ctx)).toEqual({ events: [], warnings: [] });
  });

  it('no position or a stale mark: nothing', () => {
    const { market, ctx, engine, position } = setup();
    expect(mark(market, engine, '76370', ctx)).toEqual({ events: [], warnings: [] });
    openLong(engine, ctx);
    market.setMarkFresh('BTCUSDT', false);
    expect(mark(market, engine, '76370', ctx)).toEqual({ events: [], warnings: [] });
    expect(position()!.warnLevel).toBe(0);
  });
});

describe('liquidation (long 0.1 @80000, margin 396, free 600)', () => {
  it('margin balance just above maintenance: no liquidation', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    mark(market, engine, '76370', ctx);
    // MB 31 > MM 30.54
    expect(mark(market, engine, '76350', ctx)).toEqual({ events: [], warnings: [] });
    expect(position()).toBeDefined();
  });

  it('margin balance at or below maintenance liquidates: the whole margin is lost, the wallet untouched', () => {
    const { market, ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    const held = position()!;
    ctx.now += 60_000;

    // MB 30 ≤ MM 30.536
    const r = mark(market, engine, '76340', ctx);
    expect(r.warnings).toEqual([]);
    expect(r.events.map((e) => e.type)).toEqual(['liquidation', 'position_closed']);

    const liq = find(r.events, 'liquidation');
    expect(liq.market).toBe('perp');
    expect(liq.time).toBe(ctx.now);
    expect(liq.symbol).toBe('BTCUSDT');
    expect(liq.position).toEqual(held);
    expect(s(liq.markPrice)).toBe('76340');
    expect(s(liq.tradingLoss)).toBe('366');
    expect(s(liq.liquidationFee)).toBe('30');
    expect(s(liq.remainder)).toBe('0');
    expect(s(liq.marginLost)).toBe('396');
    expect(liq.cancelledOrderIds).toEqual([]);

    const closed = find(r.events, 'position_closed');
    expect(closed.reason).toBe('liquidated');
    expect(s(closed.exitPrice)).toBe('76340');
    expect(s(closed.position.qty)).toBe('0');
    expect(s(closed.position.margin)).toBe('0');
    expect(s(closed.realizedPnl)).toBe('-366');
    // Opening fee 4 plus the liquidation fee 30: −366 − 34 = −400, everything put in.
    expect(s(closed.fees)).toBe('34');
    expect(s(closed.funding)).toBe('0');
    expect(closed.holdMs).toBe(ctx.now - held.openedAt);

    expect(position()).toBeUndefined();
    expect(s(lev().free)).toBe('600');
    expect(s(lev().locked)).toBe('0');
    // Nothing left to liquidate or warn about.
    expect(mark(market, engine, '70000', ctx)).toEqual({ events: [], warnings: [] });
  });

  it('equality liquidates', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    // At mark 76340 the loss is 366 and MM 30.536, so a margin of 396.536 leaves MB exactly equal to MM.
    engine.state.positions.BTCUSDT = { ...position()!, margin: D('396.536') };
    const r = mark(market, engine, '76340', ctx);
    expect(r.events.map((e) => e.type)).toEqual(['liquidation', 'position_closed']);
    const liq = find(r.events, 'liquidation');
    expect(s(liq.marginLost)).toBe('396.536');
    expect(s(liq.tradingLoss)).toBe('366');
    expect(s(liq.liquidationFee)).toBe('30.536');
    expect(s(liq.remainder)).toBe('0');
  });

  it('mark gaps past bankruptcy: the loss is capped at the margin, no fee', () => {
    const { market, ctx, engine, lev } = setup();
    openLong(engine, ctx);
    const liq = find(mark(market, engine, '75000', ctx).events, 'liquidation');
    expect(s(liq.tradingLoss)).toBe('396');
    expect(s(liq.liquidationFee)).toBe('0');
    expect(s(liq.remainder)).toBe('0');
    expect(s(liq.marginLost)).toBe('396');
    expect(s(lev().free)).toBe('600');
    expect(s(lev().locked)).toBe('0');
  });

  it('a short is liquidated when the mark rises', () => {
    const { market, ctx, engine, lev, position } = setup();
    execute(engine, order({ side: 'sell', qty: '0.1' }), ctx);
    const margin = position()!.margin;
    const r = mark(market, engine, '90000', ctx);
    const liq = find(r.events, 'liquidation');
    expect(s(liq.marginLost)).toBe(s(margin));
    expect(find(r.events, 'position_closed').reason).toBe('liquidated');
    expect(position()).toBeUndefined();
    expect(s(lev().locked)).toBe('0');
  });

  it('needs a fresh mark only: a stale book still liquidates, a stale mark never does', () => {
    const a = setup();
    openLong(a.engine, a.ctx);
    a.market.setFresh('BTCUSDT', false);
    const r = mark(a.market, a.engine, '76340', a.ctx);
    expect(r.events.map((e) => e.type)).toEqual(['liquidation', 'position_closed']);

    const b = setup();
    openLong(b.engine, b.ctx);
    b.market.setMarkFresh('BTCUSDT', false);
    b.market.setLastPrice('BTCUSDT', D('70000'));
    expect(mark(b.market, b.engine, '70000', b.ctx)).toEqual({ events: [], warnings: [] });
    expect(b.position()).toBeDefined();
  });

  it('is judged on the mark passed in, never on the last trade price', () => {
    const { market, ctx, engine, position } = setup();
    openLong(engine, ctx);
    market.setLastPrice('BTCUSDT', D('70000'));
    expect(mark(market, engine, '78000', ctx)).toEqual({ events: [], warnings: [] });
    expect(position()).toBeDefined();
  });

  it('cancels every live order on the symbol with reason liquidation, releasing every lock', () => {
    const { market, ctx, engine, lev, position } = setup();
    openLong(engine, ctx);
    const opening = placed(engine.submit(order({ type: 'limit', price: '79900', qty: '0.1' }), ctx));
    expect(s(opening.lockAmount)).toBe('403.495');
    const reduceOnly = placed(
      engine.submit(order({ type: 'limit', side: 'sell', price: '81000', qty: '0.1', reduceOnly: true }), ctx),
    );
    ctx.now = Math.max(opening.arrivesAt!, reduceOnly.arrivesAt!);
    engine.arrive(opening.id, ctx);
    engine.arrive(reduceOnly.id, ctx);
    expect(engine.state.orders.get(opening.id)!.status).toBe('open');
    expect(engine.state.orders.get(reduceOnly.id)!.status).toBe('open');

    // Armed close-position stop-loss and take-profit.
    const stop = (id: string, type: 'stop_loss' | 'take_profit', trigger: string): PerpOrder => ({
      ...reduceOnly,
      id,
      type,
      qty: null,
      price: null,
      triggerPrice: D(trigger),
      closePosition: true,
      status: 'open',
    });
    putOrder(engine.state, stop('sl', 'stop_loss', '77000'));
    putOrder(engine.state, stop('tp', 'take_profit', '90000'));
    expect(s(lev().locked)).toBe('403.495');

    const r = mark(market, engine, '76340', ctx);
    const types = r.events.map((e) => e.type);
    expect(types).toEqual([
      'order_cancelled',
      'order_cancelled',
      'order_cancelled',
      'order_cancelled',
      'liquidation',
      'position_closed',
    ]);
    const cancelled = r.events.filter((e) => e.type === 'order_cancelled');
    for (const e of cancelled) expect(e.reason).toBe('liquidation');
    const ids = [opening.id, reduceOnly.id, 'sl', 'tp'];
    expect(cancelled.map((e) => e.order.id).sort()).toEqual([...ids].sort());
    expect([...find(r.events, 'liquidation').cancelledOrderIds].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(engine.state.orders.get(id)!.status).toBe('cancelled');
    for (const id of ids) expect(engine.state.dirty.has(id)).toBe(true);

    expect(position()).toBeUndefined();
    expect(s(lev().locked)).toBe('0');
    expect(s(lev().free)).toBe('600');
  });

  it('a liquidation on one symbol leaves other symbols alone', () => {
    const { market, ctx, engine } = setup();
    openLong(engine, ctx);
    const other = execute(engine, order({ type: 'limit', price: '79900', qty: '0.001' }), ctx);
    putOrder(engine.state, { ...other, id: 'eth', symbol: 'ETHUSDT', status: 'open' });
    mark(market, engine, '76340', ctx);
    expect(engine.state.orders.get('eth')!.status).toBe('open');
  });
});

describe('isolatedModel', () => {
  it('reports the margin ratio and whether to liquidate; null with no position', () => {
    const { ctx, engine } = setup();
    expect(isolatedModel.evaluate(engine.state, 'BTCUSDT', D('76600'), btcBrackets)).toBeNull();
    openLong(engine, ctx);
    const safe = isolatedModel.evaluate(engine.state, 'BTCUSDT', D('76350'), btcBrackets)!;
    expect(safe.liquidate).toBe(false);
    expect(safe.ratio.toFixed(6)).toBe('0.985161');
    const gone = isolatedModel.evaluate(engine.state, 'BTCUSDT', D('76340'), btcBrackets)!;
    expect(gone.liquidate).toBe(true);
    expect(gone.ratio.gt(1)).toBe(true);
  });
});

describe('nextWarning', () => {
  it.each([
    [0, '0.49', 0, null],
    [0, '0.5', 0.5, 0.5],
    [0, '0.95', 0.9, 0.9],
    [0, 'Infinity', 0.9, 0.9],
    [0.5, '0.46', 0.5, null],
    [0.5, '0.449', 0, null],
    [0.9, '0.86', 0.9, null],
    [0.9, '0.84', 0.8, null],
    // 0.8 was given (with 0.9) and the ratio has not fallen 0.05 below it: it stays given.
    [0.9, '0.78', 0.8, null],
    [0.9, '0.74', 0.5, null],
    [0.9, '0.4', 0, null],
    [0.8, '0.9', 0.9, 0.9],
  ] as const)('warnLevel %s, ratio %s → warnLevel %s, warning %s', (current, ratio, warnLevel, level) => {
    expect(nextWarning(current, D(ratio))).toEqual({ warnLevel, level });
  });
});
