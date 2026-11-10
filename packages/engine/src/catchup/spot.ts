import { floorToStep, grouped } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { finishSpot } from '../spot/engine.ts';
import type { SpotEngine } from '../spot/engine.ts';
import { allocateTradeThrough } from '../spot/matching.ts';
import { amountTooSmall, marketStep, rejectPending } from '../spot/orders.ts';
import { LIVE_STATUSES, freeOf, putOrder } from '../spot/state.ts';
import type { SpotState } from '../spot/state.ts';
import { expireTriggered, trigger, waitingToArm } from '../spot/stops.ts';
import { isStopType, isTriggered } from '../spot/triggers.ts';
import type { AggTrade, EngineCtx, EngineEvent, MarketView, SpotOrder, SpotRules } from '../types.ts';
import {
  floorMinute,
  hhmm,
  hhmmss,
  inGap,
  lower,
  MINUTE_MS,
  reachingPrice,
  restingLimit,
  usableTrades,
  walkedCandles,
  worstPrice,
} from './plan.ts';
import type { Candle1m, CatchUpBasis, CatchUpEvent, CatchUpInput } from './types.ts';

/**
 * Spot catch-up over one symbol's gap. There is no historical book, so nothing here reads the live
 * book or its own-liquidity overlay: stops fill at the worst price of a candle, limits at their own
 * price from replayed trades. Every event is dated at the moment it represents and tagged with the
 * gap and its basis; a `catch_up` summary follows when an order existed during the gap.
 */
export function applySpotCatchUp(
  engine: SpotEngine,
  input: CatchUpInput,
  ctx: EngineCtx,
): (EngineEvent | CatchUpEvent)[] {
  return new SpotCatchUp(engine, input, ctx).run();
}

/** The market as catch-up sees it: fresh, with no book and no average, `last` as the last price. */
function historical(live: MarketView, last: Decimal | null): MarketView {
  return {
    isFresh: () => true,
    book: () => ({ bids: [], asks: [] }),
    best: () => null,
    avgPrice: () => null,
    lastPrice: () => last,
    rules: (symbol) => live.rules(symbol),
  };
}

class SpotCatchUp {
  private readonly s: SpotState;
  private readonly symbol: string;
  private readonly out: EngineEvent[] = [];
  private readonly actions: string[] = [];
  /** When each stop armed by this run did so: a stop cannot trigger before it is armed. */
  private readonly armedAt = new Map<string, number>();
  /** Orders whose in-flight cancel this run has delivered (or tried to). */
  private readonly cancelsDelivered = new Set<string>();
  private readonly candleAt = new Map<number, Candle1m>();
  /** The latest price the run has seen: a replayed trade's, or a walked minute's close. */
  private last: Decimal | null = null;
  /** The highest trade id the run replayed; null when it replayed none. */
  private replayedTo: number | null = null;

  constructor(
    private readonly engine: SpotEngine,
    private readonly input: CatchUpInput,
    private readonly ctx: EngineCtx,
  ) {
    this.s = engine.state;
    this.symbol = input.symbol;
    for (const c of walkedCandles(input.candles, input.to)) this.candleAt.set(c.openTime, c);
  }

