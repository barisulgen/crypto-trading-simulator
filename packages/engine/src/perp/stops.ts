import { floorToStep } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { InputError } from '../input.ts';
import { marketLotSize, priceFilter } from '../rules.ts';
import { arrivalDelay, drift } from '../spot/orders.ts';
import { isTriggered } from '../spot/triggers.ts';
import type { StopType } from '../spot/triggers.ts';
import type { AggTrade, OrderStatus, Side } from '../types.ts';
import { bracketsOrNull, liveDataReason, opposite, validMark, walkInBand } from './market.ts';
import {
  afterOwnFills,
  attachedLegs,
  cancelOrder,
  liveOrders,
  newPerpOrder,
  noPerpFields,
  readTpSl,
  rejectOrder,
  rejectPending,
  remainingQty,
  slotsInUse,
} from './orders.ts';
import type { PerpAttach } from './orders.ts';
import { applyReducingFill, positionClosed } from './position.ts';
import type { PerpFillTerms } from './position.ts';
import { validatePerpOrder } from './rules.ts';
import { leverageFor, putOrder } from './state.ts';
import type { PerpState } from './state.ts';
import type { PerpCtx, PerpEvent, PerpOrder, PerpOrderRequest, PerpRules, Position } from './types.ts';

/**
 * Position stop-loss and take-profit: close-position stops (Binance closePosition) on the side
 * opposite the position. pending → open (armed) → triggered → filled. Armed stops trigger on the
 * last trade price, never the mark; a triggered stop is a market order for the whole current
 * position that walks the real book within the price band after a new arrival delay. It never
 * opens or flips a position, and our stale data never rejects it: it waits for the first fresh book.
 */

/** Statuses of a stop that has not triggered yet: it can still be cancelled. */
const UNTRIGGERED: ReadonlySet<OrderStatus> = new Set(['pending', 'open']);

function isStop(o: PerpOrder): o is PerpOrder & { type: StopType } {
  return o.type === 'stop_loss' || o.type === 'take_profit';
}

function legName(type: StopType): string {
  return type === 'stop_loss' ? 'stop-loss' : 'take-profit';
}

/** The side of the orders that close a position of `side`. */
function closingSide(side: Position['side']): Side {
  return side === 'long' ? 'sell' : 'buy';
}

function wouldTrigger(type: StopType, side: Side, trigger: Decimal, last: Decimal): string | null {
  if (!isTriggered(type, side, trigger, last)) return null;
  const label = type === 'stop_loss' ? 'Stop' : 'Take-profit';
  return `${label} would trigger immediately (last ${last}, trigger ${trigger})`;
}

/** Our data can judge "would trigger now": the symbol's data is fresh and there is a last price. */
export function canArmNow(symbol: string, ctx: PerpCtx): boolean {
  return liveDataReason(symbol, ctx) === null && ctx.market.lastPrice(symbol) !== null;
}

/**
 * Why the symbol cannot take another leg of `type`: the position already has an untriggered one,
 * or an opening order not yet filled will attach one at its first fill (one stop-loss and one
 * take-profit per position). Null when it can.
 */
function legConflict(s: PerpState, symbol: string, type: StopType): string | null {
  const live = liveOrders(s, symbol);
  if (live.some((o) => o.closePosition && o.type === type && UNTRIGGERED.has(o.status))) {
    return `This position already has a ${legName(type)}; cancel it first`;
  }
  const key = type === 'stop_loss' ? 'stopLoss' : 'takeProfit';
  if (live.some((o) => o.attach?.[key] && o.filledQty.isZero())) {
    return `An open order on ${symbol} already attaches a ${legName(type)}; cancel it first`;
  }
  return null;
}

/** The legs an attach or a TP/SL request asks for, in order: stop-loss, then take-profit. */
function legPrices(a: PerpAttach): [StopType, Decimal][] {
  const legs: [StopType, Decimal][] = [];
  if (a.stopLoss) legs.push(['stop_loss', a.stopLoss]);
  if (a.takeProfit) legs.push(['take_profit', a.takeProfit]);
  return legs;
}

