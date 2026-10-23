import { D, floorToStep } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { WalkResult } from '../book.ts';
import { spotFee } from '../fees.ts';
import { InputError, parseAmount } from '../input.ts';
import type {
  BookSnapshot,
  EngineCtx,
  EngineEvent,
  Fill,
  OrderPreview,
  OrderStatus,
  Side,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
} from '../types.ts';
import { assertBasisCovers, recordFill } from './accounting.ts';
import { credit, lockFunds, releaseFunds, spendFunds } from './state.ts';
import type { SpotState } from './state.ts';
import { isStopType } from './triggers.ts';

/** Order lifecycle helpers shared by market, limit and stop orders. */

/** Statuses of orders that still count against MAX_NUM_ORDERS (in flight included). */
const LIVE_STATUSES: ReadonlySet<OrderStatus> = new Set(['pending', 'open', 'partially_filled', 'triggered']);

/**
 * Order and algo-order slots in use on `symbol`. A live buy with an attached pair also holds the
 * two slots of each kind its pair takes once the buy finishes (the pair is placed only then), so
 * nothing accepted meanwhile can leave the pair without room and the bought coins unprotected.
 */
export function openCounts(s: SpotState, symbol: string): { openOrders: number; openAlgoOrders: number } {
  let openOrders = 0;
  let openAlgoOrders = 0;
  for (const o of s.orders.values()) {
    if (o.symbol !== symbol || !LIVE_STATUSES.has(o.status)) continue;
    openOrders += 1;
    if (o.type === 'stop_loss' || o.type === 'take_profit') openAlgoOrders += 1;
    if (o.attach) {
      openOrders += 2;
      openAlgoOrders += 2;
    }
  }
  return { openOrders, openAlgoOrders };
}

export interface RequestFields {
  qty: Decimal | null;
  quoteQty: Decimal | null;
  price: Decimal | null;
  triggerPrice: Decimal | null;
  attach: { stopLoss: Decimal; takeProfit: Decimal } | null;
}

export function noFields(): RequestFields {
  return { qty: null, quoteQty: null, price: null, triggerPrice: null, attach: null };
}

/**
 * Parse the typed amounts: exactly one of qty/quoteQty, then the limit price and the trigger
 * price when asked for, then an attached pair (buys of market/limit/post-only only).
 * Stops at the first problem (reason set); fields parsed so far are kept for the record.
 */
export function readRequest(
  req: SpotOrderRequest,
  withPrice: boolean,
  withTrigger = false,
): { fields: RequestFields; reason: string | null } {
  const fields = noFields();
  const fail = (reason: string) => ({ fields, reason });

  const hasQty = present(req.qty);
  if (hasQty === present(req.quoteQty)) return fail('Enter either a coin amount or a dollar amount');
  try {
    if (hasQty) fields.qty = parseAmount(req.qty!);
    else fields.quoteQty = parseAmount(req.quoteQty!);
    if (withPrice) {
      if (!present(req.price)) return fail('Enter a limit price');
      fields.price = parseAmount(req.price!);
    }
    if (withTrigger) {
      if (!present(req.triggerPrice)) return fail('Enter a trigger price');
      fields.triggerPrice = parseAmount(req.triggerPrice!);
    }
    if (req.attach) {
      if (req.side !== 'buy') return fail('Attached stop-loss and take-profit are only for buys');
      if (isStopType(req.type)) {
        return fail('Attached stop-loss and take-profit cannot be added to a stop or take-profit order');
      }
      fields.attach = { stopLoss: parseAmount(req.attach.stopLoss), takeProfit: parseAmount(req.attach.takeProfit) };
    }
  } catch (e) {
    if (e instanceof InputError) return fail(e.message);
    throw e;
  }
  return { fields, reason: null };
}

export function newOrder(req: SpotOrderRequest, rules: SpotRules, fields: RequestFields, ctx: EngineCtx): SpotOrder {
  return {
    id: ctx.newId('o'),
    symbol: req.symbol,
    side: req.side,
    type: req.type,
    qty: fields.qty,
    quoteQty: fields.quoteQty,
    price: fields.price,
    triggerPrice: fields.triggerPrice,
    status: 'pending',
    filledQty: D(0),
    filledQuote: D(0),
    fee: D(0),
    feeAsset: null,
    lockAsset: req.side === 'buy' ? rules.quote : rules.base,
    lockAmount: D(0),
    ocoGroupId: null,
    parentId: null,
    attach: fields.attach,
    createdAt: ctx.now,
    arrivesAt: null,
    cancelArrivesAt: null,
    triggeredAt: null,
    bestAtSubmit: null,
    rejectReason: null,
  };
}

