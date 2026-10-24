import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { FuturesRest, futuresRequestWeight, FUTURES_WEIGHT_BUDGET_1M } from '../src/binance/futuresRest.ts';
import { PauseController } from '../src/binance/restCore.ts';
import { BinanceRest } from '../src/binance/rest.ts';
import { TierLoader } from '../src/binance/tiers.ts';
import { FakeClock, tick } from './helpers.ts';
import bapi from './fixtures/bapi-brackets.json' with { type: 'json' };
import official from './fixtures/leverage-bracket.json' with { type: 'json' };

const T0 = 1_800_000_000_000; // a minute boundary
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'].map((c) => `${c}USDT`);

const res = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  }) as unknown as Response;

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch whose responses the test hands out; records every URL and header it was called with. */
function scriptedFetch(answer: (url: string) => Response | Promise<Response> = () => res(200)) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    return answer(url);
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function spyLogger() {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: (m: string) => lines.push(`error ${m}`),
  };
  return { lines, logger };
}

function client(answer?: (url: string) => Response | Promise<Response>, logger = spyLogger().logger) {
  const clock = new FakeClock(T0);
  const f = scriptedFetch(answer);
  const pause = new PauseController(() => clock.now, logger);
  const rest = new FuturesRest(f.fetchImpl, () => clock.now, { setTimer: clock.setTimer, logger, pause });
  return { clock, rest, pause, ...f };
}

const pathOf = (url: string) => new URL(url).pathname;

describe('futures request weights', () => {
  it('uses the documented weight of every endpoint', () => {
    expect(futuresRequestWeight('/fapi/v1/depth', 'symbol=X&limit=1000')).toBe(20);
    expect(futuresRequestWeight('/fapi/v1/depth', 'symbol=X&limit=500')).toBe(10);
    expect(futuresRequestWeight('/fapi/v1/depth', 'symbol=X&limit=100')).toBe(5);
    expect(futuresRequestWeight('/fapi/v1/depth', 'symbol=X&limit=50')).toBe(2);
    expect(futuresRequestWeight('/fapi/v1/depth', 'symbol=X')).toBe(10); // Binance default limit 500
    expect(futuresRequestWeight('/fapi/v1/aggTrades', 'symbol=X&limit=1000')).toBe(20);
    expect(futuresRequestWeight('/fapi/v1/klines', 'symbol=X&interval=1m&limit=1000')).toBe(5);
    expect(futuresRequestWeight('/fapi/v1/klines', 'symbol=X&interval=1m&limit=1500')).toBe(10);
    expect(futuresRequestWeight('/fapi/v1/klines', 'symbol=X&interval=1m&limit=499')).toBe(2);
    expect(futuresRequestWeight('/fapi/v1/klines', 'symbol=X&interval=1m&limit=99')).toBe(1);
    expect(futuresRequestWeight('/fapi/v1/markPriceKlines', 'symbol=X&interval=1m&limit=1000')).toBe(5);
    expect(futuresRequestWeight('/fapi/v1/exchangeInfo', '')).toBe(1);
    expect(futuresRequestWeight('/fapi/v1/premiumIndex', '')).toBe(10);
    expect(futuresRequestWeight('/fapi/v1/premiumIndex', 'symbol=X')).toBe(1);
    expect(futuresRequestWeight('/fapi/v1/leverageBracket', 'timestamp=1')).toBe(1);
    expect(futuresRequestWeight('/fapi/v1/time', '')).toBe(1);
    expect(() => futuresRequestWeight('/fapi/v1/order', '')).toThrow('No known request weight for /fapi/v1/order');
  });

  it('sends each call to fapi with the expected query', async () => {
    const { rest, calls } = client();
    await rest.exchangeInfo();
    await rest.depth('BTCUSDT', 1000);
    await rest.aggTrades({ symbol: 'BTCUSDT', fromId: 42, limit: 1000 });
    await rest.aggTrades({ symbol: 'BTCUSDT', startTime: 1, endTime: 2, limit: 500 });
    await rest.klines('BTCUSDT', '1m', 1000, 10, 20);
    await rest.klines('BTCUSDT', '1m', 5);
    await rest.markPriceKlines('BTCUSDT', '1m', 1000, 10, 20);
    await rest.premiumIndex();
    await rest.serverTime();
    expect(calls.map((c) => c.url)).toEqual([
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
      'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000',
      'https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&fromId=42&limit=1000',
      'https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&startTime=1&endTime=2&limit=500',
      'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=1000&startTime=10&endTime=20',
      'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=5',
      'https://fapi.binance.com/fapi/v1/markPriceKlines?symbol=BTCUSDT&interval=1m&limit=1000&startTime=10&endTime=20',
      'https://fapi.binance.com/fapi/v1/premiumIndex',
      'https://fapi.binance.com/fapi/v1/time',
    ]);
    expect(rest.usedWeight).toBe(1 + 20 + 20 + 20 + 5 + 1 + 5 + 10 + 1);
    expect(calls.every((c) => Object.keys(c.headers).length === 0)).toBe(true); // only the signed call carries the key
  });
});

