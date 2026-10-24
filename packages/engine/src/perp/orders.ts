import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { bestPrice, withoutTaken } from '../book.ts';
import { InputError, parseAmount } from '../input.ts';
import { arrivalDelay, present } from '../spot/orders.ts';
import { LIVE_STATUSES } from '../spot/state.ts';
import type { BookSnapshot, CancelReason, PriceLevel, Side } from '../types.ts';
import { lockUsdt, putOrder, releaseUsdt } from './state.ts';
import type { PerpState } from './state.ts';
import type { PerpCtx, PerpEvent, PerpMarketView, PerpOrder, PerpOrderRequest, PerpOrderType } from './types.ts';

/** Order lifecycle helpers shared by the perp order types. */

/** Trigger prices of the stop-loss and take-profit an opening order places at its first fill. */
export type PerpAttach = NonNullable<PerpOrder['attach']>;

export interface PerpFields {
  qty: Decimal | null;
  quoteQty: Decimal | null;
  price: Decimal | null;
  attach: PerpAttach | null;
}

export function noPerpFields(): PerpFields {
  return { qty: null, quoteQty: null, price: null, attach: null };
}

const NO_TP_SL_PRICE = 'Enter a stop-loss or a take-profit price';
const ATTACH_NOT_OPENING = 'Attached stop-loss and take-profit are only for orders that open or add to a position';

/**
 * Parse a stop-loss and a take-profit trigger price, each optional but not both absent. Throws
 * InputError for a malformed price.
 */
export function readTpSl(input: { stopLoss?: string; takeProfit?: string }): PerpAttach | { reason: string } {
  const stopLoss = present(input.stopLoss) ? parseAmount(input.stopLoss!) : null;
  const takeProfit = present(input.takeProfit) ? parseAmount(input.takeProfit!) : null;
  if (!stopLoss && !takeProfit) return { reason: NO_TP_SL_PRICE };
  return { stopLoss, takeProfit };
}

/**
 * Parse the typed amount: exactly one of qty (coin) and quoteQty (USDT notional), then the limit
 * price when asked for, then the attached stop-loss and take-profit (opening orders only). Stops at
 * the first problem (reason set); fields parsed so far are kept for the record.
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
    if (req.attach) {
      if (req.reduceOnly) {
        return { fields, reason: ATTACH_NOT_OPENING };
      }
      const attach = readTpSl(req.attach);
      if ('reason' in attach) return { fields, reason: attach.reason };
      fields.attach = attach;
    }
  } catch (e) {
    if (e instanceof InputError) return { fields, reason: e.message };
    throw e;
  }
  return { fields, reason: null };
}

export function newPerpOrder(
  req: { symbol: string; side: Side; type: PerpOrderType; reduceOnly?: boolean },
  fields: PerpFields,
  leverage: number,
  ctx: PerpCtx,
): PerpOrder {
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
    attach: fields.attach,
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

/** Record a rejected order (nothing locked) and return its event; `afterTrigger` marks a triggered stop. */
export function rejectOrder(
  s: PerpState,
  order: PerpOrder,
  reason: string,
  ctx: PerpCtx,
  afterTrigger = false,
): PerpEvent[] {
  const rejected: PerpOrder = { ...order, status: 'rejected', rejectReason: reason, lockAmount: D(0) };
  putOrder(s, rejected);
  const event: PerpEvent = { type: 'order_rejected', market: 'perp', time: ctx.now, order: rejected, reason };
  return [afterTrigger ? { ...event, afterTrigger } : event];
}

/** Reject an order that holds a lock: release it first. `afterTrigger` marks a triggered stop. */
export function rejectPending(
  s: PerpState,
  order: PerpOrder,
  reason: string,
  ctx: PerpCtx,
  afterTrigger = false,
): PerpEvent[] {
  releaseUsdt(s, order.lockAmount);
  return rejectOrder(s, order, reason, ctx, afterTrigger);
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

/**
 * Order slots in use on the symbol: every live order, plus the legs an opening order with attached
 * stop-loss/take-profit will place at its first fill, so nothing accepted meanwhile can leave those
 * legs without room.
 */
export function slotsInUse(s: PerpState, symbol: string): number {
  let slots = 0;
  for (const o of liveOrders(s, symbol)) {
    slots += 1;
    if (o.attach && o.filledQty.isZero()) slots += attachedLegs(o.attach);
  }
  return slots;
}

/** How many legs an attach places: one for each price given. */
export function attachedLegs(a: PerpAttach): number {
  return (a.stopLoss ? 1 : 0) + (a.takeProfit ? 1 : 0);
}

/**
 * `ctx` whose book (and best price) is the real book less what the taker fills among `events`
 * took, so several executions in one engine call never take the same liquidity twice.
 */
export function afterOwnFills(ctx: PerpCtx, events: PerpEvent[]): PerpCtx {
  const fills = events.flatMap((e) => (e.type === 'fill' && e.consumed ? [{ fill: e.fill, levels: e.consumed }] : []));
  if (fills.length === 0) return ctx;
  const m = ctx.market;
  const takenOn = (symbol: string, side: Side): PriceLevel[] =>
    fills.flatMap((f) => (f.fill.symbol === symbol && f.fill.side === side ? f.levels : []));
  const book = (symbol: string): BookSnapshot => {
    const b = m.book(symbol);
    return { bids: withoutTaken(b.bids, takenOn(symbol, 'sell')), asks: withoutTaken(b.asks, takenOn(symbol, 'buy')) };
  };
  const market: PerpMarketView = {
    isFresh: (symbol) => m.isFresh(symbol),
    isMarkFresh: (symbol) => m.isMarkFresh(symbol),
    book,
    best: (symbol, side) => (takenOn(symbol, side).length === 0 ? m.best(symbol, side) : bestPrice(book(symbol), side)),
    lastPrice: (symbol) => m.lastPrice(symbol),
    markPrice: (symbol) => m.markPrice(symbol),
    rules: (symbol) => m.rules(symbol),
    brackets: (symbol) => m.brackets(symbol),
  };
  return { ...ctx, market };
}
