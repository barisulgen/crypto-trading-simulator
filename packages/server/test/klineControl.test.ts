import { describe, it, expect } from 'vitest';
import { CandleService, INTERVALS } from '../src/market/candles.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { FakeClock, FakeWs, tick } from './helpers.ts';

const silent = { info() {}, warn() {}, error() {} };
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NEARUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'SUIUSDT', 'HYPEUSDT', 'AVAXUSDT'];
const stream = (s: string, i: string) => `${s.toLowerCase()}@kline_${i}`;

/** A kline socket that records when each control message was sent (fake clock time). */
function setup() {
  const clock = new FakeClock(1_000_000);
  const sockets: (FakeWs & { at: number[] })[] = [];
  const svc = new CandleService({
    rest: {} as any,
    logger: silent,
    now: () => clock.now,
    setTimer: clock.setTimer,
    wsFactory: (u) => {
      const w = Object.assign(new FakeWs(u), { at: [] as number[] });
      const send = w.send.bind(w);
      w.send = (d: string) => {
        w.at.push(clock.now);
        send(d);
      };
      sockets.push(w);
      return w as any;
    },
  });
  const msgs = (i = 0) => sockets[i]!.sent.map((s) => JSON.parse(s) as { method: string; params: string[]; id: number });
  return { clock, sockets, svc, msgs };
}

/** True when no closed 1000 ms window holds more than `max` of the times. */
function withinRate(times: number[], max: number): boolean {
  for (let i = 0; i + max < times.length; i++) if (times[i + max]! - times[i]! <= 1000) return false;
  return true;
}

describe('kline socket control messages', () => {
  it('50 subscribe/unsubscribe calls within 1 s never exceed 3 messages per 1000 ms; upstream ends equal to the ref-counted set', () => {
    const { clock, sockets, svc, msgs } = setup();
    const keep = svc.subscribe('BTCUSDT', '1m', () => {});
    sockets[0]!.open();
    clock.advance(1000);
    const live: { key: string; off: () => void }[] = [];
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 50; i++) {
      if (live.length > 0 && rnd(3) === 0) {
        const [h] = live.splice(rnd(live.length), 1);
        h!.off();
      } else {
        const s = SYMBOLS[rnd(SYMBOLS.length)]!;
        const iv = INTERVALS[rnd(INTERVALS.length)]!;
        live.push({ key: stream(s, iv), off: svc.subscribe(s, iv, () => {}) });
      }
      clock.advance(19);
    }
    clock.advance(20_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.pings).toBe(0);
    const times = sockets[0]!.at;
    expect(times.length).toBeGreaterThan(3);
    expect(withinRate(times, 3)).toBe(true);
    const upstream = new Set<string>();
    for (const m of msgs()) {
      for (const p of m.params) {
        if (m.method === 'SUBSCRIBE') upstream.add(p);
        else upstream.delete(p);
      }
    }
    const expected = new Set(['btcusdt@kline_1m', ...live.map((h) => h.key)]);
    expect([...upstream].sort()).toEqual([...expected].sort());
    keep();
    svc.close();
  });

  it('pending subscribes go out as ONE SUBSCRIBE and pending unsubscribes as ONE UNSUBSCRIBE', () => {
    const { clock, sockets, svc, msgs } = setup();
    const offs = ['1m', '5m', '15m'].map((i) => svc.subscribe('ETHUSDT', i, () => {}));
    sockets[0]!.open();
    clock.advance(300);
    expect(msgs()).toEqual([{ method: 'SUBSCRIBE', params: ['ethusdt@kline_1m', 'ethusdt@kline_5m', 'ethusdt@kline_15m'], id: 1 }]);
    offs[0]!();
    offs[1]!();
    svc.subscribe('SOLUSDT', '1h', () => {});
    svc.subscribe('SOLUSDT', '4h', () => {});
    clock.advance(249);
    expect(msgs()).toHaveLength(1); // debounced
    clock.advance(1);
    expect(msgs().slice(1)).toEqual([
      { method: 'SUBSCRIBE', params: ['solusdt@kline_1h', 'solusdt@kline_4h'], id: 2 },
      { method: 'UNSUBSCRIBE', params: ['ethusdt@kline_1m', 'ethusdt@kline_5m'], id: 3 },
    ]);
    svc.close();
  });

  it('a subscribe followed by an unsubscribe within the debounce window sends nothing (and vice versa)', () => {
    const { clock, sockets, svc, msgs } = setup();
    const keep = svc.subscribe('BTCUSDT', '1m', () => {});
    sockets[0]!.open();
    clock.advance(300);
    expect(msgs()).toHaveLength(1);
    const off = svc.subscribe('ETHUSDT', '5m', () => {});
    clock.advance(100);
    off();
    clock.advance(5000);
    expect(msgs()).toHaveLength(1);
    keep(); // the last stream: unsubscribe ...
    svc.subscribe('BTCUSDT', '1m', () => {}); // ... and back within the window
    clock.advance(5000);
    expect(msgs()).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    svc.close();
  });

  it('a reconnect sends a single SUBSCRIBE carrying all active streams', () => {
    const { clock, sockets, svc, msgs } = setup();
    const all = SYMBOLS.slice(0, 4).flatMap((s) => ['1m', '1h'].map((i) => (svc.subscribe(s, i, () => {}), stream(s, i))));
    sockets[0]!.open();
    clock.advance(300);
    expect(msgs()).toHaveLength(1);
    sockets[0]!.drop();
    clock.advance(1000); // reconnect backoff
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    clock.advance(5000);
    expect(msgs(1)).toHaveLength(1);
    expect(msgs(1)[0]!.method).toBe('SUBSCRIBE');
    expect(msgs(1)[0]!.params.sort()).toEqual([...all].sort());
    svc.close();
  });

  it('nothing is sent before the socket opens; the open sends one SUBSCRIBE for what is active then', () => {
    const { clock, sockets, svc, msgs } = setup();
    const a = svc.subscribe('BTCUSDT', '1m', () => {});
    svc.subscribe('ETHUSDT', '1m', () => {});
    a();
    clock.advance(500);
    expect(msgs()).toEqual([]);
    sockets[0]!.open();
    clock.advance(300);
    expect(msgs()).toEqual([{ method: 'SUBSCRIBE', params: ['ethusdt@kline_1m'], id: 1 }]);
    svc.close();
  });

  it('closes an idle socket 10 s after its last stream is gone, after unsubscribing it', () => {
    const { clock, sockets, svc, msgs } = setup();
    const off = svc.subscribe('BTCUSDT', '1m', () => {});
    sockets[0]!.open();
    clock.advance(300);
    off();
    clock.advance(9000);
    expect(msgs().map((m) => m.method)).toEqual(['SUBSCRIBE', 'UNSUBSCRIBE']);
    expect(sockets[0]!.closed).toBe(false);
    clock.advance(1000);
    expect(sockets[0]!.closed).toBe(true);
    svc.subscribe('BTCUSDT', '1m', () => {});
    expect(sockets).toHaveLength(2);
    svc.close();
  });
});

