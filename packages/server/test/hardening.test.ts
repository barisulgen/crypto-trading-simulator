import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BinanceRest } from '../src/binance/rest.ts';
import { CandleService } from '../src/market/candles.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { fakeTimers, FakeWs, tick } from './helpers.ts';
import exchangeInfo from './fixtures/btcusdt-exchangeinfo.json' with { type: 'json' };

const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };
type Lv = [string, string][];
const silent = { info() {}, warn() {}, error() {} };

const diff = (U: number, u: number, b: Lv = []) => ({
  stream: 'btcusdt@depth@100ms',
  data: { e: 'depthUpdate', E: 1_000_000, s: 'BTCUSDT', U, u, b, a: [] as Lv },
});
const snap = (id: number) => ({ lastUpdateId: id, bids: [['100', '1']] as Lv, asks: [['101', '1']] as Lv });

function setup(logger: any = silent) {
  const clock = { t: 1_000_000 };
  const health = new FeedHealth(['BTCUSDT'], cfg);
  const books = new Map([['BTCUSDT', new LocalBook()]]);
  const sockets: FakeWs[] = [];
  const timers = fakeTimers();
  let snaps = [snap(100)];
  const depth = vi.fn(async () => (snaps.length > 1 ? snaps.shift()! : snaps[0]!));
  const feed = new SpotFeed({
    symbols: ['BTCUSDT'],
    rest: { depth } as any,
    health,
    books,
    logger,
    wsFactory: (u) => {
      const w = new FakeWs(u);
      sockets.push(w);
      return w as any;
    },
    now: () => clock.t,
    setTimer: timers.setTimer,
  });
  return { clock, health, books, sockets, timers, depth, feed, setSnaps: (s: typeof snaps) => (snaps = s) };
}

