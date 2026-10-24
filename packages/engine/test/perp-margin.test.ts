import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import type { PerpActionResult, PerpCtx, PerpEvent, PerpOrderRequest } from '../src/perp/types.ts';
import { FakePerpMarket, perpCtx } from './perpFixtures.ts';

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

const req = (fields: Partial<PerpOrderRequest> = {}): PerpOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  ...fields,
});

/** The long 0.1 @80000 at 20x: margin 396, free 600. */
function openLong(engine: PerpEngine, ctx: PerpCtx): void {
  const [placed] = engine.submit(req({ qty: '0.1' }), ctx);
  if (placed?.type !== 'order_placed') throw new Error('not placed');
  ctx.now = placed.order.arrivesAt!;
  engine.arrive(placed.order.id, ctx);
}

function ok(r: PerpActionResult): PerpEvent[] {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.events;
}
function refused(r: PerpActionResult): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.reason;
}

const LOCKED = 'Leverage is locked while a position or an opening order is open on BTCUSDT';

describe('setLeverage', () => {
  it('accepts a whole number up to the maximum and emits leverage_set', () => {
    const { engine, ctx } = setup();
    const events = ok(engine.setLeverage('BTCUSDT', 150, ctx));
    expect(events).toEqual([{ type: 'leverage_set', market: 'perp', time: NOW, symbol: 'BTCUSDT', leverage: 150 }]);
    expect(engine.state.settings.BTCUSDT).toEqual({ leverage: 150, marginMode: 'isolated' });
  });

  it.each([151, 2.5, 0, -3, NaN, Infinity])('refuses %s', (n) => {
    const { engine, ctx } = setup();
    expect(refused(engine.setLeverage('BTCUSDT', n, ctx))).toBe('Leverage must be a whole number from 1 to 150');
    expect(engine.state.settings.BTCUSDT).toBeUndefined();
  });

  it('refuses until the leverage tiers are loaded', () => {
    const { engine, ctx, market } = setup();
    market.clearBrackets('BTCUSDT');
    expect(refused(engine.setLeverage('BTCUSDT', 10, ctx))).toBe('Leverage tiers not loaded yet; try again in a moment');
  });

  it('is locked while a position is open', () => {
    const { engine, ctx } = setup();
    openLong(engine, ctx);
    expect(refused(engine.setLeverage('BTCUSDT', 10, ctx))).toBe(LOCKED);
  });

  it('is locked while a non reduce-only order is live, but not by a reduce-only one', () => {
    const { engine, ctx } = setup();
    engine.submit(req({ type: 'limit', qty: '0.1', price: '79000' }), ctx);
    expect(refused(engine.setLeverage('BTCUSDT', 10, ctx))).toBe(LOCKED);

    const other = setup();
    openLong(other.engine, other.ctx);
    other.engine.submit(req({ side: 'sell', type: 'limit', qty: '0.1', price: '81000', reduceOnly: true }), other.ctx);
    // Drop the position so that only the reduce-only order is left.
    delete other.engine.state.positions.BTCUSDT;
    expect(ok(other.engine.setLeverage('BTCUSDT', 10, other.ctx))).toHaveLength(1);
  });
});

describe('setMarginMode', () => {
  it('accepts isolated as a no-op and refuses cross', () => {
    const { engine, ctx } = setup();
    expect(ok(engine.setMarginMode('BTCUSDT', 'isolated', ctx))).toEqual([]);
    expect(refused(engine.setMarginMode('BTCUSDT', 'cross', ctx))).toBe('Cross margin is not available yet; isolated only');
  });
});

