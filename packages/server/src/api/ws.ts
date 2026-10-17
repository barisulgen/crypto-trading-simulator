import type { AggTrade, BookSnapshot, SpotOrder } from '@sim/engine';
import { toJson } from '../db/store.ts';
import type { Logger } from '../log.ts';
import { INTERVALS } from '../market/candles.ts';
import type { Candle } from '../market/candles.ts';
import type { Ticker } from '../market/spotFeed.ts';
import type { SetTimer } from '../market/ws.ts';
import type { AccountSnapshot, HealthMap } from '../runner.ts';

const TICKER_MS = 1000;
const HEALTH_MS = 5000;
/** At most 4 book messages per second per symbol. */
const BOOK_MIN_GAP_MS = 250;
const BOOK_LEVELS = 20;
const TRADES_ON_SUBSCRIBE = 50;
const OPEN = 1;
/** Above this much unsent data, live messages to the client are skipped (it catches up on the next ones). */
const SKIP_BUFFER_BYTES = 1024 * 1024;
/** Above this, the client is too far behind or gone: terminated. */
const TERMINATE_BUFFER_BYTES = 4 * 1024 * 1024;
/** Ping interval; a client that has not answered the previous ping by the next one is terminated. */
const HEARTBEAT_MS = 30_000;

/** What the hub reads from MarketData. */
export interface HubMarket {
  tickers(): Record<string, Ticker>;
  healthSnapshot(): HealthMap;
  bookTop(symbol: string, levels?: number): BookSnapshot;
  recentTrades(symbol: string, n?: number): AggTrade[];
  on(event: 'trade' | 'book', cb: (...args: any[]) => void): unknown;
  off(event: 'trade' | 'book', cb: (...args: any[]) => void): unknown;
}

/** The slice of a `ws` WebSocket the hub uses. */
export interface HubSocket {
  readonly readyState: number;
  /** Bytes queued but not yet sent. */
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

export interface HubDeps {
  market: HubMarket;
  candles: { subscribe(symbol: string, interval: string, cb: (c: Candle) => void): () => void };
  runner: { account(): AccountSnapshot; openOrders(): SpotOrder[] };
  symbols: string[];
  setTimer: SetTimer;
  logger: Logger;
}

interface Client {
  symbol: string | null;
  unsubscribeKline: (() => void) | null;
  /** Answered the last ping (or connected since it). */
  alive: boolean;
}

/**
 * The browser clients. Every client gets tickers (1/s, with the revalued account), health (every
 * 5 s and on change) and the runner's account / orders / notice messages; a client that sent
 * `{ type: 'subscribe', symbol, interval }` also gets that symbol's book (top 20, at most 4/s),
 * trades and klines. Every message is JSON with decimals as strings.
 * Backpressure: live messages are skipped while a client has more than 1 MB unsent and the
 * client is terminated above 4 MB; a client that misses a 30 s ping is terminated. Whenever a
 * client goes, its kline subscription is released.
 */
export class ClientHub {
  private readonly clients = new Map<HubSocket, Client>();
  private readonly timers = new Set<() => void>();
  /** Symbols whose book was sent within the last BOOK_MIN_GAP_MS; dirty = an update is waiting. */
  private readonly bookCooling = new Map<string, { dirty: boolean }>();
  private started = false;

  constructor(private readonly d: HubDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.d.market.on('book', this.onBook);
    this.d.market.on('trade', this.onTrade);
    this.every(TICKER_MS, () => {
      if (this.clients.size === 0) return;
      this.broadcast({ type: 'tickers', tickers: this.d.market.tickers() });
      this.broadcast({ type: 'account', account: this.d.runner.account() });
    });
    this.every(HEALTH_MS, () => {
      if (this.clients.size > 0) this.broadcast({ type: 'health', health: this.d.market.healthSnapshot() });
    });
    this.every(HEARTBEAT_MS, () => this.heartbeat());
  }

  stop(): void {
    this.started = false;
    this.d.market.off('book', this.onBook);
    this.d.market.off('trade', this.onTrade);
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.bookCooling.clear();
    for (const c of this.clients.values()) c.unsubscribeKline?.();
    this.clients.clear();
  }

  /** A new connection: snapshot first (tickers, health, account, orders), then live messages. */
  add(socket: HubSocket): void {
    const client: Client = { symbol: null, unsubscribeKline: null, alive: true };
    this.clients.set(socket, client);
    socket.on('message', (raw: unknown) => this.onMessage(socket, client, raw));
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.remove(socket));
    socket.on('error', () => this.remove(socket));
    this.sendTo(socket, { type: 'tickers', tickers: this.d.market.tickers() }, true);
    this.sendTo(socket, { type: 'health', health: this.d.market.healthSnapshot() }, true);
    this.sendTo(socket, { type: 'account', account: this.d.runner.account() }, true);
    this.sendTo(socket, { type: 'orders', orders: this.d.runner.openOrders() }, true);
  }

