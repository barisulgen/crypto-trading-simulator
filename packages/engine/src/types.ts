import type { Decimal } from './decimal.ts';

export type Side = 'buy' | 'sell';
export type Wallet = 'spot' | 'leverage';
/** A Binance market. Perpetuals reuse the spot symbol names, so every per-symbol key also names the market. */
export type Market = 'spot' | 'perp';
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
  /** A copy of the whole book: costly, so read only when a walk needs the levels. */
  book(symbol: string): BookSnapshot;
  /** Best price a taker would hit (best ask for a buy, best bid for a sell), without copying the book. */
  best(symbol: string, side: Side): Decimal | null;
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
  /** For a leg of a pair attached to a buy: that buy's id. Null otherwise. */
  parentId: string | null;
  attach: { stopLoss: Decimal; takeProfit: Decimal } | null;
  createdAt: number;
  arrivesAt: number | null;
  /**
   * When the owner's cancel reaches the exchange (it takes an arrival delay like an order); null
   * when no cancel is in flight. Until then the order stays live: it can still fill or trigger.
   */
  cancelArrivesAt: number | null;
  triggeredAt: number | null;
  /**
   * Best price of the side the order takes, when it was sent to the exchange: at submit, or
   * for a stop/take-profit at trigger time (so a fill's drift measures trigger → execution).
   */
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

export type CancelReason =
  | 'user'
  | 'thin_book'
  | 'oco'
  | 'parent_cancelled'
  /** The market price band stopped a taker fill short. */
  | 'price_band'
  /** A reduce-only order asked for more than the position held. */
  | 'reduce_only'
  /** The position the order would reduce or close is gone. */
  | 'position_closed'
  | 'liquidation'
  /** The trade history needed to replay a gap is no longer available. */
  | 'catch_up_unavailable';

/** Order, fill and round-trip events carry `market` only optionally: absent means spot. */
export type EngineEvent =
  | { type: 'deposit'; time: number; wallet: Wallet; amount: Decimal; totalDeposited: Decimal }
  | { type: 'transfer'; time: number; from: Wallet; to: Wallet; amount: Decimal }
  | { type: 'order_placed'; market?: 'spot'; time: number; order: SpotOrder }
  | { type: 'order_rejected'; market?: 'spot'; time: number; order: SpotOrder; reason: string; afterTrigger?: boolean }
  | {
      type: 'order_cancelled';
      market?: 'spot';
      time: number;
      order: SpotOrder;
      reason: CancelReason;
      cancelledQty: Decimal;
    }
  /** The owner's cancel arrived after the order had filled, triggered, been rejected or been cancelled. */
  | { type: 'cancel_rejected'; market?: 'spot'; time: number; order: SpotOrder; reason: string }
  | { type: 'order_triggered'; market?: 'spot'; time: number; order: SpotOrder; lastPrice: Decimal }
  /**
   * `consumed`: for a taker fill, the quantity it took at each book level (walk order), so the
   * market can hold those levels back from later walks; absent for a maker fill.
   */
  | { type: 'fill'; market?: 'spot'; time: number; fill: Fill; order: SpotOrder; consumed?: PriceLevel[] }
  | { type: 'round_trip_closed'; market?: 'spot'; time: number; roundTrip: RoundTrip };

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
  /** Caveat shown with the estimate, e.g. 'Estimate if triggered now' for stops; null if none. */
  note: string | null;
}
