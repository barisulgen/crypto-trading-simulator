import { createHmac } from 'node:crypto';
import { redact } from '../log.ts';
import type { Logger } from '../log.ts';
import { defaultSetTimer } from '../market/ws.ts';
import type { SetTimer } from '../market/ws.ts';
import { aggTradesQuery, quietLogger, RestCore } from './restCore.ts';
import type { AggTradesQuery, PauseController, RawJson } from './restCore.ts';
import { BUDGET_EXHAUSTED, BUDGET_MAX_WAIT_MS, CLIENT_CLOSED, WeightBudget } from './weightBudget.ts';
import type { Lane } from './weightBudget.ts';

const BASE = 'https://fapi.binance.com';
/** Binance's USDⓈ-M futures REST limit: request weight per minute per IP. */
export const FUTURES_WEIGHT_LIMIT_1M = 2400;
/** We never go above 80 % of it. */
export const FUTURES_WEIGHT_BUDGET_1M = 1920;
/** Depth snapshots (bulk) stop this far short of the budget. */
export const FUTURES_BULK_HEADROOM = 200;
/** fundingRate and fundingInfo share Binance's 500 calls per 5 min: at most one call per 2 s. */
export const FUNDING_SPACING_MS = 2000;
export const RECV_WINDOW_MS = 5000;

const FIXED_WEIGHTS: Record<string, number> = {
  '/fapi/v1/exchangeInfo': 1,
  '/fapi/v1/aggTrades': 20,
  '/fapi/v1/leverageBracket': 1,
  '/fapi/v1/time': 1,
  // Not counted in the request weight; limited by the funding lane instead.
  '/fapi/v1/fundingRate': 0,
  '/fapi/v1/fundingInfo': 0,
};

const klineWeight = (limit: number) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);

/** The documented request weight of a futures REST call. */
export function futuresRequestWeight(path: string, query: string): number {
  const q = new URLSearchParams(query);
  if (path === '/fapi/v1/depth') {
    const limit = Number(q.get('limit') ?? 500);
    return limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20;
  }
  if (path === '/fapi/v1/klines' || path === '/fapi/v1/markPriceKlines') return klineWeight(Number(q.get('limit') ?? 500));
  if (path === '/fapi/v1/premiumIndex') return q.has('symbol') ? 1 : 10;
  const w = FIXED_WEIGHTS[path];
  if (w === undefined) throw new Error(`No known request weight for ${path}`);
  return w;
}

/**
 * Depth snapshots are bulk; everything else (aggTrades, klines, mark price, rules, time) is
 * critical unless the caller asks for the bulk lane (the history catch-up fetches do).
 */
export function futuresRequestLane(path: string): Lane {
  return path === '/fapi/v1/depth' ? 'bulk' : 'critical';
}

export interface FundingLaneDeps {
  now: () => number;
  setTimer: SetTimer;
  spacingMs?: number;
  maxWaitMs?: number;
}

interface LaneWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
  cancelDeadline: () => void;
}

/** Releases at most one call per `spacingMs`, first come first served; a call waiting too long rejects. */
export class FundingLane {
  private lastAt = Number.NEGATIVE_INFINITY;
  private queue: LaneWaiter[] = [];
  private cancelWake: (() => void) | null = null;
  private closed = false;
  private readonly spacingMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly d: FundingLaneDeps) {
    this.spacingMs = d.spacingMs ?? FUNDING_SPACING_MS;
    this.maxWaitMs = d.maxWaitMs ?? BUDGET_MAX_WAIT_MS;
  }

  acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(CLIENT_CLOSED));
    if (this.queue.length === 0 && this.d.now() >= this.lastAt + this.spacingMs) {
      this.lastAt = this.d.now();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: LaneWaiter = { resolve, reject, cancelDeadline: () => {} };
      w.cancelDeadline = this.d.setTimer(() => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(BUDGET_EXHAUSTED));
      }, this.maxWaitMs);
      this.queue.push(w);
      this.pump();
    });
  }

  rejectAll(message: string): void {
    for (const w of this.queue.splice(0)) {
      w.cancelDeadline();
      w.reject(new Error(message));
    }
    this.cancelWake?.();
    this.cancelWake = null;
  }

  dispose(): void {
    this.closed = true;
    this.rejectAll(CLIENT_CLOSED);
  }

  private pump(): void {
    this.cancelWake?.();
    this.cancelWake = null;
    const head = this.queue[0];
    if (!head) return;
    const now = this.d.now();
    if (now >= this.lastAt + this.spacingMs) {
      this.queue.shift();
      head.cancelDeadline();
      this.lastAt = now;
      head.resolve();
      if (this.queue.length === 0) return;
    }
    this.cancelWake = this.d.setTimer(() => {
      this.cancelWake = null;
      this.pump();
    }, Math.max(1, this.lastAt + this.spacingMs - this.d.now()));
  }
}

export interface FuturesRestOptions {
  setTimer?: SetTimer;
  logger?: Logger;
  /** Longest a request waits for weight budget or its funding slot before it rejects (default 30 s). */
  maxWaitMs?: number;
  /** The REST pause shared with the other Binance clients on this IP: limits and bans are per IP. */
  pause: PauseController;
}

export type { AggTradesQuery } from './restCore.ts';

export interface FundingRateQuery {
  symbol: string;
  startTime: number;
  endTime: number;
  limit: number;
}

const opt = (key: string, v: number | undefined) => (v === undefined ? '' : `&${key}=${v}`);

/**
 * USDⓈ-M futures REST (fapi), with its own weight budget (1920 of Binance's 2400 per minute) and a
 * funding lane; the 429/418 pause is shared with the spot client. The API key is used only by the
 * signed leverageBracket call and is never logged.
 */
