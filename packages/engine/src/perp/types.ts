import type { Decimal } from '../decimal.ts';
import type { BookSnapshot, CancelReason, FeeSchedule, Fill, OrderStatus, PriceLevel, Side } from '../types.ts';

/** A perpetual position's direction: a long gains when the price rises, a short when it falls. */
export type PositionSide = 'long' | 'short';

/** Binance USDⓈ-M perpetual trading rules for one symbol (fapi exchangeInfo). */
export interface PerpRules {
  symbol: string;
  base: string;
  quote: string;
  status: string;
  tickSize: Decimal;
  minPrice: Decimal;
  maxPrice: Decimal;
  stepSize: Decimal;
  minQty: Decimal;
  maxQty: Decimal;
  marketStepSize: Decimal;
  marketMinQty: Decimal;
  marketMaxQty: Decimal;
  minNotional: Decimal;
  maxNumOrders: number;
  multiplierUp: Decimal;
  multiplierDown: Decimal;
  liquidationFee: Decimal;
  marketTakeBound: Decimal;
}

/** One leverage tier: positions with notional in [floor, cap) use this maintenance rate and maximum leverage. */
export interface Bracket {
  floor: Decimal;
  cap: Decimal;
  /** Maintenance margin ratio. */
  mmr: Decimal;
  /** Maintenance amount: maintenance margin = notional × mmr − cum. */
  cum: Decimal;
  maxLeverage: number;
}

/** Where a tier table came from: the signed endpoint, the public web endpoint, or the copy shipped with the server. */
export type TierSource = 'official' | 'unofficial' | 'bundled';

export interface TierSet {
  source: TierSource;
  /** Epoch ms the tables were fetched (for the bundled copy, when that copy was taken). */
  fetchedAt: number;
  /** Per symbol, ascending by floor and contiguous from 0. */
  brackets: Record<string, Bracket[]>;
}

/** What the perp engine may know about the futures market. Never invents a price. */
export interface PerpMarketView {
  /** Book, trades and mark price all fresh, rules and leverage tiers loaded, and Binance TRADING the symbol. */
  isFresh(symbol: string): boolean;
  /** The mark price's connection is healthy and its last update is current and at most 10 000 ms old. */
  isMarkFresh(symbol: string): boolean;
  /** A copy of the whole book: costly, so read only when a walk needs the levels. */
  book(symbol: string): BookSnapshot;
  /** Best price a taker would hit (best ask for a buy, best bid for a sell), without copying the book. */
  best(symbol: string, side: Side): Decimal | null;
  /** The last trade price received, fresh or not; null before the first. */
  lastPrice(symbol: string): Decimal | null;
  /** The last mark price received, fresh or not (see isMarkFresh); null before the first. */
  markPrice(symbol: string): Decimal | null;
  rules(symbol: string): PerpRules;
  /** Leverage tiers, ascending by floor and contiguous from 0. */
  brackets(symbol: string): Bracket[];
}

/** An open isolated position. At most one per symbol (one-way mode). */
export interface Position {
  id: string;
  symbol: string;
  side: PositionSide;
  qty: Decimal;
  /** Quantity-weighted average of the opening fills. */
  entryPrice: Decimal;
  leverage: number;
  /** Isolated margin: what the owner loses at most, net of the fees and funding already taken from it. */
  margin: Decimal;
  openedAt: number;
  /** Trading P&L of the reducing fills so far, before fees. */
  realizedPnl: Decimal;
  /** Every trading fee paid on the position, opening and closing. */
  fees: Decimal;
  /** Net funding: positive when received, negative when paid. */
  funding: Decimal;
  /** The highest margin-ratio warning already given. */
  warnLevel: 0 | 0.5 | 0.8 | 0.9;
}

export type PerpOrderType = 'market' | 'limit' | 'post_only' | 'stop_loss' | 'take_profit';

