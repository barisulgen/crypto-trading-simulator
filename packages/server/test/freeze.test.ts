import { describe, expect, it } from 'vitest';
import { D } from '@sim/engine';
import type { SpotOrderRequest } from '@sim/engine';
import type { Db } from '../src/db/db.ts';
import { submittedOrder } from '../src/runner.ts';
import { liveStack } from './helpers.ts';

const T0 = 1_700_000_000_000;
const FREEZE_MS = 20_000;

/** The real feed, health, market data, engine and runner (liveStack); 1 BTC bought and a 0.5 BTC sell stop at 99 armed. */
async function setup() {
  const { clock, ws, market, db, engine, runner, notices, depth, trade, ping } = await liveStack(T0);

  trade(1, '100.00'); // a last price, which a stop order needs
  runner.deposit('spot', D('1000'));
  runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
  clock.advance(300);
  const stop: SpotOrderRequest = { symbol: 'BTCUSDT', side: 'sell', type: 'stop_loss', qty: '0.5', triggerPrice: '99' };
  const order = submittedOrder(runner.submit(stop));
  clock.advance(100);
  expect(engine.state.orders.get(order.id)!.status).toBe('open');

  const status = () => engine.state.orders.get(order.id)!.status;
  /**
   * The stop is triggered, then the event loop freezes for ms before its arrival time. With timersFirst
   * the due arrival timer and health poll run first, on old data; without, the buffered
   * frames are processed before them.
   */
  const triggerThenFreeze = (timersFirst = true, ms = FREEZE_MS) => {
    trade(2, '98.90');
    expect(status()).toBe('triggered');
    clock.now += ms; // no timer ran meanwhile
    if (!timersFirst) return;
    clock.advance(0);
    expect(engine.state.orders.get(order.id)).toMatchObject({ status: 'triggered', arrivesAt: null });
  };
  return { clock, ws, market, db, depth, trade, ping, triggerThenFreeze, status, notices };
}

describe('after a freeze', () => {
  it('a buffered old trade does not make a deferred triggered stop fill on the pre-freeze book', async () => {
    const t = await setup();
    t.triggerThenFreeze();
    expect(t.market.isFresh('BTCUSDT')).toBe(false);

    t.trade(3, '98.50', t.clock.now - FREEZE_MS); // the first buffered frame, 20 s old
    expect(t.market.isFresh('BTCUSDT')).toBe(false);
    expect(t.status()).toBe('triggered');

    // The book moved during the freeze: a current depth event shows the connection caught up,
    // which also ends the late trade's lag, with no further trade needed.
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

  it('buffered frames processed before the arrival timer and the health poll execute the stop on the new book only', async () => {
    const t = await setup();
    t.triggerThenFreeze(false);

    t.trade(3, '98.50', t.clock.now - FREEZE_MS); // buffered during the freeze
    expect(t.market.isFresh('BTCUSDT')).toBe(false);
    expect(t.status()).toBe('triggered');
    t.depth(102, [['99.90', '0'], ['99.80', '0'], ['99.00', '0'], ['95.00', '5']]);
    expect(t.status()).toBe('triggered');
    t.trade(4, '95.10'); // the last buffered frame is current: now fresh on the new book
    expect(t.status()).toBe('filled');

    t.clock.advance(1000); // the late timer and poll find nothing left to do
    expect(t.notices().filter((n) => n.startsWith('Sold'))).toEqual([
      expect.stringMatching(/^Sold 0\.5 BTC @ 95\.0000 /),
    ]);
  });
});

describe('after a stall shorter than the silence limit', () => {
  const PAUSED = 'Server paused (sleep or freeze)';
  const STALL_MS = 8000; // above the 5 s stall limit, below the 15 s silence limit
  const openGaps = (db: Db) => db.prepare('SELECT symbol, started_at AS startedAt, reason FROM open_gaps').all();
  const gaps = (db: Db) =>
    (db.prepare("SELECT payload FROM events WHERE type = 'feed_gap' ORDER BY id").all() as { payload: string }[]).map(
      (r) => JSON.parse(r.payload),
    );

  it('the arrival timer that runs first defers the stop, and it executes on the new book only', async () => {
    const t = await setup();
    t.triggerThenFreeze(true, STALL_MS); // deferred, not filled on the book from before the stall
    expect(t.market.healthSnapshot().BTCUSDT).toEqual({ fresh: false, reason: 'Waiting for order-book update after a pause' });
    const lastPoll = T0 + 1000; // the poll when the runner started
    expect(openGaps(t.db)).toEqual([{ symbol: 'BTCUSDT', startedAt: lastPoll, reason: PAUSED }]);

    t.trade(3, '98.50', t.clock.now - STALL_MS); // buffered during the stall
    expect(t.status()).toBe('triggered');
    t.depth(102, [['99.90', '0'], ['99.80', '0'], ['99.00', '0'], ['95.00', '5']]);
    expect(t.market.isFresh('BTCUSDT')).toBe(true);
    t.clock.advance(1000); // the next health poll sees fresh data
    expect(t.status()).toBe('filled');
    expect(t.notices().filter((n) => n.startsWith('Sold'))).toEqual([expect.stringMatching(/^Sold 0\.5 BTC @ 95\.0000 /)]);
    expect(gaps(t.db)).toEqual([{ startedAt: lastPoll, endedAt: t.clock.now, reason: PAUSED }]);
    expect(openGaps(t.db)).toEqual([]);
  });

  it('a market order whose arrival lands right after the stall is rejected as stale, with the pause recorded', async () => {
    const s = await liveStack(T0);
    s.runner.deposit('spot', D('1000'));
    const order = submittedOrder(s.runner.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' }));
    s.clock.now += STALL_MS; // no timer ran meanwhile
    s.clock.advance(0);
    expect(s.engine.state.orders.get(order.id)).toMatchObject({
      status: 'rejected',
      rejectReason: 'Live data interrupted for BTCUSDT',
    });
    expect(openGaps(s.db)).toEqual([{ symbol: 'BTCUSDT', startedAt: T0 + 1000, reason: PAUSED }]);
  });
});
