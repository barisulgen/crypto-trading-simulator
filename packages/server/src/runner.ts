import { randomUUID } from 'node:crypto';
import { Decimal, RESTART_REASON, arrivalDelay, valueAccount } from '@sim/engine';
import type {
  AccountValue,
  ActionResult,
  AggTrade,
  EngineCtx,
  EngineEvent,
  FeeSchedule,
  Fill,
  MarketView,
  OcoRequest,
  OrderPreview,
  SpotEngine,
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
  loadOpenGaps,
  openGap,
  persist,
  toJson,
  touchAlive,
} from './db/store.ts';
import type { FeedGap } from './db/store.ts';
import type { Logger } from './log.ts';
import type { SetTimer } from './market/ws.ts';

export { RESTART_REASON };
export const INTEGRITY_REFUSAL = 'Account state failed integrity check; see server log';
export const OFFLINE_REASON = 'Server offline';
export const PAUSED_REASON = 'Server paused (sleep or freeze)';
const STOPPED_REFUSAL = 'Server stopped after an internal error; see server log';

const HEALTH_POLL_MS = 1000;
/** A health poll this long after the previous one means the process was paused (sleep, freeze) in between. */
const STALL_MS = 5000;
const ALIVE_MS = 10_000;
const EQUITY_MS = 60_000;

/** An action the runner will not perform in its current state (integrity failure, stopped after an error). */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedError';
  }
}

export type HealthMap = Record<string, { fresh: boolean; reason: string | null }>;

export interface Notice {
  kind: 'fill' | 'partial_fill' | 'rejected' | 'cancel_rejected' | 'triggered' | 'thin_book' | 'feed_gap' | 'feed_restored';
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Account value plus the raw wallet balances and each held coin's average-cost basis. */
export interface AccountSnapshot extends AccountValue {
  balances: SpotState['balances'];
  /** Per coin with a holding: quantity and USDT cost (fees included), for average cost and unrealised P&L. */
  basis: Record<string, { qty: Decimal; cost: Decimal }>;
}

export type RunnerMessage =
  | { type: 'account'; account: AccountSnapshot }
  | { type: 'orders'; orders: SpotOrder[] }
  | ({ type: 'notice' } & Notice)
  | { type: 'health'; health: HealthMap };

/** What the runner reads from MarketData beyond the engine's MarketView. */
export interface RunnerMarket extends MarketView {
  /** While stale: the last real bid received, with `at` saying when; null only before any bid. */
  bestBid(symbol: string): { price: Decimal; fresh: boolean; at?: number } | null;
  healthSnapshot(): HealthMap;
  on(event: 'trade', cb: (symbol: string, trade: AggTrade) => void): unknown;
  off(event: 'trade', cb: (symbol: string, trade: AggTrade) => void): unknown;
}

export interface RunnerDeps {
  db: Db;
  seasonId: number;
  engine: SpotEngine;
  market: RunnerMarket;
  /** FeedHealth (or a stand-in): when the last frame of the live data connection was received. */
  health: { lastFrameAt(): number };
  symbols: string[];
  fees: FeeSchedule;
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

/** A gap in the live data that has not been recorded as a feed_gap yet. */
interface Gap {
  at: number;
  reason: string;
  /** Closed only by a health poll that finds the data fresh, never by a trade. */
  pollOnly: boolean;
}

/**
 * Drives the pure SpotEngine: feeds it live trades in receive order, runs arrivals at their
 * arrival time, records every interruption of live data as a feed gap, and after every engine
 * call persists the whole change in one transaction before anything is broadcast. Everything
 * runs on the one Node thread with no awaits between an engine call and its persist.
 */
export class EngineRunner {
  private readonly d: RunnerDeps;
  private readonly newId: (prefix: string) => string;
  private readonly timers = new Set<() => void>();
  /**
   * Per symbol, the open gap: since when (and why) the data is not live. Each is saved in
   * open_gaps as it opens, and seeded at startup from that table and last_alive.
   */
  private readonly gaps = new Map<string, Gap>();
  /**
   * Per symbol, the last fresh moment: when a health poll or a processed trade last found its
   * data fresh, or the receive time of the last frame by then if earlier. A silence the feed
   * still tolerated is not counted as fresh once it turns out longer.
   */
  private readonly lastFreshAt = new Map<string, number>();
  private lastPollAt: number | null = null;
  /** Per symbol, the pending orders re-sent after a restart: they wait for its first fresh data. */
  private readonly awaitingFresh = new Map<string, Set<string>>();
  /** Integrity violations of the loaded state; when set, nothing trades. */
  private readonly violations: string[];
  private dead = false;
  private started = false;
  private lastStateKey = '';
  private readonly tradeListener = (symbol: string, trade: AggTrade) => this.background(() => this.onTrade(symbol, trade));

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.newId = deps.newId ?? ((prefix) => `${prefix}-${randomUUID()}`);

