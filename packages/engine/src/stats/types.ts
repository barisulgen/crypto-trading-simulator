import type { Decimal } from '../decimal.ts';
import type { PositionCloseReason, PositionSide } from '../perp/types.ts';
import type { SimEvent } from '../sim.ts';

/** One persisted event with the row id it was stored under. */
export interface StatsEvent {
  id: number;
  time: number;
  event: SimEvent;
}

/**
 * One closed trade: a perpetual position from open to close, or a spot round trip from the buy that
 * opened it to the sale that left only dust.
 */
export interface Trade {
  /** The position id or the round trip id. */
  id: string;
  market: 'spot' | 'perp';
  symbol: string;
  /** Spot trades are always long. */
  side: PositionSide;
  /** Null for a spot trade. */
  leverage: number | null;
  openedAt: number;
  closedAt: number;
  /** The row id of the event that closed the trade. */
  closeEventId: number;
  /** Net of trading fees (and, for a perp trade, funding). */
  result: Decimal;
  /** Trading fees of the trade, in USDT. */
  fees: Decimal;
  /** Net funding of a perp trade (positive when received); zero for spot. */
  funding: Decimal;
  /** Any event of the trade was produced by a catch-up run. */
  estimated: boolean;
  reason: PositionCloseReason | 'round_trip';
}

/** A position or round trip that has not closed yet. */
export interface OpenTrade {
  market: 'spot' | 'perp';
  symbol: string;
  id: string;
}

export interface BuiltTrades {
  /** Sorted by closing time, then by the closing event's row id. */
  trades: Trade[];
  open: OpenTrade[];
}

/** Win rate, averages, profit factor, expectancy, extremes and streaks of a set of closed trades. */
export interface TradeQuality {
  count: number;
  wins: number;
  losses: number;
  breakEven: number;
  /** A fraction: 0.5 is 50 %. Null with no trades. */
  winRate: Decimal | null;
  avgWin: Decimal | null;
  /** Negative. */
  avgLoss: Decimal | null;
  /** Gross wins over the size of gross losses. Null when there is no losing trade. */
  profitFactor: Decimal | null;
  /** True when there are trades and none lost. */
  noLosses: boolean;
  /** Mean result per trade. */
  expectancy: Decimal | null;
  best: Trade | null;
  worst: Trade | null;
  longestWinStreak: number;
  longestLossStreak: number;
}

/** What trading cost, in USDT, over a set of events. */
export interface Costs {
  makerFees: Decimal;
  takerFees: Decimal;
  liquidationFees: Decimal;
  /** Positive. */
  fundingPaid: Decimal;
  fundingReceived: Decimal;
  /** Received minus paid. */
  fundingNet: Decimal;
  /** Fill slippage plus the catch-up gap cost. */
  slippage: Decimal;
  /** The part of `slippage` that a stop or take-profit gapped through its trigger in a catch-up estimate. */
  catchUpGapCost: Decimal;
  /** Price drift between order arrival and fill; informational, not in `total`. */
  drift: Decimal;
  /** Fees, liquidation fees, slippage and funding paid on net (funding received does not reduce it). */
  total: Decimal;
  /** `total` over `preCost`; null when `preCost` is not above zero. */
  share: Decimal | null;
  /** Net P&L before costs: the net P&L plus `total`. */
  preCost: Decimal;
  /** Losses neither the margin nor free leverage USDT could cover. */
  uncovered: Decimal;
  /** Fills produced by a catch-up run. */
  estimatedFills: number;
}

/** Liquidations and leverage over a range. */
export interface Risk {
  liquidations: number;
  lostToLiquidations: Decimal;
  liquidationFees: Decimal;
  /** Mean leverage of the positions open in the range; null when there are none. */
  avgLeverage: Decimal | null;
  maxLeverage: number | null;
}
