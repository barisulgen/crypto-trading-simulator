import { D, floorToStep } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
import { spotFee } from '../fees.ts';
import { validateSpotOrder } from '../rules.ts';
import type {
  ActionResult,
  AggTrade,
  EngineCtx,
  EngineEvent,
  OrderPreview,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
  Wallet,
} from '../types.ts';
import { arriveLimit, isLimitType, matchTrade, previewLimit, submitLimit } from './limit.ts';
import {
  emptyPreview,
  newOrder,
  openCounts,
  placePending,
  readRequest,
  rejectOrder,
  rejectPending,
  settleTaker,
} from './orders.ts';
import type { RequestFields } from './orders.ts';
import { balanceOf, freeOf, releaseFunds } from './state.ts';
import type { SpotState } from './state.ts';

const NOT_SUPPORTED = 'Order type not supported yet';

/** Everything submit and preview work out for a market order before touching state. */
interface MarketPlan {
  rules: SpotRules;
  fields: RequestFields;
  lockAsset: string;
  walk: WalkResult | null;
  lockAmount: Decimal | null;
  /** Why submit would reject, or null if it would be placed. */
  reason: string | null;
}

export class SpotEngine {
  private readonly s: SpotState;

  constructor(state: SpotState) {
    this.s = state;
  }

  get state(): SpotState {
    return this.s;
  }

  // ---- wallets ----

  deposit(wallet: Wallet, amount: Decimal, ctx: EngineCtx): ActionResult {
    if (!amount.isFinite() || !amount.gt(0)) return { ok: false, reason: 'Deposit must be greater than 0' };
    if (amount.decimalPlaces() > 2) return { ok: false, reason: 'Deposit has at most 2 decimals' };
    const b = balanceOf(this.s, wallet, 'USDT');
    b.free = b.free.plus(amount);
    this.s.totalDeposited = this.s.totalDeposited.plus(amount);
    return {
      ok: true,
      events: [{ type: 'deposit', time: ctx.now, wallet, amount, totalDeposited: this.s.totalDeposited }],
    };
  }

  /** Moves free USDT only; locked funds never move. Not a deposit. */
  transfer(from: Wallet, to: Wallet, amount: Decimal, ctx: EngineCtx): ActionResult {
    if (from === to) return { ok: false, reason: 'Choose two different wallets' };
    if (!amount.isFinite() || !amount.gt(0)) return { ok: false, reason: 'Transfer must be greater than 0' };
    const src = balanceOf(this.s, from, 'USDT');
    if (amount.gt(src.free)) {
      return {
        ok: false,
        reason: `Insufficient free USDT in ${from} wallet: need ${amount}, available ${src.free}`,
      };
    }
    const dst = balanceOf(this.s, to, 'USDT');
    src.free = src.free.minus(amount);
    dst.free = dst.free.plus(amount);
    return { ok: true, events: [{ type: 'transfer', time: ctx.now, from, to, amount }] };
  }

  // ---- orders ----

  submit(req: SpotOrderRequest, ctx: EngineCtx): EngineEvent[] {
    switch (req.type) {
      case 'market':
        return this.submitMarket(req, ctx);
      case 'limit':
      case 'post_only':
        return submitLimit(this.s, req, ctx);
      default: {
        const rules = ctx.market.rules(req.symbol);
        const order = newOrder(req, rules, { qty: null, quoteQty: null, price: null }, ctx);
        return rejectOrder(this.s, order, NOT_SUPPORTED, ctx);
      }
    }
  }

