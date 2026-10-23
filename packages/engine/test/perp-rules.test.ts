import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { validatePerpOrder } from '../src/perp/rules.ts';
import type { NormalizedPerpRequest } from '../src/perp/rules.ts';
import { btcPerpRules } from './perpFixtures.ts';

const MARK = D('80000');
const ok = { mark: MARK, openOrders: 0 };

const market = (fields: Partial<NormalizedPerpRequest> = {}): NormalizedPerpRequest => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  qty: D('0.1'),
  reduceOnly: false,
  ...fields,
});
const limit = (price: string, fields: Partial<NormalizedPerpRequest> = {}): NormalizedPerpRequest =>
  market({ type: 'limit', price: D(price), ...fields });

describe('validatePerpOrder', () => {
  it('passes a valid market and limit order', () => {
    expect(validatePerpOrder(market(), btcPerpRules, ok)).toBeNull();
    expect(validatePerpOrder(limit('79900'), btcPerpRules, ok)).toBeNull();
  });

  it('rejects without a positive mark price', () => {
    const reason = 'Mark price unavailable; order rejected (never guessed)';
    expect(validatePerpOrder(market(), btcPerpRules, { mark: null, openOrders: 0 })).toBe(reason);
    expect(validatePerpOrder(limit('79900'), btcPerpRules, { mark: D(0), openOrders: 0 })).toBe(reason);
    expect(validatePerpOrder(market(), btcPerpRules, { mark: D(-1), openOrders: 0 })).toBe(reason);
  });

  it('MAX_NUM_ORDERS', () => {
    expect(validatePerpOrder(market(), btcPerpRules, { mark: MARK, openOrders: 200 })).toBe(
      'MAX_NUM_ORDERS: already 200 open orders on BTCUSDT (maximum 200)',
    );
    expect(validatePerpOrder(market(), btcPerpRules, { mark: MARK, openOrders: 199 })).toBeNull();
  });

  it('PRICE_FILTER on the price and the trigger price', () => {
    expect(validatePerpOrder(limit('500'), btcPerpRules, ok)).toBe(
      'PRICE_FILTER: price 500 is below the minimum price 556.8',
    );
    expect(validatePerpOrder(limit('4529764.1'), btcPerpRules, ok)).toBe(
      'PRICE_FILTER: price 4529764.1 is above the maximum price 4529764',
    );
    expect(validatePerpOrder(limit('80000.05'), btcPerpRules, ok)).toBe(
      'PRICE_FILTER: price 80000.05 is not a multiple of tick size 0.1',
    );
    const stop = market({ type: 'stop_loss', triggerPrice: D('78000.05') });
    expect(validatePerpOrder(stop, btcPerpRules, ok)).toBe(
      'PRICE_FILTER: trigger price 78000.05 is not a multiple of tick size 0.1',
    );
  });

  it('a zero PRICE_FILTER value disables that check', () => {
    const rules = { ...btcPerpRules, maxPrice: D(0), tickSize: D(0) };
    // PERCENT_PRICE still applies, so a far price is tested against a far mark.
    expect(validatePerpOrder(limit('5000000.05'), rules, { mark: D('5000000'), openOrders: 0 })).toBeNull();
  });

  it('LOT_SIZE for limits', () => {
    expect(validatePerpOrder(limit('79900', { qty: D('0.0005') }), btcPerpRules, ok)).toBe(
      'LOT_SIZE: quantity 0.0005 is below the minimum 0.001',
    );
    expect(validatePerpOrder(limit('79900', { qty: D('1001') }), btcPerpRules, ok)).toBe(
      'LOT_SIZE: quantity 1001 is above the maximum 1000',
    );
    expect(validatePerpOrder(limit('79900', { qty: D('0.0015') }), btcPerpRules, ok)).toBe(
      'LOT_SIZE: quantity 0.0015 is not a multiple of step size 0.001',
    );
  });

  it('MARKET_LOT_SIZE for market orders', () => {
    expect(validatePerpOrder(market({ qty: D('121') }), btcPerpRules, ok)).toBe(
      'MARKET_LOT_SIZE: quantity 121 is above the market maximum 120',
    );
    expect(validatePerpOrder(market({ qty: D('0.0005') }), btcPerpRules, ok)).toBe(
      'MARKET_LOT_SIZE: quantity 0.0005 is below the market minimum 0.001',
    );
    // 121 is within LOT_SIZE but above MARKET_LOT_SIZE; a limit may use it.
    expect(validatePerpOrder(limit('79900', { qty: D('121') }), btcPerpRules, ok)).toBeNull();
  });

  it('MIN_NOTIONAL: mark × qty for market orders, price × qty for limits', () => {
    expect(validatePerpOrder(market({ qty: D('0.001') }), btcPerpRules, { mark: D('40000'), openOrders: 0 })).toBe(
      'MIN_NOTIONAL: order value 40 is below the minimum 50',
    );
    expect(validatePerpOrder(limit('40000', { qty: D('0.001') }), btcPerpRules, { mark: D('40000'), openOrders: 0 })).toBe(
      'MIN_NOTIONAL: order value 40 is below the minimum 50',
    );
    // Exactly the minimum passes.
    expect(validatePerpOrder(market({ qty: D('0.001') }), btcPerpRules, { mark: D('50000'), openOrders: 0 })).toBeNull();
  });

  it('reduce-only orders are exempt from MIN_NOTIONAL', () => {
    const req = market({ qty: D('0.001'), side: 'sell', reduceOnly: true });
    expect(validatePerpOrder(req, btcPerpRules, { mark: D('40000'), openOrders: 0 })).toBeNull();
  });

  it('PERCENT_PRICE: a buy limit at most up × mark, a sell limit at least down × mark', () => {
    expect(validatePerpOrder(limit('84001'), btcPerpRules, ok)).toBe(
      'PERCENT_PRICE: buy price 84001 is above the allowed maximum 84000 (1.05 × mark price 80000)',
    );
    expect(validatePerpOrder(limit('84000'), btcPerpRules, ok)).toBeNull();
    expect(validatePerpOrder(limit('75999.9', { side: 'sell' }), btcPerpRules, ok)).toBe(
      'PERCENT_PRICE: sell price 75999.9 is below the allowed minimum 76000 (0.95 × mark price 80000)',
    );
    expect(validatePerpOrder(limit('76000', { side: 'sell' }), btcPerpRules, ok)).toBeNull();
    // Each side has one bound: a low buy and a high sell pass.
    expect(validatePerpOrder(limit('70000'), btcPerpRules, ok)).toBeNull();
    expect(validatePerpOrder(limit('90000', { side: 'sell' }), btcPerpRules, ok)).toBeNull();
  });
});
