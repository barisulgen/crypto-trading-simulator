import { D, Decimal, floorToStep } from '../decimal.ts';
import { bestPrice, walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
import { drift } from '../spot/orders.ts';
import type { BookSnapshot, Side } from '../types.ts';
import { assumedPrice, liquidationPrice, orderCost, perpFee } from './math.ts';
import {
  cancelOrder,
  liveOrders,
  newPerpOrder,
  placePending,
  readPerpAmount,
  rejectOrder,
  rejectPending,
  remainingQty,
} from './orders.ts';
import type { PerpFields } from './orders.ts';
import {
  applyOpeningFill,
  applyReducingFill,
  marginInOf,
  positionClosed,
  positionSideOf,
  reduceOutcome,
} from './position.ts';
import type { PerpFillTerms } from './position.ts';
import { MARK_UNAVAILABLE, validatePerpOrder } from './rules.ts';
import { DEFAULT_LEVERAGE, freeUsdt, leverageFor } from './state.ts';
import type { PerpState } from './state.ts';
import { maxLeverage, maxNotionalAt } from './tiers.ts';
import type {
  Bracket,
  PerpCtx,
  PerpEvent,
  PerpOrder,
  PerpOrderRequest,
  PerpPreview,
  PerpRules,
  Position,
} from './types.ts';

/** Everything submit and preview work out for a market order before touching state. */
interface MarketPlan {
  fields: PerpFields;
  reduceOnly: boolean;
  leverage: number;
  maxLeverage: number;
  brackets: Bracket[] | null;
  mark: Decimal | null;
  /** The opposite position a reduce-only order reduces. */
  position: Position | null;
  /** The walk within the price band, for the quantity to fill (a reduce-only order's trimmed to the position). */
  walk: WalkResult | null;
  bandLimited: boolean;
  lockAmount: Decimal | null;
  /** Why submit would reject, or null if it would be placed. */
  reason: string | null;
}

function liveDataReason(symbol: string, ctx: PerpCtx): string | null {
  const m = ctx.market;
  return m.isFresh(symbol) && m.isMarkFresh(symbol) ? null : `Live data interrupted for ${symbol}`;
}

function validMark(symbol: string, ctx: PerpCtx): Decimal | null {
  const mark = ctx.market.markPrice(symbol);
  return mark && mark.gt(0) ? mark : null;
}

function marketStep(rules: PerpRules): Decimal {
  return rules.marketStepSize.isZero() ? rules.stepSize : rules.marketStepSize;
}

/** The furthest price a market order may take: mark × (1 ± marketTakeBound). */
function bandLimit(side: Side, mark: Decimal, rules: PerpRules): Decimal {
  return side === 'buy' ? mark.mul(D(1).plus(rules.marketTakeBound)) : mark.mul(D(1).minus(rules.marketTakeBound));
}

function outsideBand(side: Side, price: Decimal, limit: Decimal): boolean {
  return side === 'buy' ? price.gt(limit) : price.lt(limit);
}

function bandReason(best: Decimal, mark: Decimal, rules: PerpRules): string {
  return `Best price ${best} is outside the market price band (mark ${mark} ± ${rules.marketTakeBound.mul(100)}%)`;
}

/** Walk `book` within the band; bandLimited when the band, not the book, stopped it short. */
function walkInBand(
  book: BookSnapshot,
  side: Side,
  qty: Decimal,
  mark: Decimal,
  rules: PerpRules,
): { walk: WalkResult; bandLimited: boolean } {
  const walk = walkBook(book, side, { qty }, marketStep(rules), bandLimit(side, mark, rules));
  const levels = side === 'buy' ? book.asks : book.bids;
  return { walk, bandLimited: walk.exhausted && levels.length > walk.levelsUsed };
}

/** A reduce-only order's position: the open one on the other side, or null. */
function opposite(s: PerpState, symbol: string, side: Side): Position | null {
  const p = s.positions[symbol];
  return p && p.side !== positionSideOf(side) ? p : null;
}

/** The order cost of an opening market fill of `walk`: the lock at submit, the check at arrival. */
function costOf(
  side: Side,
  walk: WalkResult,
  qty: Decimal,
  p: { mark: Decimal; last: Decimal; leverage: number },
  ctx: PerpCtx,
): Decimal {
  const walkAvg = walk.avgPrice!;
  const imPrice = assumedPrice({ type: 'market', side, walkAvg, mark: p.mark, last: p.last });
  const { mark, leverage } = p;
  return orderCost({ side, qty, imPrice, olPrice: walkAvg, mark, leverage, takerRate: ctx.fees.taker }).total;
}

function bracketsOrNull(symbol: string, ctx: PerpCtx): Bracket[] | null {
  try {
    return ctx.market.brackets(symbol);
  } catch {
    return null;
  }
}

/**
 * Freshness, amounts, exchange filters, leverage, the one-way rule, reduce-only, the maximum
 * notional at the leverage, the book within the price band, and the funds, in that order. Stops at
 * the first problem; later fields stay null. Reads state, never writes it.
 */
export function planMarket(s: PerpState, req: PerpOrderRequest, ctx: PerpCtx): MarketPlan {
  const symbol = req.symbol;
  const tiers = bracketsOrNull(symbol, ctx);
  const plan: MarketPlan = {
    fields: { qty: null, quoteQty: null },
    reduceOnly: req.reduceOnly === true,
    leverage: tiers ? leverageFor(s, symbol, tiers) : (s.settings[symbol]?.leverage ?? DEFAULT_LEVERAGE),
    maxLeverage: tiers ? maxLeverage(tiers) : 0,
    brackets: tiers,
    mark: null,
    position: null,
    walk: null,
    bandLimited: false,
    lockAmount: null,
    reason: null,
  };
  const fail = (reason: string): MarketPlan => ({ ...plan, reason });

  const stale = liveDataReason(symbol, ctx);
  if (stale) return fail(stale);
  const rules = ctx.market.rules(symbol);
  const brackets = ctx.market.brackets(symbol);

  const read = readPerpAmount(req);
  plan.fields = read.fields;
  if (read.reason !== null) return fail(read.reason);
  if (req.attach) return fail('Attached stop-loss and take-profit are not available for perpetuals yet');
  const mark = validMark(symbol, ctx);
  plan.mark = mark;
  if (!mark) return fail(MARK_UNAVAILABLE);
  // A USDT amount is a notional at the mark, as every other perp notional is.
  if (plan.fields.quoteQty) {
    const step = marketStep(rules);
    const qty = floorToStep(plan.fields.quoteQty.div(mark), step);
    if (qty.isZero()) {
      const amount = `${plan.fields.quoteQty} ${rules.quote}`;
      return fail(`Amount too small: ${amount} does not reach one step of ${step} ${rules.base}`);
    }
    plan.fields = { ...plan.fields, qty };
  }
  const qty = plan.fields.qty!;

  const live = liveOrders(s, symbol);
  const invalid = validatePerpOrder(
    { symbol, side: req.side, type: 'market', qty, reduceOnly: plan.reduceOnly },
    rules,
    { mark, openOrders: live.length },
  );
  if (invalid) return fail(invalid);

  // A reduce-only order adds no margin, so a leverage setting the tiers no longer allow never blocks a close.
  const leverageOk = Number.isInteger(plan.leverage) && plan.leverage >= 1 && plan.leverage <= plan.maxLeverage;
  if (!plan.reduceOnly && !leverageOk) {
    return fail(`Leverage must be a whole number from 1 to ${plan.maxLeverage}`);
  }

  const side = positionSideOf(req.side);
  const held = s.positions[symbol];
  if (!plan.reduceOnly) {
    if (held && held.side !== side) {
      return fail(`One-way mode: you hold a ${held.side} position on ${symbol}; use reduce-only to reduce it`);
    }
    const against = live.find((o) => !o.reduceOnly && o.side !== req.side);
    if (against) return fail(`One-way mode: you have open orders to go ${positionSideOf(against.side)} on ${symbol}`);
  }

  if (plan.reduceOnly) {
    plan.position = opposite(s, symbol, req.side);
    if (!plan.position) return fail(`Reduce-only order would not reduce a position on ${symbol}`);
  } else {
    const opening = live.filter((o) => !o.reduceOnly).reduce((sum, o) => sum.plus(remainingQty(o)), D(0));
    const max = maxNotionalAt(brackets, plan.leverage);
    if (mark.mul((held?.qty ?? D(0)).plus(opening).plus(qty)).gt(max)) {
      const at = `the maximum at ${plan.leverage}x on ${symbol}`;
      return fail(`Position would exceed ${max} USDT, ${at}; lower the leverage`);
    }
  }

  const book = ctx.market.book(symbol);
  const best = bestPrice(book, req.side);
  if (!best) return fail(`Order book empty for ${symbol}`);
  if (outsideBand(req.side, best, bandLimit(req.side, mark, rules))) return fail(bandReason(best, mark, rules));
  const target = plan.position ? Decimal.min(qty, plan.position.qty) : qty;
  const { walk, bandLimited } = walkInBand(book, req.side, target, mark, rules);
  plan.walk = walk;
  plan.bandLimited = bandLimited;

  if (plan.reduceOnly) {
    plan.lockAmount = D(0);
    return plan;
  }
  const last = ctx.market.lastPrice(symbol);
  if (!last) return fail(`Last price unavailable for ${symbol}`);
  plan.lockAmount = costOf(req.side, walk, qty, { mark, last, leverage: plan.leverage }, ctx);
  const free = freeUsdt(s);
  if (plan.lockAmount.gt(free)) return fail(`Insufficient margin: need ${plan.lockAmount}, available ${free}`);
  return plan;
}

export function submitMarket(s: PerpState, req: PerpOrderRequest, ctx: PerpCtx): PerpEvent[] {
  const plan = planMarket(s, req, ctx);
  const order = newPerpOrder(req, plan.fields, plan.leverage, ctx);
  if (plan.reason !== null) return rejectOrder(s, order, plan.reason, ctx);
  // A plan without a reason always has its walk and lock.
  return placePending(s, order, plan.lockAmount!, plan.walk!.bestPrice, ctx);
}

export function previewMarket(s: PerpState, req: PerpOrderRequest, ctx: PerpCtx): PerpPreview {
  const plan = planMarket(s, req, ctx);
  const w = plan.walk;
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
    exhausted: w?.exhausted ?? false,
    bandLimited: plan.bandLimited,
    rejectReason: plan.reason,
    note: null,
  };
  if (!w || w.qty.isZero()) return preview;
  preview.estAvgPrice = w.avgPrice;
  preview.estSlippageUsd = w.slippageUsd;
  preview.estSlippagePct = w.bestPrice ? w.slippageUsd.div(w.bestPrice.mul(w.qty)).mul(100) : null;
  preview.notional = w.quote;
  preview.fee = perpFee(w.quote, ctx.fees.taker);
  preview.estLiquidationPrice = plan.brackets ? estLiquidation(s, req, plan, w, plan.brackets, ctx) : null;
  return preview;
}

