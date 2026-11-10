import type { AggTrade, BookSnapshot, Market, PerpOrder, SpotOrder } from '@sim/engine';
import { toJson } from '../db/store.ts';
import type { Logger } from '../log.ts';
import { INTERVALS } from '../market/candles.ts';
import type { Candle } from '../market/candles.ts';
import { marketKey } from '../market/marketKey.ts';
import type { MarketKey } from '../market/marketKey.ts';
import type { PerpMark } from '../market/perpMarketData.ts';
import type { Ticker } from '../market/spotFeed.ts';
import type { SetTimer } from '../market/ws.ts';
import type { AccountSnapshot, HealthMap, PerpSettingsMap, PositionView } from '../runner.ts';
import { SESSION_EXPIRED } from './auth.ts';

const TICKER_MS = 1000;
const HEALTH_MS = 5000;
/** At most 4 book messages per second per market and symbol. */
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
/** WebSocket close code (application range) sent, with the reason, when the client's LAN session has expired. */
export const SESSION_EXPIRED_CLOSE = 4001;

/** What the hub reads of one market's data (MarketData for spot, PerpMarketData for perps). */
export interface HubFeed {
  bookTop(symbol: string, levels?: number): BookSnapshot;
  recentTrades(symbol: string, n?: number): AggTrade[];
  /** 'book' (symbol): the symbol's book changed; 'trade' (symbol, AggTrade): a live trade. */
  on(event: 'trade' | 'book', cb: (...args: any[]) => void): unknown;
  off(event: 'trade' | 'book', cb: (...args: any[]) => void): unknown;
}

/** What the hub reads from MarketData. */
export interface HubMarket extends HubFeed {
  tickers(): Record<string, Ticker>;
  healthSnapshot(): HealthMap;
}

/** What the hub reads from PerpMarketData. */
export interface HubPerpMarket extends HubFeed {
  /** The futures 24 h tickers (last trade price and change), by symbol. */
  tickers(): Record<string, Ticker>;
  marks(): Record<string, PerpMark>;
}

/** The slice of a `ws` WebSocket the hub uses. */
export interface HubSocket {
  readonly readyState: number;
  /** Bytes queued but not yet sent. */
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** The LAN session a socket was opened with (see registerAuth). */
export interface HubSession {
  /** False once the session has expired (idle 24 h or 7 days old). */
  alive(): boolean;
  /** Renews the session's idle timer while it is alive. */
  touch(): void;
}

/** The health message's content. */
export interface HubHealth {
  health: HealthMap;
  markets: Record<string, { fresh: boolean; reason: string | null; catchingUp: boolean }>;
  catchingUp: MarketKey[];
}

export interface HubDeps {
  market: HubMarket;
  perpMarket: HubPerpMarket;
  candles: Record<Market, { subscribe(symbol: string, interval: string, cb: (c: Candle) => void): () => void }>;
  runner: {
    account(): AccountSnapshot;
    openOrders(): SpotOrder[];
    openPerpOrders(): PerpOrder[];
    positions(): PositionView[];
    /** Every symbol's perp settings (leverage, margin mode). */
    perpSettings(): PerpSettingsMap;
    /** The liquidation notices whose alert has not been acknowledged, oldest first (absent: none). */
    unacknowledgedLiquidations?(): object[];
  };
  symbols: string[];
  setTimer: SetTimer;
  logger: Logger;
  /** The health message's content: spot health by symbol, every market and symbol's health, the keys catching up. */
  health: () => HubHealth;
}

interface Client {
  /** The market and symbol whose book and trades the client gets; null before its first subscribe. */
  key: MarketKey | null;
  unsubscribeKline: (() => void) | null;
  /** Answered the last ping (or connected since it). */
  alive: boolean;
  /** The LAN session the socket was opened with; null without a password (localhost only). */
  session: HubSession | null;
}

/**
 * The browser clients. Every client gets both markets' tickers, the revalued account, the perp
 * marks (with the index price) and the positions (each once a second), health (every 5 s and on
 * change) and the runner's account / orders / positions / perp settings / notice messages; a client that sent
 * `{ type: 'subscribe', market, symbol, interval }` (market defaults to spot) also gets that
 * symbol's klines, book (top 20, at most 4/s)
 * and trades from that market only: a perp subscription never carries spot data, nor the reverse,
 * and a new subscribe releases the previous one. Every message is JSON with decimals as strings.
 * Backpressure: live messages are skipped while a client has more than 1 MB unsent and the
 * client is terminated above 4 MB; a client that misses a 30 s ping is terminated. A client whose
 * LAN session has expired is closed (code 4001) before anything more is sent to it, at the latest
 * at the next heartbeat; its messages renew the session (pongs do not, so an unattended tab does
 * not hold it open). Whenever a client goes, its kline subscription is released.
 */
export class ClientHub {
  private readonly clients = new Map<HubSocket, Client>();
  private readonly timers = new Set<() => void>();
  /** Market keys whose book was sent within the last BOOK_MIN_GAP_MS; dirty = an update is waiting. */
  private readonly bookCooling = new Map<MarketKey, { dirty: boolean }>();
  private started = false;
  private readonly listeners: { feed: HubFeed; event: 'trade' | 'book'; cb: (...args: any[]) => void }[];