describe('combined market-data socket', () => {
  it('SpotFeed never sends anything on its socket (no control messages, no pings)', async () => {
    const clock = new FakeClock(1_000_000);
    const sockets: FakeWs[] = [];
    const books = new Map([['BTCUSDT', new LocalBook()]]);
    let id = 100;
    let sendCalls = 0; // every attempt counts, even one a caller might catch
    const feed = new SpotFeed({
      symbols: ['BTCUSDT'],
      rest: { depth: async () => ({ lastUpdateId: id, bids: [['100', '1']], asks: [['101', '1']] }) } as any,
      health: new FeedHealth(['BTCUSDT'], { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 }),
      books,
      logger: silent,
      now: () => clock.now,
      setTimer: clock.setTimer,
      wsFactory: (u) => {
        const w = new FakeWs(u);
        w.send = () => {
          sendCalls++;
          throw new Error('SpotFeed must not send');
        };
        sockets.push(w);
        return w as any;
      },
    });
    const diff = (U: number, u: number) => ({
      stream: 'btcusdt@depth@100ms',
      data: { e: 'depthUpdate', E: clock.now, s: 'BTCUSDT', U, u, b: [], a: [] },
    });
    const sync = async (ws: FakeWs, from: number) => {
      id = from;
      clock.advance(1000);
      await tick();
      ws.msg(diff(from + 1, from + 1));
      expect(books.get('BTCUSDT')!.valid).toBe(true);
    };
    feed.start();
    const ws0 = sockets[0]!;
    ws0.open();
    ws0.emit('ping');
    await sync(ws0, 100);
    ws0.msg({ stream: 'btcusdt@aggTrade', data: { a: 1, p: '100', q: '1', T: 1, m: false } });
    ws0.msg({ stream: 'btcusdt@miniTicker', data: { c: '100', o: '99' } });
    ws0.msg({ stream: 'btcusdt@depth@100ms', data: { bad: true } }); // malformed -> resync
    await sync(ws0, 300);
    ws0.msg(diff(500, 501)); // gap -> resync
    await sync(ws0, 600);
    ws0.drop(); // reconnect
    clock.advance(1000);
    const ws1 = sockets[1]!;
    ws1.open();
    await sync(ws1, 700);
    clock.advance(36_000); // silent socket: the 5 s watchdog check terminates it, then it reconnects
    expect(ws1.terminated).toBe(true);
    clock.advance(2000);
    sockets[2]!.open();
    await sync(sockets[2]!, 800);
    feed.close();
    clock.advance(60_000);
    await tick();
    expect(sockets).toHaveLength(3);
    expect(sendCalls).toBe(0);
    for (const w of sockets) expect(w.pings).toBe(0);
  });
});
