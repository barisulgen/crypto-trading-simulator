import { EventEmitter } from 'node:events';
import { D } from '@sim/engine';
import type { Decimal } from '@sim/engine';
import type { Logger } from '../log.ts';
import { DEFAULT_ENDPOINTS, perpDepthStreamUrl, perpMarketStreamUrl } from '../binance/endpoints.ts';
import type { FuturesRest } from '../binance/futuresRest.ts';
import { BookSync } from './bookSync.ts';
import { FeedHealth } from './feedHealth.ts';
import type { HealthCfg } from './feedHealth.ts';
import { FeedSocket } from './feedSocket.ts';
import type { LocalBook } from './localBook.ts';
import { eventTime, LimitedWarn, onAggTrade, onMiniTicker, positive } from './streamParse.ts';
import type { StreamSink } from './streamParse.ts';
import { defaultSetTimer, defaultWsFactory } from './ws.ts';
import type { ConnectLimiter, SetTimer, WsFactory } from './ws.ts';

/** USDⓈ-M futures depth streams are served only on the public endpoint. */
export const PERP_DEPTH_URL = perpDepthStreamUrl(DEFAULT_ENDPOINTS);
/** Trades, mark price and tickers are served only on the market endpoint. */
export const PERP_MARKET_URL = perpMarketStreamUrl(DEFAULT_ENDPOINTS);

/** One markPriceUpdate: mark, index, the current funding rate and when it is next settled. */
export interface MarkUpdate {
  markPrice: Decimal;
  indexPrice: Decimal;
  fundingRate: Decimal;
  /** Epoch ms of the next funding settlement. */
  nextFundingTime: number;
  /** Binance's event time, epoch ms. */
  eventTime: number;
}

/** The health of the two perp connections: depth, and trades + mark price + tickers. */
export interface PerpHealth {
  depth: FeedHealth;
  market: FeedHealth;
}

export function perpHealth(symbols: string[], cfg: HealthCfg): PerpHealth {
  return {
    depth: new FeedHealth(symbols, cfg, { streams: ['depth'] }),
    market: new FeedHealth(symbols, cfg, { streams: ['trade', 'ticker', 'mark'] }),
  };
}

const RATE = /^-?\d+(\.\d+)?$/;

/** A markPriceUpdate's fields as a MarkUpdate, or null if any is missing or malformed. */
export function parseMarkUpdate(d: any): MarkUpdate | null {
  const markPrice = positive(d?.p);
  const indexPrice = positive(d?.i);
  if (markPrice === null || indexPrice === null) return null;
  if (typeof d.r !== 'string' || !RATE.test(d.r)) return null;
  if (!Number.isSafeInteger(d.T) || d.T <= 0 || !Number.isFinite(d.E)) return null;
  return { markPrice, indexPrice, fundingRate: D(d.r), nextFundingTime: d.T, eventTime: d.E };
}

export interface PerpFeedDeps {
  symbols: string[];
  rest: Pick<FuturesRest, 'depth'>;
  health: PerpHealth;
  /** Futures-mode books, one per symbol. */
  books: Map<string, LocalBook>;
  logger: Logger;
  wsFactory?: WsFactory;
  now?: () => number;
  setTimer?: SetTimer;
  /** Terminate a socket when no frame arrived on it for this long (default 30 s = 2 x silentMs). */
  watchdogMs?: number;
  /** Shared by every Binance socket of this process; none when absent. */
  limiter?: ConnectLimiter;
  /** The depth and market combined-stream addresses before the stream names (default PERP_DEPTH_URL, PERP_MARKET_URL). */
  depthUrl?: string;
  marketUrl?: string;
}

/**
 * The USDⓈ-M perpetual streams of all symbols over two sockets, each with its own connection
 * health, watchdog and reconnect backoff: the depth socket (per-symbol book sync from futures
 * snapshots by the futures update-id rules) and the market socket (aggTrade, markPrice@1s and
 * miniTicker). Emits 'trade' (symbol, AggTrade), 'ticker' (symbol, Ticker), 'mark' (symbol,
 * MarkUpdate), 'book' (symbol, DepthLevels) after each applied depth update and 'snapshot'
 * (symbol) whenever a book is replaced. A socket's backoff starts over once every symbol has
 * synced its book (depth) or sent a mark price (market) on the new connection.
 */
