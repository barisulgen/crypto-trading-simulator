import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { D } from '@sim/engine';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { CandleService } from '../src/market/candles.ts';
import { FakeClock, fakeTimers, FakeWs, tick } from './helpers.ts';
import { parseSpotRules } from '../src/binance/parseRules.ts';
import exchangeInfo from './fixtures/btcusdt-exchangeinfo.json' with { type: 'json' };

const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };
const silent = { info() {}, warn() {}, error() {} };

describe('MarketData', () => {
  const setup = (rest: any = {}) => {
    const clock = { t: 1_000_000 };
    const symbols = ['BTCUSDT'];
    const health = new FeedHealth(symbols, cfg);
    const books = new Map([['BTCUSDT', new LocalBook()]]);
    const feed = new EventEmitter();
    const timers = fakeTimers();
    const md = new MarketData({
      symbols,
      feed,
      books,
      health,
      rest,
      logger: silent,
      now: () => clock.t,
      setTimer: timers.setTimer,
    });
    return { clock, health, books, feed, md, timers };
  };
  const loadRules = (rest: any) => {
    rest.exchangeInfo = async () => exchangeInfo;
  };

  it('book(sym) returns the full LocalBook snapshot', () => {
    const { books, md } = setup();
    const b = books.get('BTCUSDT')!;
    b.applySnapshot({ lastUpdateId: 1, bids: [['100', '1'], ['99', '2']], asks: [['101', '3']] });
    expect(md.book('BTCUSDT').bids).toHaveLength(2);
    expect(md.book('BTCUSDT').asks[0]!.price.toString()).toBe('101');
    expect(md.bookTop('BTCUSDT', 1).bids).toHaveLength(1);
  });

  it('isFresh needs loaded rules and fresh health', async () => {
    const rest: any = {};
    loadRules(rest);
    const { clock, health, md } = setup(rest);
    health.onConnect(clock.t);
    health.setBookValid('BTCUSDT', true);
    health.onDepth('BTCUSDT', clock.t, clock.t);
    expect(md.isFresh('BTCUSDT')).toBe(false); // rules not loaded
    expect(() => md.rules('BTCUSDT')).toThrow();
    await md.refreshRules();
    expect(md.rules('BTCUSDT').symbol).toBe('BTCUSDT');
    expect(md.isFresh('BTCUSDT')).toBe(true);
    clock.t += 20_000; // connection silent
    expect(md.isFresh('BTCUSDT')).toBe(false);
    expect(md.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'Connection silent for 15s' });
  });

  it('a symbol not TRADING on Binance is not fresh, with the halt as its reason', async () => {
    const rest: any = {};
    let status = 'BREAK';
    rest.exchangeInfo = async () => ({ symbols: [{ ...(exchangeInfo as any).symbols[0], status }] });
    const { clock, health, md } = setup(rest);
    health.onConnect(clock.t);
    health.setBookValid('BTCUSDT', true);
    health.onDepth('BTCUSDT', clock.t, clock.t);
    await md.refreshRules();
    expect(md.isFresh('BTCUSDT')).toBe(false);
    expect(md.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'Trading halted on Binance (BREAK)' });
    status = 'TRADING';
    await md.refreshRules();
    expect(md.isFresh('BTCUSDT')).toBe(true);
    expect(md.healthSnapshot().BTCUSDT).toEqual({ fresh: true, reason: null });
  });

  it('rules equal parseSpotRules of the exchangeInfo symbol', async () => {
    const rest: any = {};
    loadRules(rest);
    const { md } = setup(rest);
    await md.refreshRules();
    expect(md.rules('BTCUSDT')).toEqual(parseSpotRules((exchangeInfo as any).symbols[0]));
  });

  it('avgPrice is null until the first poll, then the polled value', async () => {
    const rest = { avgPrice: vi.fn(async () => ({ mins: 5, price: '81487.69', closeTime: 1 })) };
    const { md } = setup(rest);
    expect(md.avgPrice('BTCUSDT')).toBeNull();
    await md.pollAvgPrice('BTCUSDT');
    expect(md.avgPrice('BTCUSDT')!.toString()).toBe('81487.69');
  });

  it('avgPrice keeps the old value on failure for at most 60 s, then null', async () => {
    let fail = false;
    const rest = {
      avgPrice: async () => {
        if (fail) throw new Error('boom');
        return { price: '81487.69' };
      },
    };
    const { clock, md } = setup(rest);
    await md.pollAvgPrice('BTCUSDT');
    fail = true;
    clock.t += 10_000;
    await md.pollAvgPrice('BTCUSDT');
    expect(md.avgPrice('BTCUSDT')!.toString()).toBe('81487.69');
    clock.t += 50_000; // 60 s since the last success
    expect(md.avgPrice('BTCUSDT')).not.toBeNull();
    clock.t += 1;
    expect(md.avgPrice('BTCUSDT')).toBeNull();
  });

  it('lastPrice follows aggTrades; recentTrades is a newest-first ring of 50', () => {
    const { feed, md } = setup();
    expect(md.lastPrice('BTCUSDT')).toBeNull();
    const seen: number[] = [];
    md.on('trade', (_s, t) => seen.push(t.id));
    for (let i = 1; i <= 60; i++) {
      feed.emit('trade', 'BTCUSDT', { id: i, price: D(100 + i), qty: D(1), sellerInitiated: false, time: i });
    }
    expect(md.lastPrice('BTCUSDT')!.toString()).toBe('160');
    const r = md.recentTrades('BTCUSDT');
    expect(r).toHaveLength(50);
    expect(r[0]!.id).toBe(60);
    expect(md.recentTrades('BTCUSDT', 3).map((t) => t.id)).toEqual([60, 59, 58]);
    expect(seen).toHaveLength(60);
  });

  it('tickers().change24hPct = (last-open)/open*100', () => {
    const { feed, md } = setup();
    feed.emit('ticker', 'BTCUSDT', { last: D('110'), open24h: D('100'), change24hPct: D('10') });
    expect(md.tickers().BTCUSDT!.change24hPct.toString()).toBe('10');
  });

  it('bestBid returns price and freshness, null when no bid', () => {
    const { books, md } = setup();
    expect(md.bestBid('BTCUSDT')).toBeNull();
    books.get('BTCUSDT')!.applySnapshot({ lastUpdateId: 1, bids: [['100', '1']], asks: [] });
    expect(md.bestBid('BTCUSDT')!.price.toString()).toBe('100');
    expect(md.bestBid('BTCUSDT')!.fresh).toBe(false);
  });

  it('bestBid keeps the last real bid, stale and timed, after the book is emptied; null only before any bid', async () => {
    const rest: any = {};
    loadRules(rest);
    const { clock, health, books, feed, md } = setup(rest);
    await md.refreshRules();
    expect(md.bestBid('BTCUSDT')).toBeNull(); // never had a bid since start

    const book = books.get('BTCUSDT')!;
    health.onConnect(clock.t);
    book.applySnapshot({ lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] });
    expect(book.applyDiff({ U: 2, u: 2, b: [['100.5', '1']], a: [] })).toBe('applied');
    health.setBookValid('BTCUSDT', true);
    health.onDepth('BTCUSDT', clock.t, clock.t);
    feed.emit('book', 'BTCUSDT'); // SpotFeed emits this after every applied diff
    const live = md.bestBid('BTCUSDT')!;
    expect([live.price.toString(), live.fresh, live.at]).toEqual(['100.5', true, clock.t]);
    const syncedAt = clock.t;

    // Disconnect (or a sequence-gap resync): SpotFeed empties the book until the next snapshot.
    clock.t += 3000;
    health.onDisconnect(clock.t);
    book.applySnapshot({ lastUpdateId: 0, bids: [], asks: [] });
    expect(book.bestBid()).toBeNull();
    const stale = md.bestBid('BTCUSDT')!;
    expect([stale.price.toString(), stale.fresh, stale.at]).toEqual(['100.5', false, syncedAt]);
  });

  it('clock offset = serverTime - midpoint of the request', async () => {
    const clock = { t: 1000 };
    const rest = {
      serverTime: async () => {
        clock.t += 100; // t1 = t0 + 100
        return { serverTime: 1500 };
      },
    };
    const health = new FeedHealth(['BTCUSDT'], cfg);
    const spy = vi.spyOn(health, 'setClockOffset');
    const md = new MarketData({
      symbols: ['BTCUSDT'],
      feed: new EventEmitter(),
      books: new Map([['BTCUSDT', new LocalBook()]]),
      health,
      rest: rest as any,
      logger: silent,
      now: () => clock.t,
      setTimer: fakeTimers().setTimer,
    });
    await md.refreshClockOffset();
    expect(spy).toHaveBeenCalledWith(450); // 1500 - (1000+1100)/2
  });
});

