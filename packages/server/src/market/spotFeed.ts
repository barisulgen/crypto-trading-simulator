import { EventEmitter } from 'node:events';
import type { Logger } from '../log.ts';
import type { BinanceRest } from '../binance/rest.ts';
import { BookSync } from './bookSync.ts';
import type { FeedHealth } from './feedHealth.ts';
import { FeedSocket } from './feedSocket.ts';
import type { LocalBook } from './localBook.ts';
import { LimitedWarn, onAggTrade, onMiniTicker } from './streamParse.ts';
import type { StreamSink } from './streamParse.ts';
import { defaultSetTimer, defaultWsFactory } from './ws.ts';
import type { ConnectLimiter, SetTimer, WsFactory } from './ws.ts';

export type { DepthLevels, Ticker } from './streamParse.ts';

export const SPOT_STREAM_URL = 'wss://stream.binance.com:9443/stream?streams=';

export interface SpotFeedDeps {
  symbols: string[];
  rest: Pick<BinanceRest, 'depth'>;
  health: FeedHealth;
  books: Map<string, LocalBook>;
  logger: Logger;
  wsFactory?: WsFactory;
  now?: () => number;
  setTimer?: SetTimer;
  /** Terminate the socket when no frame arrived for this long (default 30 s = 2 x silentMs). */
  watchdogMs?: number;
  /** Shared by every Binance socket of this process; none when absent. */
  limiter?: ConnectLimiter;
}

/**
 * One combined Binance spot stream for all symbols, with per-symbol order-book sync. Emits
 * 'trade' (symbol, AggTrade), 'ticker' (symbol, Ticker), 'book' (symbol, DepthLevels) after each
 * depth update applied to a book, and 'snapshot' (symbol) whenever a book is replaced: emptied
 * for a resync or disconnect, or loaded from a snapshot. The reconnect backoff starts over only
 * once every book has synced on the new connection.
 */
export class SpotFeed extends EventEmitter {
  private readonly symbols: string[];
  private readonly warn: LimitedWarn;
  private readonly sink: StreamSink;
  private readonly sync: BookSync;
  private readonly socket: FeedSocket;
  private syncedSinceConnect = new Set<string>();

  constructor(d: SpotFeedDeps) {
    super();
    this.symbols = d.symbols;
    const now = d.now ?? Date.now;
    const setTimer = d.setTimer ?? defaultSetTimer;
    this.warn = new LimitedWarn(d.logger, now);
    this.sink = { name: 'spot feed', health: d.health, warn: this.warn, emit: (event, ...args) => this.emit(event, ...args) };
    this.sync = new BookSync({
      name: 'spot feed',
      mode: 'spot',
      symbols: d.symbols,
      books: d.books,
      health: d.health,
      depth: (symbol, limit) => d.rest.depth(symbol, limit),
      logger: d.logger,
      setTimer,
      emit: (event, ...args) => this.emit(event, ...args),
      onSynced: (symbol) => {
        this.syncedSinceConnect.add(symbol);
        if (this.syncedSinceConnect.size === this.symbols.length) this.socket.resetBackoff();
      },
    });
    this.socket = new FeedSocket({
      name: 'spot feed',
      url: this.url(),
      symbols: d.symbols,
      health: d.health,
      logger: d.logger,
      warn: this.warn,
      wsFactory: d.wsFactory ?? defaultWsFactory,
      now,
      setTimer,
      watchdogMs: d.watchdogMs ?? 30_000,
      limiter: d.limiter,
      onOpen: () => {
        this.syncedSinceConnect = new Set();
        this.sync.resyncAll();
      },
      onMessage: (symbol, kind, data, at) => this.onMessage(symbol, kind, data, at),
      onDown: () => this.sync.reset(),
    });
  }

  start(): void {
    this.socket.start();
  }

  close(): void {
    this.socket.close();
    this.sync.close();
  }

  private url(): string {
    const parts = this.symbols.flatMap((s) => {
      const l = s.toLowerCase();
      return [`${l}@depth@100ms`, `${l}@aggTrade`, `${l}@miniTicker`];
    });
    return SPOT_STREAM_URL + parts.join('/');
  }

  private onMessage(symbol: string, kind: string, data: any, now: number): void {
    if (kind.startsWith('depth')) this.sync.onDepth(symbol, data, now);
    else if (kind === 'aggTrade') onAggTrade(this.sink, symbol, data, now);
    else if (kind === 'miniTicker') onMiniTicker(this.sink, symbol, data, now);
  }
}
