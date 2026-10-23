import { describe, it, expect } from 'vitest';
import { D } from '@sim/engine';
import type { TierSet } from '@sim/engine';
import { parsePerpRules } from '../src/binance/parsePerpRules.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { PerpFeed, perpHealth, PERP_DEPTH_URL, PERP_MARKET_URL } from '../src/market/perpFeed.ts';
import { PerpMarketData, TIERS_REFRESH_MS } from '../src/market/perpMarketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { FakeClock, FakeWs, tick } from './helpers.ts';
import perpInfo from './fixtures/btcusdt-perp-exchangeinfo.json' with { type: 'json' };

const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };
const T0 = 1_792_711_920_000;
const silent = { info() {}, warn() {}, error() {} };
type Lv = [string, string][];

const btcEntry = (perpInfo as any).symbols.find((s: any) => s.symbol === 'BTCUSDT');
const entry = (symbol: string, status = 'TRADING') => ({ ...btcEntry, symbol, pair: symbol, status });

const tierSet = (source: TierSet['source'], fetchedAt: number, symbols: string[], maxLeverage = 150): TierSet => ({
  source,
  fetchedAt,
  brackets: Object.fromEntries(
    symbols.map((s) => [s, [{ floor: D(0), cap: D(300000), mmr: D('0.004'), cum: D(0), maxLeverage }]]),
  ),
});

/**
 * The real PerpFeed and PerpMarketData over fake sockets and a fake clock. `sync()` opens both
 * sockets, loads every book (bids 100 x 1, asks 101 x 1, then a bridging update), sends a mark and
 * a trade per symbol and loads rules and tiers: every symbol is fresh after it.
 */
function stack(symbols = ['BTCUSDT']) {
  const clock = new FakeClock(T0);
  const sockets: FakeWs[] = [];
  const health = perpHealth(symbols, cfg);
  const books = new Map(symbols.map((s) => [s, new LocalBook({ mode: 'futures' })]));
  const status: Record<string, string> = Object.fromEntries(symbols.map((s) => [s, 'TRADING']));
  const calls = { exchangeInfo: [] as number[], tiers: [] as number[] };
  let tiersResult: () => Promise<TierSet> = async () => tierSet('unofficial', clock.now, symbols);
  const rest = {
    depth: async (_s: string) => ({ lastUpdateId: 100, E: clock.now, T: clock.now, bids: [['100', '1']] as Lv, asks: [['101', '1']] as Lv }),
    exchangeInfo: async () => {
      calls.exchangeInfo.push(clock.now);
      return { symbols: [...symbols.map((s) => entry(s, status[s])), entry('BTCUSDT_261225')] };
    },
    serverTime: async () => ({ serverTime: clock.now }),
  };
  const tiers = {
    load: async (now: number) => {
      calls.tiers.push(now);
      return tiersResult();
    },
  };
  const common = { symbols, logger: silent, now: () => clock.now, setTimer: clock.setTimer };
  const feed = new PerpFeed({
    ...common,
    rest,
    health,
    books,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w as any;
    },
  });
  const md = new PerpMarketData({ ...common, feed, books, health, rest, tiers });
  const depthWs = () => sockets.filter((w) => w.url.startsWith(PERP_DEPTH_URL)).at(-1)!;
  const marketWs = () => sockets.filter((w) => w.url.startsWith(PERP_MARKET_URL)).at(-1)!;
  let nextU = 106;
  /** A current depth update chaining on the previous one. */
  const depth = (sym = 'BTCUSDT', b: Lv = [], a: Lv = []) => {
    const U = nextU;
    nextU += 2;
    depthWs().msg({ stream: `${sym.toLowerCase()}@depth@100ms`, data: { e: 'depthUpdate', E: clock.now, T: clock.now, s: sym, U, u: U + 1, pu: U - 1, b, a } });
  };
  const mark = (sym = 'BTCUSDT', p = '81328.08443478', E = clock.now) =>
    marketWs().msg({
      stream: `${sym.toLowerCase()}@markPrice@1s`,
      data: { e: 'markPriceUpdate', E, s: sym, p, i: '81367.24130435', P: '81402.1', r: '0.00005355', T: 1792713600000 },
    });
  const trade = (sym = 'BTCUSDT', id = 1, p = '100.5') =>
    marketWs().msg({ stream: `${sym.toLowerCase()}@aggTrade`, data: { e: 'aggTrade', E: clock.now, a: id, p, q: '0.5', T: clock.now, m: false } });
  const advance = async (ms: number) => {
    clock.advance(ms);
    await tick();
  };
  const sync = async () => {
    feed.start();
    depthWs().open();
    marketWs().open();
    for (const s of symbols) {
      depthWs().msg({ stream: `${s.toLowerCase()}@depth@100ms`, data: { e: 'depthUpdate', E: clock.now, T: clock.now, s, U: 90, u: 105, pu: 89, b: [], a: [] } });
    }
    await advance(200 * symbols.length);
    await md.refreshRules();
    await md.refreshTiers();
    for (const s of symbols) {
      mark(s);
      trade(s);
    }
  };
  const setTiers = (fn: () => Promise<TierSet>) => {
    tiersResult = fn;
  };
  return { clock, sockets, health, books, status, calls, feed, md, depthWs, marketWs, depth, mark, trade, advance, sync, setTiers };
}