export class FuturesRest {
  private readonly core: RestCore;
  private readonly funding: FundingLane;
  private readonly unsubscribe: () => void;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    opts: FuturesRestOptions,
  ) {
    const logger = opts.logger ?? quietLogger;
    const setTimer = opts.setTimer ?? defaultSetTimer;
    const pause = opts.pause;
    const weights = new WeightBudget({
      now,
      setTimer,
      logger,
      maxWaitMs: opts.maxWaitMs,
      budget: FUTURES_WEIGHT_BUDGET_1M,
      bulkHeadroom: FUTURES_BULK_HEADROOM,
      host: 'Binance futures REST',
    });
    this.core = new RestCore({
      base: BASE,
      host: 'Binance futures REST',
      weightLimit1m: FUTURES_WEIGHT_LIMIT_1M,
      fetchImpl,
      now,
      weights,
      pause,
    });
    this.funding = new FundingLane({ now, setTimer, maxWaitMs: opts.maxWaitMs });
    this.unsubscribe = pause.onPause((message) => this.funding.rejectAll(message));
  }

  /** Epoch ms before which no REST call is made (after an HTTP 429/418 on any Binance host); 0 if not paused. */
  get pausedUntil(): number {
    return this.core.pausedUntil;
  }

  /** Effective used futures request weight of the last 60 s. */
  get usedWeight(): number {
    return this.core.usedWeight;
  }

  /** The most futures weight we use per 60 s. */
  get budget(): number {
    return this.core.budget;
  }

  /** Rejects queued requests and every later call; for shutdown. */
  dispose(): void {
    this.unsubscribe();
    this.funding.dispose();
    this.core.dispose();
  }

  /** `query` as a function is built only when the request is sent (see RestCore.get); `weightQuery` then prices it. */
  private get(
    path: string,
    query: string | (() => string),
    headers?: Record<string, string>,
    weightQuery = '',
    lane: Lane = futuresRequestLane(path),
  ): Promise<RawJson> {
    const weight = futuresRequestWeight(path, typeof query === 'string' ? query : weightQuery);
    return this.core.get(path, query, { weight, lane, headers });
  }

  private async fundingGet(path: string, query: string): Promise<RawJson> {
    this.core.assertUsable();
    await this.funding.acquire();
    return this.core.get(path, query, { weight: 0, lane: 'critical' });
  }

  /** All futures symbols (the endpoint takes no symbol filter). */
  exchangeInfo(): Promise<RawJson> {
    return this.get('/fapi/v1/exchangeInfo', '');
  }

  depth(symbol: string, limit = 1000): Promise<RawJson> {
    return this.get('/fapi/v1/depth', `symbol=${symbol}&limit=${limit}`);
  }

  /** `lane` 'bulk' for history fetched by catch-up, so it waits behind the live requests. */
  aggTrades(q: AggTradesQuery, lane?: Lane): Promise<RawJson> {
    return this.get('/fapi/v1/aggTrades', aggTradesQuery(q), undefined, '', lane);
  }

  klines(symbol: string, interval: string, limit: number, startTime?: number, endTime?: number, lane?: Lane): Promise<RawJson> {
    return this.get(
      '/fapi/v1/klines',
      `symbol=${symbol}&interval=${interval}&limit=${limit}${opt('startTime', startTime)}${opt('endTime', endTime)}`,
      undefined,
      '',
      lane,
    );
  }

  markPriceKlines(
    symbol: string,
    interval: '1m',
    limit: number,
    startTime: number,
    endTime: number,
    lane?: Lane,
  ): Promise<RawJson> {
    return this.get(
      '/fapi/v1/markPriceKlines',
      `symbol=${symbol}&interval=${interval}&limit=${limit}&startTime=${startTime}&endTime=${endTime}`,
      undefined,
      '',
      lane,
    );
  }

  /** Mark price, index price and next funding for every symbol. */
  premiumIndex(): Promise<RawJson> {
    return this.get('/fapi/v1/premiumIndex', '');
  }

  fundingInfo(): Promise<RawJson> {
    return this.fundingGet('/fapi/v1/fundingInfo', '');
  }

  fundingRate(q: FundingRateQuery): Promise<RawJson> {
    return this.fundingGet(
      '/fapi/v1/fundingRate',
      `symbol=${q.symbol}&startTime=${q.startTime}&endTime=${q.endTime}&limit=${q.limit}`,
    );
  }

  serverTime(): Promise<RawJson> {
    return this.get('/fapi/v1/time', '');
  }

  /**
   * The signed leverage brackets of every symbol. The timestamp is corrected to Binance's clock and
   * taken when the request is sent, after any wait for weight, so the queue never eats into
   * recvWindow. Errors are scrubbed of the key, the secret and the signature before they leave here.
   */
  async leverageBracket(key: string, secret: string): Promise<RawJson> {
    const before = this.now();
    const time = await this.serverTime();
    const after = this.now();
    const serverTime = Number(time?.serverTime);
    if (!Number.isSafeInteger(serverTime)) throw new Error('Binance /fapi/v1/time returned no serverTime');
    const offset = serverTime - Math.round((before + after) / 2);
    let signature: string | null = null;
    const signedQuery = () => {
      const unsigned = `timestamp=${this.now() + offset}&recvWindow=${RECV_WINDOW_MS}`;
      signature = createHmac('sha256', secret).update(unsigned).digest('hex');
      return `${unsigned}&signature=${signature}`;
    };
    try {
      return await this.get('/fapi/v1/leverageBracket', signedQuery, { 'X-MBX-APIKEY': key });
    } catch (e) {
      const secrets = signature === null ? [key, secret] : [key, secret, signature];
      throw new Error(redact(e instanceof Error ? e.message : String(e), secrets));
    }
  }
}
