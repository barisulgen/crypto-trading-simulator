import { D, floorToStep } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { bestPrice, walkBook } from '../book.ts';
import { spotFee } from '../fees.ts';
import { validateSpotOrder } from '../rules.ts';
import type {
  AggTrade,
  BookSnapshot,
  EngineCtx,
  EngineEvent,
  OrderPreview,
  OrderStatus,
  Side,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
} from '../types.ts';
import { assertBasisCovers, recordFill } from './accounting.ts';
import { allocateTradeThrough } from './matching.ts';
import {
  applyFill,
  emptyPreview,
  makeFill,
  newOrder,
  noFields,
  openCounts,
  placePending,
  readRequest,
  rejectOrder,
  rejectPending,
  settleTaker,
} from './orders.ts';
import type { RequestFields } from './orders.ts';
import { credit, freeOf, releaseFunds, spendFunds } from './state.ts';
import type { SpotState } from './state.ts';

/** Limit and post-only orders. */

export const POST_ONLY_REJECT = 'Post-only order would immediately match; rejected';

/** Statuses of an arrived limit order that trades can still fill. */
const RESTING: ReadonlySet<OrderStatus> = new Set(['open', 'partially_filled']);

export function isLimitType(o: { type: string }): boolean {
  return o.type === 'limit' || o.type === 'post_only';
}

interface LimitPlan {
  rules: SpotRules;
  fields: RequestFields;
  lockAmount: Decimal | null;
  /** Why submit would reject, or null if it would be placed. */
  reason: string | null;
}

/**
 * Freshness, amounts and price, exchange filters, lock size and funds, in that order.
 * A dollar-sized limit becomes qty = floor(quoteQty / price) to the step size.
 */
function planLimit(s: SpotState, req: SpotOrderRequest, ctx: EngineCtx): LimitPlan {
  const rules = ctx.market.rules(req.symbol);
  let fields = noFields();
  const fail = (why: string): LimitPlan => ({ rules, fields, lockAmount: null, reason: why });
  if (!ctx.market.isFresh(req.symbol)) return fail(`Live data interrupted for ${req.symbol}`);
  const read = readRequest(req, true);
  fields = read.fields;
  if (read.reason !== null) return fail(read.reason);

  const price = fields.price!;
  if (!fields.qty) fields.qty = floorToStep(fields.quoteQty!.div(price), rules.stepSize);
  const qty = fields.qty;

  const invalid = validateSpotOrder(
    { symbol: req.symbol, side: req.side, type: req.type, qty, price },
    rules,
    { avgPrice: ctx.market.avgPrice(req.symbol), ...openCounts(s, req.symbol) },
  );
  if (invalid) return fail(invalid);

  const lockAsset = req.side === 'buy' ? rules.quote : rules.base;
  const lockAmount = req.side === 'buy' ? price.mul(qty) : qty;
  const free = freeOf(s, 'spot', lockAsset);
  if (lockAmount.gt(free)) return fail(`Insufficient ${lockAsset}: need ${lockAmount}, available ${free}`);
  return { rules, fields, lockAmount, reason: null };
}

export function submitLimit(s: SpotState, req: SpotOrderRequest, ctx: EngineCtx): EngineEvent[] {
  const plan = planLimit(s, req, ctx);
  const order = newOrder(req, plan.rules, plan.fields, ctx);
  if (plan.reason !== null) return rejectOrder(s, order, plan.reason, ctx);
  const best = bestPrice(ctx.market.book(req.symbol), req.side);
  return placePending(s, order, plan.lockAmount!, best, ctx);
}

/** Would the order trade against the book right now? (buy: best ask ≤ L; sell: best bid ≥ L) */
function marketable(book: BookSnapshot, side: Side, price: Decimal): boolean {
  const best = bestPrice(book, side);
  if (!best) return false;
  return side === 'buy' ? best.lte(price) : best.gte(price);
}

/**
 * Arrival of a pending limit or post-only order. A marketable limit takes the book up to its
 * price as a taker and the remainder rests as a maker; a marketable post-only is rejected.
 */
export function arriveLimit(s: SpotState, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  if (!ctx.market.isFresh(order.symbol)) {
    return rejectPending(s, order, `Live data interrupted for ${order.symbol}`, ctx);
  }
  const book = ctx.market.book(order.symbol);
  const price = order.price!;
  if (!marketable(book, order.side, price)) {
    s.orders.set(order.id, { ...order, status: 'open' });
    return [];
  }
  if (order.type === 'post_only') return rejectPending(s, order, POST_ONLY_REJECT, ctx);

  const rules = ctx.market.rules(order.symbol);
  const qty = order.qty!.minus(order.filledQty);
  const walk = walkBook(book, order.side, { qty }, rules.stepSize, price);
  const remaining = qty.minus(walk.qty);
  const retain = order.side === 'buy' ? remaining.mul(price) : remaining;
  const status: OrderStatus = remaining.isZero() ? 'filled' : 'partially_filled';
  const settled = settleTaker(s, order, walk, rules, status, ctx, retain);
  s.orders.set(order.id, settled.order);
  return recordFill(s, settled.fill, settled.order, rules, ctx);
}