describe('SpotFeed hardening', () => {
  it('bounds the diff buffer while snapshots keep failing', async () => {
    const { feed, sockets, timers, depth } = setup();
    depth.mockRejectedValue(new Error('503'));
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    let max = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 1500; i++) {
        ws.msg(diff(1000 + round * 1500 + i, 1000 + round * 1500 + i));
        max = Math.max(max, (feed as any).st.get('BTCUSDT').buffer.length);
      }
      timers.fire();
      await tick();
    }
    expect(max).toBe(1000);
    expect((feed as any).st.get('BTCUSDT').buffer.length).toBeLessThanOrEqual(1000);
    // the newest diffs are the ones retained
    const buf = (feed as any).st.get('BTCUSDT').buffer;
    expect(buf[buf.length - 1].u).toBe(1000 + 2 * 1500 + 1499);
  });

  it('snapshot fetch retries back off 1,2,4,8,16,30,30 s and reset after a successful sync', async () => {
    const { feed, sockets, timers, depth, setSnaps } = setup();
    depth.mockRejectedValue(new Error('503'));
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire(); // initial fetch (delay 0)
    await tick();
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      seen.push(timers.pending()[0]!.ms);
      timers.fire();
      await tick();
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    depth.mockReset();
    depth.mockImplementation(async () => snap(100));
    setSnaps([snap(100)]);
    timers.fire();
    await tick();
    ws.msg(diff(99, 101));
    expect((feed as any).st.get('BTCUSDT').failures).toBe(0);
    ws.msg(diff(500, 501)); // gap -> first retry again 1 s
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
  });

  it('a live gap keeps the triggering diff so the next snapshot can bridge it', async () => {
    const { feed, sockets, timers, books, health, clock, setSnaps } = setup();
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire();
    await tick();
    ws.msg(diff(99, 101));
    expect(books.get('BTCUSDT')!.valid).toBe(true);
    ws.msg(diff(150, 151, [['100', '7']])); // gap
    expect(books.get('BTCUSDT')!.valid).toBe(false);
    setSnaps([snap(149)]);
    timers.fire();
    await tick();
    expect(books.get('BTCUSDT')!.valid).toBe(true); // replayed 150..151 on top of snapshot 149
    expect(books.get('BTCUSDT')!.bestBid()!.qty.toString()).toBe('7');
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
  });

  it('terminates a silent socket and reconnects; frames keep it alive', () => {
    const { feed, sockets, timers, clock } = setup();
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    clock.t += 20_000;
    ws.emit('ping');
    clock.t += 11_000; // 11 s since the ping: still alive
    timers.fireMs(5000);
    expect(ws.terminated).toBe(false);
    clock.t += 20_000; // 31 s with no frame
    timers.fireMs(5000);
    expect(ws.terminated).toBe(true);
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
    timers.fire();
    expect(sockets).toHaveLength(2);
  });

  it('terminates a socket that never opens (handshake stall)', () => {
    const { feed, sockets, timers, clock } = setup();
    feed.start();
    clock.t += 31_000;
    timers.fireMs(5000);
    expect(sockets[0]!.terminated).toBe(true);
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
  });

  it('start() is idempotent', () => {
    const { feed, sockets } = setup();
    feed.start();
    feed.start();
    expect(sockets).toHaveLength(1);
  });

  it('drops invalid aggTrade/miniTicker payloads and logs once per minute', () => {
    const warns: string[] = [];
    const { feed, sockets, clock } = setup({ info() {}, error() {}, warn: (m: string) => warns.push(m) });
    const events: unknown[] = [];
    feed.on('trade', (...a) => events.push(a));
    feed.on('ticker', (...a) => events.push(a));
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    const bad = [
      { a: 1, p: '-5', q: '1', T: 1, m: false },
      { a: 1, p: '5', q: '0', T: 1, m: false },
      { a: 1.5, p: '5', q: '1', T: 1, m: false },
      { a: 1, p: '5', q: '1', T: 'x', m: false },
      { a: 1, p: 'abc', q: '1', T: 1, m: false },
    ];
    for (const d of bad) ws.msg({ stream: 'btcusdt@aggTrade', data: d });
    ws.msg({ stream: 'btcusdt@miniTicker', data: { c: '0', o: '1' } });
    ws.msg({ stream: 'btcusdt@miniTicker', data: { c: '1', o: '0' } });
    expect(events).toHaveLength(0);
    expect(warns.filter((w) => w.includes('aggTrade'))).toHaveLength(1);
    clock.t += 61_000;
    ws.msg({ stream: 'btcusdt@aggTrade', data: bad[0] });
    expect(warns.filter((w) => w.includes('aggTrade'))).toHaveLength(2);
    ws.msg({ stream: 'btcusdt@aggTrade', data: { a: 2, p: '5', q: '1', T: 1, m: false } });
    expect(events).toHaveLength(1);
  });

  it('a throwing book listener during replay does not reject; the symbol resyncs', async () => {
    const { feed, sockets, timers, depth, books } = setup();
    feed.on('book', () => {
      throw new Error('listener bug');
    });
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    ws.msg(diff(99, 101));
    timers.fire();
    await tick();
    await tick();
    expect(books.get('BTCUSDT')!.valid).toBe(false);
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
    timers.fire();
    await tick();
    expect(depth).toHaveBeenCalledTimes(2);
  });
});

