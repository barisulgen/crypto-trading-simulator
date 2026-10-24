import { D, FUNDING_WINDOW_MS } from '@sim/engine';
import type { Decimal } from '@sim/engine';
import type { FundingRateQuery } from '../binance/futuresRest.ts';
import type { Logger } from '../log.ts';
import type { SetTimer } from '../market/ws.ts';

/** While a settlement is awaited, fundingRate is polled this often (through the funding lane). */
export const FUNDING_POLL_MS = 30_000;
/** A settlement still missing this long after its funding time is logged (once per symbol)... */
export const FUNDING_UNSETTLED_LOG_MS = 6 * 3_600_000;
/** ...and polled this often from then on. It is never estimated. */
export const FUNDING_SLOW_POLL_MS = 300_000;
/** Timers are armed in steps of at most this, re-reading the clock each time: a wake from sleep is seen within it. */
const TIMER_STEP_MS = 60_000;
/** A fundingRate record within this of the funding time is its settlement. */
const MATCH_MS = 60_000;
/** The fundingRate query reaches this far either side of the funding time. */
const QUERY_MS = 60_000;
const QUERY_LIMIT = 10;
/** While a symbol's windows are left to catch-up, an open or close that fell due is tried again this often. */
export const FUNDING_DEFER_RETRY_MS = 1000;

/** A funding window by symbol and funding time. */
export interface FundingRef {
  symbol: string;
  fundingTime: number;
}

/** What the service does to the account: each call is one engine call, persisted (the runner). */
export interface FundingSim {
  /** The windows open now and those closed and waiting for their settled rate, as saved. */
  fundingWindows(): { open: FundingRef[]; pending: FundingRef[] };
  openFundingWindow(symbol: string, fundingTime: number): void;
  closeFundingWindow(symbol: string, fundingTime: number): void;
  applyFunding(symbol: string, fundingTime: number, rate: Decimal, markPrice: Decimal): unknown;
  /**
   * Whether the symbol's perp data is in a gap or catching up after one: what was held across its
   * funding windows is known only once catch-up has run (it models the windows of its gap itself),
   * so the service then neither opens, closes nor settles them. Absent: never.
   */
  fundingDeferred?(symbol: string): boolean;
}

export interface FundingServiceDeps {
  rest: { fundingRate(q: FundingRateQuery): Promise<unknown> };
  sim: FundingSim;
  /** The mark stream: 'mark' (symbol, { nextFundingTime }). */
  market: {
    on(event: 'mark', cb: (symbol: string, mark: { nextFundingTime: number }) => void): unknown;
    off(event: 'mark', cb: (symbol: string, mark: { nextFundingTime: number }) => void): unknown;
  };
  now: () => number;
  setTimer: SetTimer;
  logger: Logger;
}

/**
 * Real funding, never estimated. Each symbol's next funding time T comes from the mark stream: the
 * window opens at T − 15 s and closes at T + 15 s, then fundingRate (startTime T − 60 s, endTime
 * T + 60 s) is polled every 30 s, through the funding lane, until Binance has published the
 * settlement (a record within 60 s of T); its rate and mark price are then applied, once. Still
 * missing after 6 h, it is logged once per symbol and polled every 5 min. Windows live in the
 * perp state, so they survive a restart: on start, a window still open is closed at its own close
 * time (at once if that has passed) and every window waiting for its rate is polled again at once.
 * A funding time first seen after its window closed (the server was down) is left to catch-up.
 * While a symbol's data is in a gap or catching up (fundingDeferred), its due opens and closes wait
 * and its polls stop; once its catch-up has run (caughtUp), every window found open or waiting in
 * the state is closed on time and polled, whoever opened it, so each is settled exactly once.
 */
export class FundingService {
  private readonly d: FundingServiceDeps;
  private readonly timers = new Set<() => void>();
  /** `${symbol}@${T}` of every funding time already scheduled or handled, kept for a day. */
  private readonly seen = new Map<string, number>();
  /** Symbols whose missing settlement has been logged; cleared when one of theirs settles. */
  private readonly loggedLate = new Set<string>();
  /** Windows whose last poll failed (logged once until a poll answers). */
  private readonly failing = new Set<string>();
  /** Windows with a close armed, and windows with a poll chain running: never two of either. */
  private readonly closing = new Set<string>();
  private readonly polling = new Set<string>();
  /** Refusals of the account already logged, by message: each is logged once. */
  private readonly refusals = new Set<string>();
  private started = false;
  private readonly markListener = (symbol: string, mark: { nextFundingTime: number }) =>
    this.onMark(symbol, mark.nextFundingTime);

  constructor(deps: FundingServiceDeps) {
    this.d = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.track();
    this.d.market.on('mark', this.markListener);
  }

