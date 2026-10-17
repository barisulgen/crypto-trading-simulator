import type { Decimal } from './decimal.ts';

export type Side = 'buy' | 'sell';
export type Wallet = 'spot' | 'leverage';
export type OrderType = 'market' | 'limit' | 'post_only' | 'stop_loss' | 'take_profit';

export interface SpotRules {
  symbol: string;
  base: string;
  quote: string;
  tickSize: Decimal;
  minPrice: Decimal;
  maxPrice: Decimal;
  stepSize: Decimal;
  minQty: Decimal;
  maxQty: Decimal;
  marketMinQty: Decimal; // 0 = defer to LOT_SIZE
  marketMaxQty: Decimal;
  marketStepSize: Decimal; // 0 = defer to LOT_SIZE
  minNotional: Decimal;
  maxNotional: Decimal;
  applyMinToMarket: boolean;
  applyMaxToMarket: boolean;
  bidMultiplierUp: Decimal;
  bidMultiplierDown: Decimal;
  askMultiplierUp: Decimal;
  askMultiplierDown: Decimal;
  maxNumOrders: number;
  maxNumAlgoOrders: number;
}

export interface SpotOrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  qty?: string;
  quoteQty?: string;
  price?: string;
  triggerPrice?: string;
  attach?: { stopLoss: string; takeProfit: string }; // buys only
}

export interface NormalizedRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  qty?: Decimal;
  quoteQty?: Decimal;
  price?: Decimal;
  triggerPrice?: Decimal;
  attach?: { stopLoss: Decimal; takeProfit: Decimal };
}
