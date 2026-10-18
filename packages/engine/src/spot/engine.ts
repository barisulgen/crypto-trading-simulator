import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { walkBook } from '../book.ts';
import type { WalkResult } from '../book.ts';
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
import { arriveLimit, matchTrade, previewLimit, submitLimit } from './limit.ts';
import {
  emptyPreview,
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
import { balanceOf, freeOf, releaseFunds } from './state.ts';
import type { SpotState } from './state.ts';
import {
  activateAttachedPairs,
  armWaitingPairs,
  arriveStop,
  arriveTriggered,
  attachOco,
  cancelStop,
  executeDue,
  previewStop,
  submitStop,
  triggerStops,
} from './stops.ts';
import type { OcoRequest } from './stops.ts';
import { isStopType } from './triggers.ts';

export const UNKNOWN_ORDER_TYPE = 'Unknown order type';
export const RESTART_REASON = 'Server restarted before execution';
export const RULES_NOT_LOADED = 'Exchange rules not loaded yet; try again in a moment';

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
      case 'stop_loss':
      case 'take_profit':
        return submitStop(this.s, req, ctx);
      default: {
        // A runtime value outside OrderType (e.g. from the API) is recorded as rejected.
        const order = newOrder(req, ctx.market.rules(req.symbol), noFields(), ctx);
        return rejectOrder(this.s, order, UNKNOWN_ORDER_TYPE, ctx);
      }
    }
  }

  /**
   * The order reaches the exchange after its delay: a submitted order (pending) or a triggered
   * stop. A no-op for unknown or other orders (e.g. cancelled while in flight) and before the
   * order's arrivesAt. A buy that finishes here activates its attached pair.
   */
  arrive(orderId: string, ctx: EngineCtx): EngineEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order) return [];
    if (order.status === 'triggered') return arriveTriggered(this.s, order, ctx);
    if (order.status !== 'pending') return [];
    if (order.arrivesAt !== null && ctx.now < order.arrivesAt) return [];
    switch (order.type) {
      case 'market':
        return activateAttachedPairs(this.s, this.arriveMarket(order, ctx), ctx);
      case 'limit':
      case 'post_only':
        return activateAttachedPairs(this.s, arriveLimit(this.s, order, ctx), ctx);
      case 'stop_loss':
      case 'take_profit':
        return arriveStop(this.s, order, ctx);
    }
  }

  /**
   * A real trade on `symbol`. While the symbol is fresh it first does what onFresh does (arms
   * waiting attached pairs, executes due triggered orders), so nothing waits on a missed onFresh;
   * then triggers the armed stops its price reached; then fills the resting limit and post-only
   * orders it went through. A trade id at or below the last one processed for the symbol is a
   * replay and is ignored, so no trade is ever counted twice. A trade that arrives while the
   * symbol is stale is skipped without moving that cursor, so a later replay of it is processed.
   */
  onTrade(symbol: string, trade: AggTrade, ctx: EngineCtx): EngineEvent[] {
    const lastId = this.s.lastTradeId[symbol];
    if (lastId !== undefined && trade.id <= lastId) return [];
    if (!ctx.market.isFresh(symbol)) return [];
    const events = [
      ...this.onFresh(symbol, ctx),
      ...triggerStops(this.s, symbol, trade, ctx),
      ...matchTrade(this.s, symbol, trade, ctx),
    ];
    this.s.lastTradeId[symbol] = trade.id;
    return activateAttachedPairs(this.s, events, ctx);
  }

  /**
   * The symbol's book is fresh again: attached pairs that waited for fresh data arm (or are
   * rejected if they would trigger now), and triggered orders that are due execute against it.
   * A no-op while the symbol is stale.
   */
  onFresh(symbol: string, ctx: EngineCtx): EngineEvent[] {
    return [...armWaitingPairs(this.s, symbol, ctx), ...executeDue(this.s, symbol, ctx)];
  }

  /** Attach a linked stop-loss / take-profit pair (both sells) to coins already held. */
  attachOco(req: OcoRequest, ctx: EngineCtx): EngineEvent[] {
    return attachOco(this.s, req, ctx);
  }

  /**
   * Cancel by the owner. Pending, open and partially filled limit/post-only orders and
   * untriggered stops can be cancelled (a cancelled pending order never arrives; a pair is
   * cancelled as a whole); market orders in flight and triggered stops are already executing.
   */
  cancel(orderId: string, ctx: EngineCtx): ActionResult {
    const order = this.s.orders.get(orderId);
    if (!order) return { ok: false, reason: 'Order not found' };
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      return { ok: false, reason: 'Order is not open' };
    }
    if (order.status === 'triggered' || order.type === 'market') {
      return { ok: false, reason: 'Order is already executing and cannot be cancelled' };
    }
    if (cancelNeedsRules(order) && !rulesLoaded(order.symbol, ctx)) return { ok: false, reason: RULES_NOT_LOADED };
    if (isStopType(order.type)) return { ok: true, events: cancelStop(this.s, order, ctx) };
    releaseFunds(this.s, order.lockAsset, order.lockAmount);
    const cancelled: SpotOrder = { ...order, status: 'cancelled', lockAmount: D(0) };
    this.s.orders.set(cancelled.id, cancelled);
    const cancelledQty = order.qty!.minus(order.filledQty);
    const events: EngineEvent[] = [
      { type: 'order_cancelled', time: ctx.now, order: cancelled, reason: 'user', cancelledQty },
    ];
    return { ok: true, events: activateAttachedPairs(this.s, events, ctx) };
  }

  /**
   * On restart: a market order still waiting for its arrival delay never reached the
   * exchange, so it is rejected and its lock released. A no-op for any other order.
   */
  rejectRestartedMarket(orderId: string, ctx: EngineCtx): EngineEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.type !== 'market' || order.status !== 'pending') return [];
    return rejectPending(this.s, order, RESTART_REASON, ctx);
  }

  /** What submit would do right now, without changing state. */
  preview(req: SpotOrderRequest, ctx: EngineCtx): OrderPreview {
    switch (req.type) {
      case 'market': {
        const plan = this.planMarket(req, ctx);
        return takerPreview(plan.walk, req.side, plan.rules, ctx, plan.reason);
      }
      case 'limit':
      case 'post_only':
        return previewLimit(this.s, req, ctx);
      case 'stop_loss':
      case 'take_profit':
        return previewStop(this.s, req, ctx);
      default:
        return emptyPreview(UNKNOWN_ORDER_TYPE);
    }
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
      fields: noFields(),
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

    const book = ctx.market.book(order.symbol);
    const walk = walkBook(book, order.side, marketTarget(order), marketStep(rules));
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
    return fillOrThin(this.s, order, walk, book, rules, ctx);
  }
}

/**
 * Cancels that need the symbol's exchange rules: a dollar-sized stop reports the coins its dollars
 * buy (floored to the step size), and a part-filled buy with an attached pair places that pair.
 */
function cancelNeedsRules(order: SpotOrder): boolean {
  if (isStopType(order.type)) return order.qty === null;
  return order.attach !== null && order.filledQty.gt(0);
}

function rulesLoaded(symbol: string, ctx: EngineCtx): boolean {
  try {
    ctx.market.rules(symbol);
    return true;
  } catch {
    return false;
  }
}
