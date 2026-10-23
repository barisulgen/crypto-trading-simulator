import { arrivalDelay } from '../spot/orders.ts';
import {
  ALREADY_EXECUTING,
  arrivesBeforeCancel,
  CANCEL_REQUESTED,
  CANCELLABLE,
  cancelDue,
  ORDER_NOT_OPEN,
  UNKNOWN_ORDER_TYPE,
} from '../spot/engine.ts';
import type { ActionResult, AggTrade } from '../types.ts';
import { arriveLimit, matchTrade, previewLimit, submitLimit } from './limit.ts';
import { addMargin, removeMargin, setLeverage, setMarginMode } from './margin.ts';
import { arriveMarket, liveDataReason, previewMarket, submitMarket } from './market.ts';
import { cancelOrder, newPerpOrder, noPerpFields, rejectOrder, remainingQty } from './orders.ts';
import { DEFAULT_LEVERAGE, putOrder } from './state.ts';
import type { PerpState } from './state.ts';
import type {
  PerpActionResult,
  PerpCtx,
  PerpEvent,
  PerpOrder,
  PerpOrderRequest,
  PerpPreview,
} from './types.ts';

/**
 * USDⓈ-M perpetuals with isolated margin in one-way mode: an order never flips a position, and an
 * order against a position or against opening orders must be reduce-only.
 */
export class PerpEngine {
  private readonly s: PerpState;

  constructor(state: PerpState) {
    this.s = state;
  }

  get state(): PerpState {
    return this.s;
  }

  submit(req: PerpOrderRequest, ctx: PerpCtx): PerpEvent[] {
    switch (req.type) {
      case 'market':
        return submitMarket(this.s, req, ctx);
      case 'limit':
      case 'post_only':
        return submitLimit(this.s, req, ctx);
      default: {
        // A type this engine does not take (e.g. from the API) is recorded as rejected.
        const leverage = this.s.settings[req.symbol]?.leverage ?? DEFAULT_LEVERAGE;
        return rejectOrder(this.s, newPerpOrder(req, noPerpFields(), leverage, ctx), UNKNOWN_ORDER_TYPE, ctx);
      }
    }
  }

