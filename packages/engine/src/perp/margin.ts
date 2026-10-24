import { InputError, parseAmount } from '../input.ts';
import type { Decimal } from '../decimal.ts';
import { bracketsOrNull, validMark } from './market.ts';
import { liquidationPrice, maxRemovableMargin } from './math.ts';
import { liveOrders } from './orders.ts';
import { TIERS_NOT_LOADED } from './rules.ts';
import { creditUsdt, debitUsdt, freeUsdt } from './state.ts';
import type { PerpState } from './state.ts';
import { maxLeverage } from './tiers.ts';
import type { Bracket, MarginPreview, PerpActionResult, PerpCtx, Position } from './types.ts';

/** Leverage, margin mode and the margin of open isolated positions. */

/** Margin cannot be added or removed without live data (a fresh mark price): a temporary refusal. */
export const MARGIN_MARK_UNAVAILABLE = 'Mark price unavailable; try again when live data is back';
const MAX_DECIMALS = 8;

function fail(reason: string): PerpActionResult {
  return { ok: false, reason };
}

/** A positive amount of at most 8 decimals, or the reason it is not one. */
function readMargin(input: string): { amount: Decimal } | { reason: string } {
  try {
    const amount = parseAmount(input);
    if (amount.decimalPlaces() > MAX_DECIMALS) return { reason: `Too many decimals: at most ${MAX_DECIMALS}` };
    return { amount };
  } catch (e) {
    if (e instanceof InputError) return { reason: e.message };
    throw e;
  }
}

/**
 * Leverage is a whole number from 1 to the coin's maximum and cannot change while the symbol has a
 * position or a live order that opens one (a reduce-only order cannot open anything).
 */
export function setLeverage(s: PerpState, symbol: string, leverage: number, ctx: PerpCtx): PerpActionResult {
  const tiers = bracketsOrNull(symbol, ctx);
  if (!tiers) return fail(TIERS_NOT_LOADED);
  const max = maxLeverage(tiers);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > max) {
    return fail(`Leverage must be a whole number from 1 to ${max}`);
  }
  if (s.positions[symbol] || liveOrders(s, symbol).some((o) => !o.reduceOnly)) {
    return fail(`Leverage is locked while a position or an opening order is open on ${symbol}`);
  }
  s.settings[symbol] = { leverage, marginMode: 'isolated' };
  return { ok: true, events: [{ type: 'leverage_set', market: 'perp', time: ctx.now, symbol, leverage }] };
}

/** Isolated is the only mode: asking for it is a no-op, cross is refused. */
export function setMarginMode(mode: 'isolated' | 'cross'): PerpActionResult {
  if (mode !== 'isolated') return fail('Cross margin is not available yet; isolated only');
  return { ok: true, events: [] };
}

/** Store the position's new margin and report it with the liquidation price it now has. */
function changed(s: PerpState, plan: MarginPlan, ctx: PerpCtx): PerpActionResult {
  const { pos, action, amount, margin, liquidationPrice: liq } = plan;
  s.positions[pos.symbol] = { ...pos, margin };
  return {
    ok: true,
    events: [
      {
        type: 'margin_changed',
        market: 'perp',
        time: ctx.now,
        symbol: pos.symbol,
        side: pos.side,
        action,
        amount,
        marginAfter: margin,
        liquidationPriceAfter: liq,
      },
    ],
  };
}

/** A margin change that would be accepted: the position, the amount, and the margin and liquidation price after it. */
interface MarginPlan {
  pos: Position;
  action: 'add' | 'remove';
  amount: Decimal;
  margin: Decimal;
  liquidationPrice: Decimal | null;
}

/**
 * The mark a margin change is judged at: a fresh, valid one while the symbol's market data is live,
 * else null (never a stale one).
 */
function liveMark(symbol: string, ctx: PerpCtx): Decimal | null {
  return ctx.market.isFresh(symbol) && ctx.market.isMarkFresh(symbol) ? validMark(symbol, ctx) : null;
}