  /** Send to every client (the runner's account, orders, notice and health messages). */
  broadcast(msg: object): void {
    if (this.clients.size === 0) return;
    const text = toJson(msg);
    for (const socket of [...this.clients.keys()]) this.write(socket, text);
  }

  private remove(socket: HubSocket): void {
    const c = this.clients.get(socket);
    if (!c) return;
    c.unsubscribeKline?.();
    this.clients.delete(socket);
  }

  /** Forget the client (releasing its kline subscription) and kill its socket. */
  private drop(socket: HubSocket, why: string): void {
    this.d.logger.warn(`ws client terminated: ${why}`);
    this.remove(socket);
    try {
      socket.terminate();
    } catch {
      // already gone
    }
  }

  private heartbeat(): void {
    for (const [socket, c] of [...this.clients]) {
      if (!c.alive) {
        this.drop(socket, 'no pong since the last ping');
        continue;
      }
      c.alive = false;
      try {
        socket.ping();
      } catch {
        this.drop(socket, 'ping failed');
      }
    }
  }

  private onMessage(socket: HubSocket, client: Client, raw: unknown): void {
    let msg: { type?: unknown; symbol?: unknown; interval?: unknown };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return this.sendTo(socket, { type: 'error', error: 'Invalid message' });
    }
    if (msg?.type !== 'subscribe') return this.sendTo(socket, { type: 'error', error: 'Unknown message type' });
    const { symbol, interval } = msg;
    if (typeof symbol !== 'string' || !this.d.symbols.includes(symbol)) {
      return this.sendTo(socket, { type: 'error', error: `Unknown symbol ${String(symbol)}` });
    }
    if (typeof interval !== 'string' || !(INTERVALS as readonly string[]).includes(interval)) {
      return this.sendTo(socket, { type: 'error', error: `Unsupported interval ${String(interval)}` });
    }
    client.unsubscribeKline?.();
    client.unsubscribeKline = null;
    client.symbol = symbol;
    try {
      client.unsubscribeKline = this.d.candles.subscribe(symbol, interval, (candle) =>
        this.sendTo(socket, { type: 'kline', symbol, interval, candle }),
      );
    } catch (e) {
      this.d.logger.warn(`kline subscribe ${symbol} ${interval} failed: ${(e as Error).message}`);
    }
    // The subscription's starting snapshot.
    this.sendTo(socket, { type: 'book', symbol, ...this.d.market.bookTop(symbol, BOOK_LEVELS) }, true);
    const trades = this.d.market.recentTrades(symbol, TRADES_ON_SUBSCRIBE);
    this.sendTo(socket, { type: 'trades', symbol, trades }, true);
  }

  private readonly onBook = (symbol: string): void => {
    if (!this.hasSubscribers(symbol)) return;
    const cooling = this.bookCooling.get(symbol);
    if (cooling) {
      cooling.dirty = true;
      return;
    }
    this.sendBook(symbol);
  };

  /** Send now, then hold further updates for BOOK_MIN_GAP_MS and send the latest book once if any came. */
  private sendBook(symbol: string): void {
    this.toSubscribers(symbol, { type: 'book', symbol, ...this.d.market.bookTop(symbol, BOOK_LEVELS) });
    const cooling = { dirty: false };
    this.bookCooling.set(symbol, cooling);
    this.timer(() => {
      this.bookCooling.delete(symbol);
      if (cooling.dirty && this.hasSubscribers(symbol)) this.sendBook(symbol);
    }, BOOK_MIN_GAP_MS);
  }

  private readonly onTrade = (symbol: string, trade: AggTrade): void => {
    if (this.hasSubscribers(symbol)) this.toSubscribers(symbol, { type: 'trades', symbol, trades: [trade] });
  };

  private hasSubscribers(symbol: string): boolean {
    for (const c of this.clients.values()) if (c.symbol === symbol) return true;
    return false;
  }

  private toSubscribers(symbol: string, msg: object): void {
    const text = toJson(msg);
    for (const [socket, c] of [...this.clients]) if (c.symbol === symbol) this.write(socket, text);
  }

  private sendTo(socket: HubSocket, msg: object, snapshot = false): void {
    this.write(socket, toJson(msg), snapshot);
  }

  /** Snapshot messages are always sent (unless the client is terminated); live ones yield to backpressure. */
  private write(socket: HubSocket, text: string, snapshot = false): void {
    if (socket.readyState !== OPEN) return;
    if (socket.bufferedAmount > TERMINATE_BUFFER_BYTES) {
      this.drop(socket, `${socket.bufferedAmount} bytes unsent`);
      return;
    }
    if (!snapshot && socket.bufferedAmount > SKIP_BUFFER_BYTES) return;
    try {
      socket.send(text);
    } catch (e) {
      this.drop(socket, `send failed: ${(e as Error).message}`);
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
      try {
        fn();
      } catch (e) {
        this.d.logger.warn(`ws hub task failed: ${(e as Error).message}`);
      }
    };
    this.timer(loop, ms);
  }
}
