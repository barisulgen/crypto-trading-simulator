import { D, Decimal } from '../decimal.ts';
import { fundingAmount } from './math.ts';
import { creditUsdt, debitUsdt, freeUsdt } from './state.ts';
import type { FundingSide, FundingWindow, PerpState } from './state.ts';
import type { PerpCtx, PerpEvent, PositionSide } from './types.ts';

/**
 * Funding at the settled rate and the mark price at settlement, never an estimate. Binance allows a
 * deviation of up to 15 s either side of the funding time, read against the owner: a payer pays on
 * the largest size held in that window, a receiver receives on the smallest size held throughout it.
 */

/** How far either side of the funding time the window reaches. */
export const FUNDING_WINDOW_MS = 15_000;

/** A settlement within this of a funding time is that time's. */
export const SETTLEMENT_MATCH_MS = 60_000;

/**
 * A settlement at least this long after a funding time is another funding time's (intervals are an
 * hour or more). Binance publishes settlements in order, so once such a later one is published and
 * none at the earlier time, the earlier time never happened: its interval changed after the time
 * was projected or announced.
 */
export const LATER_SETTLEMENT_MS = 30 * 60_000;

/**
 * Whether `fundingTime` never happened, judged by the settlement times `settled` that cover it and
 * the times of every funding record fetched with them, `recorded` (usable as a settlement or not):
 * no settlement or record within SETTLEMENT_MATCH_MS of it, and a settlement at least
 * LATER_SETTLEMENT_MS after it. A record at the time, even one without a usable mark price, shows
 * the time happened: it then waits for its settlement, and its funding is never dropped.
 */
export function neverSettled(fundingTime: number, settled: readonly number[], recorded: readonly number[] = settled): boolean {
  return (
    !settled.some((t) => Math.abs(t - fundingTime) <= SETTLEMENT_MATCH_MS) &&
    !recorded.some((t) => Math.abs(t - fundingTime) <= SETTLEMENT_MATCH_MS) &&
    settled.some((t) => t >= fundingTime + LATER_SETTLEMENT_MS)
  );
}

/** What the symbol's position holds on `side` right now: max = min = its size, or 0 if none. */
function heldNow(s: PerpState, symbol: string, side: PositionSide): FundingSide {
  const p = s.positions[symbol];
  if (p && p.side === side) return { max: p.qty, min: p.qty, positionId: p.id, ownMax: p.qty, maxPositionId: p.id };
  return { max: D(0), min: D(0), positionId: null, ownMax: D(0), maxPositionId: null };
}

function snapshot(s: PerpState, symbol: string, fundingTime: number): FundingWindow {
  return { symbol, fundingTime, long: heldNow(s, symbol, 'long'), short: heldNow(s, symbol, 'short') };
}

function isApplied(s: PerpState, symbol: string, fundingTime: number): boolean {
  return s.funding.applied[symbol]?.includes(fundingTime) ?? false;
}

function isPending(s: PerpState, symbol: string, fundingTime: number): boolean {
  return s.funding.pending.some((w) => w.symbol === symbol && w.fundingTime === fundingTime);
}

/**
 * Open the symbol's window for `fundingTime` (run at fundingTime − 15 s), seeded with what each side
 * holds now. A no-op when that window is already open, waiting for its rate, or applied. A window
 * still open for another funding time (its close never ran) moves to pending first, with what it saw.
 */
export function openFundingWindow(s: PerpState, symbol: string, fundingTime: number, _ctx: PerpCtx): void {
  if (isApplied(s, symbol, fundingTime) || isPending(s, symbol, fundingTime)) return;
  const open = s.funding.windows[symbol];
  if (open?.fundingTime === fundingTime) return;
  if (open) s.funding.pending.push(open);
  s.funding.windows[symbol] = snapshot(s, symbol, fundingTime);
}

/** Close the symbol's window for `fundingTime` (run at fundingTime + 15 s): it waits in pending for its rate. */
export function closeFundingWindow(s: PerpState, symbol: string, fundingTime: number, _ctx: PerpCtx): void {
  const open = s.funding.windows[symbol];
  if (open?.fundingTime !== fundingTime) return;
  delete s.funding.windows[symbol];
  s.funding.pending.push(open);
}

