import { D, floorToStep } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { bestPrice, walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
import { InputError, parseAmount } from '../input.ts';
import { validateSpotOrder } from '../rules.ts';
import type {
  AggTrade,
  BookSnapshot,
  CancelReason,
  EngineCtx,
  EngineEvent,
  OrderPreview,
  OrderStatus,
  Side,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
} from '../types.ts';
import {
  arrivalDelay,
  fillOrThin,
  marketStep,
  marketTarget,
  newOrder,
  noFields,
  openCounts,
  placePending,
  readRequest,
  rejectOrder,
  rejectPending,
  takerPreview,
} from './orders.ts';
import type { RequestFields } from './orders.ts';
import { freeOf, lockFunds, releaseFunds } from './state.ts';
import type { SpotState } from './state.ts';
import { isStopType, isTriggered } from './triggers.ts';
import type { StopType } from './triggers.ts';

/**
 * Stop-loss and take-profit orders and linked SL/TP pairs.
 * pending → open (armed) → triggered → filled. Armed orders trigger on the last trade price;
 * a triggered order is a market order that walks the real book after a new arrival delay.
 */

export const ESTIMATE_NOTE = 'Estimate if triggered now';

export interface OcoRequest {
  symbol: string;
  qty: string;
  stopLoss: string;
  takeProfit: string;
}

/** Statuses of a stop that has not triggered yet: it can still be cancelled. */
const UNTRIGGERED: ReadonlySet<OrderStatus> = new Set(['pending', 'open']);

function wouldTrigger(type: StopType, side: Side, trigger: Decimal, last: Decimal): string | null {
  if (!isTriggered(type, side, trigger, last)) return null;
  const label = type === 'stop_loss' ? 'Stop' : 'Take-profit';
  return `${label} would trigger immediately (last ${last}, trigger ${trigger})`;
}

// ---- placing ----

interface StopPlan {
  rules: SpotRules;
  fields: RequestFields;
  lockAmount: Decimal | null;
  /** Why submit would reject, or null if it would be placed. */
  reason: string | null;
}

/** Freshness, amounts and trigger, exchange filters, last price, trigger-now, funds, in that order. */
function planStop(s: SpotState, req: SpotOrderRequest, ctx: EngineCtx): StopPlan {
  const rules = ctx.market.rules(req.symbol);
  let fields = noFields();
  const fail = (reason: string): StopPlan => ({ rules, fields, lockAmount: null, reason });
  if (!ctx.market.isFresh(req.symbol)) return fail(`Live data interrupted for ${req.symbol}`);
  const read = readRequest(req, false, true);
  fields = read.fields;
  if (read.reason !== null) return fail(read.reason);

  const type = req.type as StopType;
  const trigger = fields.triggerPrice!;
  // Dollar sizing: a sell becomes the coins the dollars are worth at the trigger; a buy keeps
  // its dollars for execution and is validated with the coins they buy at the trigger.
  const qty = fields.qty ?? floorToStep(fields.quoteQty!.div(trigger), rules.stepSize);
  if (req.side === 'sell') fields.qty = qty;

  const invalid = validateSpotOrder(
    { symbol: req.symbol, side: req.side, type, qty, triggerPrice: trigger },
    rules,
    { avgPrice: ctx.market.avgPrice(req.symbol), ...openCounts(s, req.symbol) },
  );
  if (invalid) return fail(invalid);

  const last = ctx.market.lastPrice(req.symbol);
  if (!last) return fail(`Last price unavailable for ${req.symbol}`);
  const early = wouldTrigger(type, req.side, trigger, last);
  if (early) return fail(early);

  // Sells lock the coins; buys lock trigger × qty, or the dollars when sized in dollars.
  const lockAsset = req.side === 'buy' ? rules.quote : rules.base;
  const lockAmount = req.side === 'sell' ? qty : fields.qty ? trigger.mul(fields.qty) : fields.quoteQty!;
  const free = freeOf(s, 'spot', lockAsset);
  if (lockAmount.gt(free)) return fail(`Insufficient ${lockAsset}: need ${lockAmount}, available ${free}`);
  return { rules, fields, lockAmount, reason: null };
}

export function submitStop(s: SpotState, req: SpotOrderRequest, ctx: EngineCtx): EngineEvent[] {
  const plan = planStop(s, req, ctx);
  const order = newOrder(req, plan.rules, plan.fields, ctx);
  if (plan.reason !== null) return rejectOrder(s, order, plan.reason, ctx);
  return placePending(s, order, plan.lockAmount!, bestPrice(ctx.market.book(req.symbol), req.side), ctx);
}

/** Estimate: the current book walked as if the order triggered now, taker fee. */
export function previewStop(s: SpotState, req: SpotOrderRequest, ctx: EngineCtx): OrderPreview {
  const plan = planStop(s, req, ctx);
  const { qty, quoteQty, triggerPrice } = plan.fields;
  const book = ctx.market.book(req.symbol);
  const sized = triggerPrice !== null && (qty !== null || quoteQty !== null);
  const walk = sized ? walkBook(book, req.side, marketTarget(plan.fields), marketStep(plan.rules)) : null;
  return { ...takerPreview(walk, req.side, plan.rules, ctx, plan.reason), note: ESTIMATE_NOTE };
}

/**
 * Arrival of a pending stop, or of both legs of a pending pair at once: armed ('open'), or
 * rejected when the data is stale or it would trigger now (as the exchange would reject it).
 */
export function arriveStop(s: SpotState, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  const legs = order.ocoGroupId ? pairLegs(s, order.ocoGroupId).filter((l) => l.status === 'pending') : [order];
  const reason = armReason(legs, ctx);
  if (reason !== null) return legs.flatMap((l) => rejectPending(s, l, reason, ctx));
  for (const l of legs) s.orders.set(l.id, { ...l, status: 'open' });
  return [];
}

function armReason(legs: SpotOrder[], ctx: EngineCtx): string | null {
  const symbol = legs[0]!.symbol;
  if (!ctx.market.isFresh(symbol)) return `Live data interrupted for ${symbol}`;
  const last = ctx.market.lastPrice(symbol);
  if (!last) return `Last price unavailable for ${symbol}`;
  for (const l of legs) {
    const reason = wouldTrigger(l.type as StopType, l.side, l.triggerPrice!, last);
    if (reason) return reason;
  }
  return null;
}

// ---- trigger and execution ----

/** Trigger the armed stops of `symbol` that this trade's price reached. Paused while stale. */
export function triggerStops(s: SpotState, symbol: string, trade: AggTrade, ctx: EngineCtx): EngineEvent[] {
  if (!ctx.market.isFresh(symbol)) return [];
  const book = ctx.market.book(symbol);
  const events: EngineEvent[] = [];
  for (const { id } of [...s.orders.values()]) {
    // Re-read: an earlier trigger in this loop may have cancelled this order as a pair partner.
    const o = s.orders.get(id)!;
    if (o.symbol !== symbol || o.status !== 'open' || !isStopType(o.type)) continue;
    if (!isTriggered(o.type, o.side, o.triggerPrice!, trade.price)) continue;
    events.push(...trigger(s, o, trade.price, book, ctx));
  }
  return events;
}

/**
 * The order is now a market order on its way to the exchange; the best price it will take is
 * recorded so the fill's drift measures trigger → execution. A pair partner is cancelled now
 * (a triggered order is certain to execute) and the pair's lock moves to the triggered leg.
 */
function trigger(s: SpotState, order: SpotOrder, last: Decimal, book: BookSnapshot, ctx: EngineCtx): EngineEvent[] {
  const partners = untriggeredPartners(s, order);
  const lockAmount = partners.reduce((sum, p) => sum.plus(p.lockAmount), order.lockAmount);
  const triggered: SpotOrder = {
    ...order,
    status: 'triggered',
    triggeredAt: ctx.now,
    arrivesAt: ctx.now + arrivalDelay(ctx),
    bestAtSubmit: bestPrice(book, order.side),
    lockAmount,
  };
  s.orders.set(triggered.id, triggered);
  const events: EngineEvent[] = [{ type: 'order_triggered', time: ctx.now, order: triggered, lastPrice: last }];
  for (const p of partners) events.push(cancelLeg(s, p, 'oco', ctx));
  return events;
}

/**
 * A triggered order whose arrival time has come. Stale data never rejects it: it stays
 * triggered with arrivesAt null and executes on the first fresh book (executeDue).
 */
export function arriveTriggered(s: SpotState, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  if (order.arrivesAt === null || ctx.now < order.arrivesAt) return [];
  if (!ctx.market.isFresh(order.symbol)) {
    s.orders.set(order.id, { ...order, arrivesAt: null });
    return [];
  }
  return executeTriggered(s, order, ctx);
}

/** Execute every triggered order of `symbol` that is due, deferred ones included. */
export function executeDue(s: SpotState, symbol: string, ctx: EngineCtx): EngineEvent[] {
  if (!ctx.market.isFresh(symbol)) return [];
  const due = [...s.orders.values()].filter(
    (o) => o.symbol === symbol && o.status === 'triggered' && (o.arrivesAt === null || o.arrivesAt <= ctx.now),
  );
  return due.flatMap((o) => executeTriggered(s, o, ctx));
}

function executeTriggered(s: SpotState, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  const rules = ctx.market.rules(order.symbol);
  const book = ctx.market.book(order.symbol);
  const walk = walkBook(book, order.side, marketTarget(order), marketStep(rules));
  // Only a qty-sized buy can cost more than its lock: a dollar-sized buy spends at most its
  // dollars and a sell at most its coins.
  if (order.side === 'buy') {
    const available = order.lockAmount.plus(freeOf(s, 'spot', order.lockAsset));
    if (walk.quote.gt(available)) return expire(s, order, walk, available, ctx);
  }
  return fillOrThin(s, order, walk, book, rules, ctx);
}

/** The exchange rejects for balance and never part-fills on it, so the order expires in full. */
function expire(s: SpotState, order: SpotOrder, walk: WalkResult, available: Decimal, ctx: EngineCtx): EngineEvent[] {
  const kind = order.type === 'stop_loss' ? 'stop' : 'take-profit';
  const reason =
    `Triggered ${kind} expired: insufficient funds at execution ` +
    `(need ${walk.quote}, available ${available}; trigger ${order.triggerPrice}, book average ${walk.avgPrice})`;
  releaseFunds(s, order.lockAsset, order.lockAmount);
  const rejected: SpotOrder = { ...order, status: 'rejected', rejectReason: reason, lockAmount: D(0) };
  s.orders.set(rejected.id, rejected);
  return [{ type: 'order_rejected', time: ctx.now, order: rejected, reason, afterTrigger: true }];
}

// ---- cancel ----

/** Owner cancel of an untriggered stop. A pair is cancelled as a whole and its lock released. */
export function cancelStop(s: SpotState, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  return [order, ...untriggeredPartners(s, order)].map((leg) => {
    releaseFunds(s, leg.lockAsset, leg.lockAmount);
    return cancelLeg(s, leg, leg === order ? 'user' : 'oco', ctx);
  });
}

/** Record the leg as cancelled with no lock; the caller has released or moved its lock. */
function cancelLeg(s: SpotState, leg: SpotOrder, reason: CancelReason, ctx: EngineCtx): EngineEvent {
  const cancelled: SpotOrder = { ...leg, status: 'cancelled', lockAmount: D(0) };
  s.orders.set(cancelled.id, cancelled);
  // A dollar-sized buy stop reports the coins its dollars buy at the trigger.
  const qty = leg.qty ?? floorToStep(leg.quoteQty!.div(leg.triggerPrice!), ctx.market.rules(leg.symbol).stepSize);
  return { type: 'order_cancelled', time: ctx.now, order: cancelled, reason, cancelledQty: qty };
}

// ---- linked pairs ----

function pairLegs(s: SpotState, groupId: string): SpotOrder[] {
  return [...s.orders.values()].filter((o) => o.ocoGroupId === groupId);
}

function untriggeredPartners(s: SpotState, order: SpotOrder): SpotOrder[] {
  if (!order.ocoGroupId) return [];
  return pairLegs(s, order.ocoGroupId).filter((l) => l.id !== order.id && UNTRIGGERED.has(l.status));
}

export function attachOco(s: SpotState, req: OcoRequest, ctx: EngineCtx): EngineEvent[] {
  let amounts: PairAmounts | null = null;
  let parseError: string | null = null;
  try {
    amounts = {
      qty: parseAmount(req.qty),
      stopLoss: parseAmount(req.stopLoss),
      takeProfit: parseAmount(req.takeProfit),
    };
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    parseError = e.message;
  }
  return placePair(s, req.symbol, amounts, parseError, ctx);
}

/**
 * Activate the attached pair of every buy these events finished: filled, or cancelled
 * after a partial fill. The pair covers the net coins received, floored to the step size.
 */
export function activateAttachedPairs(s: SpotState, events: EngineEvent[], ctx: EngineCtx): EngineEvent[] {
  const out = [...events];
  for (const e of events) {
    if (e.type !== 'fill' && e.type !== 'order_cancelled') continue;
    const o = e.order;
    if (!o.attach || (o.status !== 'filled' && o.status !== 'cancelled') || o.filledQty.isZero()) continue;
    // Buys only: the fee was taken in the coin.
    const qty = floorToStep(o.filledQty.minus(o.fee), ctx.market.rules(o.symbol).stepSize);
    out.push(...placePair(s, o.symbol, { qty, ...o.attach }, null, ctx));
  }
  return out;
}

interface PairAmounts {
  qty: Decimal;
  stopLoss: Decimal;
  takeProfit: Decimal;
}

/**
 * A sell stop-loss and a sell take-profit over the same coins, one-cancels-other. Both legs
 * share a group id and one arrival; the coins are locked once, on the stop-loss leg.
 * On any problem both legs are recorded as rejected with the same reason.
 */
function placePair(
  s: SpotState,
  symbol: string,
  a: PairAmounts | null,
  parseError: string | null,
  ctx: EngineCtx,
): EngineEvent[] {
  const rules = ctx.market.rules(symbol);
  const ocoGroupId = ctx.newId('g');
  const leg = (type: StopType, triggerPrice: Decimal | null): SpotOrder => ({
    ...newOrder({ symbol, side: 'sell', type }, rules, { ...noFields(), qty: a?.qty ?? null, triggerPrice }, ctx),
    ocoGroupId,
  });
  const sl = leg('stop_loss', a?.stopLoss ?? null);
  const tp = leg('take_profit', a?.takeProfit ?? null);
  const reason = pairReason(s, sl, tp, rules, parseError, ctx);
  if (reason !== null) return [...rejectOrder(s, sl, reason, ctx), ...rejectOrder(s, tp, reason, ctx)];

  const qty = sl.qty!;
  lockFunds(s, rules.base, qty);
  const sent = {
    status: 'pending' as const,
    arrivesAt: ctx.now + arrivalDelay(ctx),
    bestAtSubmit: bestPrice(ctx.market.book(symbol), 'sell'),
  };
  return [
    { ...sl, ...sent, lockAmount: qty },
    { ...tp, ...sent },
  ].map((o): EngineEvent => {
    s.orders.set(o.id, o);
    return { type: 'order_placed', time: ctx.now, order: o };
  });
}

/** Freshness, amounts, filters for each leg (a pair counts as two algo orders), trigger-now, funds. */
function pairReason(
  s: SpotState,
  sl: SpotOrder,
  tp: SpotOrder,
  rules: SpotRules,
  parseError: string | null,
  ctx: EngineCtx,
): string | null {
  const symbol = sl.symbol;
  if (!ctx.market.isFresh(symbol)) return `Live data interrupted for ${symbol}`;
  if (parseError !== null) return parseError;
  const avgPrice = ctx.market.avgPrice(symbol);
  const counts = openCounts(s, symbol);
  const check = (o: SpotOrder, extra: number) =>
    validateSpotOrder(
      { symbol, side: o.side, type: o.type, qty: o.qty!, triggerPrice: o.triggerPrice! },
      rules,
      { avgPrice, openOrders: counts.openOrders + extra, openAlgoOrders: counts.openAlgoOrders + extra },
    );
  const invalid = check(sl, 0) ?? check(tp, 1) ?? armReason([sl, tp], ctx);
  if (invalid) return invalid;
  const free = freeOf(s, 'spot', rules.base);
  if (sl.qty!.gt(free)) return `Insufficient ${rules.base}: need ${sl.qty}, available ${free}`;
  return null;
}