  /**
   * The symbol's catch-up has been applied: a window of a known funding time that is due now
   * (T − 15 s ≤ now < T + 15 s) and not open yet opens, before anything after the gap reaches the
   * position; then every window open or waiting in the state is tracked (track).
   */
  caughtUp(symbol: string): void {
    if (!this.started) return;
    const now = this.d.now();
    for (const fundingTime of this.knownTimes(symbol)) {
      if (now >= fundingTime - FUNDING_WINDOW_MS && now < fundingTime + FUNDING_WINDOW_MS) {
        const ref = { symbol, fundingTime };
        this.safely(ref, () => this.d.sim.openFundingWindow(symbol, fundingTime));
      }
    }
    this.track();
  }

  /**
   * Every window in the state, whatever opened it (the mark stream, a restart, catch-up): one still
   * open has its close armed at its own close time (at once, and its first poll at once, if that has
   * passed), and one waiting for its rate is polled at once. A window with a close armed or a poll
   * chain running already is left to it.
   */
  track(): void {
    if (!this.started) return;
    const { open, pending } = this.d.sim.fundingWindows();
    for (const w of open) {
      const k = refKey(w);
      this.seen.set(k, w.fundingTime);
      if (this.closing.has(k)) continue;
      const overdue = this.d.now() >= w.fundingTime + FUNDING_WINDOW_MS;
      this.armClose(w, overdue ? 0 : FUNDING_POLL_MS);
    }
    for (const w of pending) {
      this.seen.set(refKey(w), w.fundingTime);
      this.startPolling(w, 0);
    }
  }

  /** The funding times scheduled or handled for the symbol (kept for a day), ascending. */
  knownTimes(symbol: string): number[] {
    const out: number[] = [];
    for (const [k, t] of this.seen) if (k === refKey({ symbol, fundingTime: t })) out.push(t);
    return out.sort((a, b) => a - b);
  }

  /** Stops every timer and forgets what was scheduled: a later start() reads the saved windows again. */
  stop(): void {
    this.started = false;
    this.d.market.off('mark', this.markListener);
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.seen.clear();
    this.loggedLate.clear();
    this.failing.clear();
    this.closing.clear();
    this.polling.clear();
  }

  /** A mark update naming the symbol's next funding time: its window is scheduled once. */
  private onMark(symbol: string, fundingTime: number): void {
    if (!this.started || !Number.isSafeInteger(fundingTime) || fundingTime <= 0) return;
    const ref = { symbol, fundingTime };
    const k = refKey(ref);
    if (this.seen.has(k)) return;
    const now = this.d.now();
    if (now >= fundingTime + FUNDING_WINDOW_MS) return; // its window closed before it was seen: catch-up's
    this.seen.set(k, fundingTime);
    this.prune(now);
    this.at(fundingTime - FUNDING_WINDOW_MS, () => this.open(ref));
    this.armClose(ref, FUNDING_POLL_MS);
  }

  private armClose(ref: FundingRef, pollIn: number): void {
    this.closing.add(refKey(ref));
    this.at(ref.fundingTime + FUNDING_WINDOW_MS, () => this.close(ref, pollIn));
  }

  /** A poll chain for the window, `inMs` from now, unless one is running. */
  private startPolling(ref: FundingRef, inMs: number): void {
    const k = refKey(ref);
    if (this.polling.has(k)) return;
    this.polling.add(k);
    this.at(this.d.now() + inMs, () => void this.poll(ref));
  }

  private deferred(symbol: string): boolean {
    return this.d.sim.fundingDeferred?.(symbol) ?? false;
  }

  /**
   * The window opens at T − 15 s. An open that runs at or after T + 15 s (the process slept through
   * the window) opens nothing: what was held across T is not known live, so that funding time is
   * left to catch-up, and with no window it is never polled or applied here. While the symbol's
   * windows are left to catch-up (fundingDeferred) the open is tried again every second until it
   * opens or its window has passed: catch-up opens it at its time when its gap reaches it.
   */
  private open(ref: FundingRef, waited = false): void {
    if (this.d.now() >= ref.fundingTime + FUNDING_WINDOW_MS) {
      const why = waited ? 'its data was interrupted through its window' : 'the server was paused through its window';
      this.d.logger.warn(`Funding ${ref.symbol} at ${iso(ref.fundingTime)}: ${why}; left to catch-up`);
      return;
    }
    if (this.deferred(ref.symbol)) {
      this.at(this.d.now() + FUNDING_DEFER_RETRY_MS, () => this.open(ref, true));
      return;
    }
    this.safely(ref, () => this.d.sim.openFundingWindow(ref.symbol, ref.fundingTime));
  }

  /**
   * The window closes and waits for its settled rate: the first poll is `pollIn` later (30 s on
   * time). Only a window that is waiting is polled: one never opened (the open came too late, or
   * was refused) or already settled is not. A close that runs late finds the window already closed
   * by the first engine call after T + 15 s (the runner closes due windows before each one). While
   * the symbol's windows are left to catch-up the close is tried again every second: the window
   * stays open, so the gap's fills, applied by catch-up, still count in it.
   */
  private close(ref: FundingRef, pollIn = FUNDING_POLL_MS): void {
    if (this.deferred(ref.symbol)) {
      this.at(this.d.now() + FUNDING_DEFER_RETRY_MS, () => this.close(ref, pollIn));
      return;
    }
    this.closing.delete(refKey(ref));
    if (!this.safely(ref, () => this.d.sim.closeFundingWindow(ref.symbol, ref.fundingTime))) return;
    const waiting = this.d.sim.fundingWindows().pending.some((w) => refKey(w) === refKey(ref));
    if (waiting) this.startPolling(ref, pollIn);
  }

