import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ClientHub } from '../src/api/ws.ts';
import type { Candle } from '../src/market/candles.ts';
import { D } from '@sim/engine';
import type { HubSession } from '../src/api/ws.ts';
import { FakeClock, TestMarket, TestPerpMarket } from './helpers.ts';

const MB = 1024 * 1024;
const silent = { info() {}, warn() {}, error() {} };

/** The slice of a `ws` socket the hub uses, with a settable send buffer. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  pings = 0;
  terminated = false;
  closed: [number | undefined, string | undefined] | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = [code, reason];
    this.readyState = 2;
  }
  ping() {
    this.pings += 1;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
}

function setup() {
  const clock = new FakeClock(1_000_000);
  const market = new TestMarket(['BTCUSDT']);
  const perpMarket = new TestPerpMarket(['BTCUSDT']);
  perpMarket.now = () => clock.now;
  const kline = { subscribed: 0, unsubscribed: 0 };
  const service = {
    subscribe(_s: string, _i: string, _cb: (c: Candle) => void) {
      kline.subscribed += 1;
      return () => {
        kline.unsubscribed += 1;
      };
    },
  };
  const candles = { spot: service, perp: service };
  const runner = {
    account: () => ({}) as any,
    openOrders: () => [],
    openPerpOrders: () => [],
    positions: () => [],
    perpSettings: () => ({ BTCUSDT: { leverage: 20, marginMode: 'isolated' as const } }),
  };
  const health = () => ({ health: market.healthSnapshot(), markets: {}, catchingUp: [] });
  const hub = new ClientHub({ market, perpMarket, candles, runner, symbols: ['BTCUSDT'], setTimer: clock.setTimer, logger: silent, health });
  hub.start();
  const connect = (session?: HubSession) => {
    const s = new FakeSocket();
    hub.add(s, session);
    return s;
  };
  const subscribe = (s: FakeSocket, market?: string) =>
    s.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', ...(market ? { market } : {}), symbol: 'BTCUSDT', interval: '1m' })));
  return { clock, market, perpMarket, hub, kline, connect, subscribe };
}

const notice = { type: 'notice', kind: 'fill', level: 'info', text: 'x' };

describe('ClientHub backpressure', () => {
  it('sends the snapshot whatever the buffer, then skips live messages above 1 MB of buffered data', () => {
    const t = setup();
    const s = new FakeSocket();
    s.bufferedAmount = 2 * MB;
    t.hub.add(s);
    expect(s.sent.map((m) => m.type)).toEqual(['tickers', 'health', 'account', 'orders', 'marks', 'positions', 'perpSettings']);
    expect(s.sent.at(-1)).toEqual({ type: 'perpSettings', settings: { BTCUSDT: { leverage: 20, marginMode: 'isolated' } } });

    t.hub.broadcast(notice);
    expect(s.sent).toHaveLength(7); // skipped
    expect(s.terminated).toBe(false);

    s.bufferedAmount = MB; // at the threshold: still sent
    t.hub.broadcast(notice);
    expect(s.sent).toHaveLength(8);
  });

  it('terminates a client whose buffer exceeds 4 MB and releases its kline subscription', () => {
    const t = setup();
    const s = t.connect();
    s.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', symbol: 'BTCUSDT', interval: '1m' })));
    expect(t.kline).toEqual({ subscribed: 1, unsubscribed: 0 });
    s.bufferedAmount = 4 * MB + 1;
    t.hub.broadcast(notice);
    expect(s.terminated).toBe(true);
    expect(t.kline.unsubscribed).toBe(1);
    const before = s.sent.length;
    t.hub.broadcast(notice);
    expect(s.sent).toHaveLength(before); // no longer a client
  });
});

describe('ClientHub heartbeat', () => {
  it('pings every 30 s and terminates a client that did not pong since the previous ping', () => {
    const t = setup();
    const alive = t.connect();
    const dead = t.connect();
    t.clock.advance(30_000);
    expect([alive.pings, dead.pings]).toEqual([1, 1]);
    alive.emit('pong');
    t.clock.advance(30_000);
    expect(alive.terminated).toBe(false);
    expect(alive.pings).toBe(2);
    expect(dead.terminated).toBe(true);
    expect(dead.pings).toBe(1);
  });

  it('releases the kline subscription when the client closes', () => {
    const t = setup();
    const s = t.connect();
    s.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', symbol: 'BTCUSDT', interval: '1m' })));
    s.emit('close');
    expect(t.kline).toEqual({ subscribed: 1, unsubscribed: 1 });
  });
});

const trade = (id: number, price: string) => ({ id, price: D(price), qty: D('0.1'), sellerInitiated: false, time: 0 });

describe('ClientHub marks and positions', () => {
  it("sends the futures tickers with the spot ones, each market's own", () => {
    const t = setup();
    t.perpMarket.tickerMap = { BTCUSDT: { last: D('80001.1'), open24h: D('79000'), change24hPct: D('1.26') } };
    const s = t.connect();
    t.clock.advance(1000);
    const tickers = s.sent.filter((m) => m.type === 'tickers');
    expect(tickers).toHaveLength(2);
    for (const m of tickers) {
      expect(m.tickers).toEqual({});
      expect(m.perpTickers).toEqual({ BTCUSDT: { last: '80001.1', open24h: '79000', change24hPct: '1.26' } });
    }
  });

  it('pushes marks and positions once a second, never more often', () => {
    const t = setup();
    t.perpMarket.mark('BTCUSDT', '80000', 1_000_000 + 3_600_000, '0.0001', '80012.5');
    const s = t.connect();
    const marks = () => s.sent.filter((m) => m.type === 'marks');
    expect(marks()).toEqual([
      {
        type: 'marks',
        marks: {
          BTCUSDT: { markPrice: '80000', indexPrice: '80012.5', fundingRate: '0.0001', nextFundingTime: 1_000_000 + 3_600_000, fresh: true },
        },
      },
    ]);
    for (let i = 0; i < 30; i++) {
      t.perpMarket.mark('BTCUSDT', String(80000 + i));
      t.clock.advance(100);
    }
    expect(marks()).toHaveLength(1 + 3);
    expect(marks().at(-1).marks.BTCUSDT.markPrice).toBe('80029');
    expect(s.sent.filter((m) => m.type === 'positions')).toHaveLength(1 + 3);
    t.clock.advance(999);
    expect(marks()).toHaveLength(4);
    t.clock.advance(1);
    expect(marks()).toHaveLength(5);
  });
});

describe('ClientHub perp book and trades', () => {
  it('a perp subscriber gets the futures book (at most 4 a second) and trades; a spot subscriber only spot ones', () => {
    const t = setup();
    const perp = t.connect();
    const spot = t.connect();
    t.subscribe(perp, 'perp');
    t.subscribe(spot);
    const books = (s: FakeSocket) => s.sent.filter((m) => m.type === 'book');
    const trades = (s: FakeSocket) => s.sent.filter((m) => m.type === 'trades');
    expect(books(perp)).toEqual([
      expect.objectContaining({ market: 'perp', symbol: 'BTCUSDT', asks: [{ price: '80000', qty: '0.2' }, { price: '80010', qty: '1' }] }),
    ]);
    expect(books(spot)).toEqual([expect.objectContaining({ market: 'spot', symbol: 'BTCUSDT', asks: [expect.objectContaining({ price: '100' }), expect.anything(), expect.anything()] })]);

    for (let i = 0; i < 20; i++) {
      t.perpMarket.bookUpdate('BTCUSDT');
      t.clock.advance(50);
    }
    // One at once, then one per 250 ms with the latest book: 0, 250, 500, 750, 1000.
    expect(books(perp)).toHaveLength(1 + 5);
    expect(books(perp).every((m) => m.market === 'perp')).toBe(true);
    expect(books(spot)).toHaveLength(1);

    t.perpMarket.trade('BTCUSDT', trade(1, '80001'));
    t.market.trade('BTCUSDT', trade(2, '101'));
    expect(trades(perp).map((m) => [m.market, m.trades.map((x: any) => x.price)])).toEqual([
      ['perp', []],
      ['perp', ['80001']],
    ]);
    expect(trades(spot).map((m) => [m.market, m.trades.map((x: any) => x.price)])).toEqual([
      ['spot', []],
      ['spot', ['101']],
    ]);

    // Switching market releases the old subscription: nothing more from the perp feed.
    t.subscribe(perp);
    t.clock.advance(250);
    const before = perp.sent.length;
    t.perpMarket.bookUpdate('BTCUSDT');
    t.perpMarket.trade('BTCUSDT', trade(3, '80002'));
    t.clock.advance(250);
    expect(perp.sent.slice(before).filter((m) => m.type === 'book' || m.type === 'trades')).toEqual([]);
    expect(t.kline).toEqual({ subscribed: 3, unsubscribed: 1 });
  });
});

describe('ClientHub sessions', () => {
  const session = () => {
    const s = { alive: true, touches: 0 };
    const handle: HubSession = {
      alive: () => s.alive,
      touch: () => {
        if (s.alive) s.touches += 1;
      },
    };
    return { s, handle };
  };

  it('messages renew the session, pongs do not; an expired one is closed at the next heartbeat and its kline released', () => {
    const t = setup();
    const { s, handle } = session();
    const socket = t.connect(handle);
    // A pong is the browser answering a ping: an unattended open tab must not hold the session open.
    socket.emit('pong');
    expect(s.touches).toBe(0);
    t.subscribe(socket);
    expect(s.touches).toBe(1);
    t.clock.advance(30_000);
    socket.emit('pong');
    expect(s.touches).toBe(1);
    expect(socket.closed).toBeNull();

    s.alive = false; // idle 24 h, or 7 days old
    t.clock.advance(30_000);
    expect(socket.closed).toEqual([4001, 'Session expired; log in again']);
    expect(t.kline.unsubscribed).toBe(1);
    const before = socket.sent.length;
    t.hub.broadcast(notice);
    expect(socket.sent).toHaveLength(before);
  });

  it('nothing more reaches a socket once its session has expired: it is closed at the next message to it, not the heartbeat', () => {
    const t = setup();
    const { s, handle } = session();
    const socket = t.connect(handle);
    t.subscribe(socket);
    t.clock.advance(1000);
    const live = socket.sent.length;
    expect(socket.sent.slice(-4).map((m) => m.type)).toEqual(['tickers', 'account', 'marks', 'positions']);

    s.alive = false;
    t.clock.advance(1000); // the 1 s tick: account, marks and positions would go out
    expect(socket.closed).toEqual([4001, 'Session expired; log in again']);
    expect(socket.sent).toHaveLength(live);
    expect(t.kline.unsubscribed).toBe(1);

    // The same for a runner broadcast and a book update arriving first.
    const other = session();
    const second = t.connect(other.handle);
    t.subscribe(second);
    const sent = second.sent.length;
    other.s.alive = false;
    t.hub.broadcast({ type: 'account', account: {} });
    expect(second.closed).toEqual([4001, 'Session expired; log in again']);
    expect(second.sent).toHaveLength(sent);
  });

  it('a message on an expired session closes the socket instead of answering it', () => {
    const t = setup();
    const { s, handle } = session();
    const socket = t.connect(handle);
    s.alive = false;
    const before = socket.sent.length;
    t.subscribe(socket);
    expect(socket.closed).toEqual([4001, 'Session expired; log in again']);
    expect(socket.sent).toHaveLength(before);
    expect(t.kline.subscribed).toBe(0);
  });

  it('a socket without a session (no password: localhost only) is never closed for it', () => {
    const t = setup();
    const socket = t.connect();
    for (let i = 0; i < 3; i++) {
      t.clock.advance(30_000);
      socket.emit('pong');
    }
    expect(socket.closed).toBeNull();
  });
});