describe('futures weight budget', () => {
  it('is 1920 per 60 s, separate from spot: 96 aggTrades calls fit, the 97th waits for the first to leave the window', async () => {
    const { rest, clock, calls } = client();
    expect(rest.budget).toBe(FUTURES_WEIGHT_BUDGET_1M);
    expect(rest.budget).toBe(1920);
    for (let i = 0; i < 96; i++) await rest.aggTrades({ symbol: 'BTCUSDT', fromId: i, limit: 1000 });
    expect(rest.usedWeight).toBe(96 * 20);
    clock.advance(40_000);
    const late = rest.aggTrades({ symbol: 'BTCUSDT', fromId: 96, limit: 1000 });
    await tick();
    expect(calls).toHaveLength(96);
    clock.advance(19_999); // the first 96 are still in the window
    await tick();
    expect(calls).toHaveLength(96);
    clock.advance(1);
    await late;
    expect(calls).toHaveLength(97);
  });

  it('depth snapshots stop 200 short of the budget; other requests may use it all', async () => {
    const { rest, calls } = client();
    for (let i = 0; i < 86; i++) await rest.aggTrades({ symbol: 'BTCUSDT', fromId: i, limit: 1000 }); // 1720
    rest.depth('BTCUSDT', 1000).catch(() => {}); // 1740 > 1720: waits
    await tick();
    expect(calls.filter((c) => c.url.includes('depth'))).toHaveLength(0);
    for (let i = 0; i < 10; i++) await rest.aggTrades({ symbol: 'BTCUSDT', fromId: i, limit: 1000 });
    expect(rest.usedWeight).toBe(1920);
    expect(calls.filter((c) => c.url.includes('depth'))).toHaveLength(0);
  });

  it('fundingRate and fundingInfo share one lane of one call per 2 s and use no request weight', async () => {
    const { rest, clock, calls } = client();
    const sentAt: number[] = [];
    const done = [
      rest.fundingRate({ symbol: 'BTCUSDT', startTime: 1, endTime: 2, limit: 10 }),
      rest.fundingInfo(),
      rest.fundingRate({ symbol: 'ETHUSDT', startTime: 3, endTime: 4, limit: 10 }),
    ].map((p) => p.then(() => sentAt.push(clock.now)));
    await tick();
    expect(calls).toHaveLength(1);
    clock.advance(1999);
    await tick();
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await tick();
    expect(calls).toHaveLength(2);
    clock.advance(2000);
    await Promise.all(done);
    expect(sentAt).toEqual([T0, T0 + 2000, T0 + 4000]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=1&endTime=2&limit=10',
      'https://fapi.binance.com/fapi/v1/fundingInfo',
      'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&startTime=3&endTime=4&limit=10',
    ]);
    expect(rest.usedWeight).toBe(0);
  });

  it('dispose rejects queued requests (weight and funding lane) and every later call', async () => {
    const { rest, calls } = client();
    for (let i = 0; i < 96; i++) await rest.aggTrades({ symbol: 'BTCUSDT', fromId: i, limit: 1000 });
    await rest.fundingInfo();
    const queued = [rest.serverTime(), rest.fundingInfo()].map((p) => p.catch((e: Error) => e.message));
    const sent = calls.length;
    rest.dispose();
    expect(await Promise.all(queued)).toEqual(['Binance REST client closed', 'Binance REST client closed']);
    await expect(rest.exchangeInfo()).rejects.toThrow('Binance REST client closed');
    expect(calls).toHaveLength(sent);
  });
});