describe('FeedHealth non-finite event time', () => {
  it('treats a non-finite eventTime as lagging', () => {
    const h = new FeedHealth(['BTCUSDT'], cfg);
    h.onConnect(0);
    h.setBookValid('BTCUSDT', true);
    h.onDepth('BTCUSDT', 0, NaN);
    expect(h.isFresh('BTCUSDT', 1)).toBe(false);
    h.onDepth('BTCUSDT', 2, 2);
    expect(h.isFresh('BTCUSDT', 3)).toBe(true);
  });
});

type Lv = [string, string][];

describe('SpotFeed', () => {
  const diff = (sym: string, U: number, u: number, b: Lv = [], a: Lv = [], E = 1_000_000) => ({
    stream: `${sym.toLowerCase()}@depth@100ms`,
    data: { e: 'depthUpdate', E, s: sym, U, u, b, a },
  });
  const setup = (symbols = ['BTCUSDT']) => {
    const clock = { t: 1_000_000 };
    const health = new FeedHealth(symbols, cfg);
    const books = new Map(symbols.map((s) => [s, new LocalBook()]));
    const sockets: FakeWs[] = [];
    const timers = fakeTimers();
    const snaps: Record<string, { lastUpdateId: number; bids: Lv; asks: Lv }[]> = {};
    const depth = vi.fn(async (s: string) => {
      const q = snaps[s]!;
      return q.length > 1 ? q.shift()! : q[0]!;
    });
    const feed = new SpotFeed({
      symbols,
      rest: { depth } as any,
      health,
      books,
      logger: silent,
      wsFactory: (url) => {
        const w = new FakeWs(url);
        sockets.push(w);
        return w as any;
      },
      now: () => clock.t,
      setTimer: timers.setTimer,
    });
    return { clock, health, books, sockets, timers, snaps, depth, feed };
  };
  const snap = (id: number) => ({ lastUpdateId: id, bids: [['100', '1']] as Lv, asks: [['101', '1']] as Lv });

  it('opens the combined stream URL for all symbols', () => {
    const { feed, sockets } = setup(['BTCUSDT', 'ETHUSDT']);
    feed.start();
    expect(sockets[0]!.url).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@depth@100ms/btcusdt@aggTrade/btcusdt@miniTicker/ethusdt@depth@100ms/ethusdt@aggTrade/ethusdt@miniTicker',
    );
  });

  it('syncs: snapshot then replays the buffered bridging diff', async () => {
    const { feed, sockets, timers, snaps, depth, health, books, clock } = setup();
    snaps.BTCUSDT = [snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    expect(health.reason('BTCUSDT', clock.t)).toBe('Order book resyncing');
    ws.msg(diff('BTCUSDT', 90, 99)); // older than snapshot: dropped
    ws.msg(diff('BTCUSDT', 99, 102, [['100', '5']])); // bridges 101
    expect(depth).not.toHaveBeenCalled(); // staggered, timer not fired yet
    timers.fire();
    await tick();
    expect(depth).toHaveBeenCalledWith('BTCUSDT', 1000);
    expect(books.get('BTCUSDT')!.valid).toBe(true);
    expect(books.get('BTCUSDT')!.bestBid()!.qty.toString()).toBe('5');
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
    ws.msg(diff('BTCUSDT', 103, 104, [['100', '6']]));
    expect(books.get('BTCUSDT')!.bestBid()!.qty.toString()).toBe('6');
  });

  it('staggers snapshot requests ~200 ms apart', () => {
    const { feed, sockets, timers } = setup(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    feed.start();
    sockets[0]!.open();
    expect(timers.pending().map((t) => t.ms)).toEqual([0, 200, 400]);
  });

  it('refetches when the snapshot is older than the buffered diffs', async () => {
    const { feed, sockets, timers, snaps, depth, books } = setup();
    snaps.BTCUSDT = [snap(50), snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    ws.msg(diff('BTCUSDT', 99, 102)); // U=99 > 51 -> gap vs snapshot 50
    timers.fire();
    await tick();
    expect(books.get('BTCUSDT')!.valid).toBe(false);
    expect(timers.pending()).toHaveLength(1); // retry scheduled
    timers.fire();
    await tick();
    expect(depth).toHaveBeenCalledTimes(2);
    expect(books.get('BTCUSDT')!.valid).toBe(true);
  });

  it('a later gap invalidates that book only and resyncs it', async () => {
    const { feed, sockets, timers, snaps, depth, health, books, clock } = setup(['BTCUSDT', 'ETHUSDT']);
    snaps.BTCUSDT = [snap(100)];
    snaps.ETHUSDT = [snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    ws.msg(diff('BTCUSDT', 99, 101));
    ws.msg(diff('ETHUSDT', 99, 101));
    timers.fire();
    timers.fire();
    await tick();
    expect(health.isFresh('ETHUSDT', clock.t)).toBe(true);
    ws.msg(diff('BTCUSDT', 150, 151)); // gap
    expect(books.get('BTCUSDT')!.valid).toBe(false);
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(false);
    expect(health.isFresh('ETHUSDT', clock.t)).toBe(true);
    snaps.BTCUSDT = [snap(200)];
    timers.fire();
    await tick();
    expect(depth).toHaveBeenCalledTimes(3);
    ws.msg(diff('BTCUSDT', 201, 202));
    expect(books.get('BTCUSDT')!.valid).toBe(true);
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
  });

  it('retries 1 s after a failed snapshot fetch', async () => {
    const { feed, sockets, timers, depth, snaps } = setup();
    snaps.BTCUSDT = [snap(100)];
    depth.mockRejectedValueOnce(new Error('503'));
    feed.start();
    sockets[0]!.open();
    timers.fire();
    await tick();
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
    timers.fire();
    await tick();
    expect(depth).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['non-numeric u', { U: 101, u: 'x', E: 1, b: [], a: [] }],
    ['missing U', { u: 101, E: 1, b: [], a: [] }],
    ['missing E', { U: 99, u: 101, b: [], a: [] }],
    ['bad price', { U: 99, u: 101, E: 1, b: [['abc', '1']], a: [] }],
    ['bad qty', { U: 99, u: 101, E: 1, b: [], a: [['100', null]] }],
    ['levels not array', { U: 99, u: 101, E: 1, b: 'x', a: [] }],
  ])('malformed diff (%s) is a gap: invalid book, resync, never half-applied', async (_n, data) => {
    const { feed, sockets, timers, snaps, depth, health, books, clock } = setup();
    snaps.BTCUSDT = [snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire();
    await tick();
    ws.msg(diff('BTCUSDT', 99, 101));
    expect(books.get('BTCUSDT')!.valid).toBe(true);
    const applySpy = vi.spyOn(books.get('BTCUSDT')!, 'applyDiff');
    ws.msg({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', s: 'BTCUSDT', ...data } });
    expect(books.get('BTCUSDT')!.valid).toBe(false);
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(false);
    expect(applySpy).not.toHaveBeenCalled(); // rejected before touching the book
    expect(books.get('BTCUSDT')!.bestBid()).toBeNull();
    timers.fire();
    await tick();
    expect(depth).toHaveBeenCalledTimes(2);
  });

  it('disconnect invalidates all books, then reconnects with doubling backoff and resyncs', async () => {
    const { feed, sockets, timers, snaps, health, books, clock } = setup(['BTCUSDT', 'ETHUSDT']);
    snaps.BTCUSDT = [snap(100)];
    snaps.ETHUSDT = [snap(100)];
    feed.start();
    sockets[0]!.open();
    sockets[0]!.msg(diff('BTCUSDT', 99, 101));
    sockets[0]!.msg(diff('ETHUSDT', 99, 101));
    timers.fire();
    timers.fire();
    await tick();
    expect(health.isFresh('ETHUSDT', clock.t)).toBe(true);
    sockets[0]!.drop();
    expect(health.reason('BTCUSDT', clock.t)).toBe('Disconnected');
    expect(health.reason('ETHUSDT', clock.t)).toBe('Disconnected');
    expect(books.get('BTCUSDT')!.valid).toBe(false);
    expect(books.get('BTCUSDT')!.bestBid()).toBeNull();
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]);
    timers.fire();
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop(); // fails before syncing: backoff doubles
    expect(timers.pending().map((t) => t.ms)).toEqual([2000]);
    timers.fire();
    sockets[2]!.open();
    sockets[2]!.msg(diff('BTCUSDT', 99, 101));
    sockets[2]!.msg(diff('ETHUSDT', 99, 101));
    timers.fire();
    timers.fire();
    await tick();
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
    expect(health.isFresh('ETHUSDT', clock.t)).toBe(true);
    sockets[2]!.drop();
    expect(timers.pending().map((t) => t.ms)).toEqual([1000]); // reset after full sync
  });

  it('backoff caps at 30 s', () => {
    const { feed, sockets, timers } = setup();
    feed.start();
    const ms: number[] = [];
    for (let i = 0; i < 8; i++) {
      sockets[i]!.drop();
      ms.push(timers.pending()[0]!.ms);
      timers.fire();
    }
    expect(ms).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('close() stops everything: no reconnect, timers cancelled', () => {
    const { feed, sockets, timers } = setup();
    feed.start();
    sockets[0]!.open();
    feed.close();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop();
    expect(timers.pending()).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it('every message and ping counts as a frame', () => {
    const { feed, sockets, health, clock } = setup();
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    clock.t += 14_000;
    ws.emit('ping');
    clock.t += 14_000;
    ws.msg({ stream: 'btcusdt@miniTicker', data: { c: '1', o: '1' } });
    clock.t += 14_000;
    expect(health.reason('BTCUSDT', clock.t)).toBe('Order book resyncing'); // not silent
  });

  it('emits trade, ticker and book events', async () => {
    const { feed, sockets, timers, snaps } = setup();
    snaps.BTCUSDT = [snap(100)];
    const events: any[] = [];
    feed.on('trade', (s, t) => events.push(['trade', s, t]));
    feed.on('ticker', (s, t) => events.push(['ticker', s, t]));
    feed.on('book', (s) => events.push(['book', s]));
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire();
    await tick();
    ws.msg({ stream: 'btcusdt@aggTrade', data: { a: 7, p: '100.5', q: '0.2', T: 123, m: true } });
    ws.msg({ stream: 'btcusdt@miniTicker', data: { c: '110', o: '100' } });
    ws.msg(diff('BTCUSDT', 99, 101));
    const trade = events.find((e) => e[0] === 'trade')!;
    expect(trade[1]).toBe('BTCUSDT');
    expect(trade[2].id).toBe(7);
    expect(trade[2].price.toString()).toBe('100.5');
    expect(trade[2].sellerInitiated).toBe(true);
    expect(trade[2].time).toBe(123);
    const tk = events.find((e) => e[0] === 'ticker')!;
    expect(tk[2].change24hPct.toString()).toBe('10');
    expect(events.some((e) => e[0] === 'book')).toBe(true);
  });

  it('trade and ticker event times count toward lag; a malformed one counts as lagging', async () => {
    const { feed, sockets, timers, snaps, health, clock } = setup();
    snaps.BTCUSDT = [snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire();
    await tick();
    ws.msg(diff('BTCUSDT', 99, 101));
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
    const aggTrade = (E: number | undefined, p = '100') => ({
      stream: 'btcusdt@aggTrade',
      data: { e: 'aggTrade', E, a: 7, p, q: '1', T: 1, m: false },
    });
    const miniTicker = (E: number | undefined, c = '100') => ({
      stream: 'btcusdt@miniTicker',
      data: { e: '24hrMiniTicker', E, c, o: '99' },
    });
    const lag = () => health.reason('BTCUSDT', clock.t);

    ws.msg(aggTrade(clock.t - 6000));
    expect(lag()).toBe('Feed lagging by 6.0s');
    ws.msg(aggTrade(clock.t));
    expect(lag()).toBeNull();
    ws.msg(miniTicker(clock.t - 7000));
    expect(lag()).toBe('Feed lagging by 7.0s');
    ws.msg(miniTicker(clock.t));
    expect(lag()).toBeNull();

    ws.msg(aggTrade(undefined));
    expect(lag()).toBe('Feed lagging (invalid event time)');
    ws.msg(miniTicker(clock.t)); // a ticker does not clear a trade's lag
    expect(lag()).toBe('Feed lagging (invalid event time)');
    ws.msg(aggTrade(clock.t));
    expect(lag()).toBeNull();
    ws.msg(aggTrade(clock.t, 'x')); // a bad price proves nothing, whatever its event time
    expect(lag()).toBe('Feed lagging (invalid event time)');
    ws.msg(aggTrade(clock.t));
    expect(lag()).toBeNull();
    ws.msg(miniTicker(clock.t, 'x'));
    expect(lag()).toBe('Feed lagging (invalid event time)');
    ws.msg(miniTicker(clock.t));
    expect(lag()).toBeNull();
  });

  it('a current trade or ticker does not clear the lag of a late depth event', async () => {
    const { feed, sockets, timers, snaps, health, clock } = setup();
    snaps.BTCUSDT = [snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire();
    await tick();
    ws.msg(diff('BTCUSDT', 99, 101));
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);

    ws.msg(diff('BTCUSDT', 102, 102, [], [], clock.t - 6000)); // the book is 6 s old
    expect(health.reason('BTCUSDT', clock.t)).toBe('Feed lagging by 6.0s');
    ws.msg({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: clock.t, a: 7, p: '100', q: '1', T: 1, m: false } });
    ws.msg({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: clock.t, c: '100', o: '99' } });
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(false);
    ws.msg(diff('BTCUSDT', 103, 103, [], [], clock.t));
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
  });

  it('a current depth event ends the lag of a late trade or ticker without another trade', async () => {
    const { feed, sockets, timers, snaps, health, clock } = setup();
    snaps.BTCUSDT = [snap(100)];
    feed.start();
    const ws = sockets[0]!;
    ws.open();
    timers.fire();
    await tick();
    ws.msg(diff('BTCUSDT', 99, 101));
    ws.msg({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: clock.t - 6000, a: 7, p: '100', q: '1', T: 1, m: false } });
    ws.msg({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: clock.t - 7000, c: '100', o: '99' } });
    expect(health.reason('BTCUSDT', clock.t)).toBe('Feed lagging by 7.0s');
    ws.msg(diff('BTCUSDT', 102, 102, [], [], clock.t));
    expect(health.isFresh('BTCUSDT', clock.t)).toBe(true);
  });
});

describe('CandleService', () => {
  const k = (t: number) => [t, '1', '2', '0.5', '1.5', '10', t + 59999, '15', 3, '5', '7', '0'];
  it('history parses klines, caches 5 s by key, rejects other intervals', async () => {
    const clock = { t: 0 };
    const klines = vi.fn(async () => [k(60000), k(120000)]);
    const svc = new CandleService({ rest: { klines } as any, logger: silent, now: () => clock.t, setTimer: fakeTimers().setTimer });
    const a = await svc.history('BTCUSDT', '1m');
    expect(a[0]).toEqual({ time: 60000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' });
    expect(klines).toHaveBeenCalledWith('BTCUSDT', '1m', 500, undefined);
    await svc.history('BTCUSDT', '1m');
    expect(klines).toHaveBeenCalledTimes(1);
    await svc.history('BTCUSDT', '1m', 5);
    expect(klines).toHaveBeenCalledTimes(2);
    clock.t = 5001;
    await svc.history('BTCUSDT', '1m');
    expect(klines).toHaveBeenCalledTimes(3);
    await expect(svc.history('BTCUSDT', '3m')).rejects.toThrow('Unsupported interval 3m');
    expect(() => svc.subscribe('BTCUSDT', '2h', () => {})).toThrow('Unsupported interval 2h');
  });

  it('subscribe ref-counts streams on one WS and resubscribes after reconnect', () => {
    const sockets: FakeWs[] = [];
    const clock = new FakeClock(0);
    const svc = new CandleService({
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
    const u1 = svc.subscribe('BTCUSDT', '1m', (c) => got.push(c));
    const u2 = svc.subscribe('BTCUSDT', '1m', () => {});
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://stream.binance.com:9443/ws');
    sockets[0]!.open();
    clock.advance(250); // control messages are debounced
    expect(sockets[0]!.sent.map((s) => JSON.parse(s))).toEqual([
      { method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'], id: 1 },
    ]);
    sockets[0]!.msg({ e: 'kline', s: 'BTCUSDT', k: { t: 60000, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x: false } });
    expect(got[0]).toEqual({ time: 60000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' });
    u1();
    clock.advance(1000);
    expect(sockets[0]!.sent).toHaveLength(1); // still one subscriber
    sockets[0]!.drop();
    clock.advance(1000); // reconnect backoff
    sockets[1]!.open();
    clock.advance(250);
    expect(JSON.parse(sockets[1]!.sent[0]!).params).toEqual(['btcusdt@kline_1m']);
    u2();
    clock.advance(250);
    expect(JSON.parse(sockets[1]!.sent[1]!)).toMatchObject({ method: 'UNSUBSCRIBE', params: ['btcusdt@kline_1m'] });
    svc.close();
  });
});
