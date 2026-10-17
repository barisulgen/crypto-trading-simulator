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
import { checkInvariants, insertEquitySnapshot, lastAlive, persist, toJson, touchAlive } from './db/store.ts';
import type { FeedGap } from './db/store.ts';
import type { Logger } from './log.ts';
import type { HealthTransition } from './market/feedHealth.ts';
import type { SetTimer } from './market/ws.ts';

export { RESTART_REASON };
export const INTEGRITY_REFUSAL = 'Account state failed integrity check; see server log';
export const OFFLINE_REASON = 'Server offline';
const STOPPED_REFUSAL = 'Server stopped after an internal error; see server log';

const HEALTH_POLL_MS = 1000;
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
  kind: 'fill' | 'partial_fill' | 'rejected' | 'triggered' | 'thin_book' | 'feed_gap' | 'feed_restored';
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
  bestBid(symbol: string): { price: Decimal; fresh: boolean } | null;
  healthSnapshot(): HealthMap;
  on(event: 'trade', cb: (symbol: string, trade: AggTrade) => void): unknown;
  off(event: 'trade', cb: (symbol: string, trade: AggTrade) => void): unknown;
}

export interface RunnerDeps {
  db: Db;
  seasonId: number;
  engine: SpotEngine;
  market: RunnerMarket;
  /** FeedHealth (or a stand-in): per-symbol fresh/stale transitions since the last poll. */
  health: { poll(now: number): HealthTransition[] };
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

/**
 * Drives the pure SpotEngine: feeds it live trades in receive order, runs arrivals at their
 * arrival time, reacts to feed-health transitions, and after every engine call persists the
 * whole change in one transaction before anything is broadcast. Everything runs on the one
 * Node thread with no awaits between an engine call and its persist.
 */
export class EngineRunner {
  private readonly d: RunnerDeps;
  private readonly newId: (prefix: string) => string;
  private readonly timers = new Set<() => void>();
  /** Per symbol, since when (and why) the data is stale; seeded with last_alive at startup. */
  private readonly staleSince = new Map<string, { at: number; reason: string }>();
  /** Integrity violations of the loaded state; when set, nothing trades. */
  private readonly violations: string[];
  private dead = false;
  private started = false;
  private lastStateKey = '';
  private readonly tradeListener = (symbol: string, trade: AggTrade) =>
    this.background(() => this.apply((ctx) => this.d.engine.onTrade(symbol, trade, ctx)));

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.newId = deps.newId ?? ((prefix) => `${prefix}-${randomUUID()}`);

    const alive = lastAlive(deps.db);
    if (alive !== null) {
      for (const s of deps.symbols) this.staleSince.set(s, { at: alive, reason: OFFLINE_REASON });
    }

    this.violations = checkInvariants(deps.engine.state);
    for (const v of this.violations) deps.logger.error(`Account state failed integrity check: ${v}`);
    if (this.violations.length === 0) this.recover();
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

  cancel(orderId: string): ActionResult {
    this.refuseTrading();
    return this.apply((ctx) => this.d.engine.cancel(orderId, ctx));
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
    if (this.dead || this.staleSince.size === 0) return;
    const now = this.d.now();
    const gaps: FeedGap[] = [...this.staleSince].map(([symbol, s]) => ({
      symbol,
      market: 'spot',
      startedAt: s.at,
      endedAt: now,
      reason: s.reason,
    }));
    this.staleSince.clear();
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

  /** arrive() at arrivesAt (re-armed if the timer fires early); the engine ignores orders no longer waiting. */
  private scheduleArrival(orderId: string, arrivesAt: number): void {
    const fire = () => {
      const left = arrivesAt - this.d.now();
      if (left > 0) return this.timer(fire, left);
      this.background(() => this.apply((ctx) => this.d.engine.arrive(orderId, ctx)));
    };
    this.timer(fire, Math.max(0, arrivesAt - this.d.now()));
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
   * Startup: pending market orders are rejected (engine.rejectRestartedMarket); other pending
   * orders are sent again with a fresh arrival delay (a pair's legs share one). Every order with
   * an arrival time - re-armed, or triggered before the restart - gets its arrive() scheduled;
   * triggered orders and attached pairs waiting for data (arrivesAt null) are left to onFresh.
   */
  private recover(): void {
    const state = this.d.engine.state;
    const ctx = this.ctx();
    const events: EngineEvent[] = [];
    const rearmed = new Map<string, number>();
    for (const o of [...state.orders.values()]) {
      if (o.status !== 'pending') continue;
      if (o.type === 'market') {
        events.push(...this.d.engine.rejectRestartedMarket(o.id, ctx));
      } else if (o.arrivesAt !== null) {
        const key = o.ocoGroupId ?? o.id;
        const at = rearmed.get(key) ?? ctx.now + arrivalDelay(ctx);
        rearmed.set(key, at);
        state.orders.set(o.id, { ...o, arrivesAt: at });
      }
    }
    try {
      this.commit(events);
    } catch {
      return; // fatal, already reported
    }
    for (const o of state.orders.values()) {
      if ((o.status === 'pending' || o.status === 'triggered') && o.arrivesAt !== null) {
        this.scheduleArrival(o.id, o.arrivesAt);
      }
    }
  }

  /**
   * Feed-health transitions: a stale transition starts a gap; the next fresh one records it as a
   * feed_gap (in the same transaction as onFresh, which runs on every stale -> fresh transition).
   */
  private pollHealth(): void {
    const transitions = this.d.health.poll(this.d.now());
    if (transitions.length === 0) return;
    for (const t of transitions) {
      if (!t.fresh) {
        const reason = t.reason ?? 'Data stale';
        if (!this.staleSince.has(t.symbol)) this.staleSince.set(t.symbol, { at: t.at, reason });
        this.notice({ kind: 'feed_gap', level: 'warn', text: `Live data interrupted for ${t.symbol}: ${reason}` });
        continue;
      }
      const since = this.staleSince.get(t.symbol);
      this.staleSince.delete(t.symbol);
      const gaps: FeedGap[] = since
        ? [{ symbol: t.symbol, market: 'spot', startedAt: since.at, endedAt: t.at, reason: since.reason }]
        : [];
      if (this.violations.length > 0) this.commit([], gaps);
      else this.apply((ctx) => this.d.engine.onFresh(t.symbol, ctx), gaps);
      if (since) this.notice({ kind: 'feed_restored', level: 'info', text: `Live data restored for ${t.symbol}` });
    }
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

/** One notice per fill, partial fill, rejection (one per pair), trigger and thin-book cancel. */
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