  /**
   * The order reaches the exchange after its delay. A no-op for unknown or finished orders (e.g.
   * cancelled while in flight) and before the order's arrivesAt.
   */
  arrive(orderId: string, ctx: PerpCtx): PerpEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.status !== 'pending') return [];
    if (order.arrivesAt !== null && ctx.now < order.arrivesAt) return [];
    switch (order.type) {
      case 'market':
        return arriveMarket(this.s, order, ctx);
      case 'limit':
      case 'post_only':
        return arriveLimit(this.s, order, ctx);
      default:
        return [];
    }
  }

  /**
   * A real futures trade on `symbol`. While the symbol's data is fresh it first does what onFresh
   * does (delivers due cancels), so nothing waits on a missed onFresh or a late cancel timer; then
   * fills the resting limit and post-only orders it went through. A trade id at or below the last
   * one processed for the symbol is a replay and is ignored, so no trade is ever counted twice. A
   * trade that arrives while the data is stale is skipped without moving that cursor, so a later
   * replay of it is processed.
   */
  onTrade(symbol: string, trade: AggTrade, ctx: PerpCtx): PerpEvent[] {
    const lastId = this.s.lastTradeId[symbol];
    if (lastId !== undefined && trade.id <= lastId) return [];
    if (liveDataReason(symbol, ctx) !== null) return [];
    const events = [...this.onFresh(symbol, ctx), ...matchTrade(this.s, symbol, trade, ctx)];
    this.s.lastTradeId[symbol] = trade.id;
    return events;
  }

  /**
   * The symbol's data is fresh again: cancels whose arrival time has passed are delivered. A no-op
   * while the data is stale.
   */
  onFresh(symbol: string, ctx: PerpCtx): PerpEvent[] {
    if (liveDataReason(symbol, ctx) !== null) return [];
    const due = [...this.s.orders.values()].filter((o) => o.symbol === symbol && cancelDue(o, ctx.now));
    return due.flatMap((o) => this.deliverCancel(o.id, ctx, true));
  }

  /**
   * Whether onFresh has work for `symbol` at ctx.now: a cancel whose arrival time has passed. Orders
   * themselves never wait: each arrives on its own timer and is rejected if the data is stale then,
   * and trades skipped while stale are replayed. Reads only.
   */
  hasDeferredWork(symbol: string, ctx: PerpCtx): boolean {
    for (const o of this.s.orders.values()) {
      if (o.symbol === symbol && cancelDue(o, ctx.now)) return true;
    }
    return false;
  }

  /**
   * The owner asks to cancel. Pending, open and partially filled limit and post-only orders can be
   * cancelled; market orders in flight are already executing. Like an order, the request reaches
   * the exchange after an arrival delay (cancelArrivesAt) and takes effect then, in arriveCancel:
   * until then the order stays live and can still fill. One cancel per order can be in flight.
   */
  cancel(orderId: string, ctx: PerpCtx): ActionResult {
    const order = this.s.orders.get(orderId);
    if (!order) return { ok: false, reason: 'Order not found' };
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      return { ok: false, reason: ORDER_NOT_OPEN };
    }
    if (order.status === 'triggered' || order.type === 'market') return { ok: false, reason: ALREADY_EXECUTING };
    if (order.cancelArrivesAt !== null) return { ok: false, reason: CANCEL_REQUESTED };
    putOrder(this.s, { ...order, cancelArrivesAt: ctx.now + arrivalDelay(ctx) });
    return { ok: true, events: [] };
  }

  /**
   * The owner's cancel reaches the exchange; a no-op before its cancelArrivesAt or with no cancel
   * in flight. An order that can still be cancelled is cancelled (a pending one never arrives) and
   * its lock released. One that filled, was rejected or was cancelled meanwhile (e.g. a reduce-only
   * order whose position closed) stays as it is, and the late cancel is recorded as
   * cancel_rejected. A pending order whose own arrival is due no later than the cancel's arrives
   * first, here, whichever timer runs first.
   */
  arriveCancel(orderId: string, ctx: PerpCtx): PerpEvent[] {
    return this.deliverCancel(orderId, ctx, true);
  }

  /**
   * arriveCancel for a pending order the server sends again after a restart, with a new arrival
   * delay: its old arrival never happened, so a cancel that has reached the exchange cancels it
   * whatever that old arrival time was. The same as arriveCancel for any other order.
   */
  arriveCancelBeforeResend(orderId: string, ctx: PerpCtx): PerpEvent[] {
    return this.deliverCancel(orderId, ctx, false);
  }

  /** `arrivalFirst` runs a due earlier arrival first. */
  private deliverCancel(orderId: string, ctx: PerpCtx, arrivalFirst: boolean): PerpEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.cancelArrivesAt === null || ctx.now < order.cancelArrivesAt) return [];
    if (arrivalFirst && arrivesBeforeCancel(order)) {
      // The arrival changes the status, so the cancel is then delivered against what it left.
      return [...this.arrive(orderId, ctx), ...this.deliverCancel(orderId, ctx, false)];
    }
    const answered: PerpOrder = { ...order, cancelArrivesAt: null };
    if (!CANCELLABLE.has(order.status)) {
      putOrder(this.s, answered);
      const reason = `Cancel arrived too late: order already ${order.status}`;
      return [{ type: 'cancel_rejected', market: 'perp', time: ctx.now, order: answered, reason }];
    }
    return cancelOrder(this.s, answered, 'user', remainingQty(order), ctx);
  }

  /** Set the symbol's leverage; refused while a position or an opening order is live on it. */
  setLeverage(symbol: string, leverage: number, ctx: PerpCtx): PerpActionResult {
    return setLeverage(this.s, symbol, leverage, ctx);
  }

  /** Only isolated margin exists; asking for it again changes nothing. */
  setMarginMode(_symbol: string, mode: 'isolated' | 'cross', _ctx: PerpCtx): PerpActionResult {
    return setMarginMode(mode);
  }

  /** Move free leverage USDT into the symbol's position. Needs no live data. */
  addMargin(symbol: string, amount: string, ctx: PerpCtx): PerpActionResult {
    return addMargin(this.s, symbol, amount, ctx);
  }

  /** Move margin out of the symbol's position, at most what stays safe at a fresh mark price. */
  removeMargin(symbol: string, amount: string, ctx: PerpCtx): PerpActionResult {
    return removeMargin(this.s, symbol, amount, ctx);
  }

  /** What submit would do right now, without changing state. */
  preview(req: PerpOrderRequest, ctx: PerpCtx): PerpPreview {
    if (req.type === 'market') return previewMarket(this.s, req, ctx);
    if (req.type === 'limit' || req.type === 'post_only') return previewLimit(this.s, req, ctx);
    return {
      estAvgPrice: null,
      estSlippageUsd: null,
      estSlippagePct: null,
      notional: null,
      fee: null,
      marginRequired: null,
      estLiquidationPrice: null,
      leverage: this.s.settings[req.symbol]?.leverage ?? DEFAULT_LEVERAGE,
      maxLeverage: 0,
      exhausted: false,
      bandLimited: false,
      rejectReason: UNKNOWN_ORDER_TYPE,
      note: null,
    };
  }
}