  constructor(private readonly d: HubDeps) {
    this.listeners = (['spot', 'perp'] as const).flatMap((market) => [
      { feed: this.feed(market), event: 'book' as const, cb: (symbol: string) => this.onBook(market, symbol) },
      { feed: this.feed(market), event: 'trade' as const, cb: (symbol: string, t: AggTrade) => this.onTrade(market, symbol, t) },
    ]);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const l of this.listeners) l.feed.on(l.event, l.cb);
    this.every(TICKER_MS, () => {
      if (this.clients.size === 0) return;
      this.broadcast(this.tickers());
      this.broadcast({ type: 'account', account: this.d.runner.account() });
      this.broadcast({ type: 'marks', marks: this.d.perpMarket.marks() });
      this.broadcast({ type: 'positions', positions: this.d.runner.positions() });
    });
    this.every(HEALTH_MS, () => {
      if (this.clients.size > 0) this.broadcast({ type: 'health', ...this.d.health() });
    });
    this.every(HEARTBEAT_MS, () => this.heartbeat());
  }

  stop(): void {
    this.started = false;
    for (const l of this.listeners) l.feed.off(l.event, l.cb);
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.bookCooling.clear();
    for (const c of this.clients.values()) c.unsubscribeKline?.();
    this.clients.clear();
  }

