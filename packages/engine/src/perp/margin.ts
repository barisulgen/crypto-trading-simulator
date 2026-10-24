import { InputError, parseAmount } from '../input.ts';
import type { Decimal } from '../decimal.ts';
import { bracketsOrNull, validMark } from './market.ts';
import { liquidationPrice, maxRemovableMargin } from './math.ts';
import { liveOrders } from './orders.ts';
import { TIERS_NOT_LOADED } from './rules.ts';
import { creditUsdt, debitUsdt, freeUsdt } from './state.ts';
import type { PerpState } from './state.ts';
import { maxLeverage } from './tiers.ts';
import type { Bracket, PerpActionResult, PerpCtx, Position } from './types.ts';

/** Leverage, margin mode and the margin of open isolated positions. */

/** Margin cannot be removed without a fresh mark price: a temporary refusal. */
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
function changed(
  s: PerpState,
  pos: Position,
  action: 'add' | 'remove',
  amount: Decimal,
  margin: Decimal,
  tiers: Bracket[],
  ctx: PerpCtx,
): PerpActionResult {
  s.positions[pos.symbol] = { ...pos, margin };
  const liq = liquidationPrice(tiers, pos.side, pos.qty, pos.entryPrice, margin);
  return {
    ok: true,
    events: [
      {
        type: 'margin_changed',
        market: 'perp',
        time: ctx.now,
        symbol: pos.symbol,
        action,
        amount,
        marginAfter: margin,
        liquidationPriceAfter: liq,
      },
    ],
  };
}

/** Move free leverage USDT into the position's margin. Needs no live data: more margin only adds safety. */
export function addMargin(s: PerpState, symbol: string, input: string, ctx: PerpCtx): PerpActionResult {
  const pos = s.positions[symbol];
  if (!pos) return fail(`No open position on ${symbol}`);
  const tiers = bracketsOrNull(symbol, ctx);
  if (!tiers) return fail(TIERS_NOT_LOADED);
  const read = readMargin(input);
  if ('reason' in read) return fail(read.reason);
  const free = freeUsdt(s);
  if (read.amount.gt(free)) {
    return fail(`Insufficient free USDT in leverage wallet: need ${read.amount.toString()}, available ${free.toString()}`);
  }
  debitUsdt(s, read.amount);
  return changed(s, pos, 'add', read.amount, pos.margin.plus(read.amount), tiers, ctx);
}

/**
 * Move margin from the position back to free leverage USDT, up to maxRemovableMargin at the current
 * mark. Never acts on a stale mark.
 */
export function removeMargin(s: PerpState, symbol: string, input: string, ctx: PerpCtx): PerpActionResult {
  const pos = s.positions[symbol];
  if (!pos) return fail(`No open position on ${symbol}`);
  const tiers = bracketsOrNull(symbol, ctx);
  if (!tiers) return fail(TIERS_NOT_LOADED);
  const mark = ctx.market.isMarkFresh(symbol) ? validMark(symbol, ctx) : null;
  if (!mark) return fail(MARGIN_MARK_UNAVAILABLE);
  const read = readMargin(input);
  if ('reason' in read) return fail(read.reason);
  const max = maxRemovableMargin({
    brackets: tiers,
    side: pos.side,
    qty: pos.qty,
    entry: pos.entryPrice,
    margin: pos.margin,
    mark,
    leverage: pos.leverage,
  });
  if (read.amount.gt(max)) return fail(`At most ${max.toString()} USDT can be removed now`);
  creditUsdt(s, read.amount);
  return changed(s, pos, 'remove', read.amount, pos.margin.minus(read.amount), tiers, ctx);
}
