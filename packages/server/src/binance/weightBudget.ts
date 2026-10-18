import type { Logger } from '../log.ts';
import type { SetTimer } from '../market/ws.ts';

/** Binance's spot REST limit: request weight per minute per IP. */
export const WEIGHT_LIMIT_1M = 6000;
/** We never go above 80 % of it. */
export const WEIGHT_BUDGET_1M = 4800;
export const WEIGHT_WINDOW_MS = 60_000;
/** Depth snapshots (bulk) may only fill the budget up to 4400: the last 400 per 60 s stay free for critical requests. */
export const BULK_HEADROOM = 400;
export const BUDGET_MAX_WAIT_MS = 30_000;
export const BUDGET_EXHAUSTED = 'Binance REST budget exhausted; retry later';
export const CLIENT_CLOSED = 'Binance REST client closed';
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

/**
 * Waiting requests are released by lane: 'critical' (small, keeps prices and rules alive: avgPrice,
 * exchangeInfo, time, klines) before 'bulk' (depth snapshots); first come first served within a lane.
 * Bulk also stops BULK_HEADROOM short of the budget, so a snapshot storm cannot starve avgPrice.
 */
export type Lane = 'critical' | 'bulk';

export function requestLane(path: string): Lane {
  return path === '/api/v3/depth' ? 'bulk' : 'critical';
}

export interface WeightBudgetDeps {
  now: () => number;
  setTimer: SetTimer;
  logger: Logger;
  budget?: number;
  maxWaitMs?: number;
  bulkHeadroom?: number;
}

interface Reservation {
  at: number;
  weight: number;
  ticket: number;
}

interface Waiter {
  weight: number;
  lane: Lane;
  resolve: (ticket: number) => void;
  reject: (e: Error) => void;
  cancelDeadline: () => void;
}

const minuteOf = (t: number) => Math.floor(t / WEIGHT_WINDOW_MS);

/**
 * Request-weight budget for one IP. Every request reserves its weight before it is sent, in a
 * rolling 60 s window; Binance's own X-MBX-USED-WEIGHT-1M reading counts too (another process on
 * the same IP). A request that does not fit waits in its lane (see Lane).
 */
export class WeightBudget {
  readonly budget: number;
  private readonly maxWaitMs: number;
  private readonly bulkHeadroom: number;
  /** Reservations of the last 60 s. */
  private reserved: Reservation[] = [];
  private nextTicket = 1;
  /**
   * The highest X-MBX-USED-WEIGHT-1M reading for the fixed minute its request was SENT in, and the
   * ticket of that request. Binance's counter only rises within a minute.
   */
  private header: { minute: number; used: number; ticket: number } | null = null;
  private readonly waiters: Record<Lane, Waiter[]> = { critical: [], bulk: [] };
  private disposed = false;
  private cancelWake: (() => void) | null = null;
  private lastWaitLog = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: WeightBudgetDeps) {
    this.budget = d.budget ?? WEIGHT_BUDGET_1M;
    this.maxWaitMs = d.maxWaitMs ?? BUDGET_MAX_WAIT_MS;
    this.bulkHeadroom = d.bulkHeadroom ?? BULK_HEADROOM;
  }

  /** Our own reservations in the rolling window. */
  get localWeight(): number {
    this.prune();
    return this.reserved.reduce((a, r) => a + r.weight, 0);
  }

  /** Binance's reading plus what we reserved after the request that carried it; null if not from this minute. */
  get headerWeight(): number | null {
    const h = this.header;
    if (!h || h.minute !== minuteOf(this.d.now())) return null;
    this.prune();
    return h.used + this.reserved.reduce((a, r) => (r.ticket > h.ticket ? a + r.weight : a), 0);
  }

  /** Effective used weight: the larger of the local estimate and the header-based one. */
  get usedWeight(): number {
    return Math.max(this.localWeight, this.headerWeight ?? 0);
  }

  /** Resolves with a ticket once `weight` fits, behind earlier waiters of its lane (and, for bulk, all critical ones). */
  acquire(weight: number, lane: Lane = 'bulk'): Promise<number> {
    if (this.disposed) return Promise.reject(new Error(CLIENT_CLOSED));
    if (weight > this.budget) return Promise.reject(new Error(BUDGET_EXHAUSTED));
    const ahead = lane === 'critical' ? this.waiters.critical.length : this.waiting();
    if (ahead === 0 && this.fits(weight, lane)) return Promise.resolve(this.reserve(weight));
    return new Promise<number>((resolve, reject) => {
      const w: Waiter = { weight, lane, resolve, reject, cancelDeadline: () => {} };
      w.cancelDeadline = this.d.setTimer(() => {
        this.remove(w);
        reject(new Error(BUDGET_EXHAUSTED));
        this.pump(); // a large head leaving can let smaller ones through
      }, this.maxWaitMs);
      this.waiters[lane].push(w);
      this.logWait();
      this.pump();
    });
  }

  /** The request holding `ticket` goes out now: its weight counts for 60 s from here. */
  markSent(ticket: number): void {
    const r = this.reserved.find((x) => x.ticket === ticket);
    if (r) r.at = this.d.now();
  }

  /**
   * Records X-MBX-USED-WEIGHT-1M from the response to the request holding `ticket`, sent at
   * `sentAt`. The reading belongs to the minute the request was sent in, however late it arrives.
   */
  recordHeader(used: number, ticket: number, sentAt: number): void {
    const minute = minuteOf(sentAt);
    const h = this.header;
    if (h && (minute < h.minute || (minute === h.minute && used <= h.used))) return;
    this.header = { minute, used, ticket };
  }

  /** Rejects every waiting request; used when all REST calls are paused. */
  rejectAll(message: string): void {
    for (const w of [...this.waiters.critical.splice(0), ...this.waiters.bulk.splice(0)]) {
      w.cancelDeadline();
      w.reject(new Error(message));
    }
    this.cancelWake?.();
    this.cancelWake = null;
  }

  /** Rejects everything waiting and every later request; nothing queued is sent afterwards. */
  dispose(): void {
    this.disposed = true;
    this.rejectAll(CLIENT_CLOSED);
  }

  private waiting(): number {
    return this.waiters.critical.length + this.waiters.bulk.length;
  }

  private fits(weight: number, lane: Lane): boolean {
    return this.usedWeight + weight <= this.budget - (lane === 'bulk' ? this.bulkHeadroom : 0);
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
    const q = this.waiters[w.lane];
    const i = q.indexOf(w);
    if (i >= 0) q.splice(i, 1);
  }

  /** Releases waiters while they fit (critical lane first; bulk only once it is empty), then sleeps until weight can next free up. */
  private pump(): void {
    for (const lane of ['critical', 'bulk'] as const) {
      const q = this.waiters[lane];
      while (q[0] && this.fits(q[0].weight, lane)) {
        const w = q.shift()!;
        w.cancelDeadline();
        w.resolve(this.reserve(w.weight));
      }
      if (q.length > 0) break;
    }
    this.cancelWake?.();
    this.cancelWake = null;
    if (this.waiting() === 0) return;
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
