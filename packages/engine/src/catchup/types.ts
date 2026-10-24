import type { Decimal } from '../decimal.ts';
import type { AggTrade, Market } from '../types.ts';

/** One 1-minute candle (last price, or mark price for mark candles), opening at `openTime`. */
export interface Candle1m {
  openTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
}

/** What a catch-up event was estimated from. */
export type CatchUpBasis =
  | 'candle_worst_price'
  | 'trigger_minute_worst_price'
  | 'mark_candle'
  | 'funding_history'
  | 'aggtrade_replay'
  | 'history_unavailable';

/** Carried by every event a catch-up run produces: the gap it covered and what the event was estimated from. */
export interface CatchUpTag {
  from: number;
  to: number;
  basis: CatchUpBasis;
}

/** Everything one catch-up run over a gap of one market and symbol needs. */
export interface CatchUpInput {
  market: Market;
  symbol: string;
  /** The gap: from when live data stopped to when it was fresh again. */
  from: number;
  to: number;
  /** The last trade id processed before the gap; replayed trades must come after it. Null when unknown. */
  lastTradeIdBefore: number | null;
  /** The first trade id processed live after the gap; replayed trades must come before it. Null when unknown. */
  endTradeId: number | null;
  /** Last-price candles covering [floorMinute(min(from, earliest triggeredAt)), to]. */
  candles: Candle1m[];
  /** The trades of the minutes catchUpNeeds asked for, or 'unavailable' when that history is gone. */
  trades: AggTrade[] | 'unavailable';
  markCandles?: Candle1m[];
  funding?: { time: number; rate: Decimal; markPrice: Decimal }[];
}

/** The data a catch-up run needs beyond the last-price candles. */
export interface CatchUpNeeds {
  /** Open times of the minutes whose trades must be fetched, ascending. */
  tradeMinutes: number[];
  markCandles: boolean;
  funding: boolean;
}

/**
 * The summary after a catch-up run that had an order or a position to look after: what was applied,
 * one line per action, each marked estimated. Emitted even when nothing was applied (no actions).
 */
export interface CatchUpEvent {
  type: 'catch_up';
  market: Market;
  symbol: string;
  time: number;
  from: number;
  to: number;
  actions: string[];
}