describe('signed leverageBracket', () => {
  const brackets = (url: string) => {
    if (pathOf(url) === '/fapi/v1/time') return res(200, {}, { serverTime: T0 + 1234 });
    return res(200, {}, official);
  };

  it('signs timestamp (server time) and recvWindow=5000 with HMAC-SHA256 and sends the key header', async () => {
    const { lines, logger } = spyLogger();
    const { rest, calls } = client(brackets, logger);
    const out = await rest.leverageBracket('k3y', 's3cret');
    expect(out).toEqual(official);
    const signed = calls.find((c) => pathOf(c.url) === '/fapi/v1/leverageBracket')!;
    const query = signed.url.split('?')[1]!;
    const [unsigned, signature] = query.split('&signature=') as [string, string];
    expect(unsigned).toBe(`timestamp=${T0 + 1234}&recvWindow=5000`);
    expect(signature).toBe(createHmac('sha256', 's3cret').update(unsigned).digest('hex'));
    expect(signed.headers).toEqual({ 'X-MBX-APIKEY': 'k3y' });
    expect(signed.url).not.toContain('s3cret');
    expect(rest.usedWeight).toBe(2); // time + leverageBracket
    for (const line of lines) {
      expect(line).not.toContain('k3y');
      expect(line).not.toContain('s3cret');
      expect(line).not.toContain(signature);
    }
  });

  it('a signed call that waits for weight is timestamped when it is sent, so recvWindow 5000 never expires in the queue', async () => {
    let clockRef: FakeClock | null = null;
    const { rest, clock, calls } = client((url) => {
      if (pathOf(url) === '/fapi/v1/time') return res(200, {}, { serverTime: clockRef!.now + 1234 });
      return res(200, {}, official);
    });
    clockRef = clock;
    for (let i = 0; i < 95; i++) await rest.aggTrades({ symbol: 'BTCUSDT', fromId: i, limit: 1000 }); // 1900 at T0
    clock.advance(40_000);
    for (let i = 0; i < 19; i++) await rest.klines('BTCUSDT', '1m', 10); // 1919: room for the time call only
    const signedCall = rest.leverageBracket('k3y', 's3cret');
    await tick();
    await tick();
    expect(calls.filter((c) => pathOf(c.url) === '/fapi/v1/leverageBracket')).toHaveLength(0);
    clock.advance(20_000); // the calls made at T0 leave the window: the signed call is sent at T0 + 60 s
    await signedCall;
    const signed = calls.find((c) => pathOf(c.url) === '/fapi/v1/leverageBracket')!;
    const [unsigned, signature] = signed.url.split('?')[1]!.split('&signature=') as [string, string];
    expect(unsigned).toBe(`timestamp=${T0 + 60_000 + 1234}&recvWindow=5000`);
    expect(signature).toBe(createHmac('sha256', 's3cret').update(unsigned).digest('hex'));
  });

  it('a failing signed call through the tier loader never logs the key, secret or signature', async () => {
    const { lines, logger } = spyLogger();
    const { rest, calls } = client((url) => {
      if (pathOf(url) === '/fapi/v1/time') return res(200, {}, { serverTime: T0 });
      // A hostile body echoing what it was sent must not reach the log either.
      return res(401, {}, `{"code":-2015,"msg":"Invalid API-key k3y, s3cret, ${url.split('signature=')[1]}"}`);
    }, logger);
    const loader = new TierLoader({
      symbols: SYMBOLS,
      rest,
      credentials: { key: 'k3y', secret: 's3cret' },
      unofficial: async () => bapi,
      logger,
    });
    const set = await loader.load(T0);
    expect(set.source).toBe('unofficial');
    const signature = calls.find((c) => pathOf(c.url) === '/fapi/v1/leverageBracket')!.url.split('signature=')[1]!;
    expect(lines.some((l) => l.startsWith('warn') && l.includes('401'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain('k3y');
      expect(line).not.toContain('s3cret');
      expect(line).not.toContain(signature);
    }
  });
});

describe('shared pause (HTTP 429 / 418)', () => {
  function both() {
    const clock = new FakeClock(T0);
    const { logger, lines } = spyLogger();
    const pause = new PauseController(() => clock.now, logger);
    let futuresNext = res(200);
    let spotNext = res(200);
    const fut = scriptedFetch(() => futuresNext);
    const spot = scriptedFetch(() => spotNext);
    const futures = new FuturesRest(fut.fetchImpl, () => clock.now, { setTimer: clock.setTimer, logger, pause });
    const binance = new BinanceRest(spot.fetchImpl, () => clock.now, { setTimer: clock.setTimer, logger, pause });
    return {
      clock,
      lines,
      futures,
      binance,
      futCalls: fut.calls,
      spotCalls: spot.calls,
      setFutures: (r: Response) => (futuresNext = r),
      setSpot: (r: Response) => (spotNext = r),
    };
  }

  it('a 429 from FuturesRest pauses BinanceRest too, including its queued requests', async () => {
    const t = both();
    for (let i = 0; i < 240; i++) await t.binance.exchangeInfo(['BTCUSDT']); // 4800: spot budget full
    const queuedSpot = t.binance.serverTime().catch((e: Error) => e.message);
    t.setFutures(res(429, { 'retry-after': '5', 'x-mbx-used-weight-1m': '2401' }));
    await expect(t.futures.serverTime()).rejects.toThrow('HTTP 429');
    expect(await queuedSpot).toBe('Binance REST paused for 5s (rate limited)');
    expect(t.binance.pausedUntil).toBe(T0 + 5000);
    expect(t.futures.pausedUntil).toBe(T0 + 5000);
    const spotSent = t.spotCalls.length;
    await expect(t.binance.avgPrice('BTCUSDT')).rejects.toThrow('paused');
    expect(t.spotCalls).toHaveLength(spotSent);
    const warn = t.lines.find((l) => l.startsWith('warn') && l.includes('429'))!;
    expect(warn).toContain('Binance futures REST');
    expect(warn).toContain('2401/2400');
    expect(warn).toContain('/1920');
  });

  it('a 418 from BinanceRest pauses FuturesRest, and 429 escalation is shared by both hosts', async () => {
    const t = both();
    t.setSpot(res(418, { 'retry-after': '300' }));
    await expect(t.binance.serverTime()).rejects.toThrow('HTTP 418');
    const futSent = t.futCalls.length;
    await expect(t.futures.fundingInfo()).rejects.toThrow('paused');
    await expect(t.futures.serverTime()).rejects.toThrow('paused');
    expect(t.futCalls).toHaveLength(futSent);
    t.clock.advance(300_000);
    t.setFutures(res(429));
    await expect(t.futures.serverTime()).rejects.toThrow('HTTP 429');
    expect(t.binance.pausedUntil - t.clock.now).toBe(60_000);
    t.clock.advance(60_000);
    t.setSpot(res(429));
    await expect(t.binance.serverTime()).rejects.toThrow('HTTP 429');
    expect(t.futures.pausedUntil - t.clock.now).toBe(120_000); // second strike, counted across hosts
    t.clock.advance(120_000);
    t.setFutures(res(200));
    await t.futures.serverTime(); // a success on either host resets the escalation
    t.setSpot(res(429));
    await expect(t.binance.serverTime()).rejects.toThrow('HTTP 429');
    expect(t.binance.pausedUntil - t.clock.now).toBe(60_000);
  });
});