/** Lock the funds and record the order as pending until its arrival delay has passed. */
export function placePending(
  s: SpotState,
  order: SpotOrder,
  lockAmount: Decimal,
  bestAtSubmit: Decimal | null,
  ctx: EngineCtx,
): EngineEvent[] {
  lockFunds(s, order.lockAsset, lockAmount);
  const pending: SpotOrder = {
    ...order,
    status: 'pending',
    lockAmount,
    arrivesAt: ctx.now + arrivalDelay(ctx),
    bestAtSubmit,
  };
  s.orders.set(pending.id, pending);
  return [{ type: 'order_placed', time: ctx.now, order: pending }];
}

/** Record a rejected order (nothing locked) and return its event; `afterTrigger` marks a triggered stop. */
export function rejectOrder(
  s: SpotState,
  order: SpotOrder,
  reason: string,
  ctx: EngineCtx,
  afterTrigger = false,
): EngineEvent[] {
  const rejected: SpotOrder = { ...order, status: 'rejected', rejectReason: reason, lockAmount: D(0) };
  s.orders.set(rejected.id, rejected);
  const event: EngineEvent = { type: 'order_rejected', time: ctx.now, order: rejected, reason };
  return [afterTrigger ? { ...event, afterTrigger } : event];
}

/** Reject an order that holds a lock: release it first. */
export function rejectPending(
  s: SpotState,
  order: SpotOrder,
  reason: string,
  ctx: EngineCtx,
  afterTrigger = false,
): EngineEvent[] {
  releaseFunds(s, order.lockAsset, order.lockAmount);
  return rejectOrder(s, order, reason, ctx, afterTrigger);
}

/** The fields of a fill that differ between maker and taker fills. */
export interface FillTerms {
  qty: Decimal;
  price: Decimal;
  quote: Decimal;
  liquidity: 'maker' | 'taker';
  fee: { asset: string; amount: Decimal; usd: Decimal };
  bestAtArrival: Decimal | null;
  slippageUsd: Decimal;
  driftUsd: Decimal;
}

export function makeFill(order: SpotOrder, t: FillTerms, ctx: EngineCtx): Fill {
  return {
    id: ctx.newId('f'),
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    qty: t.qty,
    price: t.price,
    quote: t.quote,
    liquidity: t.liquidity,
    feeAsset: t.fee.asset,
    fee: t.fee.amount,
    feeUsd: t.fee.usd,
    bestAtArrival: t.bestAtArrival,
    bestAtSubmit: order.bestAtSubmit,
    slippageUsd: t.slippageUsd,
    driftUsd: t.driftUsd,
    triggerPrice: order.triggerPrice,
    realizedPnl: null,
    roundTripId: null,
    time: ctx.now,
  };
}

/** The order after a fill: filled totals, fee, new status and the lock it still holds. */
export function applyFill(order: SpotOrder, fill: Fill, status: OrderStatus, lockAmount: Decimal): SpotOrder {
  return {
    ...order,
    status,
    filledQty: order.filledQty.plus(fill.qty),
    filledQuote: order.filledQuote.plus(fill.quote),
    fee: order.fee.plus(fill.fee),
    feeAsset: fill.feeAsset,
    lockAmount,
  };
}

/**
 * Settle one taker fill for the walked amount: spend from the lock first (then free) and
 * credit the received asset net of the taker fee. `retain` of the unspent lock stays locked
 * for a resting remainder (marketable limit); the rest of the unspent lock is released.
 */
export function settleTaker(
  s: SpotState,
  order: SpotOrder,
  walk: WalkResult,
  rules: SpotRules,
  status: OrderStatus,
  ctx: EngineCtx,
  retain: Decimal = D(0),
): { order: SpotOrder; fill: Fill } {
  assertBasisCovers(s, rules, order.side, walk.qty);
  const buy = order.side === 'buy';
  const fee = spotFee(order.side, walk.qty, walk.quote, ctx.fees.taker, rules.base, rules.quote);
  const unspent = spendFunds(s, order.lockAsset, buy ? walk.quote : walk.qty, order.lockAmount);
  if (retain.gt(unspent)) {
    throw new Error(`Order ${order.id}: lock ${unspent} left after the taker fill cannot cover ${retain}`);
  }
  releaseFunds(s, order.lockAsset, unspent.minus(retain));
  credit(s, fee.asset, (buy ? walk.qty : walk.quote).minus(fee.amount));

  const fill = makeFill(
    order,
    {
      qty: walk.qty,
      price: walk.avgPrice!,
      quote: walk.quote,
      liquidity: 'taker',
      fee,
      bestAtArrival: walk.bestPrice,
      slippageUsd: walk.slippageUsd,
      driftUsd: drift(order.side, order.bestAtSubmit, walk.bestPrice, walk.qty),
    },
    ctx,
  );
  return { order: applyFill(order, fill, status, retain), fill };
}

export function present(s: string | undefined): boolean {
  return s !== undefined && s.trim() !== '';
}

/** 100–300 ms, uniform. */
export function arrivalDelay(ctx: EngineCtx): number {
  return 100 + Math.floor(ctx.rng() * 201);
}

