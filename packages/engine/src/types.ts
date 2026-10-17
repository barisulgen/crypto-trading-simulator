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

export interface PriceLevel {
  price: Decimal;
  qty: Decimal;
}

/** bids descending, asks ascending */
export interface BookSnapshot {
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface AggTrade {
  id: number;
  price: Decimal;
  qty: Decimal;
  sellerInitiated: boolean;
  time: number;
}

/** What the engine may know about the market. Implemented by the server's MarketData. */
export interface MarketView {
  isFresh(symbol: string): boolean;
  book(symbol: string): BookSnapshot;
  avgPrice(symbol: string): Decimal | null;
  lastPrice(symbol: string): Decimal | null;
  rules(symbol: string): SpotRules;
}

export interface FeeSchedule {
  maker: Decimal;
  taker: Decimal;
}

/** Everything impure the engine needs: time, randomness, ids and market data. */
export interface EngineCtx {
  now: number;
  rng(): number;
  newId(prefix: string): string;
  market: MarketView;
  fees: FeeSchedule;
}

export type OrderStatus =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'triggered'
  | 'filled'
  | 'cancelled'
  | 'rejected';

export interface SpotOrder {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: Decimal | null;
  quoteQty: Decimal | null;
  price: Decimal | null;
  triggerPrice: Decimal | null;
  status: OrderStatus;
  filledQty: Decimal;
  filledQuote: Decimal;
  fee: Decimal;
  feeAsset: string | null;
  lockAsset: string;
  lockAmount: Decimal;
  ocoGroupId: string | null;
  attach: { stopLoss: Decimal; takeProfit: Decimal } | null;
  createdAt: number;
  arrivesAt: number | null;
  triggeredAt: number | null;
  bestAtSubmit: Decimal | null;
  rejectReason: string | null;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: Decimal;
  price: Decimal;
  quote: Decimal;
  liquidity: 'maker' | 'taker';
  feeAsset: string;
  fee: Decimal;
  feeUsd: Decimal;
  bestAtArrival: Decimal | null;
  bestAtSubmit: Decimal | null;
  slippageUsd: Decimal;
  driftUsd: Decimal;
  triggerPrice: Decimal | null;
  realizedPnl: Decimal | null;
  roundTripId: string | null;
  time: number;
}

/** Average-cost basis of one coin (updated on every fill). */
export interface Basis {
  qty: Decimal;
  cost: Decimal;
  roundTripId: string | null;
  openedAt: number | null;
  tripRealized: Decimal;
}

export interface RoundTrip {
  id: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  pnl: Decimal;
}

export type CancelReason = 'user' | 'thin_book' | 'oco' | 'parent_cancelled';

export type EngineEvent =
  | { type: 'deposit'; time: number; wallet: Wallet; amount: Decimal; totalDeposited: Decimal }
  | { type: 'transfer'; time: number; from: Wallet; to: Wallet; amount: Decimal }
  | { type: 'order_placed'; time: number; order: SpotOrder }
  | { type: 'order_rejected'; time: number; order: SpotOrder; reason: string; afterTrigger?: boolean }
  | { type: 'order_cancelled'; time: number; order: SpotOrder; reason: CancelReason; cancelledQty: Decimal }
  | { type: 'order_triggered'; time: number; order: SpotOrder; lastPrice: Decimal }
  | { type: 'fill'; time: number; fill: Fill; order: SpotOrder }
  | { type: 'round_trip_closed'; time: number; roundTrip: RoundTrip };

export type ActionResult = { ok: true; events: EngineEvent[] } | { ok: false; reason: string };

/** Estimate shown before submitting. Amounts are null when they cannot be estimated. */
export interface OrderPreview {
  estAvgPrice: Decimal | null;
  estSlippageUsd: Decimal | null;
  /** Percent of the best-price value (0.07 means 0.07 %). */
  estSlippagePct: Decimal | null;
  fee: { asset: string | null; amount: Decimal | null; usd: Decimal | null };
  /** Buy: USDT paid. Sell: USDT received after the fee. */
  total: Decimal | null;
  /** Net amount of the received asset after the fee (coin for buys, USDT for sells). */
  receive: Decimal | null;
  exhausted: boolean;
  rejectReason: string | null;
}