/** Unplaced close-position legs on `side`; two share a group so that one triggering cancels the other. */
function newLegs(
  symbol: string,
  side: Side,
  prices: [StopType, Decimal | null][],
  leverage: number,
  parentId: string | null,
  ctx: PerpCtx,
): PerpOrder[] {
  const ocoGroupId = prices.length === 2 ? ctx.newId('g') : null;
  return prices.map(([type, triggerPrice]) => ({
    ...newPerpOrder({ symbol, side, type, reduceOnly: true }, noPerpFields(), leverage, ctx),
    triggerPrice,
    closePosition: true,
    ocoGroupId,
    parentId,
  }));
}

/** Send the legs to the exchange together: one arrival delay, or none while waiting for data. */
function placeLegs(s: PerpState, legs: PerpOrder[], arrivesAt: number | null, ctx: PerpCtx): PerpEvent[] {
  const bestAtSubmit = ctx.market.best(legs[0]!.symbol, legs[0]!.side);
  return legs.map((leg): PerpEvent => {
    const pending: PerpOrder = { ...leg, status: 'pending', arrivesAt, bestAtSubmit };
    putOrder(s, pending);
    return { type: 'order_placed', market: 'perp', time: ctx.now, order: pending };
  });
}

// ---- placing ----

/**
 * Set a stop-loss and/or take-profit on the symbol's position: close-position stops on the side
 * opposite it, sharing a group when both are given. In order: the position, fresh data, the prices,
 * the exchange filters of each leg (PRICE_FILTER, MAX_NUM_ORDERS), the last price, whether a leg
 * would trigger now, and one stop-loss and one take-profit per position. On any problem every leg
 * is recorded as rejected with the same reason.
 */
export function setPositionTpSl(
  s: PerpState,
  symbol: string,
  input: { stopLoss?: string; takeProfit?: string },
  ctx: PerpCtx,
): PerpEvent[] {
  const position = s.positions[symbol] ?? null;
  // Without a position there is no side to close; the rejected legs are recorded as sells.
  const side = position ? closingSide(position.side) : 'sell';
  const leverage = position?.leverage ?? leverageFor(s, symbol, bracketsOrNull(symbol, ctx));

  let prices: PerpAttach | { reason: string };
  try {
    prices = readTpSl(input);
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    prices = { reason: e.message };
  }
  const asked: [StopType, Decimal | null][] =
    'reason' in prices ? [['stop_loss', null]] : legPrices(prices);
  const legs = newLegs(symbol, side, asked, leverage, null, ctx);

  const reason = tpSlReason(s, symbol, position, legs, 'reason' in prices ? prices.reason : null, ctx);
  if (reason !== null) return legs.flatMap((l) => rejectOrder(s, l, reason, ctx));
  return placeLegs(s, legs, ctx.now + arrivalDelay(ctx), ctx);
}

function tpSlReason(
  s: PerpState,
  symbol: string,
  position: Position | null,
  legs: PerpOrder[],
  parseError: string | null,
  ctx: PerpCtx,
): string | null {
  if (!position) return `No open position on ${symbol}`;
  const stale = liveDataReason(symbol, ctx);
  if (stale) return stale;
  if (parseError !== null) return parseError;
  const rules = ctx.market.rules(symbol);
  const slots = slotsInUse(s, symbol);
  for (const [i, l] of legs.entries()) {
    const invalid = validatePerpOrder(
      { symbol, side: l.side, type: l.type, triggerPrice: l.triggerPrice!, reduceOnly: true },
      rules,
      { mark: validMark(symbol, ctx), openOrders: slots + i },
    );
    if (invalid) return invalid;
  }
  const last = ctx.market.lastPrice(symbol);
  if (!last) return `Last price unavailable for ${symbol}`;
  for (const l of legs) {
    const early = wouldTrigger(l.type as StopType, l.side, l.triggerPrice!, last);
    if (early) return early;
  }
  for (const l of legs) {
    const conflict = legConflict(s, symbol, l.type as StopType);
    if (conflict) return conflict;
  }
  return null;
}