describe('addMargin', () => {
  it('moves free USDT into the position and reports the new liquidation price', () => {
    const { engine, ctx, lev, position } = setup();
    openLong(engine, ctx);
    expect(position()!.margin.toString()).toBe('396');
    expect(lev().free.toString()).toBe('600');
    const events = ok(engine.addMargin('BTCUSDT', '100', ctx));
    expect(events).toHaveLength(1);
    const e = events[0]!;
    if (e.type !== 'margin_changed') throw new Error(e.type);
    expect(e).toMatchObject({ market: 'perp', symbol: 'BTCUSDT', side: 'long', action: 'add', time: ctx.now });
    expect(e.amount.toString()).toBe('100');
    expect(e.marginAfter.toString()).toBe('496');
    expect(e.liquidationPriceAfter?.toFixed(8)).toBe('75341.36546185');
    expect(position()!.margin.toString()).toBe('496');
    expect(lev().free.toString()).toBe('500');
  });

  it('refuses without a position, over the free balance, and bad amounts', () => {
    const { engine, ctx } = setup();
    expect(refused(engine.addMargin('BTCUSDT', '10', ctx))).toBe('No open position on BTCUSDT');
    openLong(engine, ctx);
    expect(refused(engine.addMargin('BTCUSDT', '600.00000001', ctx))).toBe(
      'Insufficient free USDT in leverage wallet: need 600.00000001, available 600',
    );
    expect(refused(engine.addMargin('BTCUSDT', '0', ctx))).toBe('Amount must be greater than 0');
    expect(refused(engine.addMargin('BTCUSDT', '1.123456789', ctx))).toBe('Too many decimals: at most 8');
  });

  // A margin change made while the data is not live could erase or misdate a liquidation that the
  // gap's catch-up would find (on the exchange the position may be gone already): refused.
  it('is refused without live data: a stale mark, or stale market data', () => {
    const { engine, ctx, market, lev, position } = setup();
    openLong(engine, ctx);
    market.setMarkFresh('BTCUSDT', false);
    expect(refused(engine.addMargin('BTCUSDT', '1', ctx))).toBe('Mark price unavailable; try again when live data is back');
    market.setMarkFresh('BTCUSDT', true);
    market.setFresh('BTCUSDT', false);
    expect(refused(engine.addMargin('BTCUSDT', '1', ctx))).toBe('Mark price unavailable; try again when live data is back');
    expect(position()!.margin.toString()).toBe('396');
    expect(lev().free.toString()).toBe('600');
    market.setFresh('BTCUSDT', true);
    expect(ok(engine.addMargin('BTCUSDT', '1', ctx))).toHaveLength(1);
  });
});

describe('removeMargin', () => {
  it('takes out at most the removable margin, rounded down; an unrealised profit is not removable', () => {
    const { engine, ctx, market, lev, position } = setup();
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('82000'));
    // 200 USDT in profit, but the position holds only its initial margin: nothing may come out.
    expect(refused(engine.removeMargin('BTCUSDT', '1', ctx))).toBe('At most 0 USDT can be removed now');
    ok(engine.addMargin('BTCUSDT', '100', ctx));
    expect(refused(engine.removeMargin('BTCUSDT', '86.00000001', ctx))).toBe('At most 86 USDT can be removed now');
    const events = ok(engine.removeMargin('BTCUSDT', '86', ctx));
    const e = events[0]!;
    if (e.type !== 'margin_changed') throw new Error(e.type);
    expect(e).toMatchObject({ market: 'perp', symbol: 'BTCUSDT', side: 'long', action: 'remove' });
    expect(e.amount.toString()).toBe('86');
    expect(e.marginAfter.toString()).toBe('410');
    expect(e.liquidationPriceAfter?.toFixed(8)).toBe('76204.81927711');
    expect(position()!.margin.toString()).toBe('410');
    expect(lev().free.toString()).toBe('586');
  });

  it('is refused when the mark or the market data is stale, as an add is', () => {
    const { engine, ctx, market, position } = setup();
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('82000'));
    market.setMarkFresh('BTCUSDT', false);
    expect(refused(engine.removeMargin('BTCUSDT', '1', ctx))).toBe('Mark price unavailable; try again when live data is back');
    expect(refused(engine.addMargin('BTCUSDT', '1', ctx))).toBe('Mark price unavailable; try again when live data is back');
    market.setMarkFresh('BTCUSDT', true);
    market.setFresh('BTCUSDT', false);
    expect(refused(engine.removeMargin('BTCUSDT', '1', ctx))).toBe('Mark price unavailable; try again when live data is back');
    expect(position()!.margin.toString()).toBe('396');
  });

  it('is refused without a position, and without any mark price', () => {
    const { engine, ctx, market } = setup();
    expect(refused(engine.removeMargin('BTCUSDT', '1', ctx))).toBe('No open position on BTCUSDT');
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', null);
    expect(refused(engine.removeMargin('BTCUSDT', '1', ctx))).toBe('Mark price unavailable; try again when live data is back');
  });
});