/**
 * Forget the symbol's window for `fundingTime`, open or waiting for its rate: a funding time that
 * never happened (see neverSettled). No money moves; returns whether there was one.
 */
export function dropFundingWindow(s: PerpState, symbol: string, fundingTime: number, _ctx: PerpCtx): boolean {
  const f = s.funding;
  const matches = (w: FundingWindow) => w.symbol === symbol && w.fundingTime === fundingTime;
  const before = f.pending.length;
  f.pending = f.pending.filter((w) => !matches(w));
  const open = f.windows[symbol];
  if (open && matches(open)) {
    delete f.windows[symbol];
    return true;
  }
  return f.pending.length < before;
}

/**
 * The symbol's position has changed (opened, added to, reduced, closed or liquidated): an open
 * window widens to take in the size each side holds now.
 */
export function trackFundingWindow(s: PerpState, symbol: string): void {
  const w = s.funding.windows[symbol];
  if (!w) return;
  const widen = (seen: FundingSide, now: FundingSide): FundingSide => {
    // A position held now that is not the one seen last is a new one: its own size starts over.
    const same = now.positionId === null || now.positionId === seen.positionId;
    return {
      max: Decimal.max(seen.max, now.max),
      min: Decimal.min(seen.min, now.min),
      positionId: now.positionId ?? seen.positionId,
      ownMax: same ? Decimal.max(seen.ownMax, now.ownMax) : now.ownMax,
      maxPositionId: now.max.gt(seen.max) ? now.positionId : seen.maxPositionId,
    };
  };
  s.funding.windows[symbol] = {
    ...w,
    long: widen(w.long, heldNow(s, symbol, 'long')),
    short: widen(w.short, heldNow(s, symbol, 'short')),
  };
}

/** Remove and return the window for (symbol, fundingTime): the pending one, else one still open. */
function takeWindow(s: PerpState, symbol: string, fundingTime: number): FundingWindow | null {
  const f = s.funding;
  const matches = (w: FundingWindow) => w.symbol === symbol && w.fundingTime === fundingTime;
  const pending = f.pending.find(matches);
  f.pending = f.pending.filter((w) => !matches(w));
  if (pending) return pending;
  const open = f.windows[symbol];
  if (open?.fundingTime !== fundingTime) return null;
  delete f.windows[symbol];
  return open;
}

interface Settlement {
  symbol: string;
  fundingTime: number;
  rate: Decimal;
  markPrice: Decimal;
}

function fundingEvent(
  st: Settlement,
  side: PositionSide,
  positionId: string,
  qty: Decimal,
  amount: Decimal,
  target: 'margin' | 'wallet',
  uncollected: Decimal | null,
  ctx: PerpCtx,
): PerpEvent {
  return {
    type: 'funding',
    market: 'perp',
    time: ctx.now,
    symbol: st.symbol,
    positionId,
    fundingTime: st.fundingTime,
    rate: st.rate,
    markPrice: st.markPrice,
    qty,
    side,
    amount,
    target,
    uncollected,
  };
}

/**
 * The payer's side pays on the largest size it held, rounded up. The last position held on the
 * side pays its share, on the largest size it held itself: from its margin while it is still open,
 * then from free leverage USDT. When an earlier position in the window held more (closed or
 * liquidated inside it), that position pays the rest of the total, from free leverage USDT. Free
 * never goes below zero; whatever neither covers is uncollected. One funding event per position
 * charged, the last position's first: each with the size and amount charged to it, so the events
 * sum to the total. It never liquidates: a margin taken to 0 is liquidated by the next mark.
 */