  run(): (EngineEvent | CatchUpEvent)[] {
    const { from, to } = this.input;
    if (!this.anyOrder()) return [];
    if (this.input.trades === 'unavailable') {
      throw new Error(`Spot catch-up for ${this.symbol} needs the trades of the gap`);
    }
    const trades = usableTrades(this.input, this.input.trades, this.s.lastTradeId[this.symbol]);
    this.armWaitingPairs(from);

    for (const c of walkedCandles(this.input.candles, to)) {
      const start = c.openTime;
      const end = start + MINUTE_MS;
      // Perp catch-up slots its funding and liquidation steps in here, ahead of the stops.
      this.deliverCancels((at) => at < start);
      this.triggeredStep(c);
      if (inGap(start, from, to)) {
        this.stopStep(c);
        this.tradeStep(trades.filter((t) => t.time >= start && t.time < end));
        this.deliverCancels((at) => at < end);
        // One more pass for the stops armed in this minute (pairs placed by its fills).
        this.triggeredStep(c);
        this.stopStep(c);
      }
      this.last = c.close;
    }
    this.deliverCancels(() => true);
    // The trade cursor moves past every trade replayed, so neither the live feed nor a later run
    // over an overlapping gap can use one again.
    if (this.replayedTo !== null) {
      this.s.lastTradeId[this.symbol] = Math.max(this.s.lastTradeId[this.symbol] ?? -Infinity, this.replayedTo);
    }

    const time = this.out.reduce((latest, e) => Math.max(latest, e.time), to);
    const summary: CatchUpEvent = {
      type: 'catch_up',
      market: 'spot',
      symbol: this.symbol,
      time,
      from,
      to,
      actions: this.actions,
    };
    return [...this.out, summary];
  }

  /** The symbol's exchange rules, read only once there is an order to look after. */
  private get rules(): SpotRules {
    return this.ctx.market.rules(this.symbol);
  }

  /** Whether any order of the symbol was live, or had a cancel in flight, when the gap began. */
  private anyOrder(): boolean {
    for (const o of this.s.orders.values()) {
      if (o.symbol === this.symbol && (LIVE_STATUSES.has(o.status) || o.cancelArrivesAt !== null)) return true;
    }
    return false;
  }

  private ordersOf(pred: (o: SpotOrder) => boolean): SpotOrder[] {
    return [...this.s.orders.values()].filter((o) => o.symbol === this.symbol && pred(o));
  }

  /** The engine context at `now`, on the historical market with `last` as the last price. */
  private at(now: number, last: Decimal | null): EngineCtx {
    const { rng, newId, fees } = this.ctx;
    return { now, rng: () => rng(), newId: (prefix) => newId(prefix), fees, market: historical(this.ctx.market, last) };
  }

  // ---- arming ----

  /** Attached pairs that waited for data arm at the start of the gap. */
  private armWaitingPairs(from: number): void {
    for (const o of this.ordersOf(waitingToArm)) this.arm(o.id, from);
  }

  /** The legs of attached pairs these events placed arm at once, at `now`. */
  private armPlacedPairs(events: EngineEvent[], now: number): void {
    for (const e of events) {
      if (e.type === 'order_placed' && e.order.parentId !== null && isStopType(e.order.type)) this.arm(e.order.id, now);
    }
  }

  private arm(id: string, now: number): void {
    const o = this.s.orders.get(id)!;
    if (o.status !== 'pending') return;
    putOrder(this.s, { ...o, status: 'open', arrivesAt: o.arrivesAt ?? now });
    this.armedAt.set(id, now);
  }

  // ---- steps ----

  /**
   * Orders already triggered, whose trigger minute is this minute or earlier, fill at the worst
   * price of their trigger minute (or of this minute when that candle is missing).
   */
  private triggeredStep(c: Candle1m): void {
    const due = this.ordersOf(
      (o) => o.status === 'triggered' && floorMinute(o.triggeredAt ?? c.openTime) <= c.openTime,
    );
    due.sort((a, b) => (a.triggeredAt ?? 0) - (b.triggeredAt ?? 0));
    for (const o of due) {
      const triggeredAt = o.triggeredAt ?? c.openTime;
      const minute = this.candleAt.get(floorMinute(triggeredAt)) ?? c;
      // Dated within the minute its price comes from, and never before its trigger.
      const time = Math.max(triggeredAt, minute.openTime);
      this.execute(o, worstPrice(o.side, minute), time, minute.openTime, 'trigger_minute_worst_price');
    }
  }

