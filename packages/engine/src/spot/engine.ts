import { D, floorToStep } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
import { spotFee } from '../fees.ts';
import { InputError, parseAmount } from '../input.ts';
import { validateSpotOrder } from '../rules.ts';
import type {
  ActionResult,
  EngineCtx,
  EngineEvent,
  Fill,
  OrderPreview,
  OrderStatus,
  Side,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
  Wallet,
} from '../types.ts';
import { balanceOf, credit, lockFunds, releaseFunds, spendFunds } from './state.ts';
import type { SpotState } from './state.ts';

/** Statuses of orders that still count against MAX_NUM_ORDERS (in flight included). */
const LIVE_STATUSES: ReadonlySet<OrderStatus> = new Set(['pending', 'open', 'partially_filled', 'triggered']);

const NOT_SUPPORTED = 'Order type not supported yet';

/** Everything submit and preview work out for a market order before touching state. */
interface MarketPlan {
  rules: SpotRules;
  qty: Decimal | null;
  quoteQty: Decimal | null;
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
      default: {
        const rules = ctx.market.rules(req.symbol);
        return this.rejectOrder(this.newOrder(req, rules, null, null, ctx), NOT_SUPPORTED, ctx);
      }
    }
  }

  /** The order reaches the exchange after its delay. Anything not pending is a no-op. */
  arrive(orderId: string, ctx: EngineCtx): EngineEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.status !== 'pending') return [];
    switch (order.type) {
      case 'market':
        return this.arriveMarket(order, ctx);
      default:
        return [];
    }
  }

  /** What submit would do right now, without changing state. */
  preview(req: SpotOrderRequest, ctx: EngineCtx): OrderPreview {
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
    const order = this.newOrder(req, plan.rules, plan.qty, plan.quoteQty, ctx);
    if (plan.reason !== null) return this.rejectOrder(order, plan.reason, ctx);
    // A plan without a reason always has its walk and lock.
    const lockAmount = plan.lockAmount!;
    lockFunds(this.s, plan.lockAsset, lockAmount);
    const pending: SpotOrder = {
      ...order,
      status: 'pending',
      lockAmount,
      arrivesAt: ctx.now + arrivalDelay(ctx),
      bestAtSubmit: plan.walk!.bestPrice,
    };
    this.s.orders.set(pending.id, pending);
    return [{ type: 'order_placed', time: ctx.now, order: pending }];
  }

  /**
   * Freshness, amounts, exchange filters, book walk and lock size, in that order.
   * Stops at the first problem; later fields stay null.
   */
  private planMarket(req: SpotOrderRequest, ctx: EngineCtx): MarketPlan {
    const rules = ctx.market.rules(req.symbol);
    const plan: MarketPlan = {
      rules,
      qty: null,
      quoteQty: null,
      lockAsset: req.side === 'buy' ? rules.quote : rules.base,
      walk: null,
      lockAmount: null,
      reason: null,
    };
    const fail = (reason: string): MarketPlan => ({ ...plan, reason });

    if (!ctx.market.isFresh(req.symbol)) return fail(`Live data interrupted for ${req.symbol}`);

    const hasQty = present(req.qty);
    if (hasQty === present(req.quoteQty)) return fail('Enter either a coin amount or a dollar amount');
    try {
      if (hasQty) plan.qty = parseAmount(req.qty!);
      else plan.quoteQty = parseAmount(req.quoteQty!);
    } catch (e) {
      if (e instanceof InputError) return fail(e.message);
      throw e;
    }
    // Attached pairs arrive with Task 6; never accept an order while ignoring part of it.
    if (req.attach) return fail('Attached stop-loss and take-profit are not supported yet');

    const counts = this.openCounts(req.symbol);
    const invalid = validateSpotOrder(
      {
        symbol: req.symbol,
        side: req.side,
        type: 'market',
        ...(plan.qty ? { qty: plan.qty } : {}),
        ...(plan.quoteQty ? { quoteQty: plan.quoteQty } : {}),
      },
      rules,
      { avgPrice: ctx.market.avgPrice(req.symbol), ...counts },
    );
    if (invalid) return fail(invalid);

    const walk = walkBook(ctx.market.book(req.symbol), req.side, marketTarget(plan), marketStep(rules));
    plan.walk = walk;
    // Buy by qty: preview cost of the fillable part. Buy by dollars: the dollars.
    // Sell by qty: the coins. Sell by dollars: the coins the walk needs to raise them.
    if (req.side === 'buy') plan.lockAmount = plan.qty ? walk.quote : plan.quoteQty!;
    else plan.lockAmount = plan.qty ? plan.qty : walk.qty;

    const free = balanceOf(this.s, 'spot', plan.lockAsset).free;
    if (plan.lockAmount.gt(free)) {
      return fail(`Insufficient ${plan.lockAsset}: need ${plan.lockAmount}, available ${free}`);
    }
    return plan;
  }

  private arriveMarket(order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
    const rules = ctx.market.rules(order.symbol);
    if (!ctx.market.isFresh(order.symbol)) {
      return this.rejectPending(order, `Live data interrupted for ${order.symbol}`, ctx);
    }

    const step = marketStep(rules);
    const book = ctx.market.book(order.symbol);
    const walk = walkBook(book, order.side, marketTarget(order), step);
    const need = order.side === 'buy' ? walk.quote : walk.qty;
    const available = order.lockAmount.plus(balanceOf(this.s, 'spot', order.lockAsset).free);
    if (need.gt(available)) {
      return this.rejectPending(
        order,
        `Insufficient funds at execution: price moved (need ${need}, available ${available})`,
        ctx,
      );
    }

    const thin = walk.exhausted || walk.qty.isZero();
    const events: EngineEvent[] = [];
    let current = order;
    if (walk.qty.gt(0)) {
      const settled = this.settleTaker(order, walk, rules, thin ? 'partially_filled' : 'filled', ctx);
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

  /**
   * Settle one taker fill for the walked amount: spend from the lock first (then free),
   * credit the received asset net of the fee, and release whatever lock is left.
   */
  private settleTaker(
    order: SpotOrder,
    walk: WalkResult,
    rules: SpotRules,
    status: OrderStatus,
    ctx: EngineCtx,
  ): { order: SpotOrder; fill: Fill } {
    const buy = order.side === 'buy';
    const fee = spotFee(order.side, walk.qty, walk.quote, ctx.fees.taker, rules.base, rules.quote);
    const unspent = spendFunds(this.s, order.lockAsset, buy ? walk.quote : walk.qty, order.lockAmount);
    releaseFunds(this.s, order.lockAsset, unspent);
    credit(this.s, fee.asset, (buy ? walk.qty : walk.quote).minus(fee.amount));

    const fill: Fill = {
      id: ctx.newId('f'),
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: walk.qty,
      price: walk.avgPrice!,
      quote: walk.quote,
      liquidity: 'taker',
      feeAsset: fee.asset,
      fee: fee.amount,
      feeUsd: fee.usd,
      bestAtArrival: walk.bestPrice,
      bestAtSubmit: order.bestAtSubmit,
      slippageUsd: walk.slippageUsd,
      driftUsd: drift(order.side, order.bestAtSubmit, walk.bestPrice, walk.qty),
      triggerPrice: null,
      realizedPnl: null,
      roundTripId: null,
      time: ctx.now,
    };
    const updated: SpotOrder = {
      ...order,
      status,
      filledQty: order.filledQty.plus(walk.qty),
      filledQuote: order.filledQuote.plus(walk.quote),
      fee: order.fee.plus(fee.amount),
      feeAsset: fee.asset,
      lockAmount: D(0),
    };
    return { order: updated, fill };
  }

  // ---- shared helpers ----

  private newOrder(
    req: SpotOrderRequest,
    rules: SpotRules,
    qty: Decimal | null,
    quoteQty: Decimal | null,
    ctx: EngineCtx,
  ): SpotOrder {
    return {
      id: ctx.newId('o'),
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty,
      quoteQty,
      price: null,
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

  /** Record a rejected order (nothing locked) and return its event. */
  private rejectOrder(order: SpotOrder, reason: string, ctx: EngineCtx): EngineEvent[] {
    const rejected: SpotOrder = { ...order, status: 'rejected', rejectReason: reason, lockAmount: D(0) };
    this.s.orders.set(rejected.id, rejected);
    return [{ type: 'order_rejected', time: ctx.now, order: rejected, reason }];
  }

  /** Reject an order that holds a lock: release it first. */
  private rejectPending(order: SpotOrder, reason: string, ctx: EngineCtx): EngineEvent[] {
    releaseFunds(this.s, order.lockAsset, order.lockAmount);
    return this.rejectOrder(order, reason, ctx);
  }

  private openCounts(symbol: string): { openOrders: number; openAlgoOrders: number } {
    let openOrders = 0;
    let openAlgoOrders = 0;
    for (const o of this.s.orders.values()) {
      if (o.symbol !== symbol || !LIVE_STATUSES.has(o.status)) continue;
      openOrders += 1;
      if (o.type === 'stop_loss' || o.type === 'take_profit') openAlgoOrders += 1;
    }
    return { openOrders, openAlgoOrders };
  }
}

function present(s: string | undefined): boolean {
  return s !== undefined && s.trim() !== '';
}

/** 100–300 ms, uniform. */
function arrivalDelay(ctx: EngineCtx): number {
  return 100 + Math.floor(ctx.rng() * 201);
}

function marketStep(rules: SpotRules): Decimal {
  return rules.marketStepSize.isZero() ? rules.stepSize : rules.marketStepSize;
}

function marketTarget(o: { qty: Decimal | null; quoteQty: Decimal | null }): { qty: Decimal } | { quote: Decimal } {
  return o.qty ? { qty: o.qty } : { quote: o.quoteQty! };
}

/** Signed delay drift in USD: positive means the price moved against the owner. */
function drift(side: Side, atSubmit: Decimal | null, atArrival: Decimal | null, qty: Decimal): Decimal {
  if (!atSubmit || !atArrival) return D(0);
  return side === 'buy' ? atArrival.minus(atSubmit).mul(qty) : atSubmit.minus(atArrival).mul(qty);
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

function emptyPreview(rejectReason: string | null): OrderPreview {
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
