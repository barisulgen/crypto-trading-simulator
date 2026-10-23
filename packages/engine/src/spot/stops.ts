import { D, Decimal, floorToStep } from '../decimal.ts';
import { bestPrice, walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
import { InputError, parseAmount } from '../input.ts';
import { priceFilter, validateSpotOrder } from '../rules.ts';
import type {
  AggTrade,
  BookSnapshot,
  CancelReason,
  EngineCtx,
  EngineEvent,
  OrderPreview,
  OrderStatus,
  OrderType,
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
 * A pair attached to a buy is exchange-side (like Binance's OTOCO), so gaps in our data (stale
 * feed, no last price) never reject it: its legs wait (arrivesAt null) and arm on the first fresh
 * book that has a last price (armWaitingPairs).
 */
export function arriveStop(s: SpotState, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  const legs = order.ocoGroupId ? pairLegs(s, order.ocoGroupId).filter((l) => l.status === 'pending') : [order];
  if (order.parentId !== null && !canArmNow(order.symbol, ctx)) {
    for (const l of legs) s.orders.set(l.id, { ...l, arrivesAt: null });
    return [];
  }
  const reason = armReason(legs, ctx);
  if (reason !== null) return legs.flatMap((l) => rejectPending(s, l, reason, ctx));
  for (const l of legs) s.orders.set(l.id, { ...l, status: 'open' });
  return [];
}

/** Our data can judge "would trigger now": the book is fresh and there is a last price. */
function canArmNow(symbol: string, ctx: EngineCtx): boolean {
  return ctx.market.isFresh(symbol) && ctx.market.lastPrice(symbol) !== null;
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

/** A leg of a pair attached to a buy that waits for data (fresh book, last price) to arm. */
export function waitingToArm(o: SpotOrder): boolean {
  return o.status === 'pending' && o.parentId !== null && o.arrivesAt === null;
}

/** A triggered order that executes on the next fresh book: deferred by stale data, or past its arrival. */
export function dueTriggered(o: SpotOrder, now: number): boolean {
  return o.status === 'triggered' && (o.arrivesAt === null || o.arrivesAt <= now);
}

/** Arm (or reject) the attached pairs of `symbol` that waited for data (fresh book, last price). */
export function armWaitingPairs(s: SpotState, symbol: string, ctx: EngineCtx): EngineEvent[] {
  if (!ctx.market.isFresh(symbol)) return [];
  const waiting = [...s.orders.values()].filter((o) => o.symbol === symbol && waitingToArm(o));
  const events: EngineEvent[] = [];
  for (const { id } of waiting) {
    // Re-read: arriving one leg settles its partner too.
    const o = s.orders.get(id)!;
    if (o.status === 'pending') events.push(...arriveStop(s, o, ctx));
  }
  return events;
}

/** Execute every triggered order of `symbol` that is due, deferred ones included. */
export function executeDue(s: SpotState, symbol: string, ctx: EngineCtx): EngineEvent[] {
  if (!ctx.market.isFresh(symbol)) return [];
  const due = [...s.orders.values()].filter((o) => o.symbol === symbol && dueTriggered(o, ctx.now));
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
    if (walk.quote.gt(available)) return expire(s, order, walk, available, rules, ctx);
  }
  return fillOrThin(s, order, walk, book, rules, ctx);
}

/** The exchange rejects for balance and never part-fills on it, so the order expires in full. */
function expire(
  s: SpotState,
  order: SpotOrder,
  walk: WalkResult,
  available: Decimal,
  rules: SpotRules,
  ctx: EngineCtx,
): EngineEvent[] {
  const kind = order.type === 'stop_loss' ? 'stop' : 'take-profit';
  // The book average is shown at the symbol's price precision (tick), rounded half-up.
  const avg = walk.avgPrice;
  const shownAvg = avg && !rules.tickSize.isZero() ? avg.toNearest(rules.tickSize, Decimal.ROUND_HALF_UP) : avg;
  const reason =
    `Triggered ${kind} expired: insufficient funds at execution ` +
    `(need ${walk.quote}, available ${available}; trigger ${order.triggerPrice}, book average ${shownAvg})`;
  return rejectPending(s, order, reason, ctx, true);
}

// ---- cancel ----

/** Whether an owner cancel of this order, or of the pair it belongs to, is already on its way. */
export function cancelRequested(s: SpotState, order: SpotOrder): boolean {
  return [order, ...untriggeredPartners(s, order)].some((leg) => leg.cancelArrivesAt !== null);
}

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
  return placePair(s, req.symbol, amounts, parseError, null, ctx);
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
    out.push(...placePair(s, o.symbol, { qty, ...o.attach }, null, o.id, ctx));
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
 * A pair attached to a buy (`parentId`) placed while the data is stale waits for fresh data
 * (arrivesAt null) instead of being rejected; whether it would trigger now is checked when it arms.
 */
function placePair(
  s: SpotState,
  symbol: string,
  a: PairAmounts | null,
  parseError: string | null,
  parentId: string | null,
  ctx: EngineCtx,
): EngineEvent[] {
  const rules = ctx.market.rules(symbol);
  const ocoGroupId = ctx.newId('g');
  const leg = (type: StopType, triggerPrice: Decimal | null): SpotOrder => ({
    ...newOrder({ symbol, side: 'sell', type }, rules, { ...noFields(), qty: a?.qty ?? null, triggerPrice }, ctx),
    ocoGroupId,
    parentId,
  });
  const sl = leg('stop_loss', a?.stopLoss ?? null);
  const tp = leg('take_profit', a?.takeProfit ?? null);
  const reason = pairReason(s, sl, tp, rules, parseError, ctx);
  if (reason !== null) return [...rejectOrder(s, sl, reason, ctx), ...rejectOrder(s, tp, reason, ctx)];

  const qty = sl.qty!;
  lockFunds(s, rules.base, qty);
  const sent = {
    status: 'pending' as const,
    arrivesAt: ctx.market.isFresh(symbol) ? ctx.now + arrivalDelay(ctx) : null,
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

/**
 * Freshness, amounts, filters for each leg (a pair counts as two algo orders), trigger-now, funds.
 * An attached pair skips freshness, and skips trigger-now while our data cannot judge it (stale or
 * no last price); that is checked when it arms.
 */
function pairReason(
  s: SpotState,
  sl: SpotOrder,
  tp: SpotOrder,
  rules: SpotRules,
  parseError: string | null,
  ctx: EngineCtx,
): string | null {
  const symbol = sl.symbol;
  const fresh = ctx.market.isFresh(symbol);
  if (!fresh && sl.parentId === null) return `Live data interrupted for ${symbol}`;
  if (parseError !== null) return parseError;
  const counts = openCounts(s, symbol);
  const triggerNow = sl.parentId === null || canArmNow(symbol, ctx);
  const invalid =
    pairAlgoFull(symbol, counts, rules) ??
    legFilters(symbol, sl.qty!, sl.triggerPrice!, tp.triggerPrice!, rules, counts) ??
    (triggerNow ? armReason([sl, tp], ctx) : null);
  if (invalid) return invalid;
  const free = freeOf(s, 'spot', rules.base);
  if (sl.qty!.gt(free)) return `Insufficient ${rules.base}: need ${sl.qty}, available ${free}`;
  return null;
}

/** A pair counts as two algo orders. */
function pairAlgoFull(symbol: string, counts: { openAlgoOrders: number }, rules: SpotRules): string | null {
  if (counts.openAlgoOrders + 2 <= rules.maxNumAlgoOrders) return null;
  return `MAX_NUM_ALGO_ORDERS: a stop-loss/take-profit pair needs 2 slots but ${counts.openAlgoOrders} of ${rules.maxNumAlgoOrders} are in use on ${symbol}`;
}

/** Exchange filters of both sell legs over `qty` coins; the take-profit counts the stop-loss as open. */
function legFilters(
  symbol: string,
  qty: Decimal,
  stopLoss: Decimal,
  takeProfit: Decimal,
  rules: SpotRules,
  counts: { openOrders: number; openAlgoOrders: number },
): string | null {
  // Stops and take-profits do not use the average price.
  const check = (type: StopType, triggerPrice: Decimal, extra: number) =>
    validateSpotOrder({ symbol, side: 'sell', type, qty, triggerPrice }, rules, {
      avgPrice: null,
      openOrders: counts.openOrders + extra,
      openAlgoOrders: counts.openAlgoOrders + extra,
    });
  return check('stop_loss', stopLoss, 0) ?? check('take_profit', takeProfit, 1);
}

/** Coins a buy of `qty` leaves after the fee, floored to the step size: the quantity its pair will cover. */
export function expectedNetQty(qty: Decimal, feeRate: Decimal, rules: SpotRules): Decimal {
  return floorToStep(qty.minus(qty.mul(feeRate)), rules.stepSize);
}

/**
 * Whether the pair attached to a buy would be accepted, checked when the buy is placed so a bad
 * pair rejects the whole order (as an exchange rejects every order of a list up front).
 * `reference` is the limit price for limit and post-only buys and the last price for market buys;
 * `netQty` is the coins the pair will cover (expectedNetQty, with the taker rate as an upper
 * bound on the fee). In order: both trigger prices, their position relative to `reference`, the
 * three order slots (the buy and two legs), the two algo slots, then each leg's filters.
 * Whether a leg would trigger immediately is checked again when the buy has filled.
 */
export function validateAttachedPair(
  req: { side: Side; type: OrderType; symbol: string },
  attach: { stopLoss: Decimal; takeProfit: Decimal },
  netQty: Decimal,
  reference: Decimal,
  rules: SpotRules,
  counts: { openOrders: number; openAlgoOrders: number },
): string | null {
  const { stopLoss, takeProfit } = attach;
  const price = priceFilter('trigger price', stopLoss, rules) ?? priceFilter('trigger price', takeProfit, rules);
  if (price) return price;

  const ref = req.type === 'market' ? `the last price ${reference}` : `the limit price ${reference}`;
  if (stopLoss.gte(reference)) return `Attached stop-loss ${stopLoss} must be below ${ref}`;
  if (takeProfit.lte(reference)) return `Attached take-profit ${takeProfit} must be above ${ref}`;

  if (counts.openOrders + 3 > rules.maxNumOrders) {
    return `MAX_NUM_ORDERS: an order with an attached pair needs 3 slots but ${counts.openOrders} of ${rules.maxNumOrders} are in use on ${req.symbol}`;
  }
  return pairAlgoFull(req.symbol, counts, rules) ?? legFilters(req.symbol, netQty, stopLoss, takeProfit, rules, counts);
}
