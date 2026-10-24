import type { SpotState } from '../spot/state.ts';
import { isLimitType } from '../spot/limit.ts';
import type { AggTrade, SpotOrder } from '../types.ts';
import type { Candle1m, CatchUpInput, CatchUpNeeds } from './types.ts';

/** Which minutes and data a catch-up run needs, and the minute walk every run shares. */

export const MINUTE_MS = 60_000;

/** The open time of the minute `t` falls in. */
export function floorMinute(t: number): number {
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

/** Whether the minute opening at `openTime` overlaps the gap [from, to). */
export function inGap(openTime: number, from: number, to: number): boolean {
  return openTime + MINUTE_MS > from && openTime < to;
}

/**
 * The candles a run walks, in time order: every one that opens before `to`. Those before the gap
 * are there only for the trigger minutes of orders triggered before it.
 */
export function walkedCandles(candles: Candle1m[], to: number): Candle1m[] {
  return candles.filter((c) => c.openTime < to).sort((a, b) => a.openTime - b.openTime);
}

/** A resting limit or post-only order, filled only by trades through it. */
export function restingLimit(o: SpotOrder): boolean {
  return isLimitType(o) && (o.status === 'open' || o.status === 'partially_filled');
}

/** Whether a minute's price range went strictly through the limit price: a buy below it, a sell above it. */
export function crossesLimit(o: Pick<SpotOrder, 'side' | 'price'>, c: Candle1m): boolean {
  return o.side === 'buy' ? c.low.lt(o.price!) : c.high.gt(o.price!);
}

/**
 * The spot minutes of the gap whose trades must be fetched: those whose candle went strictly
 * through a resting limit or post-only order that had reached the exchange by the minute's end
 * and whose owner's cancel had not arrived before the minute began.
 */
export function spotTradeMinutes(
  s: SpotState,
  symbol: string,
  from: number,
  to: number,
  candles: Candle1m[],
): number[] {
  const resting = [...s.orders.values()].filter((o) => o.symbol === symbol && restingLimit(o) && o.arrivesAt !== null);
  const minutes = walkedCandles(candles, to).filter(
    (c) =>
      inGap(c.openTime, from, to) &&
      resting.some(
        (o) =>
          o.arrivesAt! < c.openTime + MINUTE_MS &&
          (o.cancelArrivesAt === null || o.cancelArrivesAt >= c.openTime) &&
          crossesLimit(o, c),
      ),
  );
  return [...new Set(minutes.map((c) => c.openTime))];
}

/** The spot data a catch-up run needs: trades for the minutes that crossed a resting limit. */
export function spotCatchUpNeeds(
  s: SpotState,
  symbol: string,
  from: number,
  to: number,
  candles: Candle1m[],
): CatchUpNeeds {
  return { tradeMinutes: spotTradeMinutes(s, symbol, from, to, candles), markCandles: false, funding: false };
}

/**
 * The replayed trades a run may use, in time order: after the last trade processed before the gap
 * and before the first one processed live after it. Each order also takes only trades after its own
 * arrival (checked when matching).
 */
export function usableTrades(
  input: Pick<CatchUpInput, 'lastTradeIdBefore' | 'endTradeId'>,
  trades: AggTrade[],
): AggTrade[] {
  return trades
    .filter(
      (t) =>
        (input.lastTradeIdBefore === null || t.id > input.lastTradeIdBefore) &&
        (input.endTradeId === null || t.id < input.endTradeId),
    )
    .sort((a, b) => a.time - b.time || a.id - b.id);
}