describe('MarketData startup retries and lifecycle', () => {
  const mk = (rest: any) => {
    const clock = { t: 1_000_000 };
    const health = new FeedHealth(['BTCUSDT'], cfg);
    const timers = fakeTimers();
    const md = new MarketData({
      symbols: ['BTCUSDT'],
      feed: new EventEmitter(),
      books: new Map([['BTCUSDT', new LocalBook()]]),
      health,
      rest,
      logger: silent,
      now: () => clock.t,
      setTimer: timers.setTimer,
    });
    return { clock, health, timers, md };
  };

  it('retries a failed first exchangeInfo after 5 s, then switches to the hourly period', async () => {
    const exchangeInfoFn = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(exchangeInfo);
    const rest = {
      exchangeInfo: exchangeInfoFn,
      serverTime: async () => ({ serverTime: 1_000_000 }),
      avgPrice: async () => ({ price: '1' }),
    };
    const { clock, health, timers, md } = mk(rest);
    md.start();
    timers.fire(0); // rules, first attempt
    await tick();
    expect(md.isFresh('BTCUSDT')).toBe(false);
    expect(timers.all().map((t) => t.ms)).toContain(5000);
    health.onConnect(clock.t);
    health.setBookValid('BTCUSDT', true);
    health.onDepth('BTCUSDT', clock.t, clock.t);
    timers.fireMs(5000);
    await tick();
    expect(md.isFresh('BTCUSDT')).toBe(true);
    expect(timers.all().map((t) => t.ms)).toContain(3_600_000);
    expect(timers.all().map((t) => t.ms)).not.toContain(5000);
  });

  it('startup retry doubles 5 s -> 60 s for serverTime until it first succeeds', async () => {
    const rest = {
      exchangeInfo: async () => exchangeInfo,
      serverTime: vi.fn(async () => {
        throw new Error('down');
      }),
      avgPrice: async () => ({ price: '1' }),
    };
    const { timers, md } = mk(rest);
    md.start();
    timers.fire(1); // clock timer
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      await tick();
      const all = timers.all();
      const t = all[all.length - 1]!; // the re-armed clock timer is the newest
      seen.push(t.ms);
      t.live = false;
      t.fn();
    }
    expect(seen).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });

  it('start() twice is a no-op; stop() then start() works', () => {
    const rest = { exchangeInfo: async () => exchangeInfo, serverTime: async () => ({}), avgPrice: async () => ({ price: '1' }) };
    const { timers, md } = mk(rest);
    md.start();
    md.start();
    expect(timers.all()).toHaveLength(3); // rules, clock, one avgPrice poller
    md.stop();
    expect(timers.all()).toHaveLength(0);
    md.start();
    expect(timers.all()).toHaveLength(3);
  });
});

describe('BinanceRest rate-limit pause', () => {
  const res = (status: number, headers: Record<string, string> = {}) =>
    ({
      ok: status < 400,
      status,
      headers: new Headers(headers),
      text: async () => 'limit',
      json: async () => ({}),
    }) as unknown as Response;

  it('a 429 with Retry-After 5 pauses every REST call for 5 s', async () => {
    const clock = { t: 10_000 };
    const fetchImpl = vi.fn(async () => res(429, { 'retry-after': '5' }));
    const rest = new BinanceRest(fetchImpl as any, () => clock.t);
    await expect(rest.depth('BTCUSDT')).rejects.toThrow('HTTP 429');
    expect(rest.pausedUntil).toBe(15_000);
    clock.t = 14_999;
    for (const call of [
      () => rest.depth('BTCUSDT'),
      () => rest.avgPrice('BTCUSDT'),
      () => rest.exchangeInfo(['BTCUSDT']),
      () => rest.serverTime(),
      () => rest.klines('BTCUSDT', '1m', 5),
    ]) {
      await expect(call()).rejects.toThrow('paused');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.t = 15_000;
    fetchImpl.mockResolvedValueOnce(res(200));
    await rest.serverTime();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('418 without Retry-After pauses 60 s', async () => {
    const clock = { t: 0 };
    const rest = new BinanceRest((async () => res(418)) as any, () => clock.t);
    await expect(rest.serverTime()).rejects.toThrow('HTTP 418');
    expect(rest.pausedUntil).toBe(60_000);
  });
});

describe('CandleService hardening', () => {
  it('terminates a silent kline socket and reconnects', () => {
    const sockets: FakeWs[] = [];
    const clock = { t: 0 };
    const timers = fakeTimers();
    const svc = new CandleService({
      rest: {} as any,
      logger: silent,
      now: () => clock.t,
      setTimer: timers.setTimer,
      wsFactory: (u) => {
        const w = new FakeWs(u);
        sockets.push(w);
        return w as any;
      },
    });
    svc.subscribe('BTCUSDT', '1m', () => {});
    sockets[0]!.open();
    clock.t = 31_000;
    timers.fireMs(5000);
    expect(sockets[0]!.terminated).toBe(true);
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
    timers.fire();
    expect(sockets).toHaveLength(2);
    svc.close();
  });

  it('skips klines rows that are not arrays', async () => {
    const svc = new CandleService({
      rest: { klines: async () => [null, 'x', [60000, '1', '2', '0.5', '1.5', '10']] } as any,
      logger: silent,
    });
    const rows = await svc.history('BTCUSDT', '1m');
    expect(rows).toHaveLength(1);
  });
});