describe('PerpMarketData freshness', () => {
  it('is fresh with a synced book, current trades and mark, rules, TRADING and tiers', async () => {
    const t = stack();
    await t.sync();
    expect(t.md.isFresh('BTCUSDT')).toBe(true);
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(true);
    expect(t.md.healthSnapshot()).toEqual({ BTCUSDT: { fresh: true, reason: null } });
  });

  it('mark staleness: fresh 10 000 ms after the last mark, stale 1 ms later', async () => {
    const t = stack();
    await t.sync();
    const T = t.clock.now; // the last mark
    for (let i = 0; i < 10; i++) {
      await t.advance(1000);
      t.depth();
      t.trade('BTCUSDT', 2 + i);
    }
    expect(t.clock.now).toBe(T + 10_000);
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(true);
    expect(t.md.isFresh('BTCUSDT')).toBe(true);
    await t.advance(1);
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(false);
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'No mark price for 10s' });
    expect(t.md.markPrice('BTCUSDT')!.toString()).toBe('81328.08443478'); // the last real mark, never invented
    t.mark('BTCUSDT', '81330');
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(true);
    expect(t.md.markPrice('BTCUSDT')!.toString()).toBe('81330');
  });

  it('the depth socket being down makes the symbol stale while the mark stays fresh', async () => {
    const t = stack();
    await t.sync();
    t.depthWs().drop();
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(true);
    expect(t.md.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'Disconnected' });
    expect(t.md.best('BTCUSDT', 'buy')).toBeNull(); // an invalid book serves nothing
  });

  it('the market socket silent 15 s: perp symbols and marks are stale, the spot feed is unaffected', async () => {
    const t = stack();
    const spotSockets: FakeWs[] = [];
    const spotHealth = new FeedHealth(['BTCUSDT'], cfg);
    const spot = new SpotFeed({
      symbols: ['BTCUSDT'],
      rest: { depth: async () => ({ lastUpdateId: 100, bids: [['100', '1']] as Lv, asks: [['101', '1']] as Lv }) },
      health: spotHealth,
      books: new Map([['BTCUSDT', new LocalBook()]]),
      logger: silent,
      wsFactory: (url) => {
        const w = new FakeWs(url);
        spotSockets.push(w);
        return w as any;
      },
      now: () => t.clock.now,
      setTimer: t.clock.setTimer,
    });
    spot.start();
    spotSockets[0]!.open();
    await t.sync();
    let U = 101;
    const spotDepth = () => {
      spotSockets[0]!.msg({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', E: t.clock.now, s: 'BTCUSDT', U, u: U, b: [], a: [] } });
      U++;
    };
    spotDepth();
    expect(spotHealth.isFresh('BTCUSDT', t.clock.now)).toBe(true);
    for (let i = 0; i < 15; i++) {
      await t.advance(1000);
      t.depth(); // the perp depth socket keeps going
      spotDepth();
    }
    await t.advance(1);
    t.depth();
    spotDepth();
    expect(t.health.depth.isFresh('BTCUSDT', t.clock.now)).toBe(true);
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(false);
    expect(t.md.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'Connection silent for 15s' });
    expect(spotHealth.isFresh('BTCUSDT', t.clock.now)).toBe(true);
    spot.close();
  });

  it('isFresh needs rules, TRADING status and tiers; a halt is the reason', async () => {
    const t = stack();
    t.feed.start();
    t.depthWs().open();
    t.marketWs().open();
    t.depthWs().msg({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', E: t.clock.now, T: t.clock.now, s: 'BTCUSDT', U: 90, u: 105, pu: 89, b: [], a: [] } });
    await t.advance(0);
    t.mark();
    t.trade();
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.healthSnapshot().BTCUSDT!.reason).toBe('Trading rules not loaded');
    expect(() => t.md.rules('BTCUSDT')).toThrow('Rules not loaded for BTCUSDT');
    await t.md.refreshRules();
    expect(t.md.rules('BTCUSDT')).toEqual(parsePerpRules(btcEntry));
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.healthSnapshot().BTCUSDT!.reason).toBe('Leverage tiers not loaded');
    expect(() => t.md.brackets('BTCUSDT')).toThrow('Leverage tiers not loaded for BTCUSDT');
    await t.md.refreshTiers();
    expect(t.md.brackets('BTCUSDT')[0]!.maxLeverage).toBe(150);
    expect(t.md.isFresh('BTCUSDT')).toBe(true);
    t.status.BTCUSDT = 'SETTLING';
    await t.md.refreshRules();
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'Trading halted on Binance (SETTLING)' });
  });

  it('markStalled makes the book wait for current depth and the mark for a current mark; lastFrameAt is the older socket', async () => {
    const t = stack();
    await t.sync();
    const marketAt = t.clock.now;
    await t.advance(500);
    t.depth();
    expect(t.md.lastFrameAt()).toBe(marketAt);
    expect(t.md.healths()).toEqual([t.health.depth, t.health.market]);
    t.md.markStalled(t.clock.now);
    expect(t.md.isFresh('BTCUSDT')).toBe(false);
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(false);
    t.depth();
    expect(t.md.isFresh('BTCUSDT')).toBe(false); // the mark still waits
    t.mark();
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(true);
    expect(t.md.isFresh('BTCUSDT')).toBe(true);
  });

  it("the clock offset from Binance futures time applies to both connections' lag", async () => {
    const t = stack();
    await t.sync();
    const rest = (t.md as any).rest;
    rest.serverTime = async () => ({ serverTime: t.clock.now + 7000 }); // Binance's clock 7 s ahead
    expect(await t.md.refreshClockOffset()).toBe(true);
    t.mark('BTCUSDT', '1', t.clock.now + 7000);
    t.depth();
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(true);
    t.mark('BTCUSDT', '1', t.clock.now); // 7 s late on Binance's clock
    expect(t.md.isMarkFresh('BTCUSDT')).toBe(false);
  });
});

