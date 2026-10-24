import { randomUUID } from 'node:crypto';
import {
  ctxFor,
  FUNDING_WINDOW_MS,
  liquidationPrice,
  ORDER_NOT_OPEN,
  RESTART_REASON,
  arrivalDelay,
  putOrder,
  putPerpOrder,
  valueAccount,
} from '@sim/engine';
import type {
  AccountValue,
  ActionResult,
  AggTrade,
  Bracket,
  Decimal,
  EngineEvent,
  FeeSchedule,
  Ledger,
  Market,
  MarginWarning,
  MarketView,
  OcoRequest,
  OrderPreview,
  PerpActionResult,
  PerpEvent,
  PerpMarketView,
  PerpOrder,
  PerpOrderRequest,
  PerpPreview,
  PerpRules,
  PriceLevel,
  Side,
  SimCtx,
  SimEngine,
  SimEvent,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
  SpotState,
  Wallet,
} from '@sim/engine';
import type { Db } from './db/db.ts';
import {
  checkInvariants,
  insertEquitySnapshot,
  lastAlive,
  persist,
  settleLateCancels,
  storedOrderExists,
  toJson,
  touchAlive,
} from './db/store.ts';
import type { FeedGap } from './db/store.ts';
import { FeedGaps, OFFLINE_REASON } from './feedGaps.ts';
import type { FundingRef, FundingSim } from './funding/fundingService.ts';
import type { Logger } from './log.ts';
import { marketKey, splitKey } from './market/marketKey.ts';
import type { MarketKey } from './market/marketKey.ts';
import type { SetTimer } from './market/ws.ts';
import { marginWarningNotice, noticesFor } from './notices.ts';
import type { Notice, NoticeLookup } from './notices.ts';

export { OFFLINE_REASON, RESTART_REASON, noticesFor };
export type { Notice };
export const INTEGRITY_REFUSAL = 'Account state failed integrity check; see server log';
export const PAUSED_REASON = 'Server paused (sleep or freeze)';
const STOPPED_REFUSAL = 'Server stopped after an internal error; see server log';

const HEALTH_POLL_MS = 1000;
/** A health poll this long after the previous one means the process was paused (sleep, freeze) in between. */
const STALL_MS = 5000;
const ALIVE_MS = 10_000;
const EQUITY_MS = 60_000;
/**
 * The trade cursor of calls that change nothing else is saved at most this often (and on stop()).
 * A call with events, changed orders or a gap saves it in its own transaction.
 */
export const CURSOR_FLUSH_MS = 5000;

/** An action the runner will not perform in its current state (integrity failure, stopped after an error). */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedError';
  }
}

export type HealthMap = Record<string, { fresh: boolean; reason: string | null }>;

/** Account value plus the raw wallet balances and each held coin's average-cost basis. */
export interface AccountSnapshot extends AccountValue {
  balances: Ledger['balances'];
  /** Per coin with a holding: quantity and USDT cost (fees included), for average cost and unrealised P&L. */
  basis: Record<string, { qty: Decimal; cost: Decimal }>;
}

export type RunnerMessage =
  | { type: 'account'; account: AccountSnapshot }
  | { type: 'orders'; orders: SpotOrder[]; perpOrders: PerpOrder[] }
  | ({ type: 'notice' } & Notice)
  | { type: 'health'; health: HealthMap };

/** What the runner reads from MarketData beyond the engine's MarketView. */
export interface RunnerMarket extends MarketView {
  /** While stale: the last real bid received, with `at` saying when; null only before any bid. */
  bestBid(symbol: string): { price: Decimal; fresh: boolean; at?: number } | null;
  /** A saved taker fill of a `side` order took `levels`: later walks see them reduced. */
  consume(symbol: string, side: Side, levels: PriceLevel[]): void;
  healthSnapshot(): HealthMap;
  on(event: 'trade', cb: (symbol: string, trade: AggTrade) => void): unknown;
  off(event: 'trade', cb: (symbol: string, trade: AggTrade) => void): unknown;
}

/** A mark price update as the perp feed delivers it (the runner reads the price only). */
export interface RunnerMark {
  markPrice: Decimal;
}

/** What the runner reads from PerpMarketData beyond the perp engine's PerpMarketView. */
export interface RunnerPerpMarket extends PerpMarketView {
  /** When the last mark update was received (local clock); null before the first. */
  markReceivedAt(symbol: string): number | null;
  /** A saved taker fill of a `side` order took `levels`: later walks see them reduced. */
  consume(symbol: string, side: Side, levels: PriceLevel[]): void;
  healthSnapshot(): HealthMap;
  /** 'trade' (symbol, AggTrade): a futures trade; 'mark' (symbol, RunnerMark): a mark price update. */
  on(event: 'trade' | 'mark', cb: (...args: any[]) => void): unknown;
  off(event: 'trade' | 'mark', cb: (...args: any[]) => void): unknown;
}

