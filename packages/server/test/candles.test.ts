import { describe, expect, it, vi } from 'vitest';
import { CandleService } from '../src/market/candles.ts';
import { FakeClock } from './helpers.ts';

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
