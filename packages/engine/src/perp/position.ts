import { D, Decimal, roundDown8 } from '../decimal.ts';
import type { OrderStatus, PriceLevel } from '../types.ts';
import { perpFee } from './math.ts';
import { cancelOrder, liveOrders, remainingQty } from './orders.ts';
import { creditUsdt, debitUsdt, freeUsdt, putOrder, releaseUsdt, spendUsdt } from './state.ts';
import type { PerpState } from './state.ts';
import type { PerpCtx, PerpEvent, PerpFill, PerpOrder, Position, PositionCloseReason, PositionSide } from './types.ts';

/** What one fill traded and how it compares with the book at submit and at arrival. */
export interface PerpFillTerms {
  qty: Decimal;
  price: Decimal;
  quote: Decimal;
  liquidity: 'maker' | 'taker';
  /** The fee rate of that liquidity. */
  rate: Decimal;
  bestAtArrival: Decimal | null;
  slippageUsd: Decimal;
  driftUsd: Decimal;
  /** For a taker fill, the quantity taken at each book level. */
  consumed?: PriceLevel[];
}

/** The side of the position an order of `side` opens or adds to. */
export function positionSideOf(side: 'buy' | 'sell'): PositionSide {
  return side === 'buy' ? 'long' : 'short';
}

/** Margin an opening fill moves into the position: quote ÷ leverage, rounded down. */
export function marginInOf(quote: Decimal, leverage: number): Decimal {
  return roundDown8(quote.div(leverage));
}

/** A trading result, rounded to 8 decimals against the owner: a gain down, a loss up. */
function pnlOf(position: Position, qty: Decimal, quote: Decimal): Decimal {
  const dir = position.side === 'long' ? 1 : -1;
  return quote.minus(qty.mul(position.entryPrice)).mul(dir).toDecimalPlaces(8, Decimal.ROUND_FLOOR);
}

/**
 * Where reducing `qty` of the position at `quote`, paying `fee`, leaves the money: the trading
 * P&L, the margin released pro rata (all of it on a full close), and the margin left in the
 * position once any shortfall of released + P&L − fee has been taken from it. `owed` is the
 * shortfall the margin left could not cover (to come from free USDT); `toWallet` is what the
 * wallet receives otherwise.
 */
export function reduceOutcome(
  position: Position,
  qty: Decimal,
  quote: Decimal,
  fee: Decimal,
): { pnl: Decimal; released: Decimal; marginLeft: Decimal; toWallet: Decimal; owed: Decimal } {
  const pnl = pnlOf(position, qty, quote);
  const released = qty.eq(position.qty) ? position.margin : roundDown8(position.margin.mul(qty).div(position.qty));
  const net = released.plus(pnl).minus(fee);
  const kept = position.margin.minus(released);
  if (net.gte(0)) return { pnl, released, marginLeft: kept, toWallet: net, owed: D(0) };
  const fromMargin = Decimal.min(net.neg(), kept);
  return {
    pnl,
    released,
    marginLeft: kept.minus(fromMargin),
    toWallet: D(0),
    owed: net.neg().minus(fromMargin),
  };
}

function makeFill(
  order: PerpOrder,
  t: PerpFillTerms,
  fee: Decimal,
  more: { positionId: string; marginIn: Decimal | null; uncovered: Decimal | null; realizedPnl: Decimal | null },
  ctx: PerpCtx,
): PerpFill {
  return {
    id: ctx.newId('f'),
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    qty: t.qty,
    price: t.price,
    quote: t.quote,
    liquidity: t.liquidity,
    feeAsset: 'USDT',
    fee,
    feeUsd: t.quote.mul(t.rate),
    bestAtArrival: t.bestAtArrival,
    bestAtSubmit: order.bestAtSubmit,
    slippageUsd: t.slippageUsd,
    driftUsd: t.driftUsd,
    triggerPrice: order.triggerPrice,
    realizedPnl: more.realizedPnl,
    time: ctx.now,
    market: 'perp',
    positionId: more.positionId,
    marginIn: more.marginIn,
    uncovered: more.uncovered,
  };
}

function fillEvent(fill: PerpFill, order: PerpOrder, t: PerpFillTerms, ctx: PerpCtx): PerpEvent {
  const event: PerpEvent = { type: 'fill', market: 'perp', time: ctx.now, fill, order };
  return t.consumed ? { ...event, consumed: t.consumed } : event;
}

/**
 * An opening fill: quote ÷ leverage (rounded down) is spent from `lockShare`, the fill's share of the
 * order's lock, and the rest of that share is released. The fee comes out of the position's margin.
 * Opens the position, or adds to it at the quantity-weighted average entry. Throws when the position
 * held is on the other side: one-way mode never flips a position.
 */