/**
 * A market's feed health (or a stand-in): when the last frame of its live data connection was
 * received (the older one, for a market on two connections), and the notice that the process was
 * paused, so every book (and mark) waits for current data.
 */
export interface HealthSource {
  lastFrameAt(): number;
  markStalled(now: number): void;
}

export interface RunnerDeps {
  db: Db;
  seasonId: number;
  sim: SimEngine;
  spotMarket: RunnerMarket;
  perpMarket: RunnerPerpMarket;
  /** Per market: FeedHealth for spot; for perps, PerpMarketData itself (it reports to both its connections). */
  health: Record<Market, HealthSource>;
  /** Every symbol, traded both spot and as a perpetual. */
  symbols: string[];
  fees: { spot: FeeSchedule; perp: FeeSchedule };
  now: () => number;
  rng: () => number;
  /** Default: `${prefix}-${randomUUID()}`, unique across restarts and seasons. */
  newId?: (prefix: string) => string;
  setTimer: SetTimer;
  onBroadcast: (msg: RunnerMessage) => void;
  /** Called once when the runner stops after a persist (or other internal) failure; main exits non-zero. */
  onFatal: (err: unknown) => void;
  logger: Logger;
}

/** A live order of either market: the fields the runner reads are common to both. */
type LiveOrder = SpotOrder | PerpOrder;

const LIVE = new Set(['pending', 'open', 'partially_filled', 'triggered']);

const spotKey = (symbol: string): MarketKey => marketKey('spot', symbol);
const perpKey = (symbol: string): MarketKey => marketKey('perp', symbol);

function eventMarket(e: SimEvent): Market {
  return 'market' in e && e.market === 'perp' ? 'perp' : 'spot';
}

/**
 * Drives the SimEngine over spot and perpetuals: feeds each market's live trades to that market's
 * engine only, in receive order, and each mark price to the perp engine; runs arrivals and cancels
 * at their arrival time; records every interruption of live data as a feed gap, per market and
 * symbol; and after every engine call persists the whole change in one transaction before
 * anything is broadcast. Everything runs on the one Node thread with no awaits between an engine
 * call and its persist.
 */
export class EngineRunner implements FundingSim {
  private readonly d: RunnerDeps;
  private readonly newId: (prefix: string) => string;
  private readonly timers = new Set<() => void>();
  /** The market and symbol of every feed the runner watches: each symbol spot and perp. */
  private readonly keys: MarketKey[];
  /**
   * Per market and symbol, the open gap (since when, and why, the data is not live) and the last
   * fresh moment. Each gap is saved in open_gaps as it opens, and seeded at startup from that
   * table and last_alive.
   */
  private readonly gaps: FeedGaps;
  /** The last health poll, or the moment a pause was handled. */
  private lastPollAt: number | null = null;
  /** Per market and symbol, the pending orders re-sent after a restart: they wait for its first fresh data. */
  private readonly awaitingFresh = new Map<MarketKey, Set<string>>();
  /** Integrity violations of the loaded state; when set, nothing trades. */
  private readonly violations: string[];
  private dead = false;
  private started = false;
  private lastStateKey = '';
  /** When the trade cursor was last saved. */
  private cursorSavedAt: number;
  private readonly spotTradeListener = (symbol: string, trade: AggTrade) =>
    this.background(() => this.onTrade('spot', symbol, trade));
  private readonly perpTradeListener = (symbol: string, trade: AggTrade) =>
    this.background(() => this.onTrade('perp', symbol, trade));
  private readonly markListener = (symbol: string, mark: RunnerMark) => this.background(() => this.onMark(symbol, mark));

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.newId = deps.newId ?? ((prefix) => `${prefix}-${randomUUID()}`);
    this.cursorSavedAt = deps.now();
    this.keys = [...deps.symbols.map(spotKey), ...deps.symbols.map(perpKey)];
    this.gaps = new FeedGaps({
      db: deps.db,
      seasonId: deps.seasonId,
      now: deps.now,
      lastFrameAt: (key) => deps.health[splitKey(key).market].lastFrameAt(),
      cursorOf: (key) => this.cursorOf(key),
    });

