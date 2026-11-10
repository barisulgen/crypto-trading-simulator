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