/**
 * Whether the stop-loss and take-profit attached to an opening order would be accepted, checked
 * when the order is placed so that a bad leg rejects the whole order. `reference` is the limit
 * price for limit and post-only orders and the last price for market orders: a long needs its
 * stop-loss below it and its take-profit above, a short the reverse. In order: PRICE_FILTER of each
 * trigger, its side of the reference, one stop-loss and one take-profit per position, then the
 * order slots of the order and its legs. Whether a leg would trigger now is checked again when the
 * order first fills.
 */
export function attachReason(
  s: PerpState,
  o: { symbol: string; side: Side; type: PerpOrderRequest['type'] },
  attach: PerpAttach,
  reference: Decimal,
  rules: PerpRules,
): string | null {
  const legs = legPrices(attach);
  for (const [, price] of legs) {
    const invalid = priceFilter('trigger price', price, rules);
    if (invalid) return invalid;
  }
  const ref = o.type === 'market' ? `the last price ${reference}` : `the limit price ${reference}`;
  const long = o.side === 'buy';
  for (const [type, price] of legs) {
    // A long's stop-loss is below and its take-profit above; a short's the other way round.
    const below = (type === 'stop_loss') === long;
    if (below && price.gte(reference)) return `Attached ${legName(type)} ${price} must be below ${ref}`;
    if (!below && price.lte(reference)) return `Attached ${legName(type)} ${price} must be above ${ref}`;
  }
  for (const [type] of legs) {
    const conflict = legConflict(s, o.symbol, type);
    if (conflict) return conflict;
  }
  const used = slotsInUse(s, o.symbol);
  const need = 1 + attachedLegs(attach);
  if (used + need > rules.maxNumOrders) {
    const inUse = `${used} of ${rules.maxNumOrders} are in use on ${o.symbol}`;
    return `MAX_NUM_ORDERS: an order with attached stop-loss/take-profit needs ${need} slots but ${inUse}`;
  }
  return null;
}

/**
 * Place the attached legs of every opening order whose first fill is among `events`, for the
 * position that fill opened or added to; returns `events` followed by what that placed.
 */
export function activateAttached(s: PerpState, events: PerpEvent[], ctx: PerpCtx): PerpEvent[] {
  const out = [...events];
  for (const e of events) {
    if (e.type !== 'fill' || !e.order.attach || !e.order.filledQty.eq(e.fill.qty)) continue;
    out.push(...placeAttached(s, e.order, e.order.attach, ctx));
  }
  return out;
}

/**
 * The legs of `parent`, now that it has filled for the first time. Like Binance's attached
 * orders they are exchange-side, so gaps in our data never reject them: placed while our data
 * cannot judge "would trigger now" (stale, or no last price), they wait (arrivesAt null) and arm on
 * the first fresh data. When it can judge, a leg that would trigger now rejects both.
 */
function placeAttached(s: PerpState, parent: PerpOrder, attach: PerpAttach, ctx: PerpCtx): PerpEvent[] {
  const symbol = parent.symbol;
  const position = s.positions[symbol] ?? null;
  const side = position ? closingSide(position.side) : parent.side === 'buy' ? 'sell' : 'buy';
  const legs = newLegs(symbol, side, legPrices(attach), parent.leverage, parent.id, ctx);
  const reason = position ? attachedArmReason(s, legs, ctx) : `No open position on ${symbol}`;
  if (reason !== null) return legs.flatMap((l) => rejectOrder(s, l, reason, ctx));
  const arrivesAt = liveDataReason(symbol, ctx) === null ? ctx.now + arrivalDelay(ctx) : null;
  return placeLegs(s, legs, arrivesAt, ctx);
}

function attachedArmReason(s: PerpState, legs: PerpOrder[], ctx: PerpCtx): string | null {
  const symbol = legs[0]!.symbol;
  for (const l of legs) {
    const conflict = legConflict(s, symbol, l.type as StopType);
    if (conflict) return conflict;
  }
  return canArmNow(symbol, ctx) ? triggerNowReason(legs, ctx.market.lastPrice(symbol)!) : null;
}

