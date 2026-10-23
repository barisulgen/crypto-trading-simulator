import { describe, expect, it, vi } from 'vitest';
import { CandleService } from '../src/market/candles.ts';
import { FakeClock, FakeWs } from './helpers.ts';

const silent = { info() {}, warn() {}, error() {} };

describe('CandleService cache bound', () => {
  it('keeps at most 64 series and evicts the least recently used', async () => {
    const clock = new FakeClock(0);
    const klines = vi.fn(async () => []);
    const svc = new CandleService({ rest: { klines } as any, logger: silent, now: () => clock.now, setTimer: clock.setTimer });
    for (let end = 1; end <= 64; end++) await svc.history('BTCUSDT', '1m', end);
    expect(klines).toHaveBeenCalledTimes(64);
    await svc.history('BTCUSDT', '1m', 1); // use the oldest: it is now the newest
    expect(klines).toHaveBeenCalledTimes(64);
    await svc.history('BTCUSDT', '1m', 65); // the 65th series evicts the least recently used (2)
    expect(klines).toHaveBeenCalledTimes(65);
    await svc.history('BTCUSDT', '1m', 1);
    expect(klines).toHaveBeenCalledTimes(65);
    await svc.history('BTCUSDT', '1m', 2);
    expect(klines).toHaveBeenCalledTimes(66);
  });
});

describe('perp CandleService', () => {
  const k = (t: number) => [t, '1', '2', '0.5', '1.5', '10', t + 59999, '15', 3, '5', '7', '0'];

  it('reads history from the futures client, with the end time as the last argument', async () => {
    const klines = vi.fn(async () => [k(60000)]);
    const svc = new CandleService({ market: 'perp', rest: { klines } as any, logger: silent });
    const a = await svc.history('BTCUSDT', '1m');
    expect(a[0]).toEqual({ time: 60000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' });
    expect(klines).toHaveBeenLastCalledWith('BTCUSDT', '1m', 500, undefined, undefined);
    await svc.history('BTCUSDT', '1m', 5);
    expect(klines).toHaveBeenLastCalledWith('BTCUSDT', '1m', 500, undefined, 5);
  });

  it('the newest page is cached for 5 s, an older page until evicted', async () => {
    const clock = new FakeClock(0);
    const klines = vi.fn(async () => []);
    const svc = new CandleService({ rest: { klines } as any, logger: silent, now: () => clock.now, setTimer: clock.setTimer });
    await svc.history('BTCUSDT', '1m');
    await svc.history('BTCUSDT', '1m', 9);
    clock.advance(5000);
    await svc.history('BTCUSDT', '1m');
    expect(klines).toHaveBeenCalledTimes(2);
    clock.advance(1);
    await svc.history('BTCUSDT', '1m');
    await svc.history('BTCUSDT', '1m', 9);
    expect(klines).toHaveBeenCalledTimes(3);
  });

  it('subscribes on the futures kline socket', () => {
    const clock = new FakeClock(0);
    const sockets: FakeWs[] = [];
    const svc = new CandleService({
      market: 'perp',
      rest: {} as any,
      logger: silent,
      now: () => clock.now,
      setTimer: clock.setTimer,
      wsFactory: (u) => {
        const w = new FakeWs(u);
        sockets.push(w);
        return w as any;
      },
    });
    const got: any[] = [];
    svc.subscribe('BTCUSDT', '1m', (c) => got.push(c));
    expect(sockets.map((s) => s.url)).toEqual(['wss://fstream.binance.com/market/ws']);
    sockets[0]!.open();
    clock.advance(250);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'] });
    sockets[0]!.msg({ e: 'kline', s: 'BTCUSDT', k: { t: 60000, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x: false } });
    expect(got).toHaveLength(1);
    svc.close();
  });
});
