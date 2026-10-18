import { describe, it, expect } from 'vitest';
import { BinanceRest } from '../src/binance/rest.ts';
import { requestWeight, WEIGHT_BUDGET_1M } from '../src/binance/weightBudget.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { FakeClock, FakeWs, tick } from './helpers.ts';
import exchangeInfo from './fixtures/btcusdt-exchangeinfo.json' with { type: 'json' };

const silent = { info() {}, warn() {}, error() {} };
const T0 = 1_800_000_000_000; // a minute boundary

const res = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => 'limit',
    json: async () => body,
  }) as unknown as Response;

/** A fetch whose responses the test hands out; records every URL it was called with. */
function scriptedFetch(answer: (url: string) => Response | Promise<Response> = () => res(200)) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return answer(url);
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function client(answer?: (url: string) => Response | Promise<Response>, logger: any = silent) {
  const clock = new FakeClock(T0);
  const f = scriptedFetch(answer);
  const rest = new BinanceRest(f.fetchImpl, () => clock.now, { setTimer: clock.setTimer, logger });
  return { clock, rest, ...f };
}

/** Uses `weight` of the budget with exchangeInfo (20) and avgPrice (2): critical requests, which may fill all 4800. */
async function spend(rest: BinanceRest, weight: number) {
  for (; weight >= 20; weight -= 20) await rest.exchangeInfo(['BTCUSDT']);
  for (; weight >= 2; weight -= 2) await rest.avgPrice('BTCUSDT');
}

describe('request weights', () => {
  it('uses the documented weight of every endpoint', () => {
    expect(requestWeight('/api/v3/depth', 'symbol=X&limit=5')).toBe(5);
    expect(requestWeight('/api/v3/depth', 'symbol=X&limit=100')).toBe(5);
    expect(requestWeight('/api/v3/depth', 'symbol=X&limit=101')).toBe(25);
    expect(requestWeight('/api/v3/depth', 'symbol=X&limit=500')).toBe(25);
    expect(requestWeight('/api/v3/depth', 'symbol=X&limit=1000')).toBe(50);
    expect(requestWeight('/api/v3/depth', 'symbol=X&limit=5000')).toBe(250);
    expect(requestWeight('/api/v3/depth', 'symbol=X')).toBe(5); // Binance default limit 100
    expect(requestWeight('/api/v3/avgPrice', 'symbol=X')).toBe(2);
    expect(requestWeight('/api/v3/exchangeInfo', 'symbols=[]')).toBe(20);
    expect(requestWeight('/api/v3/klines', 'symbol=X&interval=1m&limit=500')).toBe(2);
    expect(requestWeight('/api/v3/time', '')).toBe(1);
  });

  it('reserves each request in a rolling 60 s window', async () => {
    const { rest, clock } = client();
    expect(rest.budget).toBe(4800);
    await rest.depth('BTCUSDT', 1000);
    clock.advance(30_000);
    await rest.exchangeInfo(['BTCUSDT']);
    await rest.klines('BTCUSDT', '1m', 500);
    await rest.serverTime();
    expect(rest.usedWeight).toBe(50 + 20 + 2 + 1);
    clock.advance(30_000); // the depth call is 60 s old now
    expect(rest.usedWeight).toBe(23);
    clock.advance(30_000);
    expect(rest.usedWeight).toBe(0);
  });
});