function triggerNowReason(legs: PerpOrder[], last: Decimal): string | null {
  for (const l of legs) {
    const reason = wouldTrigger(l.type as StopType, l.side, l.triggerPrice!, last);
    if (reason) return reason;
  }
  return null;
}

// ---- arming ----

function groupLegs(s: PerpState, groupId: string): PerpOrder[] {
  return [...s.orders.values()].filter((o) => o.ocoGroupId === groupId);
}

/**
 * Arrival of a pending stop, together with its pending partner: armed ('open'); cancelled
 * (position_closed) when the position is gone; rejected when the data is stale or a leg would
 * trigger now, as the exchange would reject it. Attached legs never wait on our data to be
 * rejected: while it cannot judge, they wait (arrivesAt null) for armWaitingLegs.
 */
export function arriveStop(s: PerpState, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  const symbol = order.symbol;
  const legs = order.ocoGroupId ? groupLegs(s, order.ocoGroupId).filter((l) => l.status === 'pending') : [order];
  if (order.parentId !== null && !canArmNow(symbol, ctx)) {
    for (const l of legs) putOrder(s, { ...l, arrivesAt: null });
    return [];
  }
  const stale = liveDataReason(symbol, ctx);
  if (stale) return legs.flatMap((l) => rejectOrder(s, l, stale, ctx));
  if (!opposite(s, symbol, order.side)) {
    return legs.flatMap((l) => cancelOrder(s, l, 'position_closed', remainingQty(l), ctx));
  }
  const last = ctx.market.lastPrice(symbol);
  const reason = last ? triggerNowReason(legs, last) : `Last price unavailable for ${symbol}`;
  if (reason) return legs.flatMap((l) => rejectOrder(s, l, reason, ctx));
  for (const l of legs) putOrder(s, { ...l, status: 'open' });
  return [];
}

/** An attached leg that waits for data (fresh, with a last price) to arm. */
export function waitingToArm(o: PerpOrder): boolean {
  return isStop(o) && o.status === 'pending' && o.parentId !== null && o.arrivesAt === null;
}

/** Arm (or reject) the attached legs of `symbol` that waited for data. */
export function armWaitingLegs(s: PerpState, symbol: string, ctx: PerpCtx): PerpEvent[] {
  if (!canArmNow(symbol, ctx)) return [];
  const waiting = [...s.orders.values()].filter((o) => o.symbol === symbol && waitingToArm(o));
  const events: PerpEvent[] = [];
  for (const { id } of waiting) {
    // Re-read: arriving one leg settles its partner too.
    const o = s.orders.get(id)!;
    if (o.status === 'pending') events.push(...arriveStop(s, o, ctx));
  }
  return events;
}

// ---- trigger and execution ----

/** Trigger the armed stops of `symbol` that this trade's price reached. Paused while stale. */
export function triggerStops(s: PerpState, symbol: string, trade: AggTrade, ctx: PerpCtx): PerpEvent[] {
  if (liveDataReason(symbol, ctx) !== null) return [];
  const events: PerpEvent[] = [];
  for (const { id } of [...s.orders.values()]) {
    // Re-read: an earlier trigger in this loop may have cancelled this order as a partner.
    const o = s.orders.get(id)!;
    if (o.symbol !== symbol || o.status !== 'open' || !isStop(o)) continue;
    if (!isTriggered(o.type, o.side, o.triggerPrice!, trade.price)) continue;
    events.push(...trigger(s, o, trade.price, ctx));
  }
  return events;
}

/**
 * The stop is now a market order on its way to the exchange; the best price it will take is
 * recorded so the fill's drift measures trigger → execution. Its untriggered partner is cancelled
 * now (oco): a triggered order is certain to execute.
 */