/** Signed delay drift in USD: positive means the price moved against the owner. */
function drift(side: Side, atSubmit: Decimal | null, atArrival: Decimal | null, qty: Decimal): Decimal {
  if (!atSubmit || !atArrival) return D(0);
  return side === 'buy' ? atArrival.minus(atSubmit).mul(qty) : atSubmit.minus(atArrival).mul(qty);
}

export function emptyPreview(rejectReason: string | null): OrderPreview {
  return {
    estAvgPrice: null,
    estSlippageUsd: null,
    estSlippagePct: null,
    fee: { asset: null, amount: null, usd: null },
    total: null,
    receive: null,
    exhausted: false,
    rejectReason,
    note: null,
  };
}

// ---- taker execution (market orders and triggered stops) ----

export function marketStep(rules: SpotRules): Decimal {
  return rules.marketStepSize.isZero() ? rules.stepSize : rules.marketStepSize;
}

/** Why a dollar-sized taker order cannot trade: its dollars buy less than one step of the coin. */
export function amountTooSmall(quoteQty: Decimal | null, rules: SpotRules): string {
  return `Amount too small: ${quoteQty} ${rules.quote} does not reach one step of ${marketStep(rules)} ${rules.base}`;
}

export function marketTarget(o: {
  qty: Decimal | null;
  quoteQty: Decimal | null;
}): { qty: Decimal } | { quote: Decimal } {
  return o.qty ? { qty: o.qty } : { quote: o.quoteQty! };
}

/**
 * Execute an arrived taker order against its walk of `book`: one fill for what the book had.
 * If the book ran thin the rest is cancelled (thin_book) and the unspent lock released.
 * A dollar-sized order whose walk fills nothing against a non-empty book is rejected instead:
 * its dollars are below one step, not a thin book. The caller has already checked funds.
 */
export function fillOrThin(
  s: SpotState,
  order: SpotOrder,
  walk: WalkResult,
  book: BookSnapshot,
  rules: SpotRules,
  ctx: EngineCtx,
): EngineEvent[] {
  const levels = order.side === 'buy' ? book.asks : book.bids;
  if (walk.qty.isZero() && order.quoteQty !== null && levels.length > 0) {
    return rejectPending(s, order, amountTooSmall(order.quoteQty, rules), ctx, order.status === 'triggered');
  }
  const thin = walk.exhausted || walk.qty.isZero();
  const events: EngineEvent[] = [];
  let current = order;
  if (walk.qty.gt(0)) {
    const settled = settleTaker(s, order, walk, rules, thin ? 'partially_filled' : 'filled', ctx);
    current = settled.order;
    events.push(...recordFill(s, settled.fill, current, rules, ctx));
  } else {
    releaseFunds(s, order.lockAsset, order.lockAmount);
    current = { ...order, lockAmount: D(0) };
  }

  if (thin) {
    current = { ...current, status: 'cancelled' };
    const cancelledQty = unfilledQty(order, walk, levels[walk.levelsUsed - 1]?.price ?? null, marketStep(rules));
    events.push({ type: 'order_cancelled', time: ctx.now, order: current, reason: 'thin_book', cancelledQty });
  }
  s.orders.set(current.id, current);
  return events;
}

/**
 * Quantity a thin book left unfilled. For dollar-sized orders the unspent dollars are
 * converted at the last walked price and floored to the step (0 if nothing was walked).
 */
function unfilledQty(order: SpotOrder, walk: WalkResult, lastPrice: Decimal | null, step: Decimal): Decimal {
  if (order.qty) return order.qty.minus(walk.qty);
  if (!lastPrice) return D(0);
  return floorToStep(order.quoteQty!.minus(walk.quote).div(lastPrice), step);
}

/** Estimate for a taker walk (market orders, and stops as if triggered now), taker fee. */
export function takerPreview(
  w: WalkResult | null,
  side: Side,
  rules: SpotRules,
  ctx: EngineCtx,
  rejectReason: string | null,
): OrderPreview {
  if (!w || w.qty.isZero()) return { ...emptyPreview(rejectReason), exhausted: w?.exhausted ?? false };
  const fee = spotFee(side, w.qty, w.quote, ctx.fees.taker, rules.base, rules.quote);
  const pct = w.bestPrice ? w.slippageUsd.div(w.bestPrice.mul(w.qty)).mul(100) : null;
  const buy = side === 'buy';
  return {
    estAvgPrice: w.avgPrice,
    estSlippageUsd: w.slippageUsd,
    estSlippagePct: pct,
    fee: { asset: fee.asset, amount: fee.amount, usd: fee.usd },
    total: buy ? w.quote : w.quote.minus(fee.amount),
    receive: buy ? w.qty.minus(fee.amount) : w.quote.minus(fee.amount),
    exhausted: w.exhausted,
    rejectReason,
    note: null,
  };
}