describe('REST weight budget', () => {
  it('a request over budget waits (FIFO within its lane, not an error) and is sent when weight frees up', async () => {
    const { rest, clock, calls } = client();
    await spend(rest, 2400);
    clock.advance(40_000);
    await spend(rest, 1960); // 4360 used; depth may fill up to 4400
    clock.advance(5_000);
    const order: string[] = [];
    const big = rest.depth('BTCUSDT', 1000).then(() => order.push('depth 1000')); // 4410: waits
    const small = rest.depth('BTCUSDT', 100).then(() => order.push('depth 100')); // 4365 would fit, but waits its turn
    const sent = calls.length;
    await rest.serverTime(); // critical: not behind the waiting snapshots
    expect(calls.length).toBe(sent + 1);
    clock.advance(14_999); // t = 59.999 s: the first 2400 are still in the window
    await tick();
    expect(calls.length).toBe(sent + 1);
    expect(order).toEqual([]);
    clock.advance(1);
    await Promise.all([big, small]);
    expect(order).toEqual(['depth 1000', 'depth 100']);
    expect(calls.slice(sent + 1).map((u) => new URL(u).searchParams.get('limit'))).toEqual(['1000', '100']);
  });

  it('depth snapshots stop 400 short of the budget; critical requests may use it all', async () => {
    const { rest, calls } = client();
    await spend(rest, 4360);
    rest.depth('BTCUSDT', 1000).catch(() => {}); // 4410 > 4400: waits
    await tick();
    expect(calls.filter((u) => u.includes('depth'))).toHaveLength(0);
    await spend(rest, 440); // critical requests still get through, up to the full budget
    expect(rest.usedWeight).toBe(4800);
    expect(calls.filter((u) => u.includes('depth'))).toHaveLength(0);
  });

  it('a waiting request rejects after 30 s with the budget message and is never sent', async () => {
    const { rest, clock, calls } = client();
    await spend(rest, 4800);
    const sent = calls.length;
    const p = rest.avgPrice('BTCUSDT');
    const err = p.catch((e: Error) => e.message);
    clock.advance(29_999);
    await tick();
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await tick();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(await err).toBe('Binance REST budget exhausted; retry later');
    expect(calls.length).toBe(sent);
  });

  it('logs the budget wait at most once per 10 s', async () => {
    const warns: string[] = [];
    const { rest, clock } = client(undefined, { info() {}, error() {}, warn: (m: string) => warns.push(m) });
    await spend(rest, 4800);
    for (let i = 0; i < 5; i++) {
      rest.serverTime().catch(() => {});
      clock.advance(2000);
    }
    expect(warns).toEqual(['Binance REST weight budget reached (used 4800/4800); delaying requests']);
    clock.advance(1000);
    rest.serverTime().catch(() => {});
    expect(warns).toHaveLength(2);
  });

  it('the header raises effective weight above the local estimate (another process on the same IP)', async () => {
    let hold: ((r: Response) => void) | null = null;
    let header = '4700';
    const { rest, clock, calls } = client((url) =>
      url.includes('exchangeInfo') && !hold ? new Promise<Response>((r) => (hold = r)) : res(200, { 'X-MBX-USED-WEIGHT-1M': header }),
    );
    const infoCalls = () => calls.filter((u) => u.includes('exchangeInfo')).length;
    clock.advance(40_000);
    await rest.avgPrice('BTCUSDT'); // local estimate 2, Binance says 4700
    expect(rest.usedWeight).toBe(4700);
    const inFlight = rest.exchangeInfo(['BTCUSDT']); // reserved after the header was taken: counted on top
    await tick();
    expect(rest.usedWeight).toBe(4720);
    header = '4798';
    await rest.avgPrice('BTCUSDT');
    expect(rest.usedWeight).toBe(4798);
    const blocked = rest.exchangeInfo(['BTCUSDT']); // 4818 would not fit, although the local estimate is 24
    await tick();
    expect(infoCalls()).toBe(1);
    hold!(res(200, { 'x-mbx-used-weight-1m': '4750' })); // a lower reading does not lower the minute's maximum
    await inFlight;
    expect(rest.usedWeight).toBe(4798);
    header = '20'; // what Binance reports in the new minute
    clock.advance(20_000); // next minute: the old header no longer counts; the local estimate rules
    await blocked;
    expect(infoCalls()).toBe(2);
    expect(rest.usedWeight).toBe(44);
  });
});

