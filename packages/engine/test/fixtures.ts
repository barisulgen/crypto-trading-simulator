import { D } from '../src/decimal.ts';
import type { SpotRules } from '../src/types.ts';

export const btcRules: SpotRules = {
  symbol: 'BTCUSDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: D('0.01'),
  minPrice: D('0.01'),
  maxPrice: D('1000000'),
  stepSize: D('0.00001'),
  minQty: D('0.00001'),
  maxQty: D('9000'),
  marketMinQty: D('0'),
  marketMaxQty: D('114.06718587'),
  marketStepSize: D('0'),
  minNotional: D('5'),
  maxNotional: D('9000000'),
  applyMinToMarket: true,
  applyMaxToMarket: false,
  bidMultiplierUp: D('1.2'),
  bidMultiplierDown: D('0.5'),
  askMultiplierUp: D('2'),
  askMultiplierDown: D('0.8'),
  maxNumOrders: 200,
  maxNumAlgoOrders: 5,
};
