import { describe, it, expect, vi } from 'vitest';
import { LocalBook } from '../src/market/localBook.ts';
import { parseMarkUpdate, PerpFeed, perpHealth, PERP_DEPTH_URL, PERP_MARKET_URL } from '../src/market/perpFeed.ts';
import type { MarkUpdate } from '../src/market/perpFeed.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { ConnectLimiter } from '../src/market/ws.ts';
import { FakeClock, FakeWs, tick } from './helpers.ts';
import markFixture from './fixtures/btcusdt-markprice.json' with { type: 'json' };

const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };
const T0 = 1_792_711_920_000;
type Lv = [string, string][];

function setup(symbols = ['BTCUSDT'], logger: any = { info() {}, warn() {}, error() {} }) {
  const clock = new FakeClock(T0);
  const health = perpHealth(symbols, cfg);
  const books = new Map(symbols.map((s) => [s, new LocalBook({ mode: 'futures' })]));
  const sockets: FakeWs[] = [];
  const snaps: Record<string, { lastUpdateId: number; E: number; T: number; bids: Lv; asks: Lv }[]> = {};
  const depth = vi.fn(async (s: string, _limit?: number) => {
    const q = snaps[s] ?? [snap(100)];
    return q.length > 1 ? q.shift()! : q[0]!;
  });
  const feed = new PerpFeed({
    symbols,
    rest: { depth },
    health,
    books,
    logger,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w as any;
    },
    now: () => clock.now,
    setTimer: clock.setTimer,
  });
  const depthSockets = () => sockets.filter((w) => w.url.startsWith(PERP_DEPTH_URL));
  const marketSockets = () => sockets.filter((w) => w.url.startsWith(PERP_MARKET_URL));
  /** A futures depth update for `sym`, stamped now. */
  const ev = (U: number, u: number, pu: number, b: Lv = [], a: Lv = [], sym = 'BTCUSDT') => ({
    stream: `${sym.toLowerCase()}@depth@100ms`,
    data: { e: 'depthUpdate', E: clock.now, T: clock.now, s: sym, U, u, pu, b, a },
  });
  const mark = (sym = 'BTCUSDT', E = clock.now, p = '81328.08443478') => ({
    stream: `${sym.toLowerCase()}@markPrice@1s`,
    data: { e: 'markPriceUpdate', E, s: sym, p, i: '81367.24130435', P: '81402.1', r: '0.00005355', T: 1792713600000 },
  });
  const advance = async (ms: number) => {
    clock.advance(ms);
    await tick();
  };
  return { clock, health, books, sockets, snaps, depth, feed, depthSockets, marketSockets, ev, mark, advance };
}

const snap = (id: number, bids: Lv = [['100', '1']], asks: Lv = [['101', '1']]) => ({ lastUpdateId: id, E: T0, T: T0, bids, asks });

