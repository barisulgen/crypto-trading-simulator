import type { Decimal } from './decimal.ts';
import { deposit, transfer } from './account/ledger.ts';
import { perpCatchUpNeeds, spotCatchUpNeeds } from './catchup/plan.ts';
import { applyPerpCatchUp } from './catchup/perp.ts';
import { applySpotCatchUp } from './catchup/spot.ts';
import type { Candle1m, CatchUpEvent, CatchUpInput, CatchUpNeeds } from './catchup/types.ts';
import type { Ledger } from './account/ledger.ts';
import type { PerpEngine } from './perp/engine.ts';
import type {
  MarginPreview,
  MarginWarning,
  PerpActionResult,
  PerpCtx,
  PerpEvent,
  PerpMarketView,
  PerpOrderRequest,
  PerpPreview,
} from './perp/types.ts';
import type { SpotEngine } from './spot/engine.ts';
import type {
  ActionResult,
  AggTrade,
  EngineCtx,
  EngineEvent,
  FeeSchedule,
  Market,
  MarketView,
  OrderPreview,
  SpotOrderRequest,
  Wallet,
} from './types.ts';

/** Every event the account's engines emit, and catch-up summaries: what is persisted and broadcast. */
export type SimEvent = EngineEvent | PerpEvent | CatchUpEvent;

/** Everything impure the account needs: time, randomness, ids, and each market's data and fees. */
export interface SimCtx {
  now: number;
  rng(): number;
  newId(prefix: string): string;
  spotMarket: MarketView;
  perpMarket: PerpMarketView;
  fees: { spot: FeeSchedule; perp: FeeSchedule };
}

/** The context one market's engine runs with, taken from the account's at the time of the call. */
export function ctxFor(ctx: SimCtx, market: 'spot'): EngineCtx;
export function ctxFor(ctx: SimCtx, market: 'perp'): PerpCtx;
export function ctxFor(ctx: SimCtx, market: Market): EngineCtx | PerpCtx {
  const base = { now: ctx.now, rng: () => ctx.rng(), newId: (prefix: string) => ctx.newId(prefix) };
  return market === 'spot'
    ? { ...base, market: ctx.spotMarket, fees: ctx.fees.spot }
    : { ...base, market: ctx.perpMarket, fees: ctx.fees.perp };
}

/**
 * The whole simulated account: one ledger shared by the spot and perp engines, the wallet actions,
 * and each order action sent to the engine of its market.
 */
export class SimEngine {
  constructor(
    readonly ledger: Ledger,
    readonly spot: SpotEngine,
    readonly perp: PerpEngine,
  ) {
    if (spot.state.ledger !== ledger || perp.state.ledger !== ledger) {
      throw new Error('SimEngine: the spot and perp engines must share one ledger, the account’s');
    }
  }

  deposit(wallet: Wallet, amount: Decimal, ctx: { now: number }): ActionResult {
    return deposit(this.ledger, wallet, amount, ctx);
  }

  /** Moves free USDT only: locked funds and position margin never move. */
  transfer(from: Wallet, to: Wallet, amount: Decimal, ctx: { now: number }): ActionResult {
    return transfer(this.ledger, from, to, amount, ctx);
  }

  // ---- order actions, sent to the engine of the market ----

  submit(market: 'spot', req: SpotOrderRequest, ctx: SimCtx): EngineEvent[];
  submit(market: 'perp', req: PerpOrderRequest, ctx: SimCtx): PerpEvent[];
  submit(market: Market, req: SpotOrderRequest | PerpOrderRequest, ctx: SimCtx): SimEvent[] {
    return market === 'spot'
      ? this.spot.submit(req as SpotOrderRequest, ctxFor(ctx, 'spot'))
      : this.perp.submit(req as PerpOrderRequest, ctxFor(ctx, 'perp'));
  }

  preview(market: 'spot', req: SpotOrderRequest, ctx: SimCtx): OrderPreview;
  preview(market: 'perp', req: PerpOrderRequest, ctx: SimCtx): PerpPreview;
  preview(market: Market, req: SpotOrderRequest | PerpOrderRequest, ctx: SimCtx): OrderPreview | PerpPreview {
    return market === 'spot'
      ? this.spot.preview(req as SpotOrderRequest, ctxFor(ctx, 'spot'))
      : this.perp.preview(req as PerpOrderRequest, ctxFor(ctx, 'perp'));
  }

  arrive(market: Market, orderId: string, ctx: SimCtx): SimEvent[] {
    return market === 'spot'
      ? this.spot.arrive(orderId, ctxFor(ctx, 'spot'))
      : this.perp.arrive(orderId, ctxFor(ctx, 'perp'));
  }

  /** A real trade on `symbol` in `market` (spot and futures trades are separate streams). */
  onTrade(market: Market, symbol: string, trade: AggTrade, ctx: SimCtx): SimEvent[] {
    return market === 'spot'
      ? this.spot.onTrade(symbol, trade, ctxFor(ctx, 'spot'))
      : this.perp.onTrade(symbol, trade, ctxFor(ctx, 'perp'));
  }

  onFresh(market: Market, symbol: string, ctx: SimCtx): SimEvent[] {
    return market === 'spot'
      ? this.spot.onFresh(symbol, ctxFor(ctx, 'spot'))
      : this.perp.onFresh(symbol, ctxFor(ctx, 'perp'));
  }

  hasDeferredWork(market: Market, symbol: string, ctx: SimCtx): boolean {
    return market === 'spot'
      ? this.spot.hasDeferredWork(symbol, ctxFor(ctx, 'spot'))
      : this.perp.hasDeferredWork(symbol, ctxFor(ctx, 'perp'));
  }