function pay(s: PerpState, st: Settlement, side: PositionSide, seen: FundingSide, ctx: PerpCtx): PerpEvent[] {
  if (!seen.max.gt(0) || seen.positionId === null) return [];
  const total = fundingAmount(seen.max, st.markPrice, st.rate, true);
  const earlier = seen.maxPositionId !== null && seen.maxPositionId !== seen.positionId && seen.ownMax.lt(seen.max);
  const own = earlier ? fundingAmount(seen.ownMax, st.markPrice, st.rate, true) : total;
  const events = [charge(s, st, side, seen.positionId, earlier ? seen.ownMax : seen.max, own, ctx)];
  const rest = total.minus(own);
  if (earlier && rest.gt(0)) events.push(charge(s, st, side, seen.maxPositionId!, seen.max.minus(seen.ownMax), rest, ctx));
  return events;
}

/**
 * Charge `amount` of funding on `qty` to position `positionId`: from its margin while it is the
 * symbol's open position, then from free leverage USDT (never below zero); the rest is uncollected.
 */
function charge(
  s: PerpState,
  st: Settlement,
  side: PositionSide,
  positionId: string,
  qty: Decimal,
  amount: Decimal,
  ctx: PerpCtx,
): PerpEvent {
  const held = s.positions[st.symbol];
  const position = held?.id === positionId ? held : null;
  const fromMargin = position ? Decimal.min(amount, Decimal.max(0, position.margin)) : D(0);
  const rest = amount.minus(fromMargin);
  const fromFree = Decimal.min(rest, Decimal.max(0, freeUsdt(s)));
  debitUsdt(s, fromFree);
  const uncollected = rest.minus(fromFree);
  if (position) {
    s.positions[st.symbol] = {
      ...position,
      margin: position.margin.minus(fromMargin),
      funding: position.funding.minus(amount),
    };
  }
  const target = position ? 'margin' : 'wallet';
  const left = uncollected.gt(0) ? uncollected : null;
  return fundingEvent(st, side, positionId, qty, amount.neg(), target, left, ctx);
}

/** The receiver's side receives on the smallest size it held throughout, rounded down, into free leverage USDT. */
function receive(s: PerpState, st: Settlement, side: PositionSide, seen: FundingSide, ctx: PerpCtx): PerpEvent[] {
  if (!seen.min.gt(0) || seen.positionId === null) return [];
  const amount = fundingAmount(seen.min, st.markPrice, st.rate, false);
  if (amount.isZero()) return [];
  creditUsdt(s, amount);
  const held = s.positions[st.symbol];
  if (held?.id === seen.positionId) s.positions[st.symbol] = { ...held, funding: held.funding.plus(amount) };
  return [fundingEvent(st, side, seen.positionId, seen.min, amount, 'wallet', null, ctx)];
}

/**
 * Apply the funding settled at `fundingTime` at `rate` and `markPrice`, both as Binance published
 * them. A positive rate makes longs pay shorts; a negative one, shorts pay longs. The sizes come
 * from the window for that time (pending, or still open); with none (the server was down at the
 * funding time) from the position as it is at ctx.now. Applied once per (symbol, fundingTime): a
 * repeat returns [] and changes nothing.
 */
export function applyFunding(
  s: PerpState,
  symbol: string,
  fundingTime: number,
  rate: Decimal,
  markPrice: Decimal,
  ctx: PerpCtx,
): PerpEvent[] {
  if (!Number.isSafeInteger(fundingTime)) throw new Error(`Funding ${symbol}: bad funding time ${fundingTime}`);
  if (!rate.isFinite() || !markPrice.isFinite() || !markPrice.gt(0)) {
    throw new Error(`Funding ${symbol}@${fundingTime}: bad rate ${rate.toString()} or mark ${markPrice.toString()}`);
  }
  if (isApplied(s, symbol, fundingTime)) return [];
  const window = takeWindow(s, symbol, fundingTime) ?? snapshot(s, symbol, fundingTime);
  (s.funding.applied[symbol] ??= []).push(fundingTime);
  if (rate.isZero()) return [];

  const st: Settlement = { symbol, fundingTime, rate, markPrice };
  const payer: PositionSide = rate.gt(0) ? 'long' : 'short';
  const receiver: PositionSide = payer === 'long' ? 'short' : 'long';
  return [...pay(s, st, payer, window[payer], ctx), ...receive(s, st, receiver, window[receiver], ctx)];
}
