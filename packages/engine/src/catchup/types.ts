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

/**
 * What a catch-up event was estimated from; 'cancel_arrival' marks an owner's cancel delivered at
 * its own arrival time, not an estimate.
 */
export type CatchUpBasis =
  | 'candle_worst_price'
  | 'trigger_minute_worst_price'
  | 'mark_candle'
  | 'funding_history'
  | 'aggtrade_replay'
  | 'history_unavailable'
  | 'cancel_arrival';

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
  /**
   * The first trade id processed live after the gap; replayed trades must come before it. Null when
   * unknown: replayed trades must then come before `to`.
   */
  endTradeId: number | null;
  /** Last-price candles covering [floorMinute(min(from, earliest triggeredAt)), to]. */
  candles: Candle1m[];
  /** The trades of the minutes catchUpNeeds asked for, or 'unavailable' when that history is gone. */
  trades: AggTrade[] | 'unavailable';
  markCandles?: Candle1m[];
  funding?: { time: number; rate: Decimal; markPrice: Decimal }[];
  /**
   * Perps: the time of every funding record fetched with `funding`, usable as a settlement or not
   * (one with a rate but no mark price, say). A record within 60 s of a funding time shows that time
   * happened, so it is never judged to have been skipped.
   */
  fundingRecords?: number[];
  /**
   * Perps: funding times whose window the run models though no settlement is given for them (not
   * published yet, or one whose window reaches past the end of the gap). Each window whose opening
   * (15 s before its funding time) falls before `to` opens then, seeded with the position the walk
   * has, and is widened by the gap's fills; one whose close (15 s after) also falls before `to`
   * closes then and waits for its rate. Either is left to the live path to settle. A time also
   * given in `funding` is settled from there.
   */
  fundingTimes?: number[];
}

/** The data a catch-up run needs beyond the last-price candles. */
export interface CatchUpNeeds {
  /** Open times of the minutes whose trades must be fetched, ascending. */
  tradeMinutes: number[];
  markCandles: boolean;
  funding: boolean;
}

/** A time a summary line names, as data: the minute (shown HH:MM) or, with `seconds`, the moment (HH:MM:SS). */
export interface CatchUpTime {
  at: number;
  seconds: boolean;
}

/** One summary line: its text, with each time it names kept as data, so a reader can show it in its own time zone. */
export type CatchUpLine = (string | CatchUpTime)[];

/**
 * The summary after a catch-up run that had an order or a position to look after: what was applied,
 * one line per action, each marked estimated. Emitted even when nothing was applied (no actions).
 * `actions` are the lines as text, their times in UTC and saying so (for logs, and for any reader
 * that does not format the times itself); `lines` the same lines with their times as data. An event
 * recorded before the times were kept as data has `actions` only.
 */
export interface CatchUpEvent {
  type: 'catch_up';
  market: Market;
  symbol: string;
  time: number;
  from: number;
  to: number;
  actions: string[];
  lines?: CatchUpLine[];
}