    this.violations = checkInvariants(deps.engine.state);
    for (const v of this.violations) deps.logger.error(`Account state failed integrity check: ${v}`);
    this.seedGaps();
    if (this.violations.length === 0 && !this.dead) this.recover();
  }

  // ---- lifecycle ----

  /** Subscribes to trades and starts the health poll (1 s), heartbeat (10 s) and equity snapshots (60 s). */
  start(): void {
    if (this.started || this.dead) return;
    this.started = true;
    if (this.violations.length === 0) this.d.market.on('trade', this.tradeListener);
    this.background(() => touchAlive(this.d.db, this.d.now()));
    this.background(() => this.pollHealth());
    this.every(ALIVE_MS, () => touchAlive(this.d.db, this.d.now()));
    this.every(HEALTH_POLL_MS, () => this.pollHealth());
    this.every(EQUITY_MS, () => this.snapshotEquity());
  }

  /**
   * Stops trades, timers and pending arrival timers, and records every gap still open as a
   * feed_gap ending now (after a fatal error nothing more is written).
   */
  stop(): void {
    this.started = false;
    this.d.market.off('trade', this.tradeListener);
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.closeOpenGaps();
  }

  // ---- actions (each persisted before it returns) ----

  deposit(wallet: Wallet, amount: Decimal): ActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.engine.deposit(wallet, amount, ctx));
  }

  transfer(from: Wallet, to: Wallet, amount: Decimal): ActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.engine.transfer(from, to, amount, ctx));
  }

  submit(req: SpotOrderRequest): EngineEvent[] {
    this.refuseTrading();
    return this.apply((ctx) => this.d.engine.submit(req, ctx));
  }

  /** Requests the cancel: ok means it is on its way; arriveCancel runs at the order's cancelArrivesAt. */
  cancel(orderId: string): ActionResult {
    this.refuseTrading();
    const result = this.apply((ctx) => this.d.engine.cancel(orderId, ctx));
    const at = this.d.engine.state.orders.get(orderId)?.cancelArrivesAt ?? null;
    if (result.ok && at !== null) this.scheduleCancel(orderId, at);
    return result;
  }

  attachOco(req: OcoRequest): EngineEvent[] {
    this.refuseTrading();
    return this.apply((ctx) => this.d.engine.attachOco(req, ctx));
  }

  /** Read-only estimate; nothing is persisted. */
  preview(req: SpotOrderRequest): OrderPreview {
    this.refuseIfDead();
    return this.d.engine.preview(req, this.ctx());
  }

  // ---- reads ----

  account(): AccountSnapshot {
    const state = this.d.engine.state;
    const basis: AccountSnapshot['basis'] = {};
    for (const [asset, b] of Object.entries(state.basis)) {
      if (b.qty.gt(0)) basis[asset] = { qty: b.qty, cost: b.cost };
    }
    return {
      ...valueAccount(state, (s) => this.d.market.bestBid(s), this.d.symbols),
      balances: state.balances,
      basis,
    };
  }

  /** Live (non-terminal) orders, newest first. */
  openOrders(): SpotOrder[] {
    const live = new Set(['pending', 'open', 'partially_filled', 'triggered']);
    return [...this.d.engine.state.orders.values()]
      .filter((o) => live.has(o.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get state(): SpotState {
    return this.d.engine.state;
  }

  // ---- internals ----

  private ctx(): EngineCtx {
    return { now: this.d.now(), rng: this.d.rng, newId: this.newId, market: this.d.market, fees: this.d.fees };
  }

  private refuseIfDead(): void {
    if (this.dead) throw new RefusedError(STOPPED_REFUSAL);
  }

  private refuseTrading(): void {
    this.refuseIfDead();
    if (this.violations.length > 0) throw new RefusedError(INTEGRITY_REFUSAL);
  }

  /**
   * One engine call, then persist + schedule arrivals + broadcast. An exception from the engine
   * or the database is fatal: memory may be ahead of the DB, so the runner stops for good.
   */
  private apply<T extends ActionResult | EngineEvent[]>(call: (ctx: EngineCtx) => T, gaps: FeedGap[] = []): T {
    this.refuseIfDead();
    let result: T;
    try {
      result = call(this.ctx());
    } catch (e) {
      this.die('engine call failed', e);
      throw e;
    }
    this.commit(Array.isArray(result) ? result : result.ok ? result.events : [], gaps);
    return result;
  }

  private commit(events: EngineEvent[], gaps: FeedGap[] = []): void {
    try {
      persist(this.d.db, this.d.seasonId, this.d.engine.state, events, { feedGaps: gaps });
    } catch (e) {
      this.die('persist failed', e);
      throw e;
    }
    for (const e of events) {
      if ((e.type === 'order_placed' || e.type === 'order_triggered') && e.order.arrivesAt !== null) {
        this.scheduleArrival(e.order.id, e.order.arrivesAt);
      }
    }
    this.publishState(events.length > 0);
    for (const n of noticesFor(events, (s) => this.rulesOf(s))) this.d.onBroadcast({ type: 'notice', ...n });
  }

  private closeOpenGaps(): void {
    if (this.dead || this.gaps.size === 0) return;
    const now = this.d.now();
    const gaps = [...this.gaps.keys()].flatMap((symbol) => this.takeGap(symbol, now));
    try {
      persist(this.d.db, this.d.seasonId, this.d.engine.state, [], { feedGaps: gaps });
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
  private scheduleArrival(orderId: string, arrivesAt: number): void {
    this.scheduleAt(arrivesAt, (ctx) => this.d.engine.arrive(orderId, ctx));
  }

  /** arriveCancel() at cancelArrivesAt; the engine ignores orders with no cancel in flight. */
  private scheduleCancel(orderId: string, cancelArrivesAt: number): void {
    this.scheduleAt(cancelArrivesAt, (ctx) => this.d.engine.arriveCancel(orderId, ctx));
  }

  /** One engine call at time `at` (re-armed if the timer fires early), persisted like any other. */
  private scheduleAt(at: number, call: (ctx: EngineCtx) => EngineEvent[]): void {
    const fire = () => {
      const left = at - this.d.now();
      if (left > 0) return this.timer(fire, left);
      this.background(() => this.apply(call));
    };
    this.timer(fire, Math.max(0, at - this.d.now()));
  }

  /** Account and orders after every engine call; skipped only when nothing changed and there were no events. */
  private publishState(changed: boolean): void {
    const orders = this.openOrders();
    const state = this.d.engine.state;
    const key = toJson({ b: state.balances, d: state.totalDeposited, o: orders });
    if (!changed && key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.d.onBroadcast({ type: 'account', account: this.account() });
    this.d.onBroadcast({ type: 'orders', orders });
  }

  /**
   * Startup: first, a cancel in flight whose arrival time passed while the server was down has
   * reached the exchange, so arriveCancel is applied now (one still to arrive, or one waiting for
   * the exchange rules, gets its arriveCancel scheduled; onFresh delivers the latter). Then
   * pending market orders are rejected (engine.rejectRestartedMarket); other pending orders are
   * sent again once their symbol's data is first fresh, with a fresh arrival delay
   * (rearmWhenFresh). Triggered orders with an arrival time get their arrive() scheduled;
   * triggered orders and attached pairs waiting for data (arrivesAt null) are left to onFresh.
   */
  private recover(): void {
    const state = this.d.engine.state;
    const ctx = this.ctx();
    const events: EngineEvent[] = [];
    for (const { id } of [...state.orders.values()]) {
      // Re-read: cancelling one leg of a pair settles its partner too.
      if (state.orders.get(id)!.cancelArrivesAt !== null) events.push(...this.d.engine.arriveCancel(id, ctx));
    }
    for (const o of [...state.orders.values()]) {
      if (o.status !== 'pending') continue;
      if (o.type === 'market') {
        events.push(...this.d.engine.rejectRestartedMarket(o.id, ctx));
      } else if (o.arrivesAt !== null) {
        const ids = this.awaitingFresh.get(o.symbol) ?? new Set<string>();
        ids.add(o.id);
        this.awaitingFresh.set(o.symbol, ids);
      }
    }
    try {
      this.commit(events);
    } catch {
      return; // fatal, already reported
    }
    for (const o of state.orders.values()) {
      if (o.status === 'triggered' && o.arrivesAt !== null) this.scheduleArrival(o.id, o.arrivesAt);
      if (o.cancelArrivesAt !== null) this.scheduleCancel(o.id, o.cancelArrivesAt);
    }
  }

  /**
   * Re-sends the pending orders recover() held back, for each symbol whose data is now fresh:
   * a fresh arrival delay from now (a pair's legs share one), persisted, then arrive() scheduled.
   * Until then they keep their old arrival time and nothing arrives them. A cancel of such an
   * order that is already due (one that waited for the exchange rules) is delivered first.
   */
  private rearmWhenFresh(): void {
    if (this.awaitingFresh.size === 0) return;
    const state = this.d.engine.state;
    const ctx = this.ctx();
    const delays = new Map<string, number>();
    const armed: { id: string; at: number }[] = [];
    const events: EngineEvent[] = [];
    for (const [symbol, ids] of this.awaitingFresh) {
      if (!this.d.market.isFresh(symbol)) continue;
      this.awaitingFresh.delete(symbol);
      for (const id of ids) {
        if (state.orders.get(id)?.cancelArrivesAt != null) events.push(...this.d.engine.arriveCancel(id, ctx));
        const o = state.orders.get(id);
        if (!o || o.status !== 'pending') continue; // cancelled meanwhile
        const key = o.ocoGroupId ?? o.id;
        const at = delays.get(key) ?? ctx.now + arrivalDelay(ctx);
        delays.set(key, at);
        state.orders.set(id, { ...o, arrivesAt: at });
        armed.push({ id, at });
      }
    }
    if (armed.length === 0 && events.length === 0) return;
    this.commit(events);
    for (const { id, at } of armed) this.scheduleArrival(id, at);
  }

  // ---- feed gaps ----

  /**
   * Startup: each symbol's gap is open from the earlier of its saved open gap (left by a crash)
   * and the last heartbeat (the server may have been down since then), with the saved gap's
   * reason, else Server offline. The seeds are saved in one transaction before the first
   * heartbeat, so a crash before the data is fresh again still keeps the earliest start.
   */
  private seedGaps(): void {
    const now = this.d.now();
    const alive = lastAlive(this.d.db);
    const saved = new Map(loadOpenGaps(this.d.db, this.d.seasonId).map((g) => [g.symbol, g]));
    for (const symbol of this.d.symbols) {
      const row = saved.get(symbol);
      if (row === undefined && alive === null) continue;
      const at = Math.min(row?.startedAt ?? Infinity, alive ?? Infinity, now);
      this.gaps.set(symbol, { at, reason: row?.reason ?? OFFLINE_REASON, pollOnly: false });
    }
    if (this.gaps.size === 0) return;
    try {
      this.d.db.transaction(() => {
        for (const [symbol, g] of this.gaps) {
          openGap(this.d.db, this.d.seasonId, { market: 'spot', symbol, startedAt: g.at, reason: g.reason });
        }
      })();
    } catch (e) {
      this.die('persist failed', e);
    }
  }

  /**
   * Every second. A symbol's freshness is the market's (rules, halts and feed health together).
   * Stale data opens a gap. Fresh data closes the open gap, recorded as a feed_gap in the same
   * transaction as onFresh; with no gap open, onFresh still runs when the engine has deferred work
   * for the symbol, so work deferred during a stale stretch that no poll saw does not wait for a
   * trade. A poll more than STALL_MS after the previous one means the process was paused in
   * between (sleep, freeze): every symbol is treated as stale from the previous poll, even if its
   * data looks fresh now, and that gap closes only at a later poll that finds it fresh. Last, the
   * orders held back since startup whose data is now fresh are re-sent.
   */
  private pollHealth(): void {
    const now = this.d.now();
    const prev = this.lastPollAt;
    this.lastPollAt = now;
    const pausedSince = prev !== null && now - prev > STALL_MS ? prev : null;
    let changed = false;
    for (const symbol of this.d.symbols) {
      if (pausedSince !== null) changed = this.startGap(symbol, PAUSED_REASON, pausedSince) || changed;
      else if (!this.d.market.isFresh(symbol)) changed = this.startGap(symbol, this.staleReason(symbol)) || changed;
      else changed = this.freshAtPoll(symbol, now) || changed;
    }
    if (changed) this.broadcastHealth();
    this.rearmWhenFresh();
  }

  /** A health poll found the symbol fresh. Returns whether its gap closed. */
  private freshAtPoll(symbol: string, now: number): boolean {
    this.markFresh(symbol, now);
    const gaps = this.takeGap(symbol, now);
    if (this.violations.length > 0) {
      if (gaps.length > 0) this.commit([], gaps);
    } else if (gaps.length > 0 || this.d.engine.hasDeferredWork(symbol, now)) {
      this.apply((ctx) => this.d.engine.onFresh(symbol, ctx), gaps);
    }
    if (gaps.length > 0) this.notice({ kind: 'feed_restored', level: 'info', text: `Live data restored for ${symbol}` });
    return gaps.length > 0;
  }

  /**
   * A live trade. On stale data the engine skips it, so the interruption is saved first: a gap
   * opens now, from the last fresh moment. On fresh data the open gap (unless it is a pause,
   * which a poll closes) is recorded as a feed_gap in the same transaction as the trade's own
   * changes, so the trade cursor never moves past a skipped trade before its gap is recorded.
   */
  private onTrade(symbol: string, trade: AggTrade): void {
    const now = this.d.now();
    const fresh = this.d.market.isFresh(symbol);
    const opened = !fresh && this.startGap(symbol, this.staleReason(symbol));
    const gaps = fresh && this.gaps.get(symbol)?.pollOnly !== true ? this.takeGap(symbol, now) : [];
    this.apply((ctx) => this.d.engine.onTrade(symbol, trade, ctx), gaps);
    if (fresh) this.markFresh(symbol, now);
    if (gaps.length > 0) this.notice({ kind: 'feed_restored', level: 'info', text: `Live data restored for ${symbol}` });
    if (opened || gaps.length > 0) this.broadcastHealth();
  }

  private markFresh(symbol: string, now: number): void {
    this.lastFreshAt.set(symbol, Math.min(now, this.d.health.lastFrameAt()));
  }

  /**
   * Opens the symbol's gap, saved at once so a crash keeps its start: the last fresh moment, or
   * the poll before a pause if that is earlier, or the last frame received if that is earlier
   * still (after a silent stretch nothing after that frame is known). An open gap is kept. A
   * symbol not fresh since startup has none to open: the time before is its startup gap.
   * Returns whether it opened.
   */
  private startGap(symbol: string, reason: string, pausedSince: number | null = null): boolean {
    const lastFresh = this.lastFreshAt.get(symbol);
    if (this.gaps.has(symbol) || lastFresh === undefined) return false;
    const at = Math.min(pausedSince ?? Infinity, lastFresh, this.d.health.lastFrameAt());
    openGap(this.d.db, this.d.seasonId, { market: 'spot', symbol, startedAt: at, reason });
    this.gaps.set(symbol, { at, reason, pollOnly: pausedSince !== null });
    this.notice({ kind: 'feed_gap', level: 'warn', text: `Live data interrupted for ${symbol}: ${reason}` });
    return true;
  }

  /** The symbol's open gap as a feed_gap ending at `now` (none if no gap is open); the caller persists it. */
  private takeGap(symbol: string, now: number): FeedGap[] {
    const gap = this.gaps.get(symbol);
    if (!gap) return [];
    this.gaps.delete(symbol);
    return [{ symbol, market: 'spot', startedAt: gap.at, endedAt: now, reason: gap.reason }];
  }

  private staleReason(symbol: string): string {
    return this.d.market.healthSnapshot()[symbol]?.reason ?? 'Data stale';
  }

  private broadcastHealth(): void {
    this.d.onBroadcast({ type: 'health', health: this.d.market.healthSnapshot() });
  }

  /** Every minute while data is fresh; skipped when any held coin's price is stale or missing. */
  private snapshotEquity(): void {
    const value = valueAccount(this.d.engine.state, (s) => this.d.market.bestBid(s), this.d.symbols);
    if (value.coins.some((c) => !c.fresh)) return;
    insertEquitySnapshot(this.d.db, this.d.seasonId, value, this.d.now());
  }

  private notice(n: Notice): void {
    this.d.onBroadcast({ type: 'notice', ...n });
  }

  private rulesOf(symbol: string): SpotRules | null {
    try {
      return this.d.market.rules(symbol);
    } catch {
      return null;
    }
  }
}

/** The order a submit created (its first event names it: placed or rejected). */
export function submittedOrder(events: EngineEvent[]): SpotOrder {
  const first = events.find((e) => 'order' in e) as { order: SpotOrder } | undefined;
  if (!first) throw new Error('submit produced no order');
  return first.order;
}

// ---- notices ----

/** One notice per fill, partial fill, rejection (one per pair), late cancel, trigger and thin-book cancel. */
export function noticesFor(events: EngineEvent[], rulesOf: (symbol: string) => SpotRules | null): Notice[] {
  const out: Notice[] = [];
  const rejectedPairs = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case 'fill': {
        const text = fillText(e.fill, rulesOf(e.fill.symbol));
        if (e.order.status === 'partially_filled') {
          out.push({ kind: 'partial_fill', level: 'info', text: `Partial fill: ${text}` });
        } else {
          out.push({ kind: 'fill', level: 'info', text });
        }
        break;
      }
      case 'order_rejected':
        if (e.order.ocoGroupId !== null) {
          if (rejectedPairs.has(e.order.ocoGroupId)) break;
          rejectedPairs.add(e.order.ocoGroupId);
        }
        out.push({ kind: 'rejected', level: 'error', text: e.reason });
        break;
      case 'cancel_rejected':
        out.push({ kind: 'cancel_rejected', level: 'error', text: e.reason });
        break;
      case 'order_triggered': {
        const rules = rulesOf(e.order.symbol);
        const label = e.order.type === 'stop_loss' ? 'Stop' : 'Take-profit';
        const price = rules ? e.lastPrice.toFixed(rules.tickSize.decimalPlaces()) : e.lastPrice.toString();
        out.push({ kind: 'triggered', level: 'warn', text: `${label} triggered at ${price}` });
        break;
      }
      case 'order_cancelled':
        if (e.reason === 'thin_book') {
          const base = baseOf(e.order.symbol, rulesOf(e.order.symbol));
          out.push({
            kind: 'thin_book',
            level: 'warn',
            text: `Book too thin: ${e.cancelledQty} ${base} not filled and cancelled`,
          });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** `Bought 1.2 BTC @ 100.0583 · slippage $0.07 · fee 0.0012 BTC` (price at tick decimals + 2; slippage rounded up). */
function fillText(f: Fill, rules: SpotRules | null): string {
  const verb = f.side === 'buy' ? 'Bought' : 'Sold';
  const price = rules ? f.price.toFixed(rules.tickSize.decimalPlaces() + 2) : f.price.toString();
  const slippage = f.slippageUsd.toFixed(2, Decimal.ROUND_UP);
  return `${verb} ${f.qty} ${baseOf(f.symbol, rules)} @ ${price} · slippage $${slippage} · fee ${f.fee} ${f.feeAsset}`;
}

function baseOf(symbol: string, rules: SpotRules | null): string {
  return rules?.base ?? symbol.replace(/USDT$/, '');
}
