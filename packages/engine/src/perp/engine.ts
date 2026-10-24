import type { Decimal } from '../decimal.ts';
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
import { applyFunding, closeFundingWindow, openFundingWindow } from './funding.ts';
import { arriveLimit, matchTrade, previewLimit, submitLimit } from './limit.ts';
import { checkMark, isolatedModel } from './liquidation.ts';
import type { LiquidationModel } from './liquidation.ts';
import { addMargin, removeMargin, setLeverage, setMarginMode } from './margin.ts';
import { arriveMarket, bracketsOrNull, liveDataReason, previewMarket, submitMarket } from './market.ts';
import { afterOwnFills, cancelOrder, newPerpOrder, noPerpFields, rejectOrder, remainingQty } from './orders.ts';
import { leverageFor, putOrder } from './state.ts';
import {
  activateAttached,
  armWaitingLegs,
  arriveStop,
  arriveTriggered,
  canArmNow,
  dueTriggered,
  executeDue,
  setPositionTpSl,
  triggerStops,
  waitingToArm,
} from './stops.ts';
import type { PerpState } from './state.ts';
import type {
  MarginWarning,
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
  private readonly model: LiquidationModel;

  /** `model` judges liquidation and margin ratio; isolated margin unless another is given. */
  constructor(state: PerpState, model: LiquidationModel = isolatedModel) {
    this.s = state;
    this.model = model;
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
        const leverage = leverageFor(this.s, req.symbol, bracketsOrNull(req.symbol, ctx));
        return rejectOrder(this.s, newPerpOrder(req, noPerpFields(), leverage, ctx), UNKNOWN_ORDER_TYPE, ctx);
      }
    }
  }

  /**
   * The order reaches the exchange after its delay: a submitted order (pending) or a triggered
   * stop. A no-op for unknown or finished orders (e.g. cancelled while in flight) and before the
   * order's arrivesAt. An opening order's first fill here places its attached stop-loss and
   * take-profit.
   */
  arrive(orderId: string, ctx: PerpCtx): PerpEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order) return [];
    if (order.status === 'triggered') return arriveTriggered(this.s, order, ctx);
    return this.finish(this.arrivePending(order, ctx), ctx);
  }

  /** What follows every action that can fill: the attached legs of orders filled for the first time are placed. */
  private finish(events: PerpEvent[], ctx: PerpCtx): PerpEvent[] {
    return activateAttached(this.s, events, ctx);
  }

  /** A submitted order reaches the exchange, without its finish; a no-op unless pending and due. */
  private arrivePending(order: PerpOrder, ctx: PerpCtx): PerpEvent[] {
    if (order.status !== 'pending') return [];
    if (order.arrivesAt !== null && ctx.now < order.arrivesAt) return [];
    switch (order.type) {
      case 'market':
        return arriveMarket(this.s, order, ctx);
      case 'limit':
      case 'post_only':
        return arriveLimit(this.s, order, ctx);
      case 'stop_loss':
      case 'take_profit':
        return arriveStop(this.s, order, ctx);
    }
  }

  /**
   * Set a stop-loss and/or take-profit on the symbol's position: close-position stops that close
   * whatever the position holds when they execute; both given share a group, so one triggering
   * cancels the other. One stop-loss and one take-profit per position.
   */
  setPositionTpSl(symbol: string, input: { stopLoss?: string; takeProfit?: string }, ctx: PerpCtx): PerpEvent[] {
    return setPositionTpSl(this.s, symbol, input, ctx);
  }

  /**
   * A real futures trade on `symbol`. While the symbol's data is fresh it first does what onFresh
   * does (delivers due cancels, arms waiting attached legs, executes due triggered stops), so
   * nothing waits on a missed onFresh or a late cancel timer; then triggers the armed stops its
   * price reached (the last trade price, never the mark); then fills the resting limit and
   * post-only orders it went through. A trade id at or below the last one processed for the symbol
   * is a replay and is ignored, so no trade is ever counted twice. A trade that arrives while the
   * data is stale is skipped without moving that cursor, so a later replay of it is processed.
   * Steps after a taker fill see the book less what it took.
   */
  onTrade(symbol: string, trade: AggTrade, ctx: PerpCtx): PerpEvent[] {
    const lastId = this.s.lastTradeId[symbol];
    if (lastId !== undefined && trade.id <= lastId) return [];
    if (liveDataReason(symbol, ctx) !== null) return [];
    const fresh = this.freshWork(symbol, ctx);
    const after = afterOwnFills(ctx, fresh);
    const events = [
      ...fresh,
      ...triggerStops(this.s, symbol, trade, after),
      ...matchTrade(this.s, symbol, trade, after),
    ];
    this.s.lastTradeId[symbol] = trade.id;
    return this.finish(events, ctx);
  }

  /**
   * A mark price update for `symbol`. Liquidation is judged on the mark only, never on the last
   * trade price: the position is liquidated when its margin balance is at or below its maintenance
   * margin, otherwise a margin-ratio warning is returned when the ratio reaches a new level. Needs a
   * fresh mark and nothing else (a stale book does not hold a liquidation back); with a stale mark
   * it does nothing.
   */
  onMark(symbol: string, mark: Decimal, ctx: PerpCtx): { events: PerpEvent[]; warnings: MarginWarning[] } {
    if (!ctx.market.isMarkFresh(symbol)) return { events: [], warnings: [] };
    return checkMark(this.s, symbol, mark, this.model, ctx);
  }

  /**
   * Open the symbol's funding window at fundingTime − 15 s: from now until it closes, every change
   * to the position widens the sizes the funding is settled on.
   */
  openFundingWindow(symbol: string, fundingTime: number, ctx: PerpCtx): void {
    openFundingWindow(this.s, symbol, fundingTime, ctx);
  }

  /** Close the symbol's funding window at fundingTime + 15 s; it waits for its settled rate. */
  closeFundingWindow(symbol: string, fundingTime: number, ctx: PerpCtx): void {
    closeFundingWindow(this.s, symbol, fundingTime, ctx);
  }

  /**
   * Apply the funding Binance settled at `fundingTime`, at its settled rate and the mark price at
   * settlement; never an estimate. Payers pay on the largest size held in the window, from the
   * position's margin first (on the size that position held itself; the rest of the window's size,
   * held by an earlier position, from the wallet); receivers receive on the smallest, into free
   * leverage USDT. `fundingTime` is epoch ms and must be a safe integer. Applied
   * once per (symbol, fundingTime); a repeat returns []. It never liquidates: the next mark does.
   */
  applyFunding(symbol: string, fundingTime: number, rate: Decimal, markPrice: Decimal, ctx: PerpCtx): PerpEvent[] {
    return applyFunding(this.s, symbol, fundingTime, rate, markPrice, ctx);
  }

  /**
   * The symbol's data is fresh again: cancels whose arrival time has passed are delivered, attached
   * legs that waited for fresh data arm (or are rejected if they would trigger now), and triggered
   * stops that are due execute against it. A no-op while the data is stale.
   */
  onFresh(symbol: string, ctx: PerpCtx): PerpEvent[] {
    return this.finish(this.freshWork(symbol, ctx), ctx);
  }

  /**
   * Whether onFresh has work for `symbol` at ctx.now: a cancel whose arrival time has passed, an
   * attached leg waiting for data that can arm now (fresh data and a last price), or a triggered
   * stop that is due (deferred by stale data included). Other orders never wait: each arrives on
   * its own timer and is rejected if the data is stale then, and trades skipped while stale are
   * replayed. Reads only.
   */
  hasDeferredWork(symbol: string, ctx: PerpCtx): boolean {
    const canArm = canArmNow(symbol, ctx);
    for (const o of this.s.orders.values()) {
      if (o.symbol !== symbol) continue;
      if (cancelDue(o, ctx.now) || dueTriggered(o, ctx.now) || (canArm && waitingToArm(o))) return true;
    }
    return false;
  }

  /**
   * onFresh without its finish: the caller finishes once for all its events. Each step walks the
   * book less what the taker fills of the steps before it took.
   */
  private freshWork(symbol: string, ctx: PerpCtx): PerpEvent[] {
    if (liveDataReason(symbol, ctx) !== null) return [];
    const dueCancels = [...this.s.orders.values()].filter((o) => o.symbol === symbol && cancelDue(o, ctx.now));
    const events: PerpEvent[] = [];
    for (const o of dueCancels) events.push(...this.deliverCancel(o.id, afterOwnFills(ctx, events), true));
    events.push(...armWaitingLegs(this.s, symbol, ctx));
    events.push(...executeDue(this.s, symbol, afterOwnFills(ctx, events)));
    return events;
  }

  /**
   * The owner asks to cancel. Pending, open and partially filled limit and post-only orders and
   * untriggered stops can be cancelled (one leg of a stop-loss/take-profit pair alone, leaving the
   * other in place); market orders in flight and triggered stops are already executing. Like an order, the request reaches
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
    return this.finish(this.deliverCancel(orderId, ctx, true), ctx);
  }

  /**
   * arriveCancel for a pending order the server sends again after a restart, with a new arrival
   * delay: its old arrival never happened, so a cancel that has reached the exchange cancels it
   * whatever that old arrival time was. The same as arriveCancel for any other order.
   */
  arriveCancelBeforeResend(orderId: string, ctx: PerpCtx): PerpEvent[] {
    return this.finish(this.deliverCancel(orderId, ctx, false), ctx);
  }

  /** arriveCancel without its finish; `arrivalFirst` runs a due earlier arrival first. */
  private deliverCancel(orderId: string, ctx: PerpCtx, arrivalFirst: boolean): PerpEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.cancelArrivesAt === null || ctx.now < order.cancelArrivesAt) return [];
    if (arrivalFirst && arrivesBeforeCancel(order)) {
      // The arrival changes the status, so the cancel is then delivered against what it left.
      return [...this.arrivePending(order, ctx), ...this.deliverCancel(orderId, ctx, false)];
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
      leverage: leverageFor(this.s, req.symbol, bracketsOrNull(req.symbol, ctx)),
      maxLeverage: 0,
      exhausted: false,
      bandLimited: false,
      rejectReason: UNKNOWN_ORDER_TYPE,
      note: null,
    };
  }
}