function trigger(s: PerpState, order: PerpOrder, last: Decimal, ctx: PerpCtx): PerpEvent[] {
  const triggered: PerpOrder = {
    ...order,
    status: 'triggered',
    triggeredAt: ctx.now,
    arrivesAt: ctx.now + arrivalDelay(ctx),
    bestAtSubmit: ctx.market.best(order.symbol, order.side),
  };
  putOrder(s, triggered);
  const events: PerpEvent[] = [
    { type: 'order_triggered', market: 'perp', time: ctx.now, order: triggered, lastPrice: last },
  ];
  if (order.ocoGroupId) {
    for (const p of groupLegs(s, order.ocoGroupId)) {
      if (p.id === order.id || !UNTRIGGERED.has(p.status)) continue;
      events.push(...cancelOrder(s, p, 'oco', remainingQty(p), ctx));
    }
  }
  return events;
}

/** A triggered order that executes on the next fresh data: deferred by stale data, or past its arrival. */
export function dueTriggered(o: PerpOrder, now: number): boolean {
  return o.status === 'triggered' && (o.arrivesAt === null || o.arrivesAt <= now);
}

/** The data a triggered order needs to execute: fresh book, trades and mark, and a mark price. */
function canExecute(symbol: string, ctx: PerpCtx): boolean {
  return liveDataReason(symbol, ctx) === null && validMark(symbol, ctx) !== null;
}

/**
 * A triggered order whose arrival time has come. Stale data never rejects it: it stays triggered
 * with arrivesAt null and executes on the first fresh data (executeDue).
 */
export function arriveTriggered(s: PerpState, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  if (order.arrivesAt === null || ctx.now < order.arrivesAt) return [];
  if (!canExecute(order.symbol, ctx)) {
    putOrder(s, { ...order, arrivesAt: null });
    return [];
  }
  return executeTriggered(s, order, ctx);
}

/**
 * Execute every triggered order of `symbol` that is due, deferred ones included. Each walks the
 * book less what the ones before it took.
 */
export function executeDue(s: PerpState, symbol: string, ctx: PerpCtx): PerpEvent[] {
  if (!canExecute(symbol, ctx)) return [];
  const due = [...s.orders.values()].filter((o) => o.symbol === symbol && dueTriggered(o, ctx.now));
  const events: PerpEvent[] = [];
  for (const { id } of due) {
    const o = s.orders.get(id)!;
    if (o.status === 'triggered') events.push(...executeTriggered(s, o, afterOwnFills(ctx, events)));
  }
  return events;
}

/**
 * The triggered order reaches the exchange with fresh data: a market order for the whole current
 * position, as a market quantity (floored to the market step, then MARKET_LOT_SIZE, which rejects
 * it). One taker fill within the price band; what the band or the book left is cancelled
 * (price_band or thin_book). With no position left it is cancelled (position_closed): it never
 * opens one.
 */
function executeTriggered(s: PerpState, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  const symbol = order.symbol;
  const position = opposite(s, symbol, order.side);
  if (!position) return cancelOrder(s, order, 'position_closed', remainingQty(order), ctx);
  const rules = ctx.market.rules(symbol);
  const mark = validMark(symbol, ctx)!;
  const step = rules.marketStepSize.isZero() ? rules.stepSize : rules.marketStepSize;
  const qty = floorToStep(position.qty, step);
  const lot = marketLotSize(qty, rules);
  if (lot) return rejectPending(s, order, lot, ctx, true);

  const { walk, bandLimited } = walkInBand(ctx.market.book(symbol), order.side, qty, mark, rules);
  const leftReason = bandLimited ? 'price_band' : 'thin_book';
  if (walk.qty.isZero()) return cancelOrder(s, order, leftReason, qty, ctx);

  const unfilled = qty.minus(walk.qty);
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
  const filled = applyReducingFill(s, order, terms, unfilled.gt(0) ? 'partially_filled' : 'filled', ctx);
  const events = [...filled.events];
  if (unfilled.gt(0)) events.push(...cancelOrder(s, filled.order, leftReason, unfilled, ctx));
  if (filled.closed) {
    events.push(...positionClosed(s, filled.closed, walk.avgPrice!, order.type as StopType, ctx));
  }
  return events;
}