describe('PerpMarketData data', () => {
  it('marks(), lastPrice, recentTrades, tickers and the book with the own-liquidity overlay', async () => {
    const t = stack(['BTCUSDT', 'ETHUSDT']);
    expect(t.md.markPrice('BTCUSDT')).toBeNull();
    await t.sync();
    const marks = t.md.marks();
    expect(Object.keys(marks).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(marks.BTCUSDT!.markPrice.toString()).toBe('81328.08443478');
    expect(marks.BTCUSDT!.fundingRate.toString()).toBe('0.00005355');
    expect(marks.BTCUSDT!.nextFundingTime).toBe(1792713600000);
    expect(marks.BTCUSDT!.fresh).toBe(true);
    expect(t.md.lastPrice('BTCUSDT')!.toString()).toBe('100.5');
    expect(t.md.recentTrades('BTCUSDT')).toHaveLength(1);
    t.marketWs().msg({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: t.clock.now, c: '110', o: '100' } });
    expect(t.md.tickers().BTCUSDT!.change24hPct.toString()).toBe('10');

    expect(t.md.best('BTCUSDT', 'buy')!.toString()).toBe('101');
    expect(t.md.best('BTCUSDT', 'sell')!.toString()).toBe('100');
    t.md.consume('BTCUSDT', 'buy', [{ price: D('101'), qty: D('0.4') }]);
    expect(t.md.book('BTCUSDT').asks[0]!.qty.toString()).toBe('0.6');
    expect(t.md.bookTop('BTCUSDT').asks[0]!.qty.toString()).toBe('1'); // the real book
    t.depth('BTCUSDT', [], [['101', '2']]); // the exchange's new quantity there ends the claim
    expect(t.md.book('BTCUSDT').asks[0]!.qty.toString()).toBe('2');

    await t.advance(10_001);
    expect(t.md.marks().BTCUSDT!.fresh).toBe(false);
  });

  it("re-emits 'trade', 'mark' and 'book'", async () => {
    const t = stack();
    const seen: string[] = [];
    t.md.on('trade', (s: string) => seen.push(`trade ${s}`));
    t.md.on('mark', (s: string) => seen.push(`mark ${s}`));
    t.md.on('book', (s: string) => seen.push(`book ${s}`));
    await t.sync();
    t.depth();
    expect(seen).toEqual(['book BTCUSDT', 'mark BTCUSDT', 'trade BTCUSDT', 'book BTCUSDT']);
  });
});

