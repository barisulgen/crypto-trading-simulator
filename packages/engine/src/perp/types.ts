import type { CatchUpTag } from '../catchup/types.ts';
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
  /** The highest margin-ratio warning already given and not re-armed since; 0 for none. */
  warnLevel: 0 | WarnLevel;
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
  /**
   * Set on a close estimated from history that was held to the position's margin: its price capped
   * at the bankruptcy price, or its fee cut to what the margin left. Absent otherwise.
   */
  bankruptcyCapped?: true;
  /** With bankruptcyCapped: the price the close would have filled at without the cap. */
  uncappedPrice?: Decimal;
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

/** Margin-ratio levels at which the owner is warned that a position nears liquidation. */
export type WarnLevel = 0.5 | 0.8 | 0.9;

/** The position's margin ratio has reached a warning level it had not reached before (or since it re-armed). */
export interface MarginWarning {
  symbol: string;
  positionId: string;
  /** The side of the position warned about. */
  side: PositionSide;
  level: WarnLevel;
  /** Maintenance margin ÷ margin balance at the mark. */
  ratio: Decimal;
  markPrice: Decimal;
  /** Null when the position can no longer be liquidated by a price fall (a long with enough margin). */
  liquidationPrice: Decimal | null;
}

/**
 * Events a catch-up run produced carry `catchUp`: the gap and what the event was estimated from;
 * their time is the moment they represent.
 */
export type PerpEvent = (
  | { type: 'leverage_set'; market: 'perp'; time: number; symbol: string; leverage: number }
  | {
      type: 'margin_changed';
      market: 'perp';
      time: number;
      symbol: string;
      /** The side of the position the margin went into or came out of. */
      side: PositionSide;
      action: 'add' | 'remove';
      amount: Decimal;
      marginAfter: Decimal;
      /** Null when the position can no longer be liquidated by a price fall (a long with enough margin). */
      liquidationPriceAfter: Decimal | null;
    }
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
  /**
   * Funding settled at `fundingTime` on `qty` of the position's side, at the settled rate and the
   * mark price at settlement. `amount` is negative when paid. A payment comes from the position's
   * margin while the position exists (target 'margin'), then from free leverage USDT; a receipt
   * goes to free leverage USDT (target 'wallet'). `uncollected` is the part of a payment neither
   * could cover; null when none. A payment whose window size was reached by an earlier position
   * than the last one held (closed or liquidated inside the window) is two events: the last
   * position on the size it held itself, then the earlier one on the rest, from the wallet.
   */
  | {
      type: 'funding';
      market: 'perp';
      time: number;
      symbol: string;
      positionId: string;
      fundingTime: number;
      rate: Decimal;
      markPrice: Decimal;
      qty: Decimal;
      side: PositionSide;
      amount: Decimal;
      target: 'margin' | 'wallet';
      uncollected: Decimal | null;
    }
  /**
   * An isolated position was liquidated at the mark: the whole margin is lost (marginLost), split
   * into the trading loss at the mark, the liquidation fee, and any remainder, also lost. The
   * leverage wallet outside the margin is not touched.
   */
  | {
      type: 'liquidation';
      market: 'perp';
      time: number;
      symbol: string;
      /** The position as it was when liquidated. */
      position: Position;
      markPrice: Decimal;
      marginLost: Decimal;
      tradingLoss: Decimal;
      liquidationFee: Decimal;
      remainder: Decimal;
      /**
       * False when the symbol's liquidation fee rate was not loaded: everything left after the
       * trading loss is then booked as the fee, with no remainder. The money lost is the same.
       */
      feeRateKnown: boolean;
      /** The live orders on the symbol that the liquidation cancelled. */
      cancelledOrderIds: string[];
    }
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
      /** Set when the closing fill was held to the position's margin (see PerpFill). */
      bankruptcyCapped?: true;
      /** With bankruptcyCapped: the price the close would have filled at without the cap. */
      uncappedPrice?: Decimal;
    }
) & { catchUp?: CatchUpTag };

/**
 * What adding or removing margin would do now, as the action itself would judge it: the margin and
 * the (unrounded) liquidation price after it, or the refusal. `maxRemovable` is the most a removal
 * may take at the current fresh mark, null without one (or without the tiers or a position).
 */
export interface MarginPreview {
  marginAfter: Decimal | null;
  liquidationPriceAfter: Decimal | null;
  maxRemovable: Decimal | null;
  rejectReason: string | null;
}

/** The outcome of an owner action on the perp account: its events, or why it was refused. */
export type PerpActionResult = { ok: true; events: PerpEvent[] } | { ok: false; reason: string };
