import { describe, expect, it } from 'vitest';
import { D, SpotEngine } from '@sim/engine';
import type { SpotOrderRequest } from '@sim/engine';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import { loadSpotState } from '../src/db/store.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { EngineRunner, submittedOrder } from '../src/runner.ts';
import type { RunnerMessage } from '../src/runner.ts';
import { FakeClock, FakeWs, tick } from './helpers.ts';
import exchangeInfo from './fixtures/btcusdt-exchangeinfo.json' with { type: 'json' };

const T0 = 1_700_000_000_000;
const silent = { info() {}, warn() {}, error() {} };
const FREEZE_MS = 20_000;

type Lv = [string, string][];

/** The real feed, health, market data, engine and runner over a fake socket and clock. */
async function setup() {
  const clock = new FakeClock(T0);
  const sockets: FakeWs[] = [];
  const symbols = ['BTCUSDT'];
  const health = new FeedHealth(symbols, { silentMs: 15_000, lagMs: 5000, noUpdateMs: 120_000 });
  const books = new Map([['BTCUSDT', new LocalBook()]]);
  const rest = {
    depth: async () => ({
      lastUpdateId: 100,
      bids: [['99.90', '0.4'], ['99.80', '1.0'], ['99.00', '3.0']] as Lv,
      asks: [['100.00', '0.5'], ['100.10', '1.0'], ['100.50', '2.0']] as Lv,
    }),
    exchangeInfo: async () => exchangeInfo,
    avgPrice: async () => ({ price: '100' }),
    serverTime: async () => ({ serverTime: clock.now }),
  };
  const common = { symbols, logger: silent, now: () => clock.now, setTimer: clock.setTimer };
  const feed = new SpotFeed({
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
  const market = new MarketData({ ...common, feed, books, health, rest });
  const db = openDb(':memory:');
  const seasonId = currentSeasonId(db, () => clock.now);
  const engine = new SpotEngine(loadSpotState(db, seasonId, ['USDT', 'BTC']));
  const sent: RunnerMessage[] = [];
  const runner = new EngineRunner({
    ...common,
    db,
    seasonId,
    engine,
    market,
    health,
    fees: { maker: D('0.001'), taker: D('0.001') },
    rng: () => 0,
    onBroadcast: (m) => sent.push(m),
    onFatal: (e) => {
      throw e;
    },
  });

  feed.start();
  const ws = sockets[0]!;
  ws.open();
  clock.advance(1000);
  await tick(); // the snapshot
  const depth = (U: number, b: Lv = [], a: Lv = []) =>
    ws.msg({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', E: clock.now, s: 'BTCUSDT', U, u: U, b, a } });
  const trade = (id: number, price: string, E = clock.now) =>
    ws.msg({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E, s: 'BTCUSDT', a: id, p: price, q: '1', T: E, m: true } });
  depth(101);
  await market.refreshRules();
  await market.pollAvgPrice('BTCUSDT');
  runner.start();
  expect(market.isFresh('BTCUSDT')).toBe(true);

  trade(1, '100.00'); // a last price, which a stop order needs
  runner.deposit('spot', D('1000'));
  runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
  clock.advance(300);
  const stop: SpotOrderRequest = { symbol: 'BTCUSDT', side: 'sell', type: 'stop_loss', qty: '0.5', triggerPrice: '99' };
  const order = submittedOrder(runner.submit(stop));
  clock.advance(100);
  expect(engine.state.orders.get(order.id)!.status).toBe('open');

  /** The stop is triggered, then the event loop freezes before its arrival time. */
  const triggerThenFreeze = () => {
    trade(2, '98.90');
    expect(engine.state.orders.get(order.id)!.status).toBe('triggered');
    clock.now += FREEZE_MS; // no timer ran meanwhile
    clock.advance(0); // the arrival timer and the health poll run first, on silent data
    expect(engine.state.orders.get(order.id)).toMatchObject({ status: 'triggered', arrivesAt: null });
  };
  const status = () => engine.state.orders.get(order.id)!.status;
  const notices = () => sent.flatMap((m) => (m.type === 'notice' ? [m.text] : []));
  return { clock, ws, market, depth, trade, ping: () => ws.emit('ping'), triggerThenFreeze, status, notices };
}

describe('after a freeze', () => {
  it('a buffered old trade does not make a deferred triggered stop fill on the pre-freeze book', async () => {
    const t = await setup();
    t.triggerThenFreeze();
    expect(t.market.isFresh('BTCUSDT')).toBe(false);

    t.trade(3, '98.50', t.clock.now - FREEZE_MS); // the first buffered frame, 20 s old
    expect(t.market.isFresh('BTCUSDT')).toBe(false);
    expect(t.status()).toBe('triggered');

    // The book moved during the freeze: a fresh depth event ends the wait.
    t.depth(102, [['99.90', '0'], ['99.80', '0'], ['99.00', '0'], ['95.00', '5']]);
    expect(t.market.isFresh('BTCUSDT')).toBe(true);
    t.clock.advance(1000); // the next health poll sees fresh data
    expect(t.status()).toBe('filled');
    expect(t.notices().filter((n) => n.startsWith('Sold'))).toEqual([
      expect.stringMatching(/^Sold 0\.5 BTC @ 95\.0000 /),
    ]);
  });

  it('a first frame that is current (a ping, then a trade) does not end the wait either', async () => {
    const t = await setup();
    t.triggerThenFreeze();

    t.ping();
    t.trade(3, '98.50'); // event time now: only the silent stretch says the book is old
    expect(t.market.isFresh('BTCUSDT')).toBe(false);
    expect(t.market.healthSnapshot().BTCUSDT).toEqual({
      fresh: false,
      reason: 'Waiting for order-book update after a silent connection',
    });
    expect(t.status()).toBe('triggered');

    t.clock.advance(1000); // a health poll while still waiting
    expect(t.status()).toBe('triggered');
    t.depth(102, [['99.90', '0'], ['99.80', '0'], ['99.00', '0'], ['95.00', '5']]);
    t.clock.advance(1000);
    expect(t.status()).toBe('filled');
    expect(t.notices().filter((n) => n.startsWith('Sold'))).toEqual([
      expect.stringMatching(/^Sold 0\.5 BTC @ 95\.0000 /),
    ]);
  });
});