/** Liquidation price of the position the walked fill would leave; null if it leaves none. */
function estLiquidation(
  s: PerpState,
  req: PerpOrderRequest,
  plan: MarketPlan,
  w: WalkResult,
  brackets: Bracket[],
  ctx: PerpCtx,
): Decimal | null {
  if (plan.position) {
    const p = plan.position;
    const left = p.qty.minus(w.qty);
    if (left.isZero()) return null;
    const { marginLeft } = reduceOutcome(p, w.qty, w.quote, ctx.fees.taker);
    return liquidationPrice(brackets, p.side, left, p.entryPrice, marginLeft);
  }
  const held = s.positions[req.symbol];
  const marginIn = marginInOf(w.quote, plan.leverage).minus(perpFee(w.quote, ctx.fees.taker));
  const qty = (held?.qty ?? D(0)).plus(w.qty);
  const entry = held ? held.qty.mul(held.entryPrice).plus(w.quote).div(qty) : w.quote.div(w.qty);
  const margin = (held?.margin ?? D(0)).plus(marginIn);
  return liquidationPrice(brackets, positionSideOf(req.side), qty, entry, margin);
}

/**
 * The order reaches the exchange: fresh data, the price band, a reduce-only order's position, and
 * an opening order's cost against its lock plus free USDT; then one fill within the band. What the
 * band or the book left is cancelled (price_band or thin_book), as is what a reduce-only order
 * asked beyond the position (reduce_only). A fill that empties the position closes it.
 */