  /**
   * A new connection: snapshot first (tickers, health, account, orders, marks, positions, every
   * symbol's perp settings, then the liquidation notices not acknowledged yet), then live messages.
   */
  add(socket: HubSocket, session: HubSession | null = null): void {
    const client: Client = { key: null, unsubscribeKline: null, alive: true, session };
    this.clients.set(socket, client);
    socket.on('message', (raw: unknown) => this.onMessage(socket, client, raw));
    // A pong is the browser's, not the owner's: it keeps the socket, not the session, alive.
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.remove(socket));
    socket.on('error', () => this.remove(socket));
    this.sendTo(socket, this.tickers(), true);
    this.sendTo(socket, { type: 'health', ...this.d.health() }, true);
    this.sendTo(socket, { type: 'account', account: this.d.runner.account() }, true);
    this.sendTo(socket, { type: 'orders', orders: this.d.runner.openOrders(), perpOrders: this.d.runner.openPerpOrders() }, true);
    this.sendTo(socket, { type: 'marks', marks: this.d.perpMarket.marks() }, true);
    this.sendTo(socket, { type: 'positions', positions: this.d.runner.positions() }, true);
    this.sendTo(socket, { type: 'perpSettings', settings: this.d.runner.perpSettings() }, true);
    for (const n of this.d.runner.unacknowledgedLiquidations?.() ?? []) this.sendTo(socket, { type: 'notice', ...n }, true);
  }

  /** Send to every client (the runner's account, orders, positions, notice and health messages). */
  broadcast(msg: object): void {
    if (this.clients.size === 0) return;
    const text = toJson(msg);
    for (const socket of [...this.clients.keys()]) this.write(socket, text);
  }

  /** Both markets' 24 h tickers: `tickers` spot (as before), `perpTickers` the futures. */
  private tickers(): object {
    return { type: 'tickers', tickers: this.d.market.tickers(), perpTickers: this.d.perpMarket.tickers() };
  }

  private feed(market: Market): HubFeed {
    return market === 'spot' ? this.d.market : this.d.perpMarket;
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

  /** Whether the client's session has expired; if so it is forgotten and its socket closed, saying why. */
  private closeIfExpired(socket: HubSocket, client: Client): boolean {
    if (client.session === null || client.session.alive()) return false;
    this.remove(socket);
    try {
      socket.close(SESSION_EXPIRED_CLOSE, SESSION_EXPIRED);
    } catch {
      // already gone
    }
    return true;
  }

  private heartbeat(): void {
    for (const [socket, c] of [...this.clients]) {
      if (this.closeIfExpired(socket, c)) continue;
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
    if (this.closeIfExpired(socket, client)) return;
    client.session?.touch();
    let msg: { type?: unknown; market?: unknown; symbol?: unknown; interval?: unknown };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return this.sendTo(socket, { type: 'error', error: 'Invalid message' });
    }
    if (msg?.type !== 'subscribe') return this.sendTo(socket, { type: 'error', error: 'Unknown message type' });
    const { symbol, interval } = msg;
    const market = msg.market ?? 'spot';
    if (market !== 'spot' && market !== 'perp') {
      return this.sendTo(socket, { type: 'error', error: `Unknown market ${String(market)}` });
    }
    if (typeof symbol !== 'string' || !this.d.symbols.includes(symbol)) {
      return this.sendTo(socket, { type: 'error', error: `Unknown symbol ${String(symbol)}` });
    }
    if (typeof interval !== 'string' || !(INTERVALS as readonly string[]).includes(interval)) {
      return this.sendTo(socket, { type: 'error', error: `Unsupported interval ${String(interval)}` });
    }
    // The previous subscription goes first, so nothing from it follows this one's snapshot.
    client.unsubscribeKline?.();
    client.unsubscribeKline = null;
    client.key = marketKey(market, symbol);
    try {
      client.unsubscribeKline = this.d.candles[market].subscribe(symbol, interval, (candle) =>
        this.sendTo(socket, { type: 'kline', market, symbol, interval, candle }),
      );
    } catch (e) {
      this.d.logger.warn(`kline subscribe ${market} ${symbol} ${interval} failed: ${(e as Error).message}`);
    }
    // The subscription's starting snapshot, from the subscribed market's own book and trades.
    const feed = this.feed(market);
    this.sendTo(socket, { type: 'book', market, symbol, ...feed.bookTop(symbol, BOOK_LEVELS) }, true);
    const trades = feed.recentTrades(symbol, TRADES_ON_SUBSCRIBE);
    this.sendTo(socket, { type: 'trades', market, symbol, trades }, true);
  }

  private onBook(market: Market, symbol: string): void {
    const key = marketKey(market, symbol);
    if (!this.hasSubscribers(key)) return;
    const cooling = this.bookCooling.get(key);
    if (cooling) {
      cooling.dirty = true;
      return;
    }
    this.sendBook(market, symbol);
  }

  /** Send now, then hold further updates for BOOK_MIN_GAP_MS and send the latest book once if any came. */
  private sendBook(market: Market, symbol: string): void {
    const key = marketKey(market, symbol);
    this.toSubscribers(key, { type: 'book', market, symbol, ...this.feed(market).bookTop(symbol, BOOK_LEVELS) });
    const cooling = { dirty: false };
    this.bookCooling.set(key, cooling);
    this.timer(() => {
      this.bookCooling.delete(key);
      if (cooling.dirty && this.hasSubscribers(key)) this.sendBook(market, symbol);
    }, BOOK_MIN_GAP_MS);
  }

  private onTrade(market: Market, symbol: string, trade: AggTrade): void {
    const key = marketKey(market, symbol);
    if (this.hasSubscribers(key)) this.toSubscribers(key, { type: 'trades', market, symbol, trades: [trade] });
  }

  private hasSubscribers(key: MarketKey): boolean {
    for (const c of this.clients.values()) if (c.key === key) return true;
    return false;
  }

  private toSubscribers(key: MarketKey, msg: object): void {
    const text = toJson(msg);
    for (const [socket, c] of [...this.clients]) if (c.key === key) this.write(socket, text);
  }

  private sendTo(socket: HubSocket, msg: object, snapshot = false): void {
    this.write(socket, toJson(msg), snapshot);
  }

  /**
   * Snapshot messages are always sent (unless the client is terminated); live ones yield to
   * backpressure. Nothing is sent once the client's session has expired: it is closed instead.
   */
  private write(socket: HubSocket, text: string, snapshot = false): void {
    if (socket.readyState !== OPEN) return;
    const client = this.clients.get(socket);
    if (client && this.closeIfExpired(socket, client)) return;
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
