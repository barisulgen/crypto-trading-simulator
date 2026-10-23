import { D, Decimal, floorToStep, roundUp8 } from '../decimal.ts';
import { walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
import { isLimitType, POST_ONLY_REJECT } from '../spot/limit.ts';
import { allocateTradeThrough } from '../spot/matching.ts';
import { drift } from '../spot/orders.ts';
import type { AggTrade, OrderStatus, Side } from '../types.ts';
import {
  bracketsOrNull,
  costOf,
  estLiquidation,
  liveDataReason,
  opposite,
  positionChecks,
  validMark,
} from './market.ts';
import { assumedPrice, orderCost, perpFee } from './math.ts';
import {
  cancelOrder,
  liveOrders,
  newPerpOrder,
  noPerpFields,
  placePending,
  readPerpAmount,
  rejectOrder,
  rejectPending,
  remainingQty,
} from './orders.ts';
import type { PerpFields } from './orders.ts';
import { applyOpeningFill, applyReducingFill, positionClosed } from './position.ts';
import type { PerpFillTerms } from './position.ts';
import { MARK_UNAVAILABLE, TIERS_NOT_LOADED, validatePerpOrder } from './rules.ts';
import { DEFAULT_LEVERAGE, freeUsdt, leverageFor, putOrder } from './state.ts';
import type { PerpState } from './state.ts';
import { maxLeverage } from './tiers.ts';
import type { Bracket, PerpCtx, PerpEvent, PerpOrder, PerpOrderRequest, PerpPreview, Position } from './types.ts';

/** Perp limit and post-only orders. */

/** Statuses of an arrived limit order that trades can still fill. */
const RESTING: ReadonlySet<OrderStatus> = new Set(['open', 'partially_filled']);

/** Everything submit and preview work out for a limit or post-only order before touching state. */
interface LimitPlan {
  fields: PerpFields;
  reduceOnly: boolean;
  leverage: number;
  maxLeverage: number;
  brackets: Bracket[] | null;
  /** The opposite position a reduce-only order reduces. */
  position: Position | null;
  lockAmount: Decimal | null;
  /** Why submit would reject, or null if it would be placed. */
  reason: string | null;
}

/**
 * Freshness, the leverage tiers, amounts and price, exchange filters, leverage, the one-way rule,
 * reduce-only (the open reduce-only limits plus this one within the position), the maximum
 * notional at the leverage, and the funds, in that order. A dollar-sized limit becomes
 * qty = floor(quoteQty ÷ price) to the step size. The lock is the order cost at the assumed limit
 * price, with the open loss taken at the limit price; reduce-only orders lock nothing. Stops at
 * the first problem; later fields stay null. Reads state, never writes it.
 */
function planLimit(s: PerpState, req: PerpOrderRequest, ctx: PerpCtx): LimitPlan {
  const symbol = req.symbol;
  const tiers = bracketsOrNull(symbol, ctx);
  const plan: LimitPlan = {
    fields: noPerpFields(),
    reduceOnly: req.reduceOnly === true,
    leverage: tiers ? leverageFor(s, symbol, tiers) : (s.settings[symbol]?.leverage ?? DEFAULT_LEVERAGE),
    maxLeverage: tiers ? maxLeverage(tiers) : 0,
    brackets: tiers,
    position: null,
    lockAmount: null,
    reason: null,
  };
  const fail = (reason: string): LimitPlan => ({ ...plan, reason });

  const stale = liveDataReason(symbol, ctx);
  if (stale) return fail(stale);
  if (!tiers) return fail(TIERS_NOT_LOADED);
  const rules = ctx.market.rules(symbol);

  const read = readPerpAmount(req, true);
  plan.fields = read.fields;
  if (read.reason !== null) return fail(read.reason);
  if (req.attach) return fail('Attached stop-loss and take-profit are not available for perpetuals yet');
  const mark = validMark(symbol, ctx);
  if (!mark) return fail(MARK_UNAVAILABLE);
  const price = plan.fields.price!;
  if (plan.fields.quoteQty) {
    const qty = floorToStep(plan.fields.quoteQty.div(price), rules.stepSize);
    if (qty.isZero()) {
      const amount = `${plan.fields.quoteQty} ${rules.quote}`;
      return fail(`Amount too small: ${amount} does not reach one step of ${rules.stepSize} ${rules.base}`);
    }
    plan.fields = { ...plan.fields, qty };
  }
  const qty = plan.fields.qty!;

  const live = liveOrders(s, symbol);
  const invalid = validatePerpOrder(
    { symbol, side: req.side, type: req.type, qty, price, reduceOnly: plan.reduceOnly },
    rules,
    { mark, openOrders: live.length },
  );
  if (invalid) return fail(invalid);

  const checked = positionChecks(s, { symbol, side: req.side, qty, reduceOnly: plan.reduceOnly }, plan, tiers, mark);
  if (checked.reason !== null) return fail(checked.reason);
  plan.position = checked.position;

  if (plan.position) {
    // Reduce-only market orders in flight are not counted: each is trimmed to the position when it
    // arrives, a maker fill takes at most the position, and a close cancels what is left, so no
    // combination of them can reduce more than the position holds.
    const open = live
      .filter((o) => o.reduceOnly && isLimitType(o))
      .reduce((sum, o) => sum.plus(remainingQty(o)), D(0));
    if (open.plus(qty).gt(plan.position.qty)) {
      const sum = `open ${open} + new ${qty} > ${plan.position.qty} ${rules.base}`;
      return fail(`Reduce-only orders would exceed your position (${sum})`);
    }
    plan.lockAmount = D(0);
    return plan;
  }

  const last = ctx.market.lastPrice(symbol);
  if (!last) return fail(`Last price unavailable for ${symbol}`);
  const imPrice = assumedPrice({ type: 'limit', side: req.side, price, mark, last });
  plan.lockAmount = orderCost({
    side: req.side,
    qty,
    imPrice,
    olPrice: price,
    mark,
    leverage: plan.leverage,
    takerRate: ctx.fees.taker,
  }).total;
  const free = freeUsdt(s);
  if (plan.lockAmount.gt(free)) return fail(`Insufficient margin: need ${plan.lockAmount}, available ${free}`);
  return plan;
}

export function submitLimit(s: PerpState, req: PerpOrderRequest, ctx: PerpCtx): PerpEvent[] {
  const plan = planLimit(s, req, ctx);
  const order = newPerpOrder(req, plan.fields, plan.leverage, ctx);
  if (plan.reason !== null) return rejectOrder(s, order, plan.reason, ctx);
  // A plan without a reason always has its lock.
  return placePending(s, order, plan.lockAmount!, ctx.market.best(req.symbol, req.side), ctx);
}

/** Would an order at `price` trade against `best` right now? (buy: best ask ≤ price; sell: best bid ≥ price) */
function marketable(best: Decimal | null, side: Side, price: Decimal): boolean {
  if (!best) return false;
  return side === 'buy' ? best.lte(price) : best.gte(price);
}

/**
 * The part of an opening order's lock that a fill of `qty` uses: the lock pro rata to the
 * remaining quantity, rounded up to 8 decimals so the order keeps no less than its share; all of
 * it for the fill that completes the order.
 */
function lockShare(order: PerpOrder, qty: Decimal): Decimal {
  const remaining = remainingQty(order);
  if (qty.gte(remaining)) return order.lockAmount;
  return Decimal.min(order.lockAmount, roundUp8(order.lockAmount.mul(qty).div(remaining)));
}

/**
 * Apply a fill of t.qty to the order: an opening fill takes its share of the lock, a reducing fill
 * reduces the position, and a fill that empties the position closes it (which cancels the
 * reduce-only orders left on the symbol, this one included if not filled).
 */
function applyFill(
  s: PerpState,
  order: PerpOrder,
  t: PerpFillTerms,
  position: Position | null,
  ctx: PerpCtx,
): PerpEvent[] {
  const status: OrderStatus = t.qty.gte(remainingQty(order)) ? 'filled' : 'partially_filled';
  if (!position) return applyOpeningFill(s, order, t, lockShare(order, t.qty), status, ctx).events;
  const filled = applyReducingFill(s, order, t, status, ctx);
  if (!filled.closed) return filled.events;
  return [...filled.events, ...positionClosed(s, filled.closed, t.price, 'closed', ctx)];
}

/**
 * Why an opening limit cannot take `walk` at arrival, or null. The taker part is re-priced like a
 * market order (its order cost at the market assumed price and the current mark), plus the share
 * of the lock the resting part keeps; the lock plus free USDT must cover both. A sell's taker part
 * fills at bids at or above its price, which can be above the price its lock assumed.
 */
function shortOfMargin(s: PerpState, order: PerpOrder, walk: WalkResult, ctx: PerpCtx): string | null {
  const mark = validMark(order.symbol, ctx);
  if (!mark) return MARK_UNAVAILABLE;
  const last = ctx.market.lastPrice(order.symbol);
  if (!last) return `Last price unavailable for ${order.symbol}`;
  const taker = costOf(order.side, walk, walk.qty, { mark, last, leverage: order.leverage }, ctx);
  const need = taker.plus(order.lockAmount.minus(lockShare(order, walk.qty)));
  const available = order.lockAmount.plus(freeUsdt(s));
  if (need.lte(available)) return null;
  return `Insufficient margin at execution: price moved (need ${need}, available ${available})`;
}

/**
 * Arrival of a pending limit or post-only order. A marketable limit takes the book up to its price
 * as a taker (no market price band: PERCENT_PRICE already bounds the price), a reduce-only one at
 * most the position, and the remainder rests as a maker; a marketable post-only is rejected. An
 * opening limit whose lock plus free USDT no longer covers the taker part at the market cost is
 * rejected whole (shortOfMargin).
 */
export function arriveLimit(s: PerpState, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  const symbol = order.symbol;
  const stale = liveDataReason(symbol, ctx);
  if (stale) return rejectPending(s, order, stale, ctx);
  const price = order.price!;
  if (!marketable(ctx.market.best(symbol, order.side), order.side, price)) {
    putOrder(s, { ...order, status: 'open' });
    return [];
  }
  if (order.type === 'post_only') return rejectPending(s, order, POST_ONLY_REJECT, ctx);

  let target = remainingQty(order);
  let position: Position | null = null;
  if (order.reduceOnly) {
    position = opposite(s, symbol, order.side);
    if (!position) return rejectPending(s, order, `No position to reduce on ${symbol}`, ctx);
    target = Decimal.min(target, position.qty);
  }
  const walk = walkBook(ctx.market.book(symbol), order.side, { qty: target }, ctx.market.rules(symbol).stepSize, price);
  if (walk.qty.isZero()) {
    putOrder(s, { ...order, status: 'open' });
    return [];
  }
  if (!position) {
    const short = shortOfMargin(s, order, walk, ctx);
    if (short) return rejectPending(s, order, short, ctx);
  }
  const terms: PerpFillTerms = {
    qty: walk.qty,
    price: walk.avgPrice!,
    quote: walk.quote,
    liquidity: 'taker',
    rate: ctx.fees.taker,
    bestAtArrival: walk.bestPrice,
    slippageUsd: walk.slippageUsd,
    driftUsd: drift(order.side, order.bestAtSubmit, walk.bestPrice, walk.qty),
    consumed: walk.taken,
  };
  return applyFill(s, order, terms, position, ctx);
}

/**
 * Fill the resting limit and post-only orders of `symbol` that this real trade went strictly
 * through, at each order's own price with the maker fee, sharing the trade's volume. A reduce-only
 * order fills at most the position. Matching pauses while the symbol's data is stale. The book is
 * never copied: a fill needs only its best price.
 */
export function matchTrade(s: PerpState, symbol: string, trade: AggTrade, ctx: PerpCtx): PerpEvent[] {
  if (liveDataReason(symbol, ctx) !== null) return [];
  const resting = [...s.orders.values()].filter((o) => o.symbol === symbol && RESTING.has(o.status) && isLimitType(o));
  const events: PerpEvent[] = [];
  for (const { orderId, qty } of allocateTradeThrough(resting, trade)) {
    const order = s.orders.get(orderId)!;
    // A position closed by an earlier fill of this trade has already cancelled its reduce-only orders.
    if (!RESTING.has(order.status)) continue;
    events.push(...makerFill(s, order, qty, ctx));
  }
  return events;
}

function makerFill(s: PerpState, order: PerpOrder, allocated: Decimal, ctx: PerpCtx): PerpEvent[] {
  let qty = allocated;
  let position: Position | null = null;
  if (order.reduceOnly) {
    position = opposite(s, order.symbol, order.side);
    // Closing a position cancels its reduce-only orders, so this is only a safeguard.
    if (!position) return cancelOrder(s, order, 'position_closed', remainingQty(order), ctx);
    // Trimmed to the position, the rest of this allocation's trade volume is deliberately not
    // offered to later orders: sharing it again could only fill the owner more (conservative).
    qty = Decimal.min(allocated, position.qty);
  }
  const price = order.price!;
  const terms: PerpFillTerms = {
    qty,
    price,
    quote: qty.mul(price),
    liquidity: 'maker',
    rate: ctx.fees.maker,
    bestAtArrival: ctx.market.best(order.symbol, order.side),
    slippageUsd: D(0),
    driftUsd: D(0),
  };
  return applyFill(s, order, terms, position, ctx);
}

/**
 * Estimate for a limit or post-only order: the resting part at the limit price with the maker fee;
 * a marketable limit's taker part walked up to the limit with the taker fee. The margin required
 * is the lock submit would take.
 */
export function previewLimit(s: PerpState, req: PerpOrderRequest, ctx: PerpCtx): PerpPreview {
  const plan = planLimit(s, req, ctx);
  const preview: PerpPreview = {
    estAvgPrice: null,
    estSlippageUsd: null,
    estSlippagePct: null,
    notional: null,
    fee: null,
    marginRequired: plan.lockAmount,
    estLiquidationPrice: null,
    leverage: plan.leverage,
    maxLeverage: plan.maxLeverage,
    exhausted: false,
    bandLimited: false,
    rejectReason: plan.reason,
    note: null,
  };
  const { qty, price } = plan.fields;
  if (!qty || !price || qty.isZero()) return preview;

  const isMarketable = marketable(ctx.market.best(req.symbol, req.side), req.side, price);
  if (preview.rejectReason === null && isMarketable && req.type === 'post_only') {
    preview.rejectReason = POST_ONLY_REJECT;
  }
  const step = ctx.market.rules(req.symbol).stepSize;
  const walk =
    isMarketable && req.type === 'limit'
      ? walkBook(ctx.market.book(req.symbol), req.side, { qty }, step, price)
      : null;
  const takerQty = walk?.qty ?? D(0);
  const takerQuote = walk?.quote ?? D(0);
  const makerQuote = qty.minus(takerQty).mul(price);
  const quote = takerQuote.plus(makerQuote);
  const fee = perpFee(takerQuote, ctx.fees.taker).plus(perpFee(makerQuote, ctx.fees.maker));
  const slippage = walk?.slippageUsd ?? D(0);
  preview.estAvgPrice = quote.div(qty);
  preview.estSlippageUsd = slippage;
  preview.estSlippagePct =
    walk?.bestPrice && takerQty.gt(0) ? slippage.div(walk.bestPrice.mul(takerQty)).mul(100) : D(0);
  preview.notional = quote;
  preview.fee = fee;
  if (plan.brackets && (plan.position || !plan.reduceOnly)) {
    preview.estLiquidationPrice = estLiquidation(s, req, plan, { qty, quote, fee }, plan.brackets);
  }
  return preview;
}
