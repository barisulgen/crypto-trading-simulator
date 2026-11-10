import type { Decimal } from '../decimal.ts';
import type { PerpState } from '../perp/state.ts';
import type { SpotState } from '../spot/state.ts';
import { isLimitType } from '../spot/limit.ts';
import type { AggTrade, OrderStatus, Side } from '../types.ts';
import type { Candle1m, CatchUpInput, CatchUpLine, CatchUpNeeds, CatchUpTime } from './types.ts';

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
 * The candles a run walks, in time order: every one that opens before `to`, each minute once (the
 * first candle given for it). Those before the gap are there only for the trigger minutes of
 * orders triggered before it.
 */
export function walkedCandles(candles: Candle1m[], to: number): Candle1m[] {
  const byMinute = new Map<number, Candle1m>();
  for (const c of candles) if (c.openTime < to && !byMinute.has(c.openTime)) byMinute.set(c.openTime, c);
  return [...byMinute.values()].sort((a, b) => a.openTime - b.openTime);
}

/** A resting limit or post-only order (spot or perp), filled only by trades through it. */
export function restingLimit(o: { type: string; status: OrderStatus }): boolean {
  return isLimitType(o) && (o.status === 'open' || o.status === 'partially_filled');
}

/** What the trade-minute check reads of a resting limit order, spot or perp. */
interface RestingLimit {
  side: Side;
  price: Decimal | null;
  arrivesAt: number | null;
  cancelArrivesAt: number | null;
}

/** Whether a minute's price range went strictly through the limit price: a buy below it, a sell above it. */
export function crossesLimit(o: Pick<RestingLimit, 'side' | 'price'>, c: Candle1m): boolean {
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
  return crossedMinutes(resting, from, to, candles);
}

/** The minutes of the gap whose candle went strictly through one of `resting` while it could fill. */
function crossedMinutes(resting: RestingLimit[], from: number, to: number, candles: Candle1m[]): number[] {
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
 * The perp data a catch-up run needs: trades for the minutes that crossed a resting limit (as for
 * spot); mark candles while a position is open or an opening order rests, since either can be
 * liquidated; funding history then too, or while a funding window of the symbol waits to settle.
 */
export function perpCatchUpNeeds(
  s: PerpState,
  symbol: string,
  from: number,
  to: number,
  candles: Candle1m[],
): CatchUpNeeds {
  const resting = [...s.orders.values()].filter((o) => o.symbol === symbol && restingLimit(o) && o.arrivesAt !== null);
  const exposed = s.positions[symbol] !== undefined || resting.some((o) => !o.reduceOnly);
  const window = s.funding.windows[symbol] !== undefined || s.funding.pending.some((w) => w.symbol === symbol);
  return { tradeMinutes: crossedMinutes(resting, from, to, candles), markCandles: exposed, funding: exposed || window };
}

/**
 * The replayed trades a run may use, in time order: after the last trade processed before the gap
 * and after `cursor` (the last trade already processed, live or by an earlier run over an
 * overlapping gap), and before the first one processed live after it; when that one is unknown,
 * before the end of the gap, each id once. Each order also takes only trades after its own arrival
 * (checked when matching).
 */
export function usableTrades(
  input: Pick<CatchUpInput, 'lastTradeIdBefore' | 'endTradeId' | 'to'>,
  trades: AggTrade[],
  cursor: number | undefined,
): AggTrade[] {
  const after = Math.max(input.lastTradeIdBefore ?? -Infinity, cursor ?? -Infinity);
  // A trade given twice (a paginated fetch repeats the trade on a page boundary) is used once.
  const byId = new Map<number, AggTrade>();
  for (const t of trades) {
    const inRange = t.id > after && (input.endTradeId === null ? t.time < input.to : t.id < input.endTradeId);
    if (inRange && !byId.has(t.id)) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => a.time - b.time || a.id - b.id);
}

// ---- prices and times shared by the spot and perp runs ----

/** The price a stop executes at inside a minute: the low for a sell, the high for a buy. */
export function worstPrice(side: Side, c: Candle1m): Decimal {
  return side === 'sell' ? c.low : c.high;
}

/**
 * The candle extreme that tells whether a stop triggered in the minute: the high for those that
 * trigger on a rise (buy stop-loss, sell take-profit), the low for the others.
 */
export function reachingPrice(o: { type: string; side: Side }, c: Candle1m): Decimal {
  const upward = (o.type === 'stop_loss') === (o.side === 'buy');
  return upward ? c.high : c.low;
}

/** Times in summary lines, as data: a minute (shown HH:MM) and a moment to the second (HH:MM:SS). */
export const hhmm = (t: number): CatchUpTime => ({ at: t, seconds: false });
export const hhmmss = (t: number): CatchUpTime => ({ at: t, seconds: true });

const isTime = (v: unknown): v is CatchUpTime =>
  typeof v === 'object' && v !== null && typeof (v as CatchUpTime).at === 'number' && typeof (v as CatchUpTime).seconds === 'boolean';

/**
 * A summary line from a template literal: each time (hhmm, hhmmss) kept as data, a line given inside
 * another spliced into it, anything else as its text; neighbouring text joined into one string.
 */
export function line(strings: TemplateStringsArray, ...values: unknown[]): CatchUpLine {
  const out: CatchUpLine = [];
  const text = (s: string) => {
    if (s === '') return;
    const last = out.length - 1;
    if (typeof out[last] === 'string') out[last] += s;
    else out.push(s);
  };
  const part = (v: unknown) => (isTime(v) ? out.push(v) : text(String(v)));
  strings.forEach((s, i) => {
    text(s);
    if (i >= values.length) return;
    const v = values[i];
    if (Array.isArray(v)) v.forEach(part);
    else part(v);
  });
  return out;
}

/** A summary line as text, its times in UTC and saying so: "12:04 UTC", "12:04:50 UTC". */
export function utcText(l: CatchUpLine): string {
  return l.map((p) => (typeof p === 'string' ? p : `${new Date(p.at).toISOString().slice(11, p.seconds ? 19 : 16)} UTC`)).join('');
}

export const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