  /**
   * One fundingRate poll; the settlement found is applied, otherwise the next poll is scheduled.
   * While the symbol's windows are left to catch-up the chain stops (before polling, or before
   * applying): catch-up settles the window itself, or caughtUp polls it again.
   */
  private async poll(ref: FundingRef): Promise<void> {
    const T = ref.fundingTime;
    const k = refKey(ref);
    if (this.deferred(ref.symbol)) {
      this.polling.delete(k);
      return;
    }
    let settlement: { rate: Decimal; markPrice: Decimal } | null = null;
    try {
      const rows = await this.d.rest.fundingRate({ symbol: ref.symbol, startTime: T - QUERY_MS, endTime: T + QUERY_MS, limit: QUERY_LIMIT });
      this.failing.delete(k);
      settlement = findSettlement(rows, T);
    } catch (e) {
      if (!this.failing.has(k)) {
        this.failing.add(k);
        this.d.logger.warn(`Funding ${ref.symbol} at ${iso(T)}: fundingRate poll failed (${(e as Error).message}); retrying`);
      }
    }
    if (!this.started) return;
    if (settlement !== null && this.deferred(ref.symbol)) {
      this.polling.delete(k);
      return;
    }
    if (settlement !== null) {
      this.polling.delete(k);
      const { rate, markPrice } = settlement;
      // Applied, or refused by the account: either way this window is done here. A refused one
      // stays pending in the saved state and is polled again at the next start.
      if (this.safely(ref, () => this.d.sim.applyFunding(ref.symbol, T, rate, markPrice))) this.loggedLate.delete(ref.symbol);
      return;
    }
    const late = this.d.now() - T >= FUNDING_UNSETTLED_LOG_MS;
    if (late && !this.loggedLate.has(ref.symbol)) {
      this.loggedLate.add(ref.symbol);
      this.d.logger.warn(`${ref.symbol} funding at ${iso(T)} not settled after 6 h; still waiting for Binance (never estimated)`);
    }
    this.at(this.d.now() + (late ? FUNDING_SLOW_POLL_MS : FUNDING_POLL_MS), () => void this.poll(ref));
  }

  /**
   * Runs one engine call for the window; a refusal (the runner stopped, or its state failed its
   * integrity check) is reported as false, never thrown into a timer, and logged once per message.
   */
  private safely(ref: FundingRef, fn: () => unknown): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      const message = (e as Error).message;
      if (!this.refusals.has(message)) {
        this.refusals.add(message);
        this.d.logger.warn(`Funding ${ref.symbol} at ${iso(ref.fundingTime)}: ${message}; funding waits until a restart`);
      }
      return false;
    }
  }

  /**
   * Runs `fn` at epoch ms `when` (at once if past), unless stopped first. The timer is armed in
   * steps of at most 60 s and the clock read again at each, so an early timer is re-armed and one
   * a sleep held back runs within a minute of the wake; `fn` itself reads the clock to see how late it is.
   */
  private at(when: number, fn: () => void): void {
    const arm = () => {
      const cancel = this.d.setTimer(() => {
        this.timers.delete(cancel);
        if (!this.started) return;
        if (this.d.now() < when) return arm();
        fn();
      }, Math.min(TIMER_STEP_MS, Math.max(0, when - this.d.now())));
      this.timers.add(cancel);
    };
    arm();
  }

  private prune(now: number): void {
    for (const [k, t] of this.seen) if (t < now - 86_400_000) this.seen.delete(k);
  }
}

const refKey = (r: FundingRef) => `${r.symbol}@${r.fundingTime}`;
const iso = (t: number) => new Date(t).toISOString();

/**
 * The settlement of funding time T among fundingRate records: one within 60 s of T with a decimal
 * rate and a positive mark price. Anything else (no record yet, an old record without a mark
 * price) is not a settlement: the poll goes on.
 */
function findSettlement(rows: unknown, T: number): { rate: Decimal; markPrice: Decimal } | null {
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    const time = Number(r?.fundingTime);
    if (!Number.isSafeInteger(time) || Math.abs(time - T) > MATCH_MS) continue;
    if (typeof r.fundingRate !== 'string' || !/^-?\d+(\.\d+)?$/.test(r.fundingRate)) continue;
    if (typeof r.markPrice !== 'string' || !/^\d+(\.\d+)?$/.test(r.markPrice)) continue;
    const markPrice = D(r.markPrice);
    if (!markPrice.gt(0)) continue;
    return { rate: D(r.fundingRate), markPrice };
  }
  return null;
}