describe('weight header attribution', () => {
  it('a response straddling a minute boundary counts for the minute it was sent in, not the next', async () => {
    // Fake Binance: fixed-minute accounting by arrival (= send) time.
    const used = new Map<number, number>();
    let hold: (() => void) | null = null;
    const { rest, clock, calls } = client((url) => {
      const m = Math.floor(clock.now / 60_000);
      const u = (used.get(m) ?? 0) + requestWeight(new URL(url).pathname, new URL(url).search.slice(1));
      used.set(m, u);
      const r = res(200, { 'X-MBX-USED-WEIGHT-1M': String(u) });
      return url.includes('avgPrice') && clock.now === T0 + 59_900 ? new Promise<Response>((ok) => (hold = () => ok(r))) : r;
    });
    await spend(rest, 4750); // minute M
    clock.advance(59_900);
    const late = rest.avgPrice('BTCUSDT'); // sent at M+59.9 s, carries minute M's 4752 ...
    await tick();
    clock.advance(200);
    hold!(); // ... but arrives at M+60.1 s
    await late;
    clock.advance(5000);
    const before = calls.length;
    const depth = rest.depth('BTCUSDT', 1000);
    await tick();
    expect(calls.length).toBe(before + 1); // not blocked by the previous minute's reading
    await depth;
    expect(rest.usedWeight).toBe(52);
  });

  it("a lower reading later in the same minute does not lower that minute's maximum", async () => {
    let header = '4000';
    const { rest } = client(() => res(200, { 'X-MBX-USED-WEIGHT-1M': header }));
    await rest.serverTime();
    expect(rest.usedWeight).toBe(4000);
    header = '3000';
    await rest.avgPrice('BTCUSDT');
    expect(rest.usedWeight).toBe(4002); // the 4000 reading plus what was sent after it
  });
});

describe('request lanes', () => {
  it('avgPrice, exchangeInfo, time and klines waiting for budget go before waiting depth snapshots; FIFO within a lane', async () => {
    const { rest, clock, calls } = client();
    await spend(rest, 4800);
    clock.advance(40_000);
    const order: string[] = [];
    const track = (name: string, p: Promise<unknown>) => p.then(() => order.push(name));
    const all = [
      track('depth BTC', rest.depth('BTCUSDT', 1000)),
      track('depth ETH', rest.depth('ETHUSDT', 1000)),
      track('avg BTC', rest.avgPrice('BTCUSDT')),
      track('info', rest.exchangeInfo(['BTCUSDT'])),
      track('time', rest.serverTime()),
      track('klines', rest.klines('BTCUSDT', '1m', 500)),
      track('avg ETH', rest.avgPrice('ETHUSDT')),
    ];
    const sent = calls.length;
    clock.advance(20_000); // the spent weight leaves the window
    await Promise.all(all);
    expect(order).toEqual(['avg BTC', 'info', 'time', 'klines', 'avg ETH', 'depth BTC', 'depth ETH']);
    expect(calls.length).toBe(sent + 7);
  });
});

describe('dispose', () => {
  it('rejects queued requests, sends nothing later and rejects later calls', async () => {
    const { rest, clock, calls } = client();
    await spend(rest, 4800);
    const queued = [rest.depth('BTCUSDT', 1000), rest.avgPrice('BTCUSDT')].map((p) => p.catch((e: Error) => e.message));
    const sent = calls.length;
    rest.dispose();
    expect(await Promise.all(queued)).toEqual(['Binance REST client closed', 'Binance REST client closed']);
    clock.advance(120_000);
    await tick();
    await expect(rest.serverTime()).rejects.toThrow('Binance REST client closed');
    expect(calls.length).toBe(sent);
  });
});