export class PerpFeed extends EventEmitter {
  readonly health: PerpHealth;
  private readonly symbols: string[];
  private readonly warn: LimitedWarn;
  private readonly sink: StreamSink;
  private readonly sync: BookSync;
  private readonly depthSocket: FeedSocket;
  private readonly marketSocket: FeedSocket;
  private syncedSinceConnect = new Set<string>();
  private markedSinceConnect = new Set<string>();

  constructor(d: PerpFeedDeps) {
    super();
    this.symbols = d.symbols;
    this.health = d.health;
    const now = d.now ?? Date.now;
    const setTimer = d.setTimer ?? defaultSetTimer;
    this.warn = new LimitedWarn(d.logger, now);
    this.sink = { name: 'perp feed', health: d.health.market, warn: this.warn, emit: (event, ...args) => this.emit(event, ...args) };
    this.sync = new BookSync({
      name: 'perp feed',
      mode: 'futures',
      symbols: d.symbols,
      books: d.books,
      health: d.health.depth,
      depth: (symbol, limit) => d.rest.depth(symbol, limit),
      logger: d.logger,
      setTimer,
      emit: (event, ...args) => this.emit(event, ...args),
      onSynced: (symbol) => {
        this.syncedSinceConnect.add(symbol);
        if (this.syncedSinceConnect.size === this.symbols.length) this.depthSocket.resetBackoff();
      },
    });
    const common = {
      symbols: d.symbols,
      logger: d.logger,
      warn: this.warn,
      wsFactory: d.wsFactory ?? defaultWsFactory,
      now,
      setTimer,
      watchdogMs: d.watchdogMs ?? 30_000,
      limiter: d.limiter,
    };
    const lower = d.symbols.map((s) => s.toLowerCase());
    this.depthSocket = new FeedSocket({
      ...common,
      name: 'perp depth feed',
      url: (d.depthUrl ?? PERP_DEPTH_URL) + lower.map((l) => `${l}@depth@100ms`).join('/'),
      health: d.health.depth,
      onOpen: () => {
        this.syncedSinceConnect = new Set();
        this.sync.resyncAll();
      },
      onMessage: (symbol, kind, data, at) => {
        if (kind.startsWith('depth')) this.sync.onDepth(symbol, data, at);
      },
      onDown: () => this.sync.reset(),
    });
    this.marketSocket = new FeedSocket({
      ...common,
      name: 'perp market feed',
      url: (d.marketUrl ?? PERP_MARKET_URL) + lower.flatMap((l) => [`${l}@aggTrade`, `${l}@markPrice@1s`, `${l}@miniTicker`]).join('/'),
      health: d.health.market,
      onOpen: () => {
        this.markedSinceConnect = new Set();
      },
      onMessage: (symbol, kind, data, at) => {
        if (kind === 'aggTrade') onAggTrade(this.sink, symbol, data, at);
        else if (kind.startsWith('markPrice')) this.onMark(symbol, data, at);
        else if (kind === 'miniTicker') onMiniTicker(this.sink, symbol, data, at);
      },
      onDown: () => {},
    });
  }

  start(): void {
    this.depthSocket.start();
    this.marketSocket.start();
  }

  close(): void {
    this.depthSocket.close();
    this.marketSocket.close();
    this.sync.close();
  }

  private onMark(symbol: string, data: any, now: number): void {
    const mark = parseMarkUpdate(data);
    this.health.market.onMark(symbol, now, eventTime(mark !== null, data));
    if (!mark) {
      this.warn.warn(`${symbol}:markPrice`, `perp feed: invalid markPrice for ${symbol}; dropped`);
      return;
    }
    this.markedSinceConnect.add(symbol);
    if (this.markedSinceConnect.size === this.symbols.length) this.marketSocket.resetBackoff();
    this.emit('mark', symbol, mark);
  }
}
