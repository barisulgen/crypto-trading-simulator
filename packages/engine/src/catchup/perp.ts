import type { Decimal } from '../decimal.ts';
import type { PerpEngine } from '../perp/engine.ts';
import { FUNDING_WINDOW_MS } from '../perp/funding.ts';
import { liquidateAtLiquidationPrice } from '../perp/liquidation.ts';
import { bracketsOrNull } from '../perp/market.ts';
import { liquidationPrice } from '../perp/math.ts';
import { cancelOrder, remainingQty } from '../perp/orders.ts';
import { putOrder } from '../perp/state.ts';
import type { PerpState } from '../perp/state.ts';
import { trigger, waitingToArm } from '../perp/stops.ts';
import type { PerpCtx, PerpEvent, PerpMarketView, PerpOrder } from '../perp/types.ts';
import { allocateTradeThrough } from '../spot/matching.ts';
import { LIVE_STATUSES } from '../spot/state.ts';
import { isTriggered } from '../spot/triggers.ts';
import type { AggTrade } from '../types.ts';
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
 * Perp catch-up over one symbol's gap, minute by minute: funding windows open, then liquidation on
 * the minute's mark candle (at the liquidation price), then stops already triggered, then
 * close-position stop-losses and take-profits on the last-price candle, then limit fills from
 * replayed trades (each fill judged at once against the minute's mark), then the funding windows
 * that close in the minute settle, then one more pass of liquidation and stops for what the fills
 * and the funding changed or armed. Funding is settled as live: on the sizes held through its
 * window (15 s either side of the funding time), which the replayed fills widen. There is no
 * historical book, so nothing here reads the live book. Every event is tagged with the gap and its
 * basis, dated at the moment it represents and never before an event already emitted; a
 * `catch_up` summary follows when an order, a position or a funding window existed during the gap.
 */
export function applyPerpCatchUp(
  engine: PerpEngine,
  input: CatchUpInput,
  ctx: PerpCtx,
): (PerpEvent | CatchUpEvent)[] {
  return new PerpCatchUp(engine, input, ctx).run();
}

/** The summary line when the futures trades of the gap can no longer be fetched. */
export const HISTORY_UNAVAILABLE_LINE = 'Futures trade history covers only 2 days; open limit orders were cancelled';

/**
 * The futures market as catch-up sees it: fresh, with no book and no current mark, `last` as the
 * last price.
 */
function historical(live: PerpMarketView, last: Decimal | null): PerpMarketView {
  return {
    isFresh: () => true,
    isMarkFresh: () => true,
    book: () => ({ bids: [], asks: [] }),
    best: () => null,
    lastPrice: () => last,
    markPrice: () => null,
    rules: (symbol) => live.rules(symbol),
    brackets: (symbol) => live.brackets(symbol),
  };
}

type Settlement = NonNullable<CatchUpInput['funding']>[number];

function isStop(o: PerpOrder): boolean {
  return o.type === 'stop_loss' || o.type === 'take_profit';
}

class PerpCatchUp {
  private readonly s: PerpState;
  private readonly symbol: string;
  private readonly out: PerpEvent[] = [];
  private readonly actions: string[] = [];
  /** When each stop armed by this run did so: a stop cannot trigger before it is armed. */
  private readonly armedAt = new Map<string, number>();
  /** Orders whose in-flight cancel this run has delivered (or tried to). */
  private readonly cancelsDelivered = new Set<string>();
  private readonly candleAt = new Map<number, Candle1m>();
  private readonly markAt = new Map<number, Candle1m>();
  /** The settlements given, one per funding time, in time order. */
  private readonly funding: Settlement[];
  /** How many settlements have had their window opened, and how many have been settled. */
  private windowsOpened = 0;
  private settled = 0;
  /** The latest price the run has seen: a replayed trade's, or a walked minute's close. */
  private last: Decimal | null = null;
  /** The highest trade id the run replayed; null when it replayed none. */
  private replayedTo: number | null = null;
  /** The time of the latest event emitted: no later event is dated before it. */
  private clock = -Infinity;

  constructor(
    private readonly engine: PerpEngine,
    private readonly input: CatchUpInput,
    private readonly ctx: PerpCtx,
  ) {
    this.s = engine.state;
    this.symbol = input.symbol;
    for (const c of walkedCandles(input.candles, input.to)) this.candleAt.set(c.openTime, c);
    for (const c of walkedCandles(input.markCandles ?? [], input.to)) this.markAt.set(c.openTime, c);
    const byTime = new Map<number, Settlement>();
    for (const f of input.funding ?? []) if (f.time < input.to && !byTime.has(f.time)) byTime.set(f.time, f);
    this.funding = [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  run(): (PerpEvent | CatchUpEvent)[] {
    const { from, to } = this.input;
    if (!this.anythingOpen()) return [];
    const trades =
      this.input.trades === 'unavailable'
        ? null
        : usableTrades(this.input, this.input.trades, this.s.lastTradeId[this.symbol]);
    // Without the gap's trades the resting limits are cancelled at its start, once what came
    // before it (stops held from before the gap, cancels due before it) has been walked.
    let limitsChecked = trades !== null;
    this.armWaitingLegs(from);

    for (const start of this.minutes()) {
      const end = start + MINUTE_MS;
      const c = this.candleAt.get(start);
      const gap = inGap(start, from, to);
      this.deliverCancels((at) => at < start);
      if (gap && !limitsChecked) {
        this.cancelRestingLimits(from);
        limitsChecked = true;
      }
      // Windows that closed in minutes no candle covered settle at the next walked minute, first.
      this.settleFunding(start);
      this.openFundingWindows(end);
      if (gap) this.liquidationStep(start);
      this.triggeredStep(start, c);
      if (gap) {
        if (c) this.stopStep(c);
        if (trades) this.tradeStep(start, trades.filter((t) => t.time >= start && t.time < end));
      }
      this.settleFunding(end);
      if (gap) {
        this.deliverCancels((at) => at < end);
        // One more pass for what this minute's fills and funding changed, and the stops the fills armed.
        this.liquidationStep(start);
        this.triggeredStep(start, c);
        if (c) this.stopStep(c);
      }
      if (c) this.last = c.close;
    }
    if (!limitsChecked) this.cancelRestingLimits(from);
    // Settlements whose window closes after the last walked minute settle here, at that close.
    this.openFundingWindows(Infinity);
    this.settleFunding(Infinity);
    this.deliverCancels(() => true);
    // The trade cursor moves past every trade replayed, so neither the live feed nor a later run
    // over an overlapping gap can use one again.
    if (this.replayedTo !== null) {
      this.s.lastTradeId[this.symbol] = Math.max(this.s.lastTradeId[this.symbol] ?? -Infinity, this.replayedTo);
    }

    const time = this.out.reduce((latest, e) => Math.max(latest, e.time), to);
    const summary: CatchUpEvent = {
      type: 'catch_up',
      market: 'perp',
      symbol: this.symbol,
      time,
      from,
      to,
      actions: this.actions,
    };
    return [...this.out, summary];
  }

  /**
   * Whether the symbol had a position, a live order, a cancel in flight or a funding window
   * waiting to settle when the gap began.
   */
  private anythingOpen(): boolean {
    if (this.s.positions[this.symbol]) return true;
    if (this.s.funding.windows[this.symbol] || this.s.funding.pending.some((w) => w.symbol === this.symbol)) {
      return true;
    }
    for (const o of this.s.orders.values()) {
      if (o.symbol === this.symbol && (LIVE_STATUSES.has(o.status) || o.cancelArrivesAt !== null)) return true;
    }
    return false;
  }

  /** The minutes walked, in time order: those with a last-price or a mark candle opening before `to`. */
  private minutes(): number[] {
    return [...new Set([...this.candleAt.keys(), ...this.markAt.keys()])].sort((a, b) => a - b);
  }

  private ordersOf(pred: (o: PerpOrder) => boolean): PerpOrder[] {
    return [...this.s.orders.values()].filter((o) => o.symbol === this.symbol && pred(o));
  }

  /** The engine context at `now`, on the historical market with `last` as the last price. */
  private at(now: number, last: Decimal | null): PerpCtx {
    const { rng, newId, fees } = this.ctx;
    return { now, rng: () => rng(), newId: (prefix) => newId(prefix), fees, market: historical(this.ctx.market, last) };
  }

  /** The symbol's base asset, for the summary; read only once there is something to tell. */
  private get base(): string {
    try {
      return this.ctx.market.rules(this.symbol).base;
    } catch {
      return this.symbol.replace(/USDT$/, '');
    }
  }

  // ---- before the walk ----

  /**
   * Without the gap's trades no limit fill can be replayed, so every resting limit and post-only
   * order is cancelled at the start of the gap, after the owner's cancels that arrived before it.
   */
  private cancelRestingLimits(from: number): void {
    this.deliverCancels((at) => at < from);
    const resting = this.ordersOf(restingLimit);
    for (const o of resting) {
      const events = cancelOrder(this.s, o, 'catch_up_unavailable', remainingQty(o), this.at(from, null));
      this.emit(events, 'history_unavailable', floorMinute(from));
    }
    if (resting.length > 0) this.actions.push(HISTORY_UNAVAILABLE_LINE);
  }

  /** Attached legs that waited for data arm at the start of the gap. */
  private armWaitingLegs(from: number): void {
    for (const o of this.ordersOf(waitingToArm)) this.arm(o.id, from);
  }

  /** The attached legs these events placed arm at once, at `now`. */
  private armPlacedLegs(events: PerpEvent[], now: number): void {
    for (const e of events) {
      if (e.type === 'order_placed' && e.order.parentId !== null && isStop(e.order)) this.arm(e.order.id, now);
    }
  }

  private arm(id: string, now: number): void {
    const o = this.s.orders.get(id)!;
    if (o.status !== 'pending') return;
    putOrder(this.s, { ...o, status: 'open', arrivesAt: o.arrivesAt ?? now });
    this.armedAt.set(id, now);
  }

  // ---- steps ----

  /** When a settlement's window closes: 15 s after its funding time, or at the end of the gap if sooner. */
  private closeOf(f: Settlement): number {
    return Math.min(f.time + FUNDING_WINDOW_MS, this.input.to);
  }

  /**
   * Open the window of every settlement whose window opens (15 s before its funding time) before
   * `end`, seeded with the position as the walk has it now: a window opened in a minute takes in
   * every fill of that minute. A window already open, waiting for its rate or applied (live, or by
   * an earlier run) is left as it is.
   */
  private openFundingWindows(end: number): void {
    const funding = this.funding;
    while (this.windowsOpened < funding.length && funding[this.windowsOpened]!.time - FUNDING_WINDOW_MS < end) {
      const f = funding[this.windowsOpened]!;
      this.windowsOpened += 1;
      this.engine.openFundingWindow(this.symbol, f.time, this.at(f.time - FUNDING_WINDOW_MS, this.last));
    }
  }

  /**
   * Settle every settlement whose window closes before `limit`: the window closes and the funding
   * is applied at its settled rate and mark, on the sizes held through the window (a payer on the
   * largest, a receiver on the smallest), exactly once per funding time. Dated at the window's
   * close, the first moment its sizes are final; the owner's cancels that arrived by then go first.
   */
  private settleFunding(limit: number): void {
    while (this.settled < this.funding.length && this.closeOf(this.funding[this.settled]!) < limit) {
      const f = this.funding[this.settled]!;
      this.settled += 1;
      // A window not opened yet (its minutes were not walked) opens now, on the position as it is.
      if (this.windowsOpened < this.settled) this.openFundingWindows(f.time - FUNDING_WINDOW_MS + 1);
      const close = this.closeOf(f);
      this.deliverCancels((at) => at <= close);
      const at = this.at(close, this.last);
      this.engine.closeFundingWindow(this.symbol, f.time, at);
      const events = this.engine.applyFunding(this.symbol, f.time, f.rate, f.markPrice, at);
      this.emit(events, 'funding_history', floorMinute(close));
    }
  }

  /** The earliest an event of the gap minute opening at `start` may be dated. */
  private floor(start: number): number {
    return Math.max(start, this.input.from, this.clock);
  }

  /**
   * The position is liquidated when the minute's mark candle reached its current liquidation price
   * (a long's mark low at or below it, a short's mark high at or above it), with that price as the
   * mark. Dated at the minute's start, never before the gap or before the fill or funding that
   * brought it. Never judged without a mark candle.
   */
  private liquidationStep(start: number): void {
    const p = this.s.positions[this.symbol];
    const mark = this.markAt.get(start);
    if (!p || !mark) return;
    const brackets = bracketsOrNull(this.symbol, this.ctx);
    if (!brackets) throw new Error(`Perp catch-up for ${this.symbol} needs the leverage tiers`);
    const lp = liquidationPrice(brackets, p.side, p.qty, p.entryPrice, p.margin);
    if (lp === null) return;
    if (p.side === 'long' ? mark.low.gt(lp) : mark.high.lt(lp)) return;
    const time = this.floor(start);
    const events = liquidateAtLiquidationPrice(this.s, this.symbol, lp, this.at(time, this.last));
    // The summary tells of the liquidation before the orders it cancelled.
    this.emit(events, 'mark_candle', start, 'liquidation');
  }

  /**
   * Stops already triggered, whose trigger minute is this minute or earlier, close at the worst
   * price of their trigger minute (or of this minute when that candle is missing).
   */
  private triggeredStep(start: number, c: Candle1m | undefined): void {
    const due = this.ordersOf((o) => o.status === 'triggered' && floorMinute(o.triggeredAt ?? start) <= start);
    due.sort((a, b) => (a.triggeredAt ?? 0) - (b.triggeredAt ?? 0));
    for (const o of due) {
      const triggeredAt = o.triggeredAt ?? start;
      const minute = this.candleAt.get(floorMinute(triggeredAt)) ?? c;
      if (!minute) continue;
      // Dated within the minute its price comes from, never before its trigger or an earlier event.
      const time = Math.max(triggeredAt, minute.openTime, this.clock);
      const worst = worstPrice(o.side, minute);
      this.emit(this.engine.closeAt(o, worst, this.at(time, worst)), 'trigger_minute_worst_price', minute.openTime);
    }
  }

  /**
   * Armed stop-losses, then take-profits, that the minute's last-price range reached: each
   * triggers (its pair partner is cancelled) and closes the whole position at once at the minute's
   * worst price. A stop armed only after the minute ended is not checked against it.
   */
  private stopStep(c: Candle1m): void {
    const end = c.openTime + MINUTE_MS;
    const reached = this.ordersOf(
      (o) =>
        o.status === 'open' &&
        isStop(o) &&
        (this.armedAt.get(o.id) ?? o.arrivesAt ?? c.openTime) < end &&
        isTriggered(o.type as 'stop_loss' | 'take_profit', o.side, o.triggerPrice!, reachingPrice(o, c)),
    );
    const rank = (o: PerpOrder) => (o.type === 'stop_loss' ? 0 : 1);
    reached.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    for (const { id } of reached) {
      // Re-read: a stop that fired earlier in this loop may have cancelled this order.
      const o = this.s.orders.get(id)!;
      if (o.status !== 'open') continue;
      const time = Math.max(this.floor(c.openTime), this.armedAt.get(id) ?? o.arrivesAt ?? c.openTime);
      const worst = worstPrice(o.side, c);
      const at = this.at(time, worst);
      const before = this.actions.length;
      this.emit(trigger(this.s, o, reachingPrice(o, c), at), 'candle_worst_price', c.openTime);
      // The summary tells of the close before the partner it cancelled.
      const partnerLines = this.actions.splice(before);
      this.emit(this.engine.closeAt(this.s.orders.get(id)!, worst, at), 'candle_worst_price', c.openTime);
      this.actions.push(...partnerLines);
    }
  }

  /**
   * The minute's replayed trades in time order: each fills, at their own price and the maker fee,
   * the resting limit and post-only orders it went strictly through and that had reached the
   * exchange before it. A funding window that closed meanwhile is settled first, and cancels that
   * arrive meanwhile are delivered first, at their own time. After each fill the position is judged
   * against the minute's mark candle, so a liquidation the position reached in between is not
   * hidden by the margin a later fill adds.
   */
  private tradeStep(start: number, trades: AggTrade[]): void {
    for (const trade of trades) {
      this.settleFunding(trade.time);
      this.deliverCancels((at) => at <= trade.time);
      const resting = this.ordersOf((o) => restingLimit(o) && o.arrivesAt !== null && trade.time > o.arrivesAt);
      for (const { orderId, qty } of allocateTradeThrough(resting, trade)) {
        const o = this.s.orders.get(orderId)!;
        // A position closed by an earlier fill of this trade has already cancelled its reduce-only orders.
        if (!restingLimit(o)) continue;
        const events = this.engine.fillAt(o, qty, o.price!, 'maker', this.at(trade.time, trade.price));
        this.emit(events, 'aggtrade_replay', floorMinute(trade.time));
        this.armPlacedLegs(events, trade.time);
        if (events.some((e) => e.type === 'fill')) this.liquidationStep(start);
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
      this.armPlacedLegs(events, time);
    }
  }

  // ---- events and the summary ----

  /** Tag and keep the events; their summary lines follow, those of `lead` events first. */
  private emit(events: PerpEvent[], basis: CatchUpBasis, minute: number, lead?: PerpEvent['type']): void {
    const { from, to } = this.input;
    const first: string[] = [];
    const rest: string[] = [];
    for (const e of events) {
      this.out.push({ ...e, catchUp: { from, to, basis } });
      this.clock = Math.max(this.clock, e.time);
      const action = this.describe(e, basis, minute);
      if (action !== null) (e.type === lead ? first : rest).push(action);
    }
    this.actions.push(...first, ...rest);
  }

  /** One line of the summary for an event, or null for events another line already covers. */
  private describe(e: PerpEvent, basis: CatchUpBasis, minute: number): string | null {
    const base = this.base;
    switch (e.type) {
      case 'fill': {
        const what = `${label(e.order)} filled ${e.fill.qty} ${base} at ${e.fill.price}`;
        if (basis === 'aggtrade_replay') return `${what} (replayed trade at ${hhmmss(e.time)}; estimated)`;
        const of = basis === 'trigger_minute_worst_price' ? `${hhmm(minute)}, its trigger minute` : hhmm(minute);
        const uncapped = e.fill.uncappedPrice;
        if (e.fill.bankruptcyCapped && uncapped && !uncapped.eq(e.fill.price)) {
          return `${what}, the bankruptcy price (worst price of ${of} was ${uncapped}; estimated)`;
        }
        if (e.fill.bankruptcyCapped) {
          return `${what} (worst price of ${of}; fee cut to the ${e.fill.fee} USDT the margin had left; estimated)`;
        }
        return `${what} (worst price of ${of}; estimated)`;
      }
      case 'funding': {
        const settled = `settled rate ${e.rate}, mark ${e.markPrice}`;
        const on = `on ${e.qty} ${base} ${e.side} at ${hhmm(e.fundingTime)} (${settled})`;
        const unpaid = e.uncollected ? `; ${e.uncollected} USDT could not be collected` : '';
        return e.amount.isNegative()
          ? `Funding paid ${e.amount.neg()} USDT ${on}${unpaid}`
          : `Funding received ${e.amount} USDT ${on}`;
      }
      case 'liquidation': {
        const p = e.position;
        const who = `${p.side === 'long' ? 'Long' : 'Short'} ${p.qty} ${base}`;
        const when = `its liquidation price, when the mark reached it at ${hhmm(minute)}`;
        return `${who} liquidated at ${e.markPrice}, ${when}; margin lost ${e.marginLost} USDT (estimated)`;
      }
      case 'order_rejected':
        if (e.afterTrigger) return `${label(e.order)} expired at ${hhmm(minute)} (estimated): ${e.reason}`;
        // Attached legs are rejected together: one line for both.
        if (e.order.parentId !== null && e.order.type === 'take_profit' && this.attachOf(e.order)?.stopLoss) {
          return null;
        }
        return `${label(e.order)} rejected at ${hhmmss(e.time)} (estimated): ${e.reason}`;
      case 'order_cancelled': {
        if (e.reason === 'catch_up_unavailable') return null;
        const what = e.order.closePosition ? label(e.order) : `${label(e.order)} ${e.cancelledQty} ${base}`;
        if (e.reason === 'oco') return `${what} cancelled: the other order of its pair triggered (estimated)`;
        if (e.reason === 'user') return `Cancel of ${lower(what)} took effect at ${hhmmss(e.time)} (estimated)`;
        return `${what} cancelled at ${hhmmss(e.time)} (${e.reason}; estimated)`;
      }
      case 'cancel_rejected': {
        const order = lower(label(e.order));
        return `Cancel of ${order} arrived at ${hhmmss(e.time)}: order already ${e.order.status} (estimated)`;
      }
      case 'order_placed': {
        const attach = this.attachOf(e.order);
        if (!attach) return null;
        // One line for the legs placed together, on the first of them.
        if (e.order.type === 'take_profit' && attach.stopLoss) return null;
        const legs = [
          attach.stopLoss ? `stop-loss ${attach.stopLoss}` : null,
          attach.takeProfit ? `take-profit ${attach.takeProfit}` : null,
        ].filter((l) => l !== null);
        return `Attached ${legs.join(' / ')} placed at ${hhmmss(e.time)} (estimated)`;
      }
      default:
        return null;
    }
  }

  /** The stop-loss and take-profit of the opening order that placed `o`, or null if none did. */
  private attachOf(o: PerpOrder): PerpOrder['attach'] {
    return o.parentId === null ? null : (this.s.orders.get(o.parentId)?.attach ?? null);
  }
}

/** How an order reads at the start of a summary line: "Stop-loss", "Take-profit", "Limit buy". */
function label(o: PerpOrder): string {
  switch (o.type) {
    case 'stop_loss':
      return 'Stop-loss';
    case 'take_profit':
      return 'Take-profit';
    case 'limit':
      return `Limit ${o.side}`;
    case 'post_only':
      return `Post-only ${o.side}`;
    case 'market':
      return `Market ${o.side}`;
  }
}
