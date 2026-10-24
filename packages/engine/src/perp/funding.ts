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

/** What the symbol's position holds on `side` right now: max = min = its size, or 0 if none. */
function heldNow(s: PerpState, symbol: string, side: PositionSide): FundingSide {
  const p = s.positions[symbol];
  if (p && p.side === side) return { max: p.qty, min: p.qty, positionId: p.id };
  return { max: D(0), min: D(0), positionId: null };
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
 * The symbol's position has changed (opened, added to, reduced, closed or liquidated): an open
 * window widens to take in the size each side holds now.
 */
export function trackFundingWindow(s: PerpState, symbol: string): void {
  const w = s.funding.windows[symbol];
  if (!w) return;
  const widen = (seen: FundingSide, now: FundingSide): FundingSide => ({
    max: Decimal.max(seen.max, now.max),
    min: Decimal.min(seen.min, now.min),
    positionId: now.positionId ?? seen.positionId,
  });
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
 * The payer's side pays on the largest size it held, rounded up: from the position's margin while
 * that position is still open, then from free leverage USDT (never below zero); whatever is left
 * is uncollected. It never liquidates: a margin taken to 0 is liquidated by the next mark.
 */
function pay(s: PerpState, st: Settlement, side: PositionSide, seen: FundingSide, ctx: PerpCtx): PerpEvent[] {
  if (!seen.max.gt(0) || seen.positionId === null) return [];
  const amount = fundingAmount(seen.max, st.markPrice, st.rate, true);
  const held = s.positions[st.symbol];
  const position = held?.id === seen.positionId ? held : null;
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
  return [fundingEvent(st, side, seen.positionId, seen.max, amount.neg(), target, left, ctx)];
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