describe('PerpMarketData refreshes', () => {
  it('rules refresh hourly, and every 45 000 ms while any perp symbol is not TRADING', async () => {
    const t = stack(['BTCUSDT', 'ETHUSDT']);
    const T = t.clock.now;
    t.md.start();
    await t.advance(0);
    expect(t.calls.exchangeInfo).toEqual([T]);
    t.status.ETHUSDT = 'BREAK';
    await t.advance(3_600_000);
    expect(t.calls.exchangeInfo).toEqual([T, T + 3_600_000]);
    await t.advance(44_999);
    expect(t.calls.exchangeInfo).toHaveLength(2);
    await t.advance(1);
    expect(t.calls.exchangeInfo.at(-1)).toBe(T + 3_645_000);
    t.status.ETHUSDT = 'TRADING';
    await t.advance(45_000);
    expect(t.calls.exchangeInfo.at(-1)).toBe(T + 3_690_000);
    await t.advance(3_599_999);
    expect(t.calls.exchangeInfo).toHaveLength(4);
    await t.advance(1);
    expect(t.calls.exchangeInfo.at(-1)).toBe(T + 7_290_000);
    t.md.stop();
  });

  it('a refresh picks up changed rules (marketTakeBound, price multipliers)', async () => {
    const t = stack();
    await t.md.refreshRules();
    expect(t.md.rules('BTCUSDT').marketTakeBound.toString()).toBe(btcEntry.marketTakeBound);
    const changed = {
      ...btcEntry,
      marketTakeBound: '0.03',
      filters: btcEntry.filters.map((f: any) =>
        f.filterType === 'PERCENT_PRICE' ? { ...f, multiplierUp: '1.0300', multiplierDown: '0.9700' } : f,
      ),
    };
    (t.md as any).rest.exchangeInfo = async () => ({ symbols: [changed] });
    await t.md.refreshRules();
    expect(t.md.rules('BTCUSDT').marketTakeBound.toString()).toBe('0.03');
    expect(t.md.rules('BTCUSDT').multiplierUp.toString()).toBe('1.03');
  });

  it('a failed rules refresh keeps the previous rules', async () => {
    const t = stack();
    await t.md.refreshRules();
    (t.md as any).rest.exchangeInfo = async () => {
      throw new Error('down');
    };
    expect(await t.md.refreshRules()).toBe(false);
    expect(t.md.rules('BTCUSDT').symbol).toBe('BTCUSDT');
  });

  it('tiers load at start and refresh every 24 h; a failed refresh keeps the previous set', async () => {
    const t = stack();
    const T = t.clock.now;
    expect(TIERS_REFRESH_MS).toBe(86_400_000);
    expect(t.md.tierInfo()).toBeNull();
    t.md.start();
    await t.advance(0);
    expect(t.calls.tiers).toEqual([T]);
    expect(t.md.tierInfo()).toEqual({ source: 'unofficial', fetchedAt: T });
    t.setTiers(async () => {
      throw new Error('No usable leverage tier source');
    });
    await t.advance(86_400_000);
    expect(t.calls.tiers).toEqual([T, T + 86_400_000]);
    expect(t.md.tierInfo()).toEqual({ source: 'unofficial', fetchedAt: T });
    expect(t.md.brackets('BTCUSDT')).toHaveLength(1);
    t.setTiers(async () => tierSet('official', t.clock.now, ['BTCUSDT'], 125));
    await t.advance(86_400_000);
    expect(t.md.tierInfo()).toEqual({ source: 'official', fetchedAt: T + 172_800_000 });
    expect(t.md.brackets('BTCUSDT')[0]!.maxLeverage).toBe(125);
    t.md.stop();
  });

  it('a first tier load that fails is retried soon, not after 24 h', async () => {
    const t = stack();
    t.setTiers(async () => {
      throw new Error('down');
    });
    t.md.start();
    await t.advance(0);
    expect(t.md.tierInfo()).toBeNull();
    t.setTiers(async () => tierSet('bundled', 1_790_000_000_000, ['BTCUSDT']));
    await t.advance(5000);
    expect(t.md.tierInfo()).toEqual({ source: 'bundled', fetchedAt: 1_790_000_000_000 });
    t.md.stop();
  });

  it('a bundled result counts as not yet loaded: the quick retry continues until a live source, then 24 h', async () => {
    const t = stack();
    const T = t.clock.now;
    const results: TierSet['source'][] = ['bundled', 'bundled', 'official'];
    t.setTiers(async () => tierSet(results.shift() ?? 'official', t.clock.now, ['BTCUSDT']));
    t.md.start();
    await t.advance(0);
    expect(t.md.tierInfo()!.source).toBe('bundled'); // installed meanwhile
    await t.advance(5000);
    await t.advance(10_000);
    expect(t.calls.tiers).toEqual([T, T + 5000, T + 15_000]);
    expect(t.md.tierInfo()!.source).toBe('official');
    await t.advance(60_000);
    expect(t.calls.tiers).toHaveLength(3);
    await t.advance(86_400_000 - 60_000);
    expect(t.calls.tiers).toEqual([T, T + 5000, T + 15_000, T + 15_000 + 86_400_000]);
    t.md.stop();
  });

  it('a refresh that only reaches the bundled snapshot keeps tiers fetched live', async () => {
    const t = stack();
    await t.md.refreshTiers();
    expect(t.md.tierInfo()!.source).toBe('unofficial');
    t.setTiers(async () => tierSet('bundled', 1_790_000_000_000, ['BTCUSDT'], 20));
    expect(await t.md.refreshTiers()).toBe(true);
    expect(t.md.tierInfo()!.source).toBe('unofficial');
    expect(t.md.brackets('BTCUSDT')[0]!.maxLeverage).toBe(150);
  });

  it('stop() cancels every poller', async () => {
    const t = stack();
    t.md.start();
    await t.advance(0);
    t.md.stop();
    const before = { ...t.calls, exchangeInfo: [...t.calls.exchangeInfo], tiers: [...t.calls.tiers] };
    await t.advance(100_000_000);
    expect(t.calls.exchangeInfo).toEqual(before.exchangeInfo);
    expect(t.calls.tiers).toEqual(before.tiers);
  });
});