export function applyOpeningFill(
  s: PerpState,
  order: PerpOrder,
  t: PerpFillTerms,
  lockShare: Decimal,
  status: OrderStatus,
  ctx: PerpCtx,
): { order: PerpOrder; events: PerpEvent[] } {
  const held = s.positions[order.symbol];
  if (held && held.side !== positionSideOf(order.side)) {
    throw new Error(`Order ${order.id}: opening fill on the other side of the ${held.side} position`);
  }
  const marginIn = marginInOf(t.quote, order.leverage);
  const fee = perpFee(t.quote, t.rate);
  releaseUsdt(s, spendUsdt(s, marginIn, lockShare));

  let position: Position;
  if (held) {
    const qty = held.qty.plus(t.qty);
    position = {
      ...held,
      qty,
      entryPrice: held.qty.mul(held.entryPrice).plus(t.quote).div(qty),
      margin: held.margin.plus(marginIn).minus(fee),
      fees: held.fees.plus(fee),
    };
  } else {
    position = {
      id: ctx.newId('p'),
      symbol: order.symbol,
      side: positionSideOf(order.side),
      qty: t.qty,
      entryPrice: t.quote.div(t.qty),
      leverage: order.leverage,
      margin: marginIn.minus(fee),
      openedAt: ctx.now,
      realizedPnl: D(0),
      fees: fee,
      funding: D(0),
      warnLevel: 0,
    };
  }
  s.positions[order.symbol] = position;

  const fill = makeFill(order, t, fee, { positionId: position.id, marginIn, uncovered: null, realizedPnl: null }, ctx);
  const after: PerpOrder = {
    ...order,
    status,
    filledQty: order.filledQty.plus(t.qty),
    filledQuote: order.filledQuote.plus(t.quote),
    fee: order.fee.plus(fee),
    lockAmount: order.lockAmount.minus(lockShare),
  };
  putOrder(s, after);
  const events = [fillEvent(fill, after, t, ctx)];
  if (!held) events.push({ type: 'position_opened', market: 'perp', time: ctx.now, position });
  return { order: after, events };
}

/**
 * A reducing fill of t.qty, at most the position's quantity. The wallet receives the released
 * margin plus the P&L minus the fee; a shortfall is taken from the margin left in the position,
 * then from free leverage USDT (never below zero), and anything still owed is recorded on the fill
 * as uncovered. `closed` is the emptied position when the fill closes it (it is then removed).
 */
export function applyReducingFill(
  s: PerpState,
  order: PerpOrder,
  t: PerpFillTerms,
  status: OrderStatus,
  ctx: PerpCtx,
): { order: PerpOrder; events: PerpEvent[]; closed: Position | null } {
  const held = s.positions[order.symbol];
  if (!held || t.qty.gt(held.qty)) throw new Error(`Order ${order.id}: reducing fill larger than the position`);
  const fee = perpFee(t.quote, t.rate);
  const out = reduceOutcome(held, t.qty, t.quote, fee);
  creditUsdt(s, out.toWallet);
  const fromFree = Decimal.min(out.owed, Decimal.max(0, freeUsdt(s)));
  debitUsdt(s, fromFree);
  const uncovered = out.owed.minus(fromFree);

  const position: Position = {
    ...held,
    qty: held.qty.minus(t.qty),
    margin: out.marginLeft,
    realizedPnl: held.realizedPnl.plus(out.pnl),
    fees: held.fees.plus(fee),
  };
  const closed = position.qty.isZero() ? position : null;
  if (closed) delete s.positions[order.symbol];
  else s.positions[order.symbol] = position;

  const fill = makeFill(
    order,
    t,
    fee,
    { positionId: held.id, marginIn: null, uncovered: uncovered.gt(0) ? uncovered : null, realizedPnl: out.pnl },
    ctx,
  );
  const after: PerpOrder = {
    ...order,
    status,
    filledQty: order.filledQty.plus(t.qty),
    filledQuote: order.filledQuote.plus(t.quote),
    fee: order.fee.plus(fee),
    realizedPnl: order.realizedPnl.plus(out.pnl),
  };
  putOrder(s, after);
  return { order: after, events: [fillEvent(fill, after, t, ctx)], closed };
}

/** Statuses an order is cancelled from when its position closes; a triggered order is already executing. */
const CANCELLED_ON_CLOSE: ReadonlySet<OrderStatus> = new Set(['pending', 'open', 'partially_filled']);

/**
 * The position has closed: record it, then cancel every reduce-only or close-position order left on
 * the symbol (reason position_closed), since nothing is left for them to reduce.
 */
export function positionClosed(
  s: PerpState,
  closed: Position,
  exitPrice: Decimal,
  reason: PositionCloseReason,
  ctx: PerpCtx,
): PerpEvent[] {
  const events: PerpEvent[] = [
    {
      type: 'position_closed',
      market: 'perp',
      time: ctx.now,
      position: closed,
      exitPrice,
      realizedPnl: closed.realizedPnl,
      fees: closed.fees,
      funding: closed.funding,
      holdMs: ctx.now - closed.openedAt,
      reason,
    },
  ];
  for (const o of liveOrders(s, closed.symbol)) {
    if (!(o.reduceOnly || o.closePosition) || !CANCELLED_ON_CLOSE.has(o.status)) continue;
    events.push(...cancelOrder(s, o, 'position_closed', remainingQty(o), ctx));
  }
  return events;
}