function removable(pos: Position, tiers: Bracket[], mark: Decimal): Decimal {
  return maxRemovableMargin({
    brackets: tiers,
    side: pos.side,
    qty: pos.qty,
    entry: pos.entryPrice,
    margin: pos.margin,
    mark,
    leverage: pos.leverage,
  });
}

/**
 * Every check of an add or a removal, in the order the actions make them, without changing
 * anything: the change it would make, or why it is refused. Both need live data: while it is
 * stale the position may already have been liquidated on the exchange, and a change made then
 * would decide what the gap's catch-up finds. A removal is limited to maxRemovableMargin at the
 * fresh mark.
 */
function planMargin(
  s: PerpState,
  symbol: string,
  action: 'add' | 'remove',
  input: string,
  ctx: PerpCtx,
): MarginPlan | { reason: string } {
  const pos = s.positions[symbol];
  if (!pos) return { reason: `No open position on ${symbol}` };
  const tiers = bracketsOrNull(symbol, ctx);
  if (!tiers) return { reason: TIERS_NOT_LOADED };
  const mark = liveMark(symbol, ctx);
  if (!mark) return { reason: MARGIN_MARK_UNAVAILABLE };
  const read = readMargin(input);
  if ('reason' in read) return read;
  let margin: Decimal;
  if (action === 'add') {
    const free = freeUsdt(s);
    if (read.amount.gt(free)) {
      return { reason: `Insufficient free USDT in leverage wallet: need ${read.amount.toString()}, available ${free.toString()}` };
    }
    margin = pos.margin.plus(read.amount);
  } else {
    const max = removable(pos, tiers, mark);
    if (read.amount.gt(max)) return { reason: `At most ${max.toString()} USDT can be removed now` };
    margin = pos.margin.minus(read.amount);
  }
  const liq = liquidationPrice(tiers, pos.side, pos.qty, pos.entryPrice, margin);
  return { pos, action, amount: read.amount, margin, liquidationPrice: liq };
}

/** Move free leverage USDT into the position's margin. Never while the data is stale (see planMargin). */
export function addMargin(s: PerpState, symbol: string, input: string, ctx: PerpCtx): PerpActionResult {
  const plan = planMargin(s, symbol, 'add', input, ctx);
  if ('reason' in plan) return fail(plan.reason);
  debitUsdt(s, plan.amount);
  return changed(s, plan, ctx);
}

/**
 * Move margin from the position back to free leverage USDT, up to maxRemovableMargin at the current
 * mark. Never acts on stale data.
 */
export function removeMargin(s: PerpState, symbol: string, input: string, ctx: PerpCtx): PerpActionResult {
  const plan = planMargin(s, symbol, 'remove', input, ctx);
  if ('reason' in plan) return fail(plan.reason);
  creditUsdt(s, plan.amount);
  return changed(s, plan, ctx);
}

/**
 * The margin that may be removed from the symbol's position now: maxRemovableMargin at a fresh
 * mark. Null without a position, the leverage tiers or live data (a removal is then refused).
 */
export function maxRemovable(s: PerpState, symbol: string, ctx: PerpCtx): Decimal | null {
  const pos = s.positions[symbol];
  const tiers = bracketsOrNull(symbol, ctx);
  const mark = liveMark(symbol, ctx);
  return pos && tiers && mark ? removable(pos, tiers, mark) : null;
}

/** What an add or a removal of margin would do now (see MarginPreview); nothing is changed. */
export function previewMargin(
  s: PerpState,
  symbol: string,
  action: 'add' | 'remove',
  input: string,
  ctx: PerpCtx,
): MarginPreview {
  const plan = planMargin(s, symbol, action, input, ctx);
  const max = maxRemovable(s, symbol, ctx);
  if ('reason' in plan) return { marginAfter: null, liquidationPriceAfter: null, maxRemovable: max, rejectReason: plan.reason };
  return { marginAfter: plan.margin, liquidationPriceAfter: plan.liquidationPrice, maxRemovable: max, rejectReason: null };
}