    this.violations = checkInvariants(deps.sim);
    for (const v of this.violations) deps.logger.error(`Account state failed integrity check: ${v}`);
    this.seedGaps();
    this.settleLateCancels();
    if (this.violations.length === 0 && !this.dead) this.recover();
  }

  // ---- lifecycle ----

  /**
   * Subscribes to both markets' trades and the mark prices, and starts the health poll (1 s),
   * heartbeat (10 s) and equity snapshots (60 s).
   */
  start(): void {
    if (this.started || this.dead) return;
    this.started = true;
    if (this.violations.length === 0) {
      this.d.spotMarket.on('trade', this.spotTradeListener);
      this.d.perpMarket.on('trade', this.perpTradeListener);
      this.d.perpMarket.on('mark', this.markListener);
    }
    this.background(() => touchAlive(this.d.db, this.d.now()));
    this.background(() => this.pollHealth());
    this.every(ALIVE_MS, () => touchAlive(this.d.db, this.d.now()));
    this.every(HEALTH_POLL_MS, () => this.pollHealth());
    this.every(EQUITY_MS, () => this.snapshotEquity());
  }

  /**
   * Stops trades, marks, timers and pending arrival timers, and records every gap still open as a
   * feed_gap ending now, with the trade cursors (after a fatal error nothing more is written).
   */
  stop(): void {
    this.started = false;
    this.d.spotMarket.off('trade', this.spotTradeListener);
    this.d.perpMarket.off('trade', this.perpTradeListener);
    this.d.perpMarket.off('mark', this.markListener);
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.saveOnStop();
  }

  // ---- actions (each persisted before it returns) ----

  deposit(wallet: Wallet, amount: Decimal): ActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.deposit(wallet, amount, ctx));
  }

  transfer(from: Wallet, to: Wallet, amount: Decimal): ActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.transfer(from, to, amount, ctx));
  }

  submit(req: SpotOrderRequest): EngineEvent[] {
    this.refuseTrading();
    this.noteStale(spotKey(req.symbol));
    return this.apply((ctx) => this.d.sim.submit('spot', req, ctx));
  }

  submitPerp(req: PerpOrderRequest): PerpEvent[] {
    this.refuseTrading();
    this.noteStale(perpKey(req.symbol));
    return this.apply((ctx) => this.d.sim.submit('perp', req, ctx));
  }

  /**
   * Requests the cancel of a spot or perp order: ok means it is on its way; arriveCancel runs at
   * the order's cancelArrivesAt. A finished order is no longer in memory; its saved row tells it
   * apart from an unknown id.
   */
  cancel(orderId: string): ActionResult {
    this.refuseTrading();
    const market = this.marketOfOrder(orderId);
    if (market === null) {
      if (storedOrderExists(this.d.db, this.d.seasonId, orderId)) return { ok: false, reason: ORDER_NOT_OPEN };
      return this.apply((ctx) => this.d.sim.cancel('spot', orderId, ctx)); // answered as not found
    }
    const result = this.apply((ctx) => this.d.sim.cancel(market, orderId, ctx));
    const at = this.ordersOf(market).get(orderId)?.cancelArrivesAt ?? null;
    if (result.ok && at !== null) this.scheduleCancel(market, orderId, at);
    return result;
  }

  attachOco(req: OcoRequest): EngineEvent[] {
    this.refuseTrading();
    this.noteStale(spotKey(req.symbol));
    return this.apply((ctx) => this.d.sim.spot.attachOco(req, ctxFor(ctx, 'spot')));
  }

  /** Read-only estimate; nothing is persisted. */
  preview(req: SpotOrderRequest): OrderPreview {
    this.refuseIfDead();
    return this.d.sim.preview('spot', req, this.ctx());
  }

  /** Read-only estimate; nothing is persisted. */
  previewPerp(req: PerpOrderRequest): PerpPreview {
    this.refuseIfDead();
    return this.d.sim.preview('perp', req, this.ctx());
  }

  setLeverage(symbol: string, leverage: number): PerpActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.setLeverage(symbol, leverage, ctx));
  }

  setMarginMode(symbol: string, mode: 'isolated' | 'cross'): PerpActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.setMarginMode(symbol, mode, ctx));
  }

  addMargin(symbol: string, amount: string): PerpActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.addMargin(symbol, amount, ctx));
  }

  removeMargin(symbol: string, amount: string): PerpActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.removeMargin(symbol, amount, ctx));
  }

  setPositionTpSl(symbol: string, input: { stopLoss?: string; takeProfit?: string }): PerpEvent[] {
    this.refuseTrading();
    this.noteStale(perpKey(symbol));
    return this.apply((ctx) => this.d.sim.setPositionTpSl(symbol, input, ctx));
  }

  // ---- funding (FundingService), each persisted like any engine call ----

  fundingWindows(): { open: FundingRef[]; pending: FundingRef[] } {
    const f = this.d.sim.perp.state.funding;
    const ref = (w: { symbol: string; fundingTime: number }): FundingRef => ({ symbol: w.symbol, fundingTime: w.fundingTime });
    return { open: Object.values(f.windows).map(ref), pending: f.pending.map(ref) };
  }

  openFundingWindow(symbol: string, fundingTime: number): void {
    this.refuseTrading();
    this.apply((ctx) => {
      this.d.sim.openFundingWindow(symbol, fundingTime, ctx);
      return [];
    });
  }

  closeFundingWindow(symbol: string, fundingTime: number): void {
    this.refuseTrading();
    this.apply((ctx) => {
      this.d.sim.closeFundingWindow(symbol, fundingTime, ctx);
      return [];
    });
  }

  /** The funding Binance settled at `fundingTime`, at its settled rate and mark price. Applied once per time. */
  applyFunding(symbol: string, fundingTime: number, rate: Decimal, markPrice: Decimal): PerpEvent[] {
    this.refuseTrading();
    return this.apply((ctx) => this.d.sim.applyFunding(symbol, fundingTime, rate, markPrice, ctx));
  }

  // ---- reads ----

  account(): AccountSnapshot {
    const state = this.d.sim.spot.state;
    const basis: AccountSnapshot['basis'] = {};
    for (const [asset, b] of Object.entries(state.basis)) {
      if (b.qty.gt(0)) basis[asset] = { qty: b.qty, cost: b.cost };
    }
    return {
      ...this.value(),
      balances: state.ledger.balances,
      basis,
    };
  }

  /** The account value: coins at the spot best bids, positions at the mark (a stale one flagged). */
  private value(): AccountValue {
    const perp = this.d.perpMarket;
    const mark = (symbol: string) => {
      const price = perp.markPrice(symbol);
      if (price === null) return null;
      return { price, fresh: perp.isMarkFresh(symbol), at: perp.markReceivedAt(symbol) ?? undefined };
    };
    return valueAccount(this.d.sim, (s) => this.d.spotMarket.bestBid(s), { mark }, this.d.symbols);
  }

  /** Live (non-terminal) spot orders, newest first. */
  openOrders(): SpotOrder[] {
    return [...this.d.sim.spot.state.orders.values()]
      .filter((o) => LIVE.has(o.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Live (non-terminal) perp orders, newest first. */
  openPerpOrders(): PerpOrder[] {
    return [...this.d.sim.perp.state.orders.values()]
      .filter((o) => LIVE.has(o.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get state(): SpotState {
    return this.d.sim.spot.state;
  }

  // ---- internals ----

  private ctx(): SimCtx {
    return {
      now: this.d.now(),
      rng: this.d.rng,
      newId: this.newId,
      spotMarket: this.d.spotMarket,
      perpMarket: this.d.perpMarket,
      fees: this.d.fees,
    };
  }

  private refuseIfDead(): void {
    if (this.dead) throw new RefusedError(STOPPED_REFUSAL);
  }

  private refuseTrading(): void {
    this.refuseIfDead();
    if (this.violations.length > 0) throw new RefusedError(INTEGRITY_REFUSAL);
  }

  private marketOf(market: Market): RunnerMarket | RunnerPerpMarket {
    return market === 'spot' ? this.d.spotMarket : this.d.perpMarket;
  }

  private ordersOf(market: Market): Map<string, LiveOrder> {
    return market === 'spot' ? this.d.sim.spot.state.orders : this.d.sim.perp.state.orders;
  }

  /** The market whose engine holds the order in memory; null when neither does. */
  private marketOfOrder(orderId: string): Market | null {
    if (this.d.sim.spot.state.orders.has(orderId)) return 'spot';
    if (this.d.sim.perp.state.orders.has(orderId)) return 'perp';
    return null;
  }

  /**
   * One engine call, then persist + schedule arrivals + broadcast. An exception from the engine
   * or the database is fatal: memory may be ahead of the DB, so the runner stops for good.
   * `extra` notices (margin warnings) go out after the call's own.
   */
  private apply<T extends ActionResult | PerpActionResult | SimEvent[]>(
    call: (ctx: SimCtx) => T,
    gaps: FeedGap[] = [],
    extra: () => Notice[] = () => [],
  ): T {
    this.refuseIfDead();
    let result: T;
    try {
      const ctx = this.ctx();
      this.closeDueFundingWindows(ctx);
      result = call(ctx);
    } catch (e) {
      this.die('engine call failed', e);
      throw e;
    }
    this.commit(Array.isArray(result) ? result : result.ok ? result.events : [], gaps, extra);
    return result;
  }

  /**
   * Before every engine call: a funding window still open at or after fundingTime + 15 s is closed
   * first (its own close timer may have been held back by a sleep), so no change after the window
   * ever counts in it. Saved with the call.
   */
  private closeDueFundingWindows(ctx: SimCtx): void {
    for (const w of Object.values(this.d.sim.perp.state.funding.windows)) {
      if (ctx.now >= w.fundingTime + FUNDING_WINDOW_MS) this.d.sim.closeFundingWindow(w.symbol, w.fundingTime, ctx);
    }
  }

  private commit(events: SimEvent[], gaps: FeedGap[] = [], extra: () => Notice[] = () => []): void {
    const now = this.d.now();
    try {
      const cursor = now - this.cursorSavedAt >= CURSOR_FLUSH_MS;
      if (persist(this.d.db, this.d.seasonId, this.d.sim, events, { feedGaps: gaps, cursor, now })) this.cursorSavedAt = now;
    } catch (e) {
      this.die('persist failed', e);
      throw e;
    }
    for (const e of events) {
      const market = eventMarket(e);
      if (e.type === 'fill' && e.consumed) this.marketOf(market).consume(e.fill.symbol, e.fill.side, e.consumed);
      if ((e.type === 'order_placed' || e.type === 'order_triggered') && e.order.arrivesAt !== null) {
        this.scheduleArrival(market, e.order.id, e.order.arrivesAt);
      }
    }
    this.publishState(events.length > 0);
    for (const n of [...noticesFor(events, this.noticeLookup()), ...extra()]) this.notice(n);
  }

  /** Every gap still open as a feed_gap ending now, and the trade cursors, in one transaction. */
  private saveOnStop(): void {
    if (this.dead) return;
    const now = this.d.now();
    const gaps = this.gaps.takeAll(now);
    try {
      persist(this.d.db, this.d.seasonId, this.d.sim, [], { feedGaps: gaps, cursor: true, now });
      this.cursorSavedAt = now;
    } catch (e) {
      this.die('persist failed', e);
    }
  }

  private die(what: string, e: unknown): void {
    if (this.dead) return;
    this.dead = true;
    this.d.logger.error(`${what}; stopping the engine: ${e instanceof Error ? e.message : String(e)}`);
    this.stop();
    this.d.onFatal(e);
  }

  /** Runs timer and listener work: any failure there is fatal (logged once, then onFatal). */
  private background(fn: () => void): void {
    if (this.dead) return;
    try {
      fn();
    } catch (e) {
      this.die('background task failed', e);
    }
  }

  private timer(fn: () => void, ms: number): void {
    const cancel = this.d.setTimer(() => {
      this.timers.delete(cancel);
      fn();
    }, ms);
    this.timers.add(cancel);
  }

  private every(ms: number, fn: () => void): void {
    const loop = () => {
      this.timer(loop, ms);
      this.background(fn);
    };
    this.timer(loop, ms);
  }

  /** arrive() at arrivesAt; the engine ignores orders no longer waiting. */
  private scheduleArrival(market: Market, orderId: string, arrivesAt: number): void {
    this.scheduleAt(market, arrivesAt, orderId, (ctx) => this.d.sim.arrive(market, orderId, ctx));
  }

  /**
   * arriveCancel() at cancelArrivesAt; the engine ignores orders with no cancel in flight. An order
   * held back after a restart to be sent again never had its old arrival, so the cancel does not
   * wait for it.
   */
  private scheduleCancel(market: Market, orderId: string, cancelArrivesAt: number): void {
    this.scheduleAt(market, cancelArrivesAt, orderId, (ctx) =>
      this.heldBack(orderId)
        ? this.d.sim.arriveCancelBeforeResend(market, orderId, ctx)
        : this.d.sim.arriveCancel(market, orderId, ctx),
    );
  }

  /** Whether recover() holds the order back to send it again once its symbol is fresh. */
  private heldBack(orderId: string): boolean {
    for (const ids of this.awaitingFresh.values()) if (ids.has(orderId)) return true;
    return false;
  }

  /**
   * One engine call for an order of `market` at time `at` (re-armed if the timer fires early),
   * persisted like any other. A pause is handled first; then stale data on the order's market and
   * symbol, which the engine acts on (a deferred or rejected order), opens a gap before the call.
   */
  private scheduleAt(market: Market, at: number, orderId: string, call: (ctx: SimCtx) => SimEvent[]): void {
    const fire = () => {
      const left = at - this.d.now();
      if (left > 0) return this.timer(fire, left);
      this.background(() => {
        const symbol = this.ordersOf(market).get(orderId)?.symbol;
        if (symbol !== undefined) this.noteStale(marketKey(market, symbol));
        else this.checkStall(this.d.now());
        this.apply(call);
      });
    };
    this.timer(fire, Math.max(0, at - this.d.now()));
  }

  /** Account and orders after every engine call; skipped only when nothing changed and there were no events. */
  private publishState(changed: boolean): void {
    const orders = this.openOrders();
    const perpOrders = this.openPerpOrders();
    const perp = this.d.sim.perp.state;
    const ledger = this.d.sim.ledger;
    const key = toJson({ b: ledger.balances, d: ledger.totalDeposited, o: orders, po: perpOrders, p: perp.positions });
    if (!changed && key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.d.onBroadcast({ type: 'account', account: this.account() });
    this.d.onBroadcast({ type: 'orders', orders, perpOrders });
  }

  /**
   * Startup: a cancel still in flight on an order that finished before the server stopped is
   * answered as too late (cancel_rejected); such orders are not loaded, so recover() never sees them.
   */
  private settleLateCancels(): void {
    if (this.dead) return;
    try {
      settleLateCancels(this.d.db, this.d.seasonId, this.d.now());
    } catch (e) {
      this.die('persist failed', e);
    }
  }

  /**
   * Startup, for each market: first, a cancel in flight whose arrival time passed while the server
   * was down has reached the exchange, so arriveCancel is applied now (one still to arrive, or one
   * waiting for the exchange rules, gets its arriveCancel scheduled; onFresh delivers the latter).
   * Then pending market orders are rejected (rejectRestartedMarket); other pending orders are sent
   * again once their market and symbol's data is first fresh, with a fresh arrival delay
   * (rearmWhenFresh). Triggered orders with an arrival time get their arrive() scheduled;
   * triggered orders and attached pairs waiting for data (arrivesAt null) are left to onFresh.
   */
  private recover(): void {
    const ctx = this.ctx();
    this.closeDueFundingWindows(ctx);
    const events: SimEvent[] = [];
    for (const market of ['spot', 'perp'] as const) {
      const orders = this.ordersOf(market);
      for (const { id } of [...orders.values()]) {
        // Re-read: cancelling one leg of a pair settles its partner too. A pending order is sent
        // again below, so its old arrival never happened and does not come before the cancel.
        if (orders.get(id)!.cancelArrivesAt !== null) events.push(...this.d.sim.arriveCancelBeforeResend(market, id, ctx));
      }
      for (const o of [...orders.values()]) {
        if (o.status !== 'pending') continue;
        if (o.type === 'market') {
          events.push(
            ...(market === 'spot'
              ? this.d.sim.spot.rejectRestartedMarket(o.id, ctxFor(ctx, 'spot'))
              : this.d.sim.perp.rejectRestartedMarket(o.id, ctxFor(ctx, 'perp'))),
          );
        } else if (o.arrivesAt !== null) {
          const key = marketKey(market, o.symbol);
          const ids = this.awaitingFresh.get(key) ?? new Set<string>();
          ids.add(o.id);
          this.awaitingFresh.set(key, ids);
        }
      }
    }
    try {
      this.commit(events);
    } catch {
      return; // fatal, already reported
    }
    for (const market of ['spot', 'perp'] as const) {
      for (const o of this.ordersOf(market).values()) {
        if (o.status === 'triggered' && o.arrivesAt !== null) this.scheduleArrival(market, o.id, o.arrivesAt);
        if (o.cancelArrivesAt !== null) this.scheduleCancel(market, o.id, o.cancelArrivesAt);
      }
    }
  }

  /**
   * Re-sends the pending orders recover() held back, for each market and symbol whose data is now
   * fresh: a fresh arrival delay from now (a pair's legs share one), persisted, then arrive()
   * scheduled. Until then they keep their old arrival time and nothing arrives them. A cancel of
   * such an order that is already due (one that waited for the exchange rules) is delivered first.
   */
  private rearmWhenFresh(): void {
    if (this.awaitingFresh.size === 0) return;
    const ctx = this.ctx();
    const delays = new Map<string, number>();
    const armed: { market: Market; id: string; at: number }[] = [];
    const events: SimEvent[] = [];
    for (const [key, ids] of this.awaitingFresh) {
      if (!this.isFresh(key)) continue;
      this.awaitingFresh.delete(key);
      const { market } = splitKey(key);
      const orders = this.ordersOf(market);
      for (const id of ids) {
        if (orders.get(id)?.cancelArrivesAt != null) events.push(...this.d.sim.arriveCancelBeforeResend(market, id, ctx));
        const o = orders.get(id);
        if (!o || o.status !== 'pending') continue; // cancelled meanwhile
        const group = o.ocoGroupId ?? o.id;
        const at = delays.get(group) ?? ctx.now + arrivalDelay(ctx);
        delays.set(group, at);
        if (market === 'spot') putOrder(this.d.sim.spot.state, { ...(o as SpotOrder), arrivesAt: at });
        else putPerpOrder(this.d.sim.perp.state, { ...(o as PerpOrder), arrivesAt: at });
        armed.push({ market, id, at });
      }
    }
    if (armed.length === 0 && events.length === 0) return;
    this.commit(events);
    for (const { market, id, at } of armed) this.scheduleArrival(market, id, at);
  }

  // ---- feed gaps ----

  /**
   * Startup: each watched market and symbol has a gap open from the earlier of its saved open gap
   * (left by a crash) and the last heartbeat (the server may have been down since then), saved
   * before the first heartbeat (FeedGaps.seed).
   */
  private seedGaps(): void {
    try {
      this.gaps.seed(this.keys, lastAlive(this.d.db));
    } catch (e) {
      this.die('persist failed', e);
    }
  }

  /** The trade cursor of the engine of the key's market, for its symbol. */
  private cursorOf(key: MarketKey): number | null {
    const { market, symbol } = splitKey(key);
    const cursors = market === 'spot' ? this.d.sim.spot.state.lastTradeId : this.d.sim.perp.state.lastTradeId;
    return cursors[symbol] ?? null;
  }

  /**
   * A key's freshness is its market's (rules, halts and feed health together; for perps also the
   * mark and the leverage tiers, so a stale mark is a gap only as part of that whole).
   */
  private isFresh(key: MarketKey): boolean {
    const { market, symbol } = splitKey(key);
    return this.marketOf(market).isFresh(symbol);
  }

  /**
   * Every second, for every market and symbol. Stale data opens a gap. Fresh data closes the open
   * gap, recorded as a feed_gap in the same transaction as onFresh; with no gap open, onFresh still
   * runs when the market's engine has deferred work for the symbol, so work deferred during a
   * stale stretch that no poll saw does not wait for a trade. A poll that finds the process was
   * paused (checkStall) does only that. Last, the orders held back since startup whose data is now
   * fresh are re-sent.
   */
  private pollHealth(): void {
    const now = this.d.now();
    const paused = this.checkStall(now);
    this.lastPollAt = now;
    let changed = false;
    for (const key of paused ? [] : this.keys) {
      if (!this.isFresh(key)) changed = this.startGap(key, this.staleReason(key)) || changed;
      else changed = this.freshAtPoll(key, now) || changed;
    }
    if (changed) this.broadcastHealth();
    this.rearmWhenFresh();
  }

  /**
   * More than STALL_MS since the last poll means the process was paused (sleep, event-loop
   * freeze). Every poll, timer-driven engine call, trade and mark checks this first, and whichever
   * runs first after the pause handles it, once: every feed health of both markets is told, so
   * every book and mark waits for current data and nothing executes or liquidates on data from
   * before the pause; and every key is treated as stale from the last poll, even if its data looks
   * fresh (a gap opens there, or the open gap is kept; either closes only at a poll that finds the
   * data fresh). Returns whether there was a pause.
   */
  private checkStall(now: number): boolean {
    const since = this.lastPollAt;
    if (!this.started || since === null || now - since <= STALL_MS) return false;
    this.lastPollAt = now;
    this.d.health.spot.markStalled(now);
    this.d.health.perp.markStalled(now);
    for (const key of this.keys) {
      if (!this.gaps.markPollOnly(key)) this.startGap(key, PAUSED_REASON, since);
    }
    this.broadcastHealth();
    return true;
  }

  /**
   * Before an engine call on a key that is not a poll or a trade (an arrival, a cancel, an order
   * from the owner): a pause is handled first; then stale data, which the engine acts on (a
   * deferred or rejected order), opens a gap, so a stale stretch no poll or trade saw is still recorded.
   */
  private noteStale(key: MarketKey): void {
    this.checkStall(this.d.now());
    if (!this.isFresh(key) && this.startGap(key, this.staleReason(key))) this.broadcastHealth();
  }

  /** A health poll found the key's data fresh. Returns whether its gap closed. */
  private freshAtPoll(key: MarketKey, now: number): boolean {
    const { market, symbol } = splitKey(key);
    this.gaps.markFresh(key, now);
    const gaps = this.gaps.take(key, now);
    if (this.violations.length > 0) {
      if (gaps.length > 0) this.commit([], gaps);
    } else if (gaps.length > 0 || this.d.sim.hasDeferredWork(market, symbol, this.ctx())) {
      this.apply((ctx) => this.d.sim.onFresh(market, symbol, ctx), gaps);
    }
    if (gaps.length > 0) this.notice({ kind: 'feed_restored', level: 'info', text: `Live data restored for ${label(key)}` });
    return gaps.length > 0;
  }

  /**
   * A live trade of `market`, sent to that market's engine only. On stale data the engine skips
   * it, so the interruption is saved first: a gap opens now, from the last fresh moment. On fresh
   * data the open gap (unless it is a pause, which a poll closes) is recorded as a feed_gap in the
   * same transaction as the trade's own changes, so the trade cursor never moves past a skipped
   * trade before its gap is recorded.
   */
  private onTrade(market: Market, symbol: string, trade: AggTrade): void {
    const now = this.d.now();
    const key = marketKey(market, symbol);
    this.checkStall(now);
    const fresh = this.isFresh(key);
    const opened = !fresh && this.startGap(key, this.staleReason(key));
    const gaps = fresh && !this.gaps.isPollOnly(key) ? this.gaps.take(key, now) : [];
    this.apply((ctx) => this.d.sim.onTrade(market, symbol, trade, ctx), gaps);
    if (fresh) this.gaps.markFresh(key, now);
    if (gaps.length > 0) this.notice({ kind: 'feed_restored', level: 'info', text: `Live data restored for ${label(key)}` });
    if (opened || gaps.length > 0) this.broadcastHealth();
  }

  /**
   * A mark price update: the perp engine liquidates on it or warns of the margin ratio (it acts
   * only on a fresh mark). A pause is handled first, so a mark from before it is never used. The
   * mark alone neither opens nor closes a gap: the poll follows the market's freshness.
   */
  private onMark(symbol: string, mark: RunnerMark): void {
    this.checkStall(this.d.now());
    let warnings: MarginWarning[] = [];
    this.apply(
      (ctx) => {
        const r = this.d.sim.onMark(symbol, mark.markPrice, ctx);
        warnings = r.warnings;
        return r.events;
      },
      [],
      () => warnings.map((w) => marginWarningNotice(w, this.perpRulesOf(w.symbol))),
    );
  }

  /**
   * Opens the key's gap (FeedGaps.start: from its last fresh moment, saved at once with the trade
   * cursor) and tells the owner. Returns whether it opened.
   */
  private startGap(key: MarketKey, reason: string, pausedSince: number | null = null): boolean {
    if (!this.gaps.start(key, reason, pausedSince)) return false;
    this.notice({ kind: 'feed_gap', level: 'warn', text: `Live data interrupted for ${label(key)}: ${reason}` });
    return true;
  }

  private staleReason(key: MarketKey): string {
    const { market, symbol } = splitKey(key);
    return this.marketOf(market).healthSnapshot()[symbol]?.reason ?? 'Data stale';
  }

  /** The spot health map, as the clients read it (perp health joins it with the perp API). */
  private broadcastHealth(): void {
    this.d.onBroadcast({ type: 'health', health: this.d.spotMarket.healthSnapshot() });
  }

  /**
   * Every minute while data is fresh; skipped when any held coin's price or position's mark is stale
   * or missing, and when it is the first to run after a pause (the books are from before it).
   */
  private snapshotEquity(): void {
    if (this.checkStall(this.d.now())) return;
    const value = this.value();
    if (value.coins.some((c) => !c.fresh) || value.leverage.positions.some((p) => !p.markFresh)) return;
    insertEquitySnapshot(this.d.db, this.d.seasonId, value, this.d.now());
  }

  private notice(n: Notice): void {
    this.d.onBroadcast({ type: 'notice', ...n });
  }

  private noticeLookup(): NoticeLookup {
    return {
      spotRules: (s) => this.spotRulesOf(s),
      perpRules: (s) => this.perpRulesOf(s),
      liquidationPrice: (s) => {
        const p = this.d.sim.perp.state.positions[s];
        const brackets = this.bracketsOf(s);
        return p && brackets ? liquidationPrice(brackets, p.side, p.qty, p.entryPrice, p.margin) : null;
      },
    };
  }

  private spotRulesOf(symbol: string): SpotRules | null {
    try {
      return this.d.spotMarket.rules(symbol);
    } catch {
      return null;
    }
  }

  private perpRulesOf(symbol: string): PerpRules | null {
    try {
      return this.d.perpMarket.rules(symbol);
    } catch {
      return null;
    }
  }

  private bracketsOf(symbol: string): Bracket[] | null {
    try {
      return this.d.perpMarket.brackets(symbol);
    } catch {
      return null;
    }
  }
}

/** How a key is named to the owner: the symbol for spot, `BTCUSDT perp` for a perpetual. */
function label(key: MarketKey): string {
  const { market, symbol } = splitKey(key);
  return market === 'spot' ? symbol : `${symbol} perp`;
}

/** The order a submit created (its first event names it: placed or rejected). */
export function submittedOrder(events: EngineEvent[]): SpotOrder {
  const first = events.find((e) => 'order' in e) as { order: SpotOrder } | undefined;
  if (!first) throw new Error('submit produced no order');
  return first.order;
}
