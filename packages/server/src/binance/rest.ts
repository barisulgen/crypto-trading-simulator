import type { Logger } from '../log.ts';
import { defaultSetTimer } from '../market/ws.ts';
import type { SetTimer } from '../market/ws.ts';
import { requestWeight, WEIGHT_LIMIT_1M, WeightBudget } from './weightBudget.ts';

const BASE = 'https://api.binance.com';
const DEFAULT_429_PAUSE_S = 60;
const MAX_429_ESCALATION_S = 900;
const DEFAULT_418_PAUSE_S = 900;

// Raw Binance shapes, typed loosely on purpose.
export type RawJson = any;

export interface BinanceRestOptions {
  setTimer?: SetTimer;
  logger?: Logger;
  /** Longest a request waits for weight budget before it rejects (default 30 s). */
  maxWaitMs?: number;
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

/** Retry-After in seconds, or null when missing or unusable. */
function retryAfter(res: Response): number | null {
  const ra = Number(res.headers?.get?.('retry-after') ?? Number.NaN);
  return Number.isFinite(ra) && ra > 0 ? ra : null;
}

/**
 * Public spot REST endpoints. Every request first gets room in the weight budget; HTTP 429 / 418
 * pause ALL calls. Nothing here retries: callers keep their own backoff.
 */
export class BinanceRest {
  private pausedUntilMs = 0;
  private readonly weights: WeightBudget;
  private readonly log: Logger;
  /** Consecutive 429s with no successful response in between. */
  private strikes = 0;
  /** End of the pause set by the last counted 429; a 429 for a request sent before it does not escalate. */
  private strikePauseEnd = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    opts: BinanceRestOptions = {},
  ) {
    this.log = opts.logger ?? quiet;
    this.weights = new WeightBudget({
      now,
      setTimer: opts.setTimer ?? defaultSetTimer,
      logger: this.log,
      maxWaitMs: opts.maxWaitMs,
    });
  }

  /** Epoch ms before which no REST call is made (after an HTTP 429/418); 0 if not paused. */
  get pausedUntil(): number {
    return this.pausedUntilMs;
  }

  /** Effective used request weight of the last 60 s (local estimate or Binance's reading, whichever is larger). */
  get usedWeight(): number {
    return this.weights.usedWeight;
  }

  /** The most weight we use per 60 s. */
  get budget(): number {
    return this.weights.budget;
  }

  private pausedMessage(): string {
    return `Binance REST paused for ${Math.ceil((this.pausedUntilMs - this.now()) / 1000)}s (rate limited)`;
  }

  private assertNotPaused(): void {
    if (this.now() < this.pausedUntilMs) throw new Error(this.pausedMessage());
  }

  private pause(seconds: number): void {
    this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + seconds * 1000);
    this.weights.rejectAll(this.pausedMessage()); // queued requests are never sent
  }

  private weightFigures(header: number | null): string {
    return `used weight ${header ?? 'unknown'}/${WEIGHT_LIMIT_1M} reported, ${this.weights.localWeight}/${this.budget} local estimate`;
  }

  private onRateLimited(status: 429 | 418, res: Response, sentAt: number, header: number | null): void {
    const ra = retryAfter(res);
    if (status === 418) {
      const seconds = ra ?? DEFAULT_418_PAUSE_S;
      this.pause(seconds);
      this.log.error(`Binance REST HTTP 418 (IP banned; ${this.weightFigures(header)}); no REST calls for ${seconds}s`);
      return;
    }
    if (sentAt >= this.strikePauseEnd) {
      this.strikes++;
      const escalation = this.strikes >= 2 ? Math.min(DEFAULT_429_PAUSE_S * 2 ** (this.strikes - 1), MAX_429_ESCALATION_S) : 0;
      const seconds = Math.max(ra ?? DEFAULT_429_PAUSE_S, escalation);
      this.pause(seconds);
      this.strikePauseEnd = this.pausedUntilMs;
      this.log.warn(`Binance REST HTTP 429 (${this.weightFigures(header)}); pausing all REST calls for ${seconds}s`);
    } else {
      this.pause(ra ?? DEFAULT_429_PAUSE_S); // in flight when the pause began: no escalation, no new log
    }
  }

  private async get(path: string, query: string): Promise<RawJson> {
    this.assertNotPaused();
    const ticket = await this.weights.acquire(requestWeight(path, query));
    this.assertNotPaused();
    const sentAt = this.now();
    this.weights.markSent(ticket);
    const res = await this.fetchImpl(`${BASE}${path}${query ? `?${query}` : ''}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const used = Number(res.headers?.get?.('x-mbx-used-weight-1m') ?? Number.NaN);
    const header = Number.isFinite(used) && used >= 0 ? used : null;
    if (header !== null) this.weights.recordHeader(header, ticket);
    if (res.status === 429 || res.status === 418) this.onRateLimited(res.status, res, sentAt, header);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Binance ${path} HTTP ${res.status}: ${body}`);
    }
    this.strikes = 0;
    return res.json();
  }

  exchangeInfo(symbols: string[]): Promise<RawJson> {
    return this.get('/api/v3/exchangeInfo', `symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  }

  depth(symbol: string, limit = 1000): Promise<RawJson> {
    return this.get('/api/v3/depth', `symbol=${symbol}&limit=${limit}`);
  }

  avgPrice(symbol: string): Promise<RawJson> {
    return this.get('/api/v3/avgPrice', `symbol=${symbol}`);
  }

  klines(symbol: string, interval: string, limit: number, endTime?: number): Promise<RawJson> {
    const end = endTime === undefined ? '' : `&endTime=${endTime}`;
    return this.get('/api/v3/klines', `symbol=${symbol}&interval=${interval}&limit=${limit}${end}`);
  }

  serverTime(): Promise<RawJson> {
    return this.get('/api/v3/time', '');
  }
}