  /**
   * The order reaches the exchange after its delay. A no-op for unknown or non-pending
   * orders (e.g. cancelled while in flight) and before the order's arrivesAt.
   */
  arrive(orderId: string, ctx: EngineCtx): EngineEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.status !== 'pending') return [];
    if (order.arrivesAt !== null && ctx.now < order.arrivesAt) return [];
    switch (order.type) {
      case 'market':
        return this.arriveMarket(order, ctx);
      case 'limit':
      case 'post_only':
        return arriveLimit(this.s, order, ctx);
      default:
        return [];
    }
  }

  /** A real trade on `symbol`: fills resting limit and post-only orders it went through. */
  onTrade(symbol: string, trade: AggTrade, ctx: EngineCtx): EngineEvent[] {
    return matchTrade(this.s, symbol, trade, ctx);
  }

  /**
   * Cancel by the owner. Pending, open and partially filled limit/post-only orders can be
   * cancelled (a cancelled pending order never arrives); market orders in flight and
   * triggered orders are already executing.
   */
  cancel(orderId: string, ctx: EngineCtx): ActionResult {
    const order = this.s.orders.get(orderId);
    if (!order) return { ok: false, reason: 'Order not found' };
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      return { ok: false, reason: 'Order is not open' };
    }
    if (order.status === 'triggered' || !isLimitType(order)) {
      return { ok: false, reason: 'Order is already executing and cannot be cancelled' };
    }
    releaseFunds(this.s, order.lockAsset, order.lockAmount);
    const cancelled: SpotOrder = { ...order, status: 'cancelled', lockAmount: D(0) };
    this.s.orders.set(cancelled.id, cancelled);
    const cancelledQty = order.qty!.minus(order.filledQty);
    return {
      ok: true,
      events: [{ type: 'order_cancelled', time: ctx.now, order: cancelled, reason: 'user', cancelledQty }],
    };
  }

  /** What submit would do right now, without changing state. */
  preview(req: SpotOrderRequest, ctx: EngineCtx): OrderPreview {
    if (req.type === 'limit' || req.type === 'post_only') return previewLimit(this.s, req, ctx);
    if (req.type !== 'market') return emptyPreview(NOT_SUPPORTED);
    const plan = this.planMarket(req, ctx);
    const w = plan.walk;
    if (!w || w.qty.isZero()) {
      return { ...emptyPreview(plan.reason), exhausted: w?.exhausted ?? false };
    }
    const { rules } = plan;
    const fee = spotFee(req.side, w.qty, w.quote, ctx.fees.taker, rules.base, rules.quote);
    const pct = w.bestPrice ? w.slippageUsd.div(w.bestPrice.mul(w.qty)).mul(100) : null;
    const buy = req.side === 'buy';
    return {
      estAvgPrice: w.avgPrice,
      estSlippageUsd: w.slippageUsd,
      estSlippagePct: pct,
      fee: { asset: fee.asset, amount: fee.amount, usd: fee.usd },
      total: buy ? w.quote : w.quote.minus(fee.amount),
      receive: buy ? w.qty.minus(fee.amount) : w.quote.minus(fee.amount),
      exhausted: w.exhausted,
      rejectReason: plan.reason,
    };
  }

  // ---- market orders ----

  private submitMarket(req: SpotOrderRequest, ctx: EngineCtx): EngineEvent[] {
    const plan = this.planMarket(req, ctx);
    const order = newOrder(req, plan.rules, plan.fields, ctx);
    if (plan.reason !== null) return rejectOrder(this.s, order, plan.reason, ctx);
    // A plan without a reason always has its walk and lock.
    return placePending(this.s, order, plan.lockAmount!, plan.walk!.bestPrice, ctx);
  }

  /**
   * Freshness, amounts, exchange filters, book walk, lock size and funds, in that order.
   * Stops at the first problem; later fields stay null. Reads state, never writes it.
   */
  private planMarket(req: SpotOrderRequest, ctx: EngineCtx): MarketPlan {
    const rules = ctx.market.rules(req.symbol);
    const plan: MarketPlan = {
      rules,
      fields: { qty: null, quoteQty: null, price: null },
      lockAsset: req.side === 'buy' ? rules.quote : rules.base,
      walk: null,
      lockAmount: null,
      reason: null,
    };
    const fail = (reason: string): MarketPlan => ({ ...plan, reason });

    if (!ctx.market.isFresh(req.symbol)) return fail(`Live data interrupted for ${req.symbol}`);

    const read = readRequest(req, false);
    plan.fields = read.fields;
    if (read.reason !== null) return fail(read.reason);
    const { qty, quoteQty } = plan.fields;

    const invalid = validateSpotOrder(
      {
        symbol: req.symbol,
        side: req.side,
        type: 'market',
        ...(qty ? { qty } : {}),
        ...(quoteQty ? { quoteQty } : {}),
      },
      rules,
      { avgPrice: ctx.market.avgPrice(req.symbol), ...openCounts(this.s, req.symbol) },
    );
    if (invalid) return fail(invalid);

    const book = ctx.market.book(req.symbol);
    const walk = walkBook(book, req.side, marketTarget(plan.fields), marketStep(rules));
    plan.walk = walk;
    if (walk.qty.isZero()) {
      const side = req.side === 'buy' ? book.asks : book.bids;
      if (side.length === 0) return fail(`Order book empty for ${req.symbol}`);
      const step = marketStep(rules);
      return fail(`Amount too small: ${quoteQty} ${rules.quote} does not reach one step of ${step} ${rules.base}`);
    }
    // Buy by qty: preview cost of the fillable part. Buy by dollars: the dollars.
    // Sell by qty: the coins. Sell by dollars: the coins the walk needs to raise them.
    if (req.side === 'buy') plan.lockAmount = qty ? walk.quote : quoteQty!;
    else plan.lockAmount = qty ? qty : walk.qty;

    const free = freeOf(this.s, 'spot', plan.lockAsset);
    if (plan.lockAmount.gt(free)) {
      return fail(`Insufficient ${plan.lockAsset}: need ${plan.lockAmount}, available ${free}`);
    }
    return plan;
  }

  private arriveMarket(order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
    if (!ctx.market.isFresh(order.symbol)) {
      return rejectPending(this.s, order, `Live data interrupted for ${order.symbol}`, ctx);
    }
    const rules = ctx.market.rules(order.symbol);

    const step = marketStep(rules);
    const book = ctx.market.book(order.symbol);
    const walk = walkBook(book, order.side, marketTarget(order), step);
    const need = order.side === 'buy' ? walk.quote : walk.qty;
    const available = order.lockAmount.plus(freeOf(this.s, 'spot', order.lockAsset));
    if (need.gt(available)) {
      return rejectPending(
        this.s,
        order,
        `Insufficient funds at execution: price moved (need ${need}, available ${available})`,
        ctx,
      );
    }

    const thin = walk.exhausted || walk.qty.isZero();
    const events: EngineEvent[] = [];
    let current = order;
    if (walk.qty.gt(0)) {
      const settled = settleTaker(this.s, order, walk, rules, thin ? 'partially_filled' : 'filled', ctx);
      current = settled.order;
      events.push({ type: 'fill', time: ctx.now, fill: settled.fill, order: current });
    } else {
      releaseFunds(this.s, order.lockAsset, order.lockAmount);
      current = { ...order, lockAmount: D(0) };
    }

    if (thin) {
      current = { ...current, status: 'cancelled' };
      const levels = order.side === 'buy' ? book.asks : book.bids;
      const cancelledQty = unfilledQty(order, walk, levels[walk.levelsUsed - 1]?.price ?? null, step);
      events.push({ type: 'order_cancelled', time: ctx.now, order: current, reason: 'thin_book', cancelledQty });
    }
    this.s.orders.set(current.id, current);
    return events;
  }
}

function marketStep(rules: SpotRules): Decimal {
  return rules.marketStepSize.isZero() ? rules.stepSize : rules.marketStepSize;
}

function marketTarget(o: { qty: Decimal | null; quoteQty: Decimal | null }): { qty: Decimal } | { quote: Decimal } {
  return o.qty ? { qty: o.qty } : { quote: o.quoteQty! };
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
