import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { validateSpotOrder } from '../src/rules.ts';
import type { NormalizedRequest } from '../src/types.ts';
import { btcRules } from './fixtures.ts';

type Req = Omit<NormalizedRequest, 'symbol'>;
const base = { avgPrice: D('100') as ReturnType<typeof D> | null, openOrders: 0, openAlgoOrders: 0 };
const check = (r: Req, ctx: Partial<typeof base> = {}) =>
  validateSpotOrder({ symbol: 'BTCUSDT', ...r }, btcRules, { ...base, ...ctx });

describe('validateSpotOrder', () => {
  it('PRICE_FILTER tick size', () => {
    expect(check({ side: 'buy', type: 'limit', price: D('100.005'), qty: D('1') })).toBe(
      'PRICE_FILTER: price 100.005 is not a multiple of tick size 0.01',
    );
  });
  it('LOT_SIZE step', () => {
    expect(check({ side: 'buy', type: 'limit', price: D('99'), qty: D('0.000015') })).toBe(
      'LOT_SIZE: quantity 0.000015 is not a multiple of step size 0.00001',
    );
  });
  it('NOTIONAL minimum on limit', () => {
    expect(check({ side: 'buy', type: 'limit', price: D('99'), qty: D('0.05') })).toBe(
      'NOTIONAL: order value 4.95 is below the minimum 5',
    );
  });
  it('PERCENT_PRICE_BY_SIDE', () => {
    expect(check({ side: 'buy', type: 'limit', price: D('121'), qty: D('1') })).toBe(
      'PERCENT_PRICE_BY_SIDE: buy price 121 is above the allowed maximum 120 (1.2 × average price 100)',
    );
    expect(check({ side: 'sell', type: 'limit', price: D('79'), qty: D('1') })).toMatch(
      /^PERCENT_PRICE_BY_SIDE:/,
    );
    expect(check({ side: 'sell', type: 'limit', price: D('199'), qty: D('1') })).toBeNull();
  });
  it('market notional uses average price', () => {
    expect(check({ side: 'buy', type: 'market', qty: D('0.04') })).toMatch(/^NOTIONAL:/);
  });
  it('market notional on quoteQty-only order', () => {
    expect(check({ side: 'buy', type: 'market', quoteQty: D('4') })).toMatch(/^NOTIONAL:/);
    expect(check({ side: 'buy', type: 'market', quoteQty: D('50') })).toBeNull();
  });
  it('MARKET_LOT_SIZE max', () => {
    expect(check({ side: 'buy', type: 'market', qty: D('115') })).toBe(
      'MARKET_LOT_SIZE: quantity 115 is above the market maximum 114.06718587',
    );
  });
  it('MAX_NUM_ALGO_ORDERS', () => {
    expect(
      check({ side: 'sell', type: 'stop_loss', triggerPrice: D('95'), qty: D('1') }, { openAlgoOrders: 5 }),
    ).toBe('MAX_NUM_ALGO_ORDERS: already 5 open stop/take-profit orders on BTCUSDT (maximum 5)');
  });
  it('MAX_NUM_ORDERS', () => {
    expect(check({ side: 'buy', type: 'limit', price: D('99'), qty: D('1') }, { openOrders: 200 })).toBe(
      'MAX_NUM_ORDERS: already 200 open orders on BTCUSDT (maximum 200)',
    );
  });
  it('rejects when average price is unavailable', () => {
    expect(check({ side: 'buy', type: 'market', qty: D('1') }, { avgPrice: null })).toBe(
      'Average price unavailable; order rejected (never guessed)',
    );
  });
  it('accepts a valid limit buy', () => {
    expect(check({ side: 'buy', type: 'limit', price: D('99'), qty: D('1') })).toBeNull();
  });
});
