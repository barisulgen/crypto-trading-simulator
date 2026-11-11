import type { Decimal } from '../decimal.ts';
import type { Position, PositionCloseReason, PositionSide } from '../perp/types.ts';
import type { SimEvent } from '../sim.ts';
import type { AccountValue } from '../spot/accounting.ts';
import type { Basis, SpotRules, Wallet } from '../types.ts';
import type { Breakdowns } from './breakdowns.ts';
import type { Drawdown, PnlPoint, Scope, Snapshot } from './equity.ts';

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
  /** Dust sales (they carry no round trip) made before any trip of their coin had closed. */
  unattributed: StatsEvent[];
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

/** Which part of the record the stats cover. Bounds are inclusive; a null field does not filter. */
export interface StatsFilter {
  from: number | null;
  to: number | null;
  symbol: string | null;
  /** 'spot' is the spot wallet and spot trades; 'leverage' the leverage wallet and perp trades. */
  market: 'spot' | 'leverage' | null;
}

/** Everything the stats are computed from: the record, and the account as it is now. */
export interface StatsInput {
  events: StatsEvent[];
  snapshots: Snapshot[];
  now: number;
  account: AccountValue;
  basis: Record<string, Basis>;
  positions: Position[];
  /** False while any price is paused or anything is catching up: the current value is then not used. */
  live: boolean;
  /** The BTC ask each deposit's benchmark buy is made at, by the deposit's event row id. */
  benchmarkBuys: { depositEventId: number; price: Decimal }[];
  btcRules: SpotRules;
  spotTakerFee: Decimal;
  /** The current BTC best bid; null when there is none. */
  btcBid: Decimal | null;
  /** The IANA time zone hours and weekdays are read in. */
  tz: string;
}

export interface StatsHeadline {
  scope: Scope;
  netPnl: Decimal;
  /** A fraction of capitalMax; null when that is not above zero. */
  returnPct: Decimal | null;
  /** The highest capital of the scope during the range. */
  capitalMax: Decimal;
  /** The account's total value, or under a market filter the wallet's. */
  currentValue: Decimal;
  /** Total deposited, or under a market filter the wallet's capital. */
  deposited: Decimal;
  /** The figures include the current value at live prices. */
  live: boolean;
}

/** Buying BTC with every deposit and holding it, measured over the whole account. */
export interface StatsBenchmark {
  scope: 'account';
  /** Deposits with no BTC price to buy at; while any is missing every figure is null. */
  missing: number;
  /** The benchmark's value at the end of the range; null when it cannot be priced. */
  value: Decimal | null;
  pnl: Decimal | null;
  returnPct: Decimal | null;
  /** The benchmark's value at each point of the account series with a known BTC bid. */
  series: { time: number; value: Decimal }[];
}

/**
 * A deposit, or under a wallet filter a transfer into or out of the wallet, for the equity chart.
 * `wallet` is the wallet the deposit went into, or for a transfer the filtered wallet.
 */
export interface StatsMarker {
  time: number;
  kind: 'deposit' | 'transfer_in' | 'transfer_out';
  amount: Decimal;
  wallet: Wallet;
}

export interface StatsReport {
  headline: StatsHeadline;
  series: PnlPoint[];
  /** The deposits in the range (for every filter) and, under a market filter, its wallet's transfers; by time. */
  markers: StatsMarker[];
  drawdown: Drawdown;
  quality: TradeQuality;
  risk: Risk;
  costs: Costs;
  breakdowns: Breakdowns;
  benchmark: StatsBenchmark;
  /** Positions and round trips still open, and their unrealised P&L now (null when one is unpriced). */
  open: { count: number; unrealized: Decimal | null };
  /** Dust sales that belong to no trade; their P&L is in the net P&L but in no trade figure. */
  unattributed: { count: number; realized: Decimal };
  /** Closed trades and fills in scope that a catch-up run estimated. */
  estimated: { trades: number; fills: number };
}
