import { UNKNOWN_ORDER_TYPE } from '../spot/engine.ts';
import { arriveMarket, previewMarket, submitMarket } from './market.ts';
import { newPerpOrder, noPerpFields, rejectOrder } from './orders.ts';
import { DEFAULT_LEVERAGE } from './state.ts';
import type { PerpState } from './state.ts';
import type { PerpCtx, PerpEvent, PerpOrderRequest, PerpPreview } from './types.ts';

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
      default: {
        // A type this engine does not take (e.g. from the API) is recorded as rejected.
        const leverage = this.s.settings[req.symbol]?.leverage ?? DEFAULT_LEVERAGE;
        return rejectOrder(this.s, newPerpOrder(req, noPerpFields(), leverage, ctx), UNKNOWN_ORDER_TYPE, ctx);
      }
    }
  }

  /**
   * The order reaches the exchange after its delay. A no-op for unknown or finished orders and
   * before the order's arrivesAt.
   */
  arrive(orderId: string, ctx: PerpCtx): PerpEvent[] {
    const order = this.s.orders.get(orderId);
    if (!order || order.status !== 'pending') return [];
    if (order.arrivesAt !== null && ctx.now < order.arrivesAt) return [];
    switch (order.type) {
      case 'market':
        return arriveMarket(this.s, order, ctx);
      default:
        return [];
    }
  }

  /** What submit would do right now, without changing state. */
  preview(req: PerpOrderRequest, ctx: PerpCtx): PerpPreview {
    if (req.type === 'market') return previewMarket(this.s, req, ctx);
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

  /**
   * Whether the symbol has work that waits for fresh data at ctx.now. Market orders never do: each
   * arrives on its own timer and is rejected if the data is stale then, so nothing waits.
   */
  hasDeferredWork(_symbol: string, _ctx: PerpCtx): boolean {
    return false;
  }
}
