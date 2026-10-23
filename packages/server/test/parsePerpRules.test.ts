import { describe, it, expect } from 'vitest';
import { parsePerpRules } from '../src/binance/parsePerpRules.ts';
import info from './fixtures/btcusdt-perp-exchangeinfo.json' with { type: 'json' };

const btc = info.symbols[0]!;
const without = (type: string) => ({ ...btc, filters: btc.filters.filter((f) => f.filterType !== type) });
const withFilter = (type: string, patch: object) => ({
  ...btc,
  filters: btc.filters.map((f) => (f.filterType === type ? { ...f, ...patch } : f)),
});

describe('parsePerpRules', () => {
  it('maps the BTCUSDT perpetual filters and top-level fields', () => {
    const r = parsePerpRules(btc);
    expect(r.symbol).toBe('BTCUSDT');
    expect(r.base).toBe('BTC');
    expect(r.quote).toBe('USDT');
    expect(r.status).toBe('TRADING');
    expect(r.tickSize.toFixed()).toBe('0.1');
    expect(r.tickSize.eq('0.10')).toBe(true);
    expect(r.minPrice.toString()).toBe('556.8');
    expect(r.maxPrice.toString()).toBe('4529764');
    expect(r.stepSize.toString()).toBe('0.001');
    expect(r.minQty.toString()).toBe('0.001');
    expect(r.maxQty.toString()).toBe('1000');
    expect(r.marketStepSize.toString()).toBe('0.001');
    expect(r.marketMinQty.toString()).toBe('0.001');
    expect(r.marketMaxQty.toString()).toBe('120');
    expect(r.minNotional.toString()).toBe('50');
    expect(r.maxNumOrders).toBe(200);
    expect(r.multiplierUp.eq('1.0500')).toBe(true);
    expect(r.multiplierDown.eq('0.9500')).toBe(true);
    expect(r.liquidationFee.eq('0.012500')).toBe(true);
    expect(r.marketTakeBound.eq('0.05')).toBe(true);
  });

  it('throws on a missing required filter', () => {
    expect(() => parsePerpRules(without('MIN_NOTIONAL'))).toThrow('Missing filter MIN_NOTIONAL for BTCUSDT');
    for (const f of ['PRICE_FILTER', 'LOT_SIZE', 'MARKET_LOT_SIZE', 'MAX_NUM_ORDERS', 'PERCENT_PRICE']) {
      expect(() => parsePerpRules(without(f)), f).toThrow(`Missing filter ${f} for BTCUSDT`);
    }
  });

  it('throws on missing or unusable values', () => {
    expect(() => parsePerpRules({ ...btc, liquidationFee: undefined })).toThrow(
      'parsePerpRules: BTCUSDT has no liquidationFee',
    );
    expect(() => parsePerpRules({ ...btc, marketTakeBound: '' })).toThrow('parsePerpRules: BTCUSDT has no marketTakeBound');
    expect(() => parsePerpRules({ ...btc, status: undefined })).toThrow('parsePerpRules: BTCUSDT has no status');
    expect(() => parsePerpRules({ ...btc, baseAsset: undefined })).toThrow('parsePerpRules: BTCUSDT has no baseAsset');
    expect(() => parsePerpRules(withFilter('MIN_NOTIONAL', { notional: undefined }))).toThrow(
      'parsePerpRules: BTCUSDT MIN_NOTIONAL.notional is not a number (undefined)',
    );
    expect(() => parsePerpRules(withFilter('PERCENT_PRICE', { multiplierUp: 'x' }))).toThrow(
      'parsePerpRules: BTCUSDT PERCENT_PRICE.multiplierUp is not a number (x)',
    );
    expect(() => parsePerpRules(withFilter('MAX_NUM_ORDERS', { limit: 0 }))).toThrow(
      'parsePerpRules: BTCUSDT MAX_NUM_ORDERS.limit is not a positive integer (0)',
    );
    expect(() => parsePerpRules({ filters: [] })).toThrow('parsePerpRules: not a Binance symbol info object');
  });
});