describe('PerpFeed', () => {
  it('opens the public depth socket and the market socket (trades, mark price, ticker) for all symbols', () => {
    const t = setup(['BTCUSDT', 'ETHUSDT']);
    t.feed.start();
    expect(t.sockets.map((w) => w.url)).toEqual([
      'wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms/ethusdt@depth@100ms',
      'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s/btcusdt@miniTicker/ethusdt@aggTrade/ethusdt@markPrice@1s/ethusdt@miniTicker',
    ]);
  });

  it('syncs each book from a futures depth snapshot (limit 1000) by the futures rules', async () => {
    const t = setup();
    t.snaps.BTCUSDT = [snap(100)];
    t.feed.start();
    const ws = t.depthSockets()[0]!;
    ws.open();
    ws.msg(t.ev(80, 99, 79)); // ends before the snapshot: dropped
    ws.msg(t.ev(90, 105, 99, [['100', '5']])); // straddles 100
    await t.advance(0);
    expect(t.depth).toHaveBeenCalledWith('BTCUSDT', 1000);
    const book = t.books.get('BTCUSDT')!;
    expect(book.valid).toBe(true);
    expect(book.bestBid()!.qty.toString()).toBe('5');
    expect(t.health.depth.isFresh('BTCUSDT', t.clock.now)).toBe(true);
    ws.msg(t.ev(106, 110, 105, [['100', '6']]));
    expect(book.bestBid()!.qty.toString()).toBe('6');
  });

  it('a broken pu chain resyncs that book only, keeping the event for the next snapshot to bridge', async () => {
    const t = setup(['BTCUSDT', 'ETHUSDT']);
    t.feed.start();
    const ws = t.depthSockets()[0]!;
    ws.open();
    ws.msg(t.ev(90, 105, 89));
    ws.msg(t.ev(90, 105, 89, [], [], 'ETHUSDT'));
    await t.advance(200);
    expect(t.health.depth.isFresh('ETHUSDT', t.clock.now)).toBe(true);
    ws.msg(t.ev(120, 130, 119, [['100', '7']])); // pu 119, previous u 105: a gap
    expect(t.books.get('BTCUSDT')!.valid).toBe(false);
    expect(t.health.depth.reason('BTCUSDT', t.clock.now)).toBe('Order book resyncing');
    expect(t.health.depth.isFresh('ETHUSDT', t.clock.now)).toBe(true);
    t.snaps.BTCUSDT = [snap(125)];
    await t.advance(1000); // backed-off resync
    expect(t.books.get('BTCUSDT')!.valid).toBe(true); // 120..130 replayed on snapshot 125
    expect(t.books.get('BTCUSDT')!.bestBid()!.qty.toString()).toBe('7');
  });

  it('a depth event without pu is malformed: the book resyncs and is never half-applied', async () => {
    const t = setup();
    t.feed.start();
    const ws = t.depthSockets()[0]!;
    ws.open();
    await t.advance(0);
    ws.msg(t.ev(90, 105, 89));
    expect(t.books.get('BTCUSDT')!.valid).toBe(true);
    const e = t.ev(106, 107, 105, [['100', '9']]);
    delete (e.data as any).pu;
    ws.msg(e);
    expect(t.books.get('BTCUSDT')!.valid).toBe(false);
    expect(t.books.get('BTCUSDT')!.bestBid()).toBeNull();
  });

  it('parses a markPriceUpdate into a MarkUpdate', () => {
    const m = parseMarkUpdate(markFixture.data)!;
    expect(m.markPrice.toString()).toBe('81328.08443478');
    expect(m.indexPrice.toString()).toBe('81367.24130435');
    expect(m.fundingRate.toString()).toBe('0.00005355');
    expect(m.nextFundingTime).toBe(1792713600000);
    expect(m.eventTime).toBe(1792711922000);
  });

  it.each([
    ['no mark price', { p: undefined }],
    ['a zero mark price', { p: '0' }],
    ['a bad index price', { i: 'x' }],
    ['a missing funding rate', { r: undefined }],
    ['a non-numeric funding rate', { r: 'NaN' }],
    ['no next funding time', { T: undefined }],
    ['no event time', { E: undefined }],
  ])('rejects a markPriceUpdate with %s', (_n, over) => {
    expect(parseMarkUpdate({ ...markFixture.data, ...over })).toBeNull();
  });

  it('a negative or zero funding rate is a real rate', () => {
    expect(parseMarkUpdate({ ...markFixture.data, r: '-0.00012' })!.fundingRate.toString()).toBe('-0.00012');
    expect(parseMarkUpdate({ ...markFixture.data, r: '0.00000000' })!.fundingRate.isZero()).toBe(true);
  });

  it("emits 'mark', 'trade' and 'ticker' from the market socket and keeps the mark's health", () => {
    const t = setup();
    const marks: [string, MarkUpdate][] = [];
    const trades: unknown[] = [];
    const tickers: unknown[] = [];
    t.feed.on('mark', (s, m) => marks.push([s, m]));
    t.feed.on('trade', (s, tr) => trades.push([s, tr]));
    t.feed.on('ticker', (s, tk) => tickers.push([s, tk]));
    t.feed.start();
    const ws = t.marketSockets()[0]!;
    ws.open();
    t.clock.now = markFixture.data.E;
    ws.msg(markFixture);
    expect(marks).toHaveLength(1);
    expect(marks[0]![0]).toBe('BTCUSDT');
    expect(marks[0]![1].markPrice.toString()).toBe('81328.08443478');
    expect(t.health.market.isMarkFresh('BTCUSDT', t.clock.now)).toBe(true);
    ws.msg({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: t.clock.now, a: 7, p: '81300.10', q: '0.011', nq: '0.011', T: t.clock.now, m: true } });
    ws.msg({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: t.clock.now, c: '110', o: '100' } });
    expect(trades).toHaveLength(1);
    expect((trades[0] as any)[1].price.toString()).toBe('81300.1');
    expect((trades[0] as any)[1].id).toBe(7);
    expect((tickers[0] as any)[1].change24hPct.toString()).toBe('10');
    expect(t.health.market.isFresh('BTCUSDT', t.clock.now)).toBe(true);
  });

  it('a malformed mark is dropped, counts as lagging, and is logged at most once a minute', () => {
    const warns: string[] = [];
    const t = setup(['BTCUSDT'], { info() {}, error() {}, warn: (m: string) => warns.push(m) });
    const marks: unknown[] = [];
    t.feed.on('mark', (...a) => marks.push(a));
    t.feed.start();
    const ws = t.marketSockets()[0]!;
    ws.open();
    ws.msg(t.mark());
    ws.msg(t.mark('BTCUSDT', t.clock.now, '-1'));
    ws.msg(t.mark('BTCUSDT', t.clock.now, 'abc'));
    expect(marks).toHaveLength(1);
    expect(t.health.market.isMarkFresh('BTCUSDT', t.clock.now)).toBe(false);
    expect(t.health.market.reason('BTCUSDT', t.clock.now)).toBe('Feed lagging (invalid event time)');
    expect(warns.filter((w) => w.includes('markPrice'))).toHaveLength(1);
  });

  it('each socket has its own connection: the market socket dropping leaves the books and depth health alone', async () => {
    const t = setup();
    t.feed.start();
    const d = t.depthSockets()[0]!;
    const m = t.marketSockets()[0]!;
    d.open();
    m.open();
    d.msg(t.ev(90, 105, 89));
    m.msg(t.mark());
    await t.advance(0);
    d.msg(t.ev(106, 107, 105));
    expect(t.health.depth.isFresh('BTCUSDT', t.clock.now)).toBe(true);
    expect(t.health.market.isFresh('BTCUSDT', t.clock.now)).toBe(true);

    m.drop();
    expect(t.health.market.reason('BTCUSDT', t.clock.now)).toBe('Disconnected');
    expect(t.health.depth.isFresh('BTCUSDT', t.clock.now)).toBe(true);
    expect(t.books.get('BTCUSDT')!.valid).toBe(true);
    await t.advance(1000);
    expect(t.marketSockets()).toHaveLength(2);
    expect(t.depthSockets()).toHaveLength(1);

    d.drop();
    expect(t.health.depth.reason('BTCUSDT', t.clock.now)).toBe('Disconnected');
    expect(t.books.get('BTCUSDT')!.bestBid()).toBeNull();
    t.marketSockets()[1]!.open();
    t.marketSockets()[1]!.msg(t.mark());
    expect(t.health.market.isMarkFresh('BTCUSDT', t.clock.now)).toBe(true);
  });

  it('the market socket backoff doubles and resets only after a mark for every symbol', async () => {
    const t = setup(['BTCUSDT', 'ETHUSDT']);
    t.feed.start();
    const connects = () => t.marketSockets().length;
    t.marketSockets()[0]!.drop();
    await t.advance(999);
    expect(connects()).toBe(1);
    await t.advance(1);
    expect(connects()).toBe(2);
    t.marketSockets()[1]!.open();
    t.marketSockets()[1]!.msg(t.mark('BTCUSDT'));
    t.marketSockets()[1]!.drop(); // only one symbol had a mark: the backoff keeps growing
    await t.advance(1999);
    expect(connects()).toBe(2);
    await t.advance(1);
    expect(connects()).toBe(3);
    t.marketSockets()[2]!.open();
    t.marketSockets()[2]!.msg(t.mark('BTCUSDT'));
    t.marketSockets()[2]!.msg(t.mark('ETHUSDT'));
    t.marketSockets()[2]!.drop();
    await t.advance(1000); // reset
    expect(connects()).toBe(4);
  });

  it('terminates a silent market socket and reconnects it; the depth socket is untouched', async () => {
    const t = setup();
    t.feed.start();
    const d = t.depthSockets()[0]!;
    const m = t.marketSockets()[0]!;
    d.open();
    m.open();
    for (let i = 0; i < 7; i++) {
      await t.advance(5000);
      d.emit('ping');
    }
    expect(m.terminated).toBe(true); // 35 s without a frame
    expect(d.terminated).toBe(false);
    await t.advance(1000);
    expect(t.marketSockets()).toHaveLength(2);
    expect(t.depthSockets()).toHaveLength(1);
  });

  it('close() closes both sockets and nothing reconnects', async () => {
    const t = setup();
    t.feed.start();
    t.depthSockets()[0]!.open();
    t.marketSockets()[0]!.open();
    t.feed.close();
    expect(t.sockets.every((w) => w.closed)).toBe(true);
    t.sockets.forEach((w) => w.drop());
    await t.advance(60_000);
    expect(t.sockets).toHaveLength(2);
    expect(t.depth).not.toHaveBeenCalled();
  });

  it('start() is idempotent', () => {
    const t = setup();
    t.feed.start();
    t.feed.start();
    expect(t.sockets).toHaveLength(2);
  });
});