describe('HTTP 429 / 418', () => {
  it('a 429 with Retry-After 5 pauses all calls for 5 s, including queued ones', async () => {
    let hold: ((r: Response) => void) | null = null;
    const { rest, clock, calls } = client((url) =>
      url.includes('time') ? new Promise<Response>((r) => (hold = r)) : res(200),
    );
    await spend(rest, 4798);
    clock.advance(55_000); // the spent weight leaves the window when the pause ends
    const inFlight = rest.serverTime(); // 4799: sent, answer pending
    await tick();
    const queued = rest.avgPrice('BTCUSDT').catch((e: Error) => e.message); // 4801: waits
    hold!(res(429, { 'retry-after': '5' }));
    await expect(inFlight).rejects.toThrow('HTTP 429');
    expect(rest.pausedUntil).toBe(T0 + 60_000);
    expect(await queued).toBe('Binance REST paused for 5s (rate limited)');
    const sent = calls.length;
    clock.advance(4999);
    for (const call of [
      () => rest.depth('BTCUSDT'),
      () => rest.avgPrice('BTCUSDT'),
      () => rest.exchangeInfo(['BTCUSDT']),
      () => rest.serverTime(),
      () => rest.klines('BTCUSDT', '1m', 5),
    ]) {
      await expect(call()).rejects.toThrow('paused');
    }
    expect(calls.length).toBe(sent);
    clock.advance(1);
    await rest.avgPrice('BTCUSDT');
    expect(calls.length).toBe(sent + 1);
  });

  it('consecutive 429s escalate the pause 60, 120, 240 ... capped at 15 min; a success resets it', async () => {
    let next = res(429);
    const { rest, clock } = client(() => next);
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) {
      await expect(rest.serverTime()).rejects.toThrow('HTTP 429');
      pauses.push((rest.pausedUntil - clock.now) / 1000);
      clock.advance(rest.pausedUntil - clock.now);
    }
    expect(pauses).toEqual([60, 120, 240, 480, 900, 900]);
    next = res(200);
    await rest.serverTime();
    next = res(429, { 'retry-after': '5' });
    await expect(rest.serverTime()).rejects.toThrow('HTTP 429');
    expect(rest.pausedUntil - clock.now).toBe(5000);
    clock.advance(5000);
    await expect(rest.serverTime()).rejects.toThrow('HTTP 429');
    expect(rest.pausedUntil - clock.now).toBe(120_000); // escalation beats a short Retry-After
  });

  it('a 200 for a request sent before a 429 does not reset the escalation', async () => {
    const holds: ((r: Response) => void)[] = [];
    let next: Response | null = null;
    const { rest, clock } = client(() => next ?? new Promise<Response>((r) => holds.push(r)));
    const a = rest.serverTime();
    const b = rest.serverTime();
    await tick();
    holds[0]!(res(429));
    await expect(a).rejects.toThrow('HTTP 429');
    holds[1]!(res(200)); // in flight before the pause: says nothing about the limit now
    await b;
    clock.advance(60_000);
    next = res(429);
    await expect(rest.serverTime()).rejects.toThrow('HTTP 429');
    expect(rest.pausedUntil - clock.now).toBe(120_000);
  });

  it('429s for requests already in flight when the pause began do not escalate it', async () => {
    const holds: ((r: Response) => void)[] = [];
    const { rest } = client(() => new Promise<Response>((r) => holds.push(r)));
    const a = rest.serverTime();
    const b = rest.serverTime();
    await tick();
    holds[0]!(res(429));
    await expect(a).rejects.toThrow('HTTP 429');
    holds[1]!(res(429));
    await expect(b).rejects.toThrow('HTTP 429');
    expect(rest.pausedUntil - T0).toBe(60_000);
  });

  it('a 418 with Retry-After 300 makes zero requests for 300 s, including queued ones', async () => {
    let hold: ((r: Response) => void) | null = null;
    const errors: string[] = [];
    const { rest, clock, calls } = client(
      (url) => (url.includes('time') ? new Promise<Response>((r) => (hold = r)) : res(200)),
      { info() {}, warn() {}, error: (m: string) => errors.push(m) },
    );
    await spend(rest, 4798);
    const banned = rest.serverTime(); // 4799
    await tick();
    const queued = rest.avgPrice('BTCUSDT').catch((e: Error) => e.message); // 4801: waits
    hold!(res(418, { 'Retry-After': '300', 'X-MBX-USED-WEIGHT-1M': '6100' }));
    await expect(banned).rejects.toThrow('HTTP 418');
    expect(await queued).toMatch(/paused/);
    const sent = calls.length;
    for (let s = 0; s < 300; s += 10) {
      await expect(rest.avgPrice('BTCUSDT')).rejects.toThrow('paused');
      clock.advance(10_000);
    }
    expect(calls.length).toBe(sent);
    expect(clock.now).toBe(T0 + 300_000);
    await rest.avgPrice('BTCUSDT');
    expect(calls.length).toBe(sent + 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('418');
    expect(errors[0]).toContain('6100');
  });

  it('a 418 without Retry-After pauses 15 min; a 429 warns with the weight figures', async () => {
    const warns: string[] = [];
    let next = res(418);
    const { rest, clock } = client(() => next, { info() {}, error() {}, warn: (m: string) => warns.push(m) });
    await expect(rest.serverTime()).rejects.toThrow('HTTP 418');
    expect(rest.pausedUntil).toBe(T0 + 900_000);
    clock.advance(900_000);
    next = res(429, { 'X-MBX-USED-WEIGHT-1M': '6001' });
    await expect(rest.serverTime()).rejects.toThrow('HTTP 429');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('429');
    expect(warns[0]).toContain('6001');
    expect(warns[0]).toContain('4800');
  });
});