export interface PerpOrder {
  id: string;
  symbol: string;
  side: Side;
  type: PerpOrderType;
  /** Base quantity; for an order sized in USDT, the quantity it was converted to. Null for a close-position stop. */
  qty: Decimal | null;
  /** The USDT notional typed by the owner, or null when sized in the coin. */
  quoteQty: Decimal | null;
  price: Decimal | null;
  triggerPrice: Decimal | null;
  reduceOnly: boolean;
  /** Closes whatever the position holds when it executes. */
  closePosition: boolean;
  leverage: number;
  status: OrderStatus;
  filledQty: Decimal;
  filledQuote: Decimal;
  fee: Decimal;
  /** Leverage-wallet USDT still locked for the order. */
  lockAmount: Decimal;
  ocoGroupId: string | null;
  parentId: string | null;
  attach: { stopLoss: Decimal | null; takeProfit: Decimal | null } | null;
  createdAt: number;
  arrivesAt: number | null;
  triggeredAt: number | null;
  /** When the owner's cancel reaches the exchange; null when no cancel is in flight. */
  cancelArrivesAt: number | null;
  /** Best price of the side the order takes when it was sent to the exchange. */
  bestAtSubmit: Decimal | null;
  rejectReason: string | null;
  /** Trading P&L the order's reducing fills realised, before fees. */
  realizedPnl: Decimal;
}

export interface PerpOrderRequest {
  symbol: string;
  side: Side;
  type: 'market' | 'limit' | 'post_only';
  qty?: string;
  /** USDT notional, converted to a quantity at the mark price (limit price for limits). */
  quoteQty?: string;
  price?: string;
  reduceOnly?: boolean;
  attach?: { stopLoss?: string; takeProfit?: string };
}

/** Everything impure the perp engine needs: time, randomness, ids and futures market data. */
export interface PerpCtx {
  now: number;
  rng(): number;
  newId(prefix: string): string;
  market: PerpMarketView;
  fees: FeeSchedule;
}

export interface PerpFill extends Omit<Fill, 'roundTripId'> {
  market: 'perp';
  positionId: string;
  /** Margin the fill moved into the position (opening fills); null for reducing fills. */
  marginIn: Decimal | null;
  /** A reducing fill's loss that neither the position's margin nor free leverage USDT could cover; null when none. */
  uncovered: Decimal | null;
}

/** Estimate shown before submitting. Amounts are null when they cannot be estimated. */
export interface PerpPreview {
  estAvgPrice: Decimal | null;
  estSlippageUsd: Decimal | null;
  /** Percent of the best-price value (0.07 means 0.07 %). */
  estSlippagePct: Decimal | null;
  /** Quote value of the estimated fill. */
  notional: Decimal | null;
  /** Taker fee of the estimated fill. */
  fee: Decimal | null;
  /** Leverage USDT the order would lock (0 for reduce-only). */
  marginRequired: Decimal | null;
  /** Liquidation price of the position the estimated fill would leave; null if none or never liquidated. */
  estLiquidationPrice: Decimal | null;
  leverage: number;
  maxLeverage: number;
  /** The fill would stop short of the quantity (thin book or price band). */
  exhausted: boolean;
  /** The market price band, not the book, would stop the fill short. */
  bandLimited: boolean;
  rejectReason: string | null;
  note: string | null;
}

export type PositionCloseReason = 'closed' | 'stop_loss' | 'take_profit' | 'liquidated';

export type PerpEvent =
  | { type: 'order_placed'; market: 'perp'; time: number; order: PerpOrder }
  | { type: 'order_rejected'; market: 'perp'; time: number; order: PerpOrder; reason: string; afterTrigger?: boolean }
  | {
      type: 'order_cancelled';
      market: 'perp';
      time: number;
      order: PerpOrder;
      reason: CancelReason;
      cancelledQty: Decimal;
    }
  | { type: 'cancel_rejected'; market: 'perp'; time: number; order: PerpOrder; reason: string }
  | { type: 'order_triggered'; market: 'perp'; time: number; order: PerpOrder; lastPrice: Decimal }
  /** `consumed`: for a taker fill, the quantity it took at each book level (walk order); absent for a maker fill. */
  | { type: 'fill'; market: 'perp'; time: number; fill: PerpFill; order: PerpOrder; consumed?: PriceLevel[] }
  | { type: 'position_opened'; market: 'perp'; time: number; position: Position }
  | {
      type: 'position_closed';
      market: 'perp';
      time: number;
      /** The position as it closed (quantity 0). */
      position: Position;
      exitPrice: Decimal;
      realizedPnl: Decimal;
      fees: Decimal;
      funding: Decimal;
      holdMs: number;
      reason: PositionCloseReason;
    };
