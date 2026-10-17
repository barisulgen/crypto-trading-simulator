import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ClientHub } from '../src/api/ws.ts';
import type { Candle } from '../src/market/candles.ts';
import { FakeClock, TestMarket } from './helpers.ts';

const MB = 1024 * 1024;
const silent = { info() {}, warn() {}, error() {} };

/** The slice of a `ws` socket the hub uses, with a settable send buffer. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  pings = 0;
  terminated = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
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
  const kline = { subscribed: 0, unsubscribed: 0 };
  const candles = {
    subscribe(_s: string, _i: string, _cb: (c: Candle) => void) {
      kline.subscribed += 1;
      return () => {
        kline.unsubscribed += 1;
      };
    },
  };
  const runner = { account: () => ({}) as any, openOrders: () => [] };
  const hub = new ClientHub({ market, candles, runner, symbols: ['BTCUSDT'], setTimer: clock.setTimer, logger: silent });
  hub.start();
  const connect = () => {
    const s = new FakeSocket();
    hub.add(s);
    return s;
  };
  return { clock, market, hub, kline, connect };
}

const notice = { type: 'notice', kind: 'fill', level: 'info', text: 'x' };

describe('ClientHub backpressure', () => {
  it('sends the snapshot whatever the buffer, then skips live messages above 1 MB of buffered data', () => {
    const t = setup();
    const s = new FakeSocket();
    s.bufferedAmount = 2 * MB;
    t.hub.add(s);
    expect(s.sent.map((m) => m.type)).toEqual(['tickers', 'health', 'account', 'orders']);

    t.hub.broadcast(notice);
    expect(s.sent).toHaveLength(4); // skipped
    expect(s.terminated).toBe(false);

    s.bufferedAmount = MB; // at the threshold: still sent
    t.hub.broadcast(notice);
    expect(s.sent).toHaveLength(5);
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