/**
 * Fill resting orders of `symbol` that this real trade went strictly through.
 * Fills are at the order's own price, maker fee, and share the trade's volume.
 * Matching pauses while the symbol is stale.
 */
export function matchTrade(s: SpotState, symbol: string, trade: AggTrade, ctx: EngineCtx): EngineEvent[] {
  if (!ctx.market.isFresh(symbol)) return [];
  const resting = [...s.orders.values()].filter((o) => o.symbol === symbol && RESTING.has(o.status) && isLimitType(o));
  const allocations = allocateTradeThrough(resting, trade);
  if (allocations.length === 0) return [];

  const rules = ctx.market.rules(symbol);
  const book = ctx.market.book(symbol);
  return allocations.flatMap(({ orderId, qty }) => makerFill(s, s.orders.get(orderId)!, qty, rules, book, ctx));
}

function makerFill(
  s: SpotState,
  order: SpotOrder,
  qty: Decimal,
  rules: SpotRules,
  book: BookSnapshot,
  ctx: EngineCtx,
): EngineEvent[] {
  assertBasisCovers(s, rules, order.side, qty);
  const buy = order.side === 'buy';
  const price = order.price!;
  const quote = qty.mul(price);
  const fee = spotFee(order.side, qty, quote, ctx.fees.maker, rules.base, rules.quote);
  let lock = spendFunds(s, order.lockAsset, buy ? quote : qty, order.lockAmount);
  credit(s, fee.asset, (buy ? qty : quote).minus(fee.amount));

  const done = order.filledQty.plus(qty).gte(order.qty!);
  if (done && lock.gt(0)) {
    releaseFunds(s, order.lockAsset, lock);
    lock = D(0);
  }
  const fill = makeFill(
    order,
    {
      qty,
      price,
      quote,
      liquidity: 'maker',
      fee,
      bestAtArrival: bestPrice(book, order.side),
      slippageUsd: D(0),
      driftUsd: D(0),
    },
    ctx,
  );
  const updated = applyFill(order, fill, done ? 'filled' : 'partially_filled', lock);
  s.orders.set(updated.id, updated);
  return recordFill(s, fill, updated, rules, ctx);
}

/**
 * Estimate for a limit or post-only order: the resting part at the limit price with
 * the maker fee; a marketable limit's taker part walked up to the limit with the taker fee.
 */
export function previewLimit(s: SpotState, req: SpotOrderRequest, ctx: EngineCtx): OrderPreview {
  const plan = planLimit(s, req, ctx);
  const { qty, price } = plan.fields;
  if (!qty || !price || qty.isZero()) return emptyPreview(plan.reason);

  const { rules } = plan;
  const book = ctx.market.book(req.symbol);
  const isMarketable = marketable(book, req.side, price);
  let rejectReason = plan.reason;
  if (rejectReason === null && isMarketable && req.type === 'post_only') rejectReason = POST_ONLY_REJECT;

  const walk = isMarketable && req.type === 'limit' ? walkBook(book, req.side, { qty }, rules.stepSize, price) : null;
  const takerQty = walk?.qty ?? D(0);
  const takerQuote = walk?.quote ?? D(0);
  const makerQty = qty.minus(takerQty);
  const makerQuote = makerQty.mul(price);
  const takerFee = spotFee(req.side, takerQty, takerQuote, ctx.fees.taker, rules.base, rules.quote);
  const makerFee = spotFee(req.side, makerQty, makerQuote, ctx.fees.maker, rules.base, rules.quote);
  const feeAmount = takerFee.amount.plus(makerFee.amount);
  const quote = takerQuote.plus(makerQuote);
  const slippage = walk?.slippageUsd ?? D(0);
  const buy = req.side === 'buy';
  return {
    estAvgPrice: quote.div(qty),
    estSlippageUsd: slippage,
    estSlippagePct: walk?.bestPrice && takerQty.gt(0) ? slippage.div(walk.bestPrice.mul(takerQty)).mul(100) : D(0),
    fee: { asset: makerFee.asset, amount: feeAmount, usd: takerFee.usd.plus(makerFee.usd) },
    total: buy ? quote : quote.minus(feeAmount),
    receive: buy ? qty.minus(feeAmount) : quote.minus(feeAmount),
    exhausted: false,
    rejectReason,
    note: null,
  };
}
