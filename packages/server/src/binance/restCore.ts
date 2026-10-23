import type { Logger } from '../log.ts';
import { CLIENT_CLOSED } from './weightBudget.ts';
import type { Lane, WeightBudget } from './weightBudget.ts';

const DEFAULT_429_PAUSE_S = 60;
const MAX_429_ESCALATION_S = 900;
const DEFAULT_418_PAUSE_S = 900;
const REQUEST_TIMEOUT_MS = 10_000;

// Raw Binance shapes, typed loosely on purpose.
export type RawJson = any;

export const quietLogger: Logger = { info() {}, warn() {}, error() {} };

/** Retry-After in seconds, or null when missing or unusable. */
export function retryAfter(res: Response): number | null {
  const ra = Number(res.headers?.get?.('retry-after') ?? Number.NaN);
  return Number.isFinite(ra) && ra > 0 ? ra : null;
}

/**
 * The single REST pause for this IP, shared by every Binance REST client (spot, futures, the
 * public web endpoint). Binance limits and bans by IP, so an HTTP 429 or 418 from any host stops
 * every REST call on every host, and the requests each client has queued are dropped.
 *
 * 429: pause for Retry-After (60 s if missing). Consecutive 429s escalate 60, 120, 240 ... capped at
 * 15 min; only a success for a request sent after the last pause began resets the count, and a 429
 * for a request already in flight when the pause began neither escalates nor logs again.
 * 418 (IP banned): pause for Retry-After (15 min if missing).
 */
export class PauseController {
  private pausedUntilMs = 0;
  /** Consecutive 429s with no successful response in between. */
  private strikes = 0;
  /** End of the pause set by the last counted 429; a 429 for a request sent before it does not escalate. */
  private strikePauseEnd = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<(message: string) => void>();

  constructor(
    /** The clock every client sharing this pause uses. */
    readonly now: () => number,
    private readonly log: Logger = quietLogger,
  ) {}

  /** Epoch ms before which no REST call is made (after an HTTP 429/418); 0 if never paused. */
  get pausedUntil(): number {
    return this.pausedUntilMs;
  }

  pausedMessage(): string {
    return `Binance REST paused for ${Math.ceil((this.pausedUntilMs - this.now()) / 1000)}s (rate limited)`;
  }

  assertNotPaused(): void {
    if (this.now() < this.pausedUntilMs) throw new Error(this.pausedMessage());
  }

  /** Calls `fn` with the pause message whenever a pause starts or grows; returns an unsubscribe. */
  onPause(fn: (message: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Records an HTTP 429/418 for a request sent at `sentAt`. `host` names the client in the log line
   * (e.g. 'Binance REST'); `figures` describes its weight use.
   */
  rateLimited(status: 429 | 418, res: Response, sentAt: number, host: string, figures: string): void {
    const ra = retryAfter(res);
    if (status === 418) {
      const seconds = ra ?? DEFAULT_418_PAUSE_S;
      this.pause(seconds);
      this.log.error(`${host} HTTP 418 (IP banned; ${figures}); no REST calls for ${seconds}s`);
      return;
    }
    if (sentAt >= this.strikePauseEnd) {
      this.strikes++;
      const escalation = this.strikes >= 2 ? Math.min(DEFAULT_429_PAUSE_S * 2 ** (this.strikes - 1), MAX_429_ESCALATION_S) : 0;
      const seconds = Math.max(ra ?? DEFAULT_429_PAUSE_S, escalation);
      this.pause(seconds);
      this.strikePauseEnd = this.pausedUntilMs;
      this.log.warn(`${host} HTTP 429 (${figures}); pausing all REST calls for ${seconds}s`);
    } else {
      this.pause(ra ?? DEFAULT_429_PAUSE_S); // in flight when the pause began: no escalation, no new log
    }
  }

  /** A successful response to a request sent at `sentAt`. */
  succeeded(sentAt: number): void {
    // Only a request sent after the last 429 pause proves the limit has cleared.
    if (sentAt >= this.strikePauseEnd) this.strikes = 0;
  }

  private pause(seconds: number): void {
    this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + seconds * 1000);
    const message = this.pausedMessage();
    for (const fn of [...this.listeners]) fn(message); // queued requests are never sent
  }
}

export interface RestCoreDeps {
  base: string;
  /** Names the client in log lines, e.g. 'Binance REST'. */
  host: string;
  /** Binance's own request-weight limit per minute on this host, for log lines. */
  weightLimit1m: number;
  fetchImpl: typeof fetch;
  now: () => number;
  weights: WeightBudget;
  pause: PauseController;
}

export interface RequestOptions {
  /** Request weight to reserve first; 0 sends without touching the weight budget. */
  weight: number;
  lane: Lane;
  headers?: Record<string, string>;
}

/**
 * Sends GET requests for one Binance REST host: reserves weight, honours the shared pause,
 * reconciles with X-MBX-USED-WEIGHT-1M, and reports 429/418 to the pause. Nothing here retries.
 * Error messages name the path only, never the query (which may carry a signature).
 */
export class RestCore {
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly d: RestCoreDeps) {
    this.unsubscribe = d.pause.onPause((message) => d.weights.rejectAll(message));
  }

  get usedWeight(): number {
    return this.d.weights.usedWeight;
  }

  get budget(): number {
    return this.d.weights.budget;
  }

  get pausedUntil(): number {
    return this.d.pause.pausedUntil;
  }

  /** Throws when the client is closed or REST is paused. */
  assertUsable(): void {
    if (this.closed) throw new Error(CLIENT_CLOSED);
    this.d.pause.assertNotPaused();
  }

  /** Rejects queued requests and every later call; for shutdown. */
  dispose(): void {
    this.closed = true;
    this.unsubscribe();
    this.d.weights.dispose();
  }

  async get(path: string, query: string, opts: RequestOptions): Promise<RawJson> {
    this.assertUsable();
    const ticket = opts.weight > 0 ? await this.d.weights.acquire(opts.weight, opts.lane) : null;
    this.assertUsable();
    const sentAt = this.d.now();
    if (ticket !== null) this.d.weights.markSent(ticket);
    const init: RequestInit = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (opts.headers) init.headers = opts.headers;
    const res = await this.d.fetchImpl(`${this.d.base}${path}${query ? `?${query}` : ''}`, init);
    const used = Number(res.headers?.get?.('x-mbx-used-weight-1m') ?? Number.NaN);
    const header = Number.isFinite(used) && used >= 0 ? used : null;
    if (header !== null && ticket !== null) this.d.weights.recordHeader(header, ticket, sentAt);
    if (res.status === 429 || res.status === 418) {
      this.d.pause.rateLimited(res.status, res, sentAt, this.d.host, this.figures(header));
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Binance ${path} HTTP ${res.status}: ${body}`);
    }
    this.d.pause.succeeded(sentAt);
    return res.json();
  }

  private figures(header: number | null): string {
    const w = this.d.weights;
    return `used weight ${header ?? 'unknown'}/${this.d.weightLimit1m} reported, ${w.localWeight}/${w.budget} local estimate`;
  }
}