describe('resync storm', () => {
  it('10 books gapping every 200 ms for 5 minutes plus pollers stay within the weight budget, never starve, and avgPrice never lapses', async () => {
    const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NEARUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'SUIUSDT', 'HYPEUSDT', 'AVAXUSDT'];
    const clock = new FakeClock(T0 + 17_300); // not on a minute boundary
    const start = clock.now;
    const seq = new Map(SYMBOLS.map((s, i) => [s, 1000 * (i + 1)]));

    // Fake Binance: fixed-minute weight accounting, 429 above 6000.
    const minuteUsed = new Map<number, number>();
    const sent: { at: number; weight: number }[] = [];
    const statuses: number[] = [];
    const avgSent = new Map<string, number[]>(SYMBOLS.map((s) => [s, []]));
    const avgFirst = new Map<string, number>();
    const avgLost: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      const q = u.searchParams;
      const weight =
        u.pathname === '/api/v3/depth'
          ? Number(q.get('limit')) <= 100
            ? 5
            : Number(q.get('limit')) <= 500
              ? 25
              : Number(q.get('limit')) <= 1000
                ? 50
                : 250
          : ({ '/api/v3/avgPrice': 2, '/api/v3/exchangeInfo': 20, '/api/v3/klines': 2, '/api/v3/time': 1 } as Record<string, number>)[
              u.pathname
            ]!;
      const minute = Math.floor(clock.now / 60_000);
      const used = (minuteUsed.get(minute) ?? 0) + weight;
      minuteUsed.set(minute, used);
      sent.push({ at: clock.now, weight });
      if (u.pathname === '/api/v3/avgPrice') avgSent.get(q.get('symbol')!)!.push(clock.now);
      const headers = { 'X-MBX-USED-WEIGHT-1M': String(used) };
      const status = used > 6000 ? 429 : 200;
      statuses.push(status);
      if (status !== 200) return res(status, headers);
      if (u.pathname === '/api/v3/depth') {
        return res(200, headers, { lastUpdateId: seq.get(q.get('symbol')!)!, bids: [['100', '1']], asks: [['101', '1']] });
      }
      if (u.pathname === '/api/v3/avgPrice') return res(200, headers, { mins: 5, price: '100' });
      if (u.pathname === '/api/v3/time') return res(200, headers, { serverTime: clock.now });
      return res(200, headers, exchangeInfo); // BTCUSDT only: rules keep retrying on the startup schedule
    }) as unknown as typeof fetch;

    const rest = new BinanceRest(fetchImpl, () => clock.now, { setTimer: clock.setTimer, logger: silent });
    const health = new FeedHealth(SYMBOLS, { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 });
    const syncs = new Map<string, number[]>(SYMBOLS.map((s) => [s, []]));
    const setBookValid = health.setBookValid.bind(health);
    health.setBookValid = (s: string, v: boolean) => {
      if (v) syncs.get(s)!.push(clock.now);
      setBookValid(s, v);
    };
    const books = new Map(SYMBOLS.map((s) => [s, new LocalBook()]));
    const sockets: FakeWs[] = [];
    const feed = new SpotFeed({
      symbols: SYMBOLS,
      rest,
      health,
      books,
      logger: silent,
      now: () => clock.now,
      setTimer: clock.setTimer,
      wsFactory: (u) => {
        const w = new FakeWs(u);
        sockets.push(w);
        return w as any;
      },
    });
    const md = new MarketData({ symbols: SYMBOLS, feed, books, health, rest, logger: silent, now: () => clock.now, setTimer: clock.setTimer });
    md.start();
    feed.start();
    sockets[0]!.open();

    const diff = (s: string, U: number, u: number) => ({
      stream: `${s.toLowerCase()}@depth@100ms`,
      data: { e: 'depthUpdate', E: clock.now, s, U, u, b: [], a: [] },
    });
    let maxLocal = 0;
    for (let step = 1; clock.now - start < 5 * 60_000; step++) {
      clock.advance(100);
      await tick();
      for (const s of SYMBOLS) {
        const n = seq.get(s)! + 1; // contiguous: bridges a fresh snapshot
        sockets[0]!.msg(diff(s, n, n));
        seq.set(s, n);
        if (step % 2 === 0) {
          const g = n + 5; // sequence gap
          sockets[0]!.msg(diff(s, g, g));
          seq.set(s, g);
        }
      }
      maxLocal = Math.max(maxLocal, rest.usedWeight);
      for (const s of SYMBOLS) {
        if (md.avgPrice(s) !== null) avgFirst.set(s, avgFirst.get(s) ?? clock.now);
        else if (avgFirst.has(s)) avgLost.push(`${s} at +${clock.now - start} ms`);
      }
    }
    md.stop();
    feed.close();

    // Binance never limited us.
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    // No rolling 60 s window over 4800 (so none over 6000).
    let maxRolling = 0;
    for (const r of sent) {
      const w = sent.filter((x) => x.at > r.at - 60_000 && x.at <= r.at).reduce((a, x) => a + x.weight, 0);
      maxRolling = Math.max(maxRolling, w);
    }
    expect(maxRolling).toBeLessThanOrEqual(WEIGHT_BUDGET_1M);
    expect(maxLocal).toBeLessThanOrEqual(WEIGHT_BUDGET_1M);
    // The storm really pushed against the budget (demand is several times the budget).
    expect(maxRolling).toBeGreaterThan(4500);
    // Every symbol resynced at least once in every simulated minute.
    for (let m = 0; m < 5; m++) {
      const lo = start + m * 60_000;
      for (const s of SYMBOLS) {
        expect(syncs.get(s)!.some((t) => t >= lo && t < lo + 60_000), `${s} in minute ${m}`).toBe(true);
      }
    }
    // avgPrice goes before snapshots: every symbol has one within 20 s and never loses it.
    for (const s of SYMBOLS) expect(avgFirst.get(s)! - start, s).toBeLessThan(20_000);
    expect(avgLost).toEqual([]);
    for (const [s, ts] of avgSent) {
      // AVG_PRICE_MAX_AGE_MS is 60 s; the 10 s poll must keep its pace, not merely scrape under it.
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!, s).toBeLessThan(15_000);
      expect(ts.length, s).toBeGreaterThanOrEqual(25); // about every 10 s
    }
    expect(sent.filter((r) => r.weight === 20).length).toBeGreaterThan(4);
  }, 30_000);
});
