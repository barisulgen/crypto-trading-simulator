import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { WalkResult } from '../book.ts';
import { spotFee } from '../fees.ts';
import { InputError, parseAmount } from '../input.ts';
import type {
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
import { credit, lockFunds, releaseFunds, spendFunds } from './state.ts';
import type { SpotState } from './state.ts';

/** Order lifecycle helpers shared by market and limit orders. */

/** Statuses of orders that still count against MAX_NUM_ORDERS (in flight included). */
const LIVE_STATUSES: ReadonlySet<OrderStatus> = new Set(['pending', 'open', 'partially_filled', 'triggered']);

export function openCounts(s: SpotState, symbol: string): { openOrders: number; openAlgoOrders: number } {
  let openOrders = 0;
  let openAlgoOrders = 0;
  for (const o of s.orders.values()) {
    if (o.symbol !== symbol || !LIVE_STATUSES.has(o.status)) continue;
    openOrders += 1;
    if (o.type === 'stop_loss' || o.type === 'take_profit') openAlgoOrders += 1;
  }
  return { openOrders, openAlgoOrders };
}

export interface RequestFields {
  qty: Decimal | null;
  quoteQty: Decimal | null;
  price: Decimal | null;
}

/**
 * Parse the typed amounts: exactly one of qty/quoteQty, then the limit price when asked for.
 * Stops at the first problem (reason set); fields parsed so far are kept for the record.
 */
export function readRequest(
  req: SpotOrderRequest,
  withPrice: boolean,
): { fields: RequestFields; reason: string | null } {
  const fields: RequestFields = { qty: null, quoteQty: null, price: null };
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
  } catch (e) {
    if (e instanceof InputError) return fail(e.message);
    throw e;
  }
  // Attached pairs arrive with Task 6; never accept an order while ignoring part of it.
  if (req.attach) return fail('Attached stop-loss and take-profit are not supported yet');
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
    triggerPrice: null,
    status: 'pending',
    filledQty: D(0),
    filledQuote: D(0),
    fee: D(0),
    feeAsset: null,
    lockAsset: req.side === 'buy' ? rules.quote : rules.base,
    lockAmount: D(0),
    ocoGroupId: null,
    attach: null,
    createdAt: ctx.now,
    arrivesAt: null,
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

/** Record a rejected order (nothing locked) and return its event. */
export function rejectOrder(s: SpotState, order: SpotOrder, reason: string, ctx: EngineCtx): EngineEvent[] {
  const rejected: SpotOrder = { ...order, status: 'rejected', rejectReason: reason, lockAmount: D(0) };
  s.orders.set(rejected.id, rejected);
  return [{ type: 'order_rejected', time: ctx.now, order: rejected, reason }];
}

/** Reject an order that holds a lock: release it first. */
export function rejectPending(s: SpotState, order: SpotOrder, reason: string, ctx: EngineCtx): EngineEvent[] {
  releaseFunds(s, order.lockAsset, order.lockAmount);
  return rejectOrder(s, order, reason, ctx);
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
    triggerPrice: null,
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
function arrivalDelay(ctx: EngineCtx): number {
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
  };
}