  /**
   * Armed stop-losses, then take-profits, that the minute's range reached: each triggers (its pair
   * partner is cancelled) and fills at once at the minute's worst price. A stop armed only after
   * the minute ended is not checked against it.
   */
  private stopStep(c: Candle1m): void {
    const end = c.openTime + MINUTE_MS;
    const reached = this.ordersOf(
      (o) =>
        o.status === 'open' &&
        isStopType(o.type) &&
        (this.armedAt.get(o.id) ?? o.arrivesAt ?? c.openTime) < end &&
        isTriggered(o.type, o.side, o.triggerPrice!, reachingPrice(o, c)),
    );
    const rank = (o: SpotOrder) => (o.type === 'stop_loss' ? 0 : 1);
    reached.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    for (const { id } of reached) {
      // Re-read: a stop-loss that fired earlier in this loop may have cancelled this order as its partner.
      const o = this.s.orders.get(id)!;
      if (o.status !== 'open') continue;
      const time = Math.max(c.openTime, this.armedAt.get(id) ?? o.arrivesAt ?? c.openTime);
      const worst = worstPrice(o.side, c);
      const at = this.at(time, worst);
      const before = this.actions.length;
      this.emit(finishSpot(this.s, trigger(this.s, o, reachingPrice(o, c), at), at), 'candle_worst_price', c.openTime);
      // The summary tells of the fill before the partner it cancelled.
      const partnerLines = this.actions.splice(before);
      this.execute(this.s.orders.get(id)!, worst, time, c.openTime, 'candle_worst_price');
      this.actions.push(...partnerLines);
    }
  }

  /**
   * A triggered order executes at `price` with the taker fee. A qty-sized buy whose cost there
   * exceeds its lock plus free USDT expires in full, as at the exchange.
   */
  private execute(o: SpotOrder, price: Decimal, time: number, minute: number, basis: CatchUpBasis): void {
    const at = this.at(time, price);
    let qty = o.qty;
    if (o.side === 'buy') {
      if (qty === null) {
        qty = floorToStep(o.quoteQty!.div(price), marketStep(this.rules));
        if (qty.isZero()) {
          this.emit(rejectPending(this.s, o, amountTooSmall(o.quoteQty, this.rules), at, true), basis, minute);
          return;
        }
      } else {
        const need = qty.mul(price);
        const available = o.lockAmount.plus(freeOf(this.s, 'spot', o.lockAsset));
        if (need.gt(available)) {
          const events = expireTriggered(this.s, o, need, available, `candle worst ${price}`, at);
          this.emit(finishSpot(this.s, events, at), basis, minute);
          return;
        }
      }
    }
    this.emit(this.engine.fillAt(o, qty!, price, 'taker', at), basis, minute);
  }

  /**
   * The minute's replayed trades in time order: each fills, at their own price and the maker fee,
   * the resting limit and post-only orders it went strictly through and that had reached the
   * exchange before it. Cancels that arrive meanwhile are delivered first, at their own time.
   */
  private tradeStep(trades: AggTrade[]): void {
    for (const trade of trades) {
      this.deliverCancels((at) => at <= trade.time);
      const resting = this.ordersOf((o) => restingLimit(o) && o.arrivesAt !== null && trade.time > o.arrivesAt);
      for (const { orderId, qty } of allocateTradeThrough(resting, trade)) {
        const o = this.s.orders.get(orderId)!;
        const events = this.engine.fillAt(o, qty, o.price!, 'maker', this.at(trade.time, trade.price));
        this.emit(events, 'aggtrade_replay', floorMinute(trade.time));
        this.armPlacedPairs(events, trade.time);
      }
      this.last = trade.price;
      this.replayedTo = Math.max(this.replayedTo ?? -Infinity, trade.id);
    }
  }

