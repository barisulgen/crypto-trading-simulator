import type { Logger } from '../log.ts';
import { DEFAULT_ENDPOINTS } from './endpoints.ts';
import { defaultSetTimer } from '../market/ws.ts';
import type { SetTimer } from '../market/ws.ts';
import { aggTradesQuery, PauseController, quietLogger, RestCore } from './restCore.ts';
import type { AggTradesQuery, RawJson } from './restCore.ts';
import { requestLane, requestWeight, WEIGHT_LIMIT_1M, WeightBudget } from './weightBudget.ts';
import type { Lane } from './weightBudget.ts';

export type { AggTradesQuery, RawJson } from './restCore.ts';

export interface BinanceRestOptions {
  setTimer?: SetTimer;
  logger?: Logger;
  /** Longest a request waits for weight budget before it rejects (default 30 s). */
  maxWaitMs?: number;
  /** The REST pause shared with the other Binance clients on this IP (default: a pause of its own). */
  pause?: PauseController;
  /** The spot REST base address (default: live Binance). */
  base?: string;
}

/**
 * Public spot REST endpoints. Every request first gets room in the weight budget; HTTP 429 / 418
 * pause ALL calls (see PauseController). Nothing here retries: callers keep their own backoff.
 */
export class BinanceRest {
  private readonly core: RestCore;

  constructor(fetchImpl: typeof fetch = fetch, now: () => number = Date.now, opts: BinanceRestOptions = {}) {
    const logger = opts.logger ?? quietLogger;
    const weights = new WeightBudget({ now, setTimer: opts.setTimer ?? defaultSetTimer, logger, maxWaitMs: opts.maxWaitMs });
    this.core = new RestCore({
      base: opts.base ?? DEFAULT_ENDPOINTS.spotRest,
      host: 'Binance REST',
      weightLimit1m: WEIGHT_LIMIT_1M,
      fetchImpl,
      now,
      weights,
      pause: opts.pause ?? new PauseController(now, logger),
    });
  }

  /** Epoch ms before which no REST call is made (after an HTTP 429/418); 0 if not paused. */
  get pausedUntil(): number {
    return this.core.pausedUntil;
  }

  /** Effective used request weight of the last 60 s (local estimate or Binance's reading, whichever is larger). */
  get usedWeight(): number {
    return this.core.usedWeight;
  }

  /** The most weight we use per 60 s. */
  get budget(): number {
    return this.core.budget;
  }

  /** Rejects queued requests and every later call; for shutdown. */
  dispose(): void {
    this.core.dispose();
  }

  private get(path: string, query: string, lane: Lane = requestLane(path)): Promise<RawJson> {
    return this.core.get(path, query, { weight: requestWeight(path, query), lane });
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

  /**
   * Klines ending by `endTime` (the latest when omitted), from `opts.startTime` when given. History
   * fetched for catch-up asks for the bulk lane, so it waits behind the live requests.
   */
  klines(
    symbol: string,
    interval: string,
    limit: number,
    endTime?: number,
    opts: { startTime?: number; lane?: Lane } = {},
  ): Promise<RawJson> {
    const start = opts.startTime === undefined ? '' : `&startTime=${opts.startTime}`;
    const end = endTime === undefined ? '' : `&endTime=${endTime}`;
    return this.get('/api/v3/klines', `symbol=${symbol}&interval=${interval}&limit=${limit}${start}${end}`, opts.lane);
  }

  /** Aggregate trades (only catch-up asks for them): always in the bulk lane. */
  aggTrades(q: AggTradesQuery): Promise<RawJson> {
    return this.get('/api/v3/aggTrades', aggTradesQuery(q));
  }

  serverTime(): Promise<RawJson> {
    return this.get('/api/v3/time', '');
  }
}