describe('ConnectLimiter', () => {
  it('allows the limit of attempts in any rolling window, then says how long to wait', () => {
    const l = new ConnectLimiter({ limit: 3, windowMs: 300_000 });
    expect([l.acquire(0), l.acquire(10), l.acquire(20)]).toEqual([0, 0, 0]);
    expect(l.acquire(30)).toBe(299_970);
    expect(l.acquire(300_000)).toBe(0); // the first attempt left the window
    expect(l.acquire(300_005)).toBe(5);
  });

  it('is shared by every socket: spot and perp reconnects wait once the attempts are used up', async () => {
    const clock = new FakeClock(T0);
    const sockets: FakeWs[] = [];
    const wsFactory = (url: string) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w as any;
    };
    const limiter = new ConnectLimiter({ limit: 3, windowMs: 300_000 });
    const silent = { info() {}, warn() {}, error() {} };
    // A watchdog longer than the test: only the dropped socket reconnects.
    const common = { logger: silent, wsFactory, now: () => clock.now, setTimer: clock.setTimer, limiter, watchdogMs: 10_000_000 };
    const spot = new SpotFeed({
      ...common,
      symbols: ['BTCUSDT'],
      rest: { depth: async () => snap(1) },
      health: new FeedHealth(['BTCUSDT'], cfg),
      books: new Map([['BTCUSDT', new LocalBook()]]),
    });
    const perp = new PerpFeed({
      ...common,
      symbols: ['BTCUSDT'],
      rest: { depth: async () => snap(1) },
      health: perpHealth(['BTCUSDT'], cfg),
      books: new Map([['BTCUSDT', new LocalBook({ mode: 'futures' })]]),
    });
    spot.start();
    perp.start();
    expect(sockets).toHaveLength(3);
    sockets[0]!.drop(); // the spot socket
    clock.advance(1000); // its reconnect is due, but three attempts were made at T0
    expect(sockets).toHaveLength(3);
    clock.advance(299_000); // the window has passed
    expect(sockets).toHaveLength(4);
    spot.close();
    perp.close();
  });
});