export function arriveMarket(s: PerpState, order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
  const symbol = order.symbol;
  const stale = liveDataReason(symbol, ctx);
  if (stale) return rejectPending(s, order, stale, ctx);
  const mark = validMark(symbol, ctx);
  if (!mark) return rejectPending(s, order, MARK_UNAVAILABLE, ctx);
  const rules = ctx.market.rules(symbol);

  const book = ctx.market.book(symbol);
  const best = bestPrice(book, order.side);
  if (best && outsideBand(order.side, best, bandLimit(order.side, mark, rules))) {
    return rejectPending(s, order, bandReason(best, mark, rules), ctx);
  }

  const remaining = remainingQty(order);
  let target = remaining;
  let position: Position | null = null;
  if (order.reduceOnly) {
    position = opposite(s, symbol, order.side);
    if (!position) return rejectPending(s, order, `No position to reduce on ${symbol}`, ctx);
    target = Decimal.min(remaining, position.qty);
  }

  const { walk, bandLimited } = walkInBand(book, order.side, target, mark, rules);
  if (walk.qty.isZero()) return cancelOrder(s, order, 'thin_book', remaining, ctx);

  if (!position) {
    const last = ctx.market.lastPrice(symbol);
    if (!last) return rejectPending(s, order, `Last price unavailable for ${symbol}`, ctx);
    const need = costOf(order.side, walk, walk.qty, { mark, last, leverage: order.leverage }, ctx);
    const available = order.lockAmount.plus(freeUsdt(s));
    if (need.gt(available)) {
      return rejectPending(
        s,
        order,
        `Insufficient margin at execution: price moved (need ${need}, available ${available})`,
        ctx,
      );
    }
  }

  const unfilled = remaining.minus(walk.qty);
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
  const status = unfilled.gt(0) ? 'partially_filled' : 'filled';
  const filled = position
    ? applyReducingFill(s, order, terms, status, ctx)
    : { ...applyOpeningFill(s, order, terms, order.lockAmount, status, ctx), closed: null };

  const events = [...filled.events];
  if (unfilled.gt(0)) {
    const reason = walk.exhausted ? (bandLimited ? 'price_band' : 'thin_book') : 'reduce_only';
    events.push(...cancelOrder(s, filled.order, reason, unfilled, ctx));
  }
  if (filled.closed) events.push(...positionClosed(s, filled.closed, walk.avgPrice!, 'closed', ctx));
  return events;
}
