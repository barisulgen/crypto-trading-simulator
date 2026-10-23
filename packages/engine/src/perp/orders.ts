import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { InputError, parseAmount } from '../input.ts';
import { arrivalDelay, present } from '../spot/orders.ts';
import { LIVE_STATUSES } from '../spot/state.ts';
import type { CancelReason } from '../types.ts';
import { lockUsdt, putOrder, releaseUsdt } from './state.ts';
import type { PerpState } from './state.ts';
import type { PerpCtx, PerpEvent, PerpOrder, PerpOrderRequest } from './types.ts';

/** Order lifecycle helpers shared by the perp order types. */

export interface PerpFields {
  qty: Decimal | null;
  quoteQty: Decimal | null;
  price: Decimal | null;
}

export function noPerpFields(): PerpFields {
  return { qty: null, quoteQty: null, price: null };
}

/**
 * Parse the typed amount: exactly one of qty (coin) and quoteQty (USDT notional), then the limit
 * price when asked for. Stops at the first problem (reason set); fields parsed so far are kept for
 * the record.
 */
export function readPerpAmount(
  req: PerpOrderRequest,
  withPrice = false,
): { fields: PerpFields; reason: string | null } {
  const fields = noPerpFields();
  const hasQty = present(req.qty);
  if (hasQty === present(req.quoteQty)) return { fields, reason: 'Enter either a coin amount or a dollar amount' };
  try {
    if (hasQty) fields.qty = parseAmount(req.qty!);
    else fields.quoteQty = parseAmount(req.quoteQty!);
    if (withPrice) {
      if (!present(req.price)) return { fields, reason: 'Enter a limit price' };
      fields.price = parseAmount(req.price!);
    }
  } catch (e) {
    if (e instanceof InputError) return { fields, reason: e.message };
    throw e;
  }
  return { fields, reason: null };
}

export function newPerpOrder(req: PerpOrderRequest, fields: PerpFields, leverage: number, ctx: PerpCtx): PerpOrder {
  return {
    id: ctx.newId('o'),
    symbol: req.symbol,
    side: req.side,
    type: req.type,
    qty: fields.qty,
    quoteQty: fields.quoteQty,
    price: fields.price,
    triggerPrice: null,
    reduceOnly: req.reduceOnly === true,
    closePosition: false,
    leverage,
    status: 'pending',
    filledQty: D(0),
    filledQuote: D(0),
    fee: D(0),
    lockAmount: D(0),
    ocoGroupId: null,
    parentId: null,
    attach: null,
    createdAt: ctx.now,
    arrivesAt: null,
    triggeredAt: null,
    cancelArrivesAt: null,
    bestAtSubmit: null,
    rejectReason: null,
    realizedPnl: D(0),
  };
}

/** Lock the leverage USDT and record the order as pending until its arrival delay has passed. */
export function placePending(
  s: PerpState,
  order: PerpOrder,
  lockAmount: Decimal,
  bestAtSubmit: Decimal | null,
  ctx: PerpCtx,
): PerpEvent[] {
  lockUsdt(s, lockAmount);
  const pending: PerpOrder = {
    ...order,
    status: 'pending',
    lockAmount,
    arrivesAt: ctx.now + arrivalDelay(ctx),
    bestAtSubmit,
  };
  putOrder(s, pending);
  return [{ type: 'order_placed', market: 'perp', time: ctx.now, order: pending }];
}

/** Record a rejected order (nothing locked) and return its event. */
export function rejectOrder(s: PerpState, order: PerpOrder, reason: string, ctx: PerpCtx): PerpEvent[] {
  const rejected: PerpOrder = { ...order, status: 'rejected', rejectReason: reason, lockAmount: D(0) };
  putOrder(s, rejected);
  return [{ type: 'order_rejected', market: 'perp', time: ctx.now, order: rejected, reason }];
}

/** Reject an order that holds a lock: release it first. */
export function rejectPending(s: PerpState, order: PerpOrder, reason: string, ctx: PerpCtx): PerpEvent[] {
  releaseUsdt(s, order.lockAmount);
  return rejectOrder(s, order, reason, ctx);
}

/** Cancel what is left of an order, releasing its lock. */
export function cancelOrder(
  s: PerpState,
  order: PerpOrder,
  reason: CancelReason,
  cancelledQty: Decimal,
  ctx: PerpCtx,
): PerpEvent[] {
  releaseUsdt(s, order.lockAmount);
  const cancelled: PerpOrder = { ...order, status: 'cancelled', lockAmount: D(0) };
  putOrder(s, cancelled);
  return [{ type: 'order_cancelled', market: 'perp', time: ctx.now, order: cancelled, reason, cancelledQty }];
}

/** Base quantity an order still has to fill; 0 for a close-position order, which has none of its own. */
export function remainingQty(o: PerpOrder): Decimal {
  return o.qty ? o.qty.minus(o.filledQty) : D(0);
}

/** Live orders on the symbol, in flight included. */
export function liveOrders(s: PerpState, symbol: string): PerpOrder[] {
  return [...s.orders.values()].filter((o) => o.symbol === symbol && LIVE_STATUSES.has(o.status));
}
