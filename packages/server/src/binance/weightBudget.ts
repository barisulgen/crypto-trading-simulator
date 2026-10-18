import type { Logger } from '../log.ts';
import type { SetTimer } from '../market/ws.ts';

/** Binance's spot REST limit: request weight per minute per IP. */
export const WEIGHT_LIMIT_1M = 6000;
/** We never go above 80 % of it. */
export const WEIGHT_BUDGET_1M = 4800;
export const WEIGHT_WINDOW_MS = 60_000;
export const BUDGET_MAX_WAIT_MS = 30_000;
export const BUDGET_EXHAUSTED = 'Binance REST budget exhausted; retry later';
const WAIT_LOG_EVERY_MS = 10_000;

const FIXED_WEIGHTS: Record<string, number> = {
  '/api/v3/avgPrice': 2,
  '/api/v3/exchangeInfo': 20,
  '/api/v3/klines': 2,
  '/api/v3/time': 1,
};

/** The documented request weight of a spot REST call. */
export function requestWeight(path: string, query: string): number {
  if (path === '/api/v3/depth') {
    const limit = Number(new URLSearchParams(query).get('limit') ?? 100);
    return limit <= 100 ? 5 : limit <= 500 ? 25 : limit <= 1000 ? 50 : 250;
  }
  const w = FIXED_WEIGHTS[path];
  if (w === undefined) throw new Error(`No known request weight for ${path}`);
  return w;
}

export interface WeightBudgetDeps {
  now: () => number;
  setTimer: SetTimer;
  logger: Logger;
  budget?: number;
  maxWaitMs?: number;
}

interface Reservation {
  at: number;
  weight: number;
  ticket: number;
}

interface Waiter {
  weight: number;
  resolve: (ticket: number) => void;
  reject: (e: Error) => void;
  cancelDeadline: () => void;
}

const minuteOf = (t: number) => Math.floor(t / WEIGHT_WINDOW_MS);

/**
 * Request-weight budget for one IP. Every request reserves its weight before it is sent, in a
 * rolling 60 s window; Binance's own X-MBX-USED-WEIGHT-1M reading counts too (another process on
 * the same IP). A request that does not fit waits, first come first served.
 */
export class WeightBudget {
  readonly budget: number;
  private readonly maxWaitMs: number;
  /** Reservations of the last 60 s. */
  private reserved: Reservation[] = [];
  private nextTicket = 1;
  /** The newest header reading: Binance's used weight in the fixed minute containing `at`. */
  private header: { used: number; at: number; ticket: number } | null = null;
  private readonly waiters: Waiter[] = [];
  private cancelWake: (() => void) | null = null;
  private lastWaitLog = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: WeightBudgetDeps) {
    this.budget = d.budget ?? WEIGHT_BUDGET_1M;
    this.maxWaitMs = d.maxWaitMs ?? BUDGET_MAX_WAIT_MS;
  }

  /** Our own reservations in the rolling window. */
  get localWeight(): number {
    this.prune();
    return this.reserved.reduce((a, r) => a + r.weight, 0);
  }

  /** Binance's reading plus what we reserved after the request that carried it; null if not from this minute. */
  get headerWeight(): number | null {
    const h = this.header;
    if (!h || minuteOf(h.at) !== minuteOf(this.d.now())) return null;
    this.prune();
    return h.used + this.reserved.reduce((a, r) => (r.ticket > h.ticket ? a + r.weight : a), 0);
  }

  /** Effective used weight: the larger of the local estimate and the header-based one. */
  get usedWeight(): number {
    return Math.max(this.localWeight, this.headerWeight ?? 0);
  }

  /** Resolves with a ticket once `weight` fits; queued FIFO behind earlier waiters. */
  acquire(weight: number): Promise<number> {
    if (weight > this.budget) return Promise.reject(new Error(BUDGET_EXHAUSTED));
    if (this.waiters.length === 0 && this.fits(weight)) return Promise.resolve(this.reserve(weight));
    return new Promise<number>((resolve, reject) => {
      const w: Waiter = { weight, resolve, reject, cancelDeadline: () => {} };
      w.cancelDeadline = this.d.setTimer(() => {
        this.remove(w);
        reject(new Error(BUDGET_EXHAUSTED));
        this.pump(); // a large head leaving can let smaller ones through
      }, this.maxWaitMs);
      this.waiters.push(w);
      this.logWait();
      this.pump();
    });
  }

  /** The request holding `ticket` goes out now: its weight counts for 60 s from here. */
  markSent(ticket: number): void {
    const r = this.reserved.find((x) => x.ticket === ticket);
    if (r) r.at = this.d.now();
  }

  /** Records X-MBX-USED-WEIGHT-1M from the response to the request holding `ticket`. */
  recordHeader(used: number, ticket: number): void {
    const now = this.d.now();
    const h = this.header;
    // Responses can arrive out of order: within a minute, keep the reading of the newest request.
    if (h && minuteOf(h.at) === minuteOf(now) && h.ticket > ticket) return;
    this.header = { used, at: now, ticket };
  }

  /** Rejects every waiting request; used when all REST calls are paused. */
  rejectAll(message: string): void {
    for (const w of this.waiters.splice(0)) {
      w.cancelDeadline();
      w.reject(new Error(message));
    }
    this.cancelWake?.();
    this.cancelWake = null;
  }

  private fits(weight: number): boolean {
    return this.usedWeight + weight <= this.budget;
  }

  private reserve(weight: number): number {
    const ticket = this.nextTicket++;
    this.reserved.push({ at: this.d.now(), weight, ticket });
    return ticket;
  }

  private prune(): void {
    const cutoff = this.d.now() - WEIGHT_WINDOW_MS;
    if (this.reserved.some((r) => r.at <= cutoff)) this.reserved = this.reserved.filter((r) => r.at > cutoff);
  }

  private remove(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /** Releases waiters in order while they fit, then sleeps until weight can next free up. */
  private pump(): void {
    while (this.waiters[0] && this.fits(this.waiters[0].weight)) {
      const w = this.waiters.shift()!;
      w.cancelDeadline();
      w.resolve(this.reserve(w.weight));
    }
    this.cancelWake?.();
    this.cancelWake = null;
    if (this.waiters.length === 0) return;
    const now = this.d.now();
    const expiry = this.reserved.reduce((m, r) => Math.min(m, r.at + WEIGHT_WINDOW_MS), Number.POSITIVE_INFINITY);
    const nextMinute = this.headerWeight === null ? Number.POSITIVE_INFINITY : (minuteOf(now) + 1) * WEIGHT_WINDOW_MS;
    const at = Math.min(expiry, nextMinute);
    if (!Number.isFinite(at)) return; // nothing will free up; the deadline rejects
    this.cancelWake = this.d.setTimer(() => {
      this.cancelWake = null;
      this.pump();
    }, Math.max(1, at - now));
  }

  private logWait(): void {
    const now = this.d.now();
    if (now - this.lastWaitLog < WAIT_LOG_EVERY_MS) return;
    this.lastWaitLog = now;
    this.d.logger.warn(`Binance REST weight budget reached (used ${this.usedWeight}/${this.budget}); delaying requests`);
  }
}