  cancel(market: Market, orderId: string, ctx: SimCtx): ActionResult {
    return market === 'spot'
      ? this.spot.cancel(orderId, ctxFor(ctx, 'spot'))
      : this.perp.cancel(orderId, ctxFor(ctx, 'perp'));
  }

  arriveCancel(market: Market, orderId: string, ctx: SimCtx): SimEvent[] {
    return market === 'spot'
      ? this.spot.arriveCancel(orderId, ctxFor(ctx, 'spot'))
      : this.perp.arriveCancel(orderId, ctxFor(ctx, 'perp'));
  }

  arriveCancelBeforeResend(market: Market, orderId: string, ctx: SimCtx): SimEvent[] {
    return market === 'spot'
      ? this.spot.arriveCancelBeforeResend(orderId, ctxFor(ctx, 'spot'))
      : this.perp.arriveCancelBeforeResend(orderId, ctxFor(ctx, 'perp'));
  }

  // ---- perps only ----

  onMark(symbol: string, mark: Decimal, ctx: SimCtx): { events: PerpEvent[]; warnings: MarginWarning[] } {
    return this.perp.onMark(symbol, mark, ctxFor(ctx, 'perp'));
  }

  setLeverage(symbol: string, leverage: number, ctx: SimCtx): PerpActionResult {
    return this.perp.setLeverage(symbol, leverage, ctxFor(ctx, 'perp'));
  }

  setMarginMode(symbol: string, mode: 'isolated' | 'cross', ctx: SimCtx): PerpActionResult {
    return this.perp.setMarginMode(symbol, mode, ctxFor(ctx, 'perp'));
  }

  addMargin(symbol: string, amount: string, ctx: SimCtx): PerpActionResult {
    return this.perp.addMargin(symbol, amount, ctxFor(ctx, 'perp'));
  }

  removeMargin(symbol: string, amount: string, ctx: SimCtx): PerpActionResult {
    return this.perp.removeMargin(symbol, amount, ctxFor(ctx, 'perp'));
  }

  /** What adding or removing margin would do now; nothing is changed. */
  previewMargin(symbol: string, action: 'add' | 'remove', amount: string, ctx: SimCtx): MarginPreview {
    return this.perp.previewMargin(symbol, action, amount, ctxFor(ctx, 'perp'));
  }

  /** The margin that may be removed from the symbol's position now; null without a fresh mark. */
  maxRemovable(symbol: string, ctx: SimCtx): Decimal | null {
    return this.perp.maxRemovable(symbol, ctxFor(ctx, 'perp'));
  }

  setPositionTpSl(symbol: string, input: { stopLoss?: string; takeProfit?: string }, ctx: SimCtx): PerpEvent[] {
    return this.perp.setPositionTpSl(symbol, input, ctxFor(ctx, 'perp'));
  }

  /** Live marks held back while the symbol caught up, as their lowest and highest (PerpEngine.liquidateOnMarkRange). */
  liquidateOnMarkRange(symbol: string, low: Decimal, high: Decimal, ctx: SimCtx): PerpEvent[] {
    return this.perp.liquidateOnMarkRange(symbol, low, high, ctxFor(ctx, 'perp'));
  }

  openFundingWindow(symbol: string, fundingTime: number, ctx: SimCtx): void {
    this.perp.openFundingWindow(symbol, fundingTime, ctxFor(ctx, 'perp'));
  }

  closeFundingWindow(symbol: string, fundingTime: number, ctx: SimCtx): void {
    this.perp.closeFundingWindow(symbol, fundingTime, ctxFor(ctx, 'perp'));
  }

  applyFunding(symbol: string, fundingTime: number, rate: Decimal, markPrice: Decimal, ctx: SimCtx): PerpEvent[] {
    return this.perp.applyFunding(symbol, fundingTime, rate, markPrice, ctxFor(ctx, 'perp'));
  }
}

// ---- catch-up after a gap in live data ----

/**
 * What a catch-up run over the gap [from, to) of `market`/`symbol` needs beyond its last-price
 * candles: the minutes whose trades must be fetched (a candle went strictly through a resting limit
 * or post-only order that had reached the exchange by that minute's end), and whether mark candles
 * and funding history are needed (perps: while a position is open or an opening order rests, and
 * funding also while a funding window waits to settle). Reads only.
 */
export function catchUpNeeds(
  sim: SimEngine,
  market: Market,
  symbol: string,
  from: number,
  to: number,
  candles: Candle1m[],
): CatchUpNeeds {
  return market === 'spot'
    ? spotCatchUpNeeds(sim.spot.state, symbol, from, to, candles)
    : perpCatchUpNeeds(sim.perp.state, symbol, from, to, candles);
}

/**
 * Apply what would have happened during a gap in live data, minute by minute, from candles and
 * replayed trades (no historical book exists, so nothing reads the live one); for perps also from
 * mark candles and settled funding. Perp limit orders are cancelled at the start of the gap when
 * its trades are 'unavailable'. Every event is dated at the moment it represents and carries
 * `catchUp`; a `catch_up` summary follows when an order or a position existed during the gap. No
 * events at all when nothing did.
 */
export function applyCatchUp(sim: SimEngine, input: CatchUpInput, ctx: SimCtx): SimEvent[] {
  return input.market === 'spot'
    ? applySpotCatchUp(sim.spot, input, ctxFor(ctx, 'spot'))
    : applyPerpCatchUp(sim.perp, input, ctxFor(ctx, 'perp'));
}