  /**
   * The owner cancels in flight that arrive within the gap and pass `due`, in arrival order, each
   * at its own arrival time: the order is cancelled, or the late cancel is recorded if the order
   * filled or triggered first. A cancel of an order still on its way to the exchange is left to
   * the live path, which delivers it after that order's own arrival.
   */
  private deliverCancels(due: (at: number) => boolean): void {
    for (;;) {
      const next = this.ordersOf(
        (o) =>
          o.cancelArrivesAt !== null &&
          o.status !== 'pending' &&
          o.cancelArrivesAt <= this.input.to &&
          due(o.cancelArrivesAt) &&
          !this.cancelsDelivered.has(o.id),
      ).sort((a, b) => a.cancelArrivesAt! - b.cancelArrivesAt!)[0];
      if (!next) return;
      this.cancelsDelivered.add(next.id);
      const time = next.cancelArrivesAt!;
      const events = this.engine.arriveCancel(next.id, this.at(time, this.last));
      this.emit(events, 'cancel_arrival', floorMinute(time));
      this.armPlacedPairs(events, time);
    }
  }

  // ---- events and the summary ----

  private emit(events: EngineEvent[], basis: CatchUpBasis, minute: number): void {
    const { from, to } = this.input;
    for (const e of events) {
      if (e.type === 'deposit' || e.type === 'transfer') throw new Error(`Catch-up produced a ${e.type}`);
      this.out.push({ ...e, catchUp: { from, to, basis } });
      const action = this.describe(e, basis, minute);
      if (action !== null) this.actions.push(action);
    }
  }

  /** One line of the summary for an event, or null for events another line already covers. */
  private describe(e: EngineEvent, basis: CatchUpBasis, minute: number): string | null {
    const base = this.rules.base;
    switch (e.type) {
      case 'fill': {
        const what = `${label(e.order)} filled ${e.fill.qty} ${base} at ${grouped(e.fill.price)}`;
        if (basis === 'aggtrade_replay') return `${what} (replayed trade at ${hhmmss(e.time)}; estimated)`;
        if (basis === 'trigger_minute_worst_price') {
          return `${what} (worst price of ${hhmm(minute)}, its trigger minute; estimated)`;
        }
        return `${what} (worst price of ${hhmm(minute)}; estimated)`;
      }
      case 'order_rejected':
        if (e.afterTrigger) return `${label(e.order)} expired at ${hhmm(minute)} (estimated): ${e.reason}`;
        // A pair is rejected as a whole: one line for both legs.
        if (e.order.parentId !== null && e.order.type === 'take_profit') return null;
        return `${label(e.order)} rejected at ${hhmmss(e.time)} (estimated): ${e.reason}`;
      case 'order_cancelled': {
        const what = `${label(e.order)} ${e.cancelledQty} ${base}`;
        if (e.reason === 'oco') return `${what} cancelled: the other order of its pair triggered (estimated)`;
        if (e.reason === 'user') return `Cancel of ${lower(what)} took effect at ${hhmmss(e.time)} (estimated)`;
        return `${what} cancelled at ${hhmmss(e.time)} (${e.reason}; estimated)`;
      }
      case 'cancel_rejected': {
        const order = lower(label(e.order));
        return `Cancel of ${order} arrived at ${hhmmss(e.time)}: order already ${e.order.status} (estimated)`;
      }
      case 'order_placed': {
        if (e.order.type !== 'stop_loss') return null;
        const parent = e.order.parentId === null ? undefined : this.s.orders.get(e.order.parentId);
        const tp = parent?.attach ? ` / take-profit ${grouped(parent.attach.takeProfit)}` : '';
        const pair = `Attached stop-loss ${grouped(String(e.order.triggerPrice))}${tp}`;
        return `${pair} placed for ${e.order.qty} ${base} at ${hhmmss(e.time)} (estimated)`;
      }
      default:
        return null;
    }
  }
}

/** How an order reads at the start of a summary line: "Stop-loss", "Buy take-profit", "Limit buy". */
function label(o: SpotOrder): string {
  switch (o.type) {
    case 'stop_loss':
      return o.side === 'sell' ? 'Stop-loss' : 'Buy stop-loss';
    case 'take_profit':
      return o.side === 'sell' ? 'Take-profit' : 'Buy take-profit';
    case 'limit':
      return `Limit ${o.side}`;
    case 'post_only':
      return `Post-only ${o.side}`;
    case 'market':
      return `Market ${o.side}`;
  }
}