describe('previewMargin', () => {
  it('reports the margin and liquidation price an add would leave, changing nothing', () => {
    const { engine, ctx, lev, position } = setup();
    openLong(engine, ctx);
    const p = engine.previewMargin('BTCUSDT', 'add', '100', ctx);
    expect(p.rejectReason).toBeNull();
    expect(p.marginAfter?.toString()).toBe('496');
    expect(p.liquidationPriceAfter?.toFixed(8)).toBe('75341.36546185');
    expect(position()!.margin.toString()).toBe('396');
    expect(lev().free.toString()).toBe('600');
  });

  it('checks a removal as removeMargin does: the same refusal, and the maximum at the fresh mark', () => {
    const { engine, ctx, market, lev, position } = setup();
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('82000'));
    ok(engine.addMargin('BTCUSDT', '100', ctx));
    const over = engine.previewMargin('BTCUSDT', 'remove', '86.00000001', ctx);
    expect(over.rejectReason).toBe(refused(engine.removeMargin('BTCUSDT', '86.00000001', ctx)));
    expect([over.marginAfter, over.liquidationPriceAfter]).toEqual([null, null]);
    expect(over.maxRemovable?.toString()).toBe('86');
    const fits = engine.previewMargin('BTCUSDT', 'remove', '86', ctx);
    expect(fits.rejectReason).toBeNull();
    expect(fits.marginAfter?.toString()).toBe('410');
    expect(fits.liquidationPriceAfter?.toFixed(8)).toBe('76204.81927711');
    expect(position()!.margin.toString()).toBe('496');
    expect(lev().free.toString()).toBe('500');
  });

  it('with a stale mark or stale market data: no maximum, and both a removal and an add refused', () => {
    const { engine, ctx, market } = setup();
    openLong(engine, ctx);
    for (const stale of [() => market.setMarkFresh('BTCUSDT', false), () => market.setFresh('BTCUSDT', false)]) {
      market.setMarkFresh('BTCUSDT', true);
      market.setFresh('BTCUSDT', true);
      stale();
      const reason = 'Mark price unavailable; try again when live data is back';
      expect(engine.previewMargin('BTCUSDT', 'remove', '1', ctx)).toMatchObject({ rejectReason: reason, maxRemovable: null });
      expect(engine.previewMargin('BTCUSDT', 'add', '1', ctx)).toMatchObject({ rejectReason: reason, maxRemovable: null });
    }
  });

  it('gives the refusal without a position, over the free balance, or for a bad amount', () => {
    const { engine, ctx } = setup();
    expect(engine.previewMargin('BTCUSDT', 'add', '10', ctx).rejectReason).toBe('No open position on BTCUSDT');
    openLong(engine, ctx);
    expect(engine.previewMargin('BTCUSDT', 'add', '600.00000001', ctx).rejectReason).toBe(
      'Insufficient free USDT in leverage wallet: need 600.00000001, available 600',
    );
    expect(engine.previewMargin('BTCUSDT', 'add', 'lots', ctx).rejectReason).toMatch(/^Invalid amount "lots"/);
  });
});

describe('maxRemovable', () => {
  it('is what removeMargin allows now; null without a fresh mark, the tiers or a position', () => {
    const { engine, ctx, market } = setup();
    expect(engine.maxRemovable('BTCUSDT', ctx)).toBeNull();
    openLong(engine, ctx);
    market.setMarkPrice('BTCUSDT', D('82000'));
    expect(engine.maxRemovable('BTCUSDT', ctx)?.toString()).toBe('0');
    ok(engine.addMargin('BTCUSDT', '100', ctx));
    expect(engine.maxRemovable('BTCUSDT', ctx)?.toString()).toBe('86');
    market.setMarkFresh('BTCUSDT', false);
    expect(engine.maxRemovable('BTCUSDT', ctx)).toBeNull();
    market.setMarkFresh('BTCUSDT', true);
    market.setFresh('BTCUSDT', false);
    expect(engine.maxRemovable('BTCUSDT', ctx)).toBeNull();
    market.setFresh('BTCUSDT', true);
    market.clearBrackets('BTCUSDT');
    expect(engine.maxRemovable('BTCUSDT', ctx)).toBeNull();
  });
});
