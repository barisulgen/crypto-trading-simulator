import { describe, it, expect } from 'vitest';
import { FeedHealth } from '../src/market/feedHealth.ts';

const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };
const mk = () => {
  const h = new FeedHealth(['BTCUSDT', 'ETHUSDT'], cfg);
  h.setBookValid('BTCUSDT', true);
  h.setBookValid('ETHUSDT', true);
  h.onConnect(0);
  h.onFrame(0);
  h.onDepth('BTCUSDT', 0, 0);
  return h;
};

/** An unbroken connection: a frame every 10 s (well inside silentMs) from one time to another. */
const frames = (h: FeedHealth, from: number, to: number) => {
  for (let t = from; t < to; t += 10000) h.onFrame(t);
  h.onFrame(to);
};

describe('FeedHealth', () => {
  it('is fresh after depth', () => {
    expect(mk().isFresh('BTCUSDT', 1000)).toBe(true);
  });
  it('is stale initially (disconnected)', () => {
    const h = new FeedHealth(['BTCUSDT'], cfg);
    expect(h.reason('BTCUSDT', 0)).toBe('Disconnected');
  });
  it('quiet coin stays fresh while frames arrive, then goes stale at the no-update limit', () => {
    const h = mk();
    frames(h, 10000, 60000);
    expect(h.isFresh('BTCUSDT', 60000)).toBe(true);
    frames(h, 70000, 120001);
    expect(h.reason('BTCUSDT', 120001)).toBe('No order-book updates for 120s');
  });
  it('uses connectAt for a symbol that never had depth', () => {
    const h = mk();
    frames(h, 10000, 120001);
    expect(h.reason('ETHUSDT', 120001)).toBe('No order-book updates for 120s');
  });
  it('reports silent connection', () => {
    expect(mk().reason('BTCUSDT', 15001)).toBe('Connection silent for 15s');
  });
  it('reports lag and recovers', () => {
    const h = mk();
    h.onDepth('BTCUSDT', 10000, 4000);
    expect(h.reason('BTCUSDT', 10000)).toBe('Feed lagging by 6.0s');
    h.onDepth('BTCUSDT', 10100, 10000);
    expect(h.isFresh('BTCUSDT', 10100)).toBe(true);
  });
  it('a trade or ticker event time counts toward lag like a depth event', () => {
    const h = mk();
    h.onTrade('BTCUSDT', 10000, 4000);
    expect(h.reason('BTCUSDT', 10000)).toBe('Feed lagging by 6.0s');
    h.onTrade('BTCUSDT', 10100, 10000);
    expect(h.isFresh('BTCUSDT', 10100)).toBe(true);
    h.onTicker('BTCUSDT', 10200, 4000);
    expect(h.reason('BTCUSDT', 10200)).toBe('Feed lagging by 6.2s');
    h.onTicker('BTCUSDT', 10300, 10300);
    expect(h.isFresh('BTCUSDT', 10300)).toBe(true);
  });
  it('a trade or ticker with a missing event time is lagging', () => {
    const h = mk();
    h.onTrade('BTCUSDT', 1000, Number.NaN);
    expect(h.reason('BTCUSDT', 1000)).toBe('Feed lagging (invalid event time)');
    h.onTicker('BTCUSDT', 1100, 1100);
    expect(h.isFresh('BTCUSDT', 1100)).toBe(true);
    h.onTicker('BTCUSDT', 1200, Number.NaN);
    expect(h.reason('BTCUSDT', 1200)).toBe('Feed lagging (invalid event time)');
  });
  it('a trade or ticker applies the clock offset to lag', () => {
    const h = mk();
    h.setClockOffset(-6000);
    h.onTrade('BTCUSDT', 10000, 4000);
    expect(h.isFresh('BTCUSDT', 10000)).toBe(true);
    h.onTicker('BTCUSDT', 10000, 4000);
    expect(h.isFresh('BTCUSDT', 10000)).toBe(true);
  });
  it('after a silent stretch a symbol needs a depth update, not just frames, trades or tickers', () => {
    const h = mk();
    h.onFrame(20000); // first frame after 20 s of silence
    h.onTrade('BTCUSDT', 20000, 20000);
    expect(h.isFresh('BTCUSDT', 20000)).toBe(false);
    expect(h.reason('BTCUSDT', 20000)).toBe('Waiting for order-book update after a silent connection');
    h.onTicker('BTCUSDT', 20100, 20100);
    h.onFrame(20200);
    expect(h.reason('BTCUSDT', 20200)).toBe('Waiting for order-book update after a silent connection');
    h.onDepth('BTCUSDT', 20300, 20300);
    expect(h.isFresh('BTCUSDT', 20300)).toBe(true);
  });
  it('the wait covers every symbol and each is released by its own depth update', () => {
    const h = mk();
    h.onFrame(20000);
    h.onDepth('BTCUSDT', 20000, 20000);
    expect(h.isFresh('BTCUSDT', 20000)).toBe(true);
    h.onTrade('ETHUSDT', 20000, 20000);
    expect(h.reason('ETHUSDT', 20000)).toBe('Waiting for order-book update after a silent connection');
    h.onDepth('ETHUSDT', 20100, 20100);
    expect(h.isFresh('ETHUSDT', 20100)).toBe(true);
  });
  it('a depth update that is itself lagging does not end the wait', () => {
    const h = mk();
    h.onFrame(20000);
    h.onDepth('BTCUSDT', 20000, 12000); // buffered during the freeze: 8 s old
    expect(h.reason('BTCUSDT', 20000)).toBe('Feed lagging by 8.0s');
    h.onTrade('BTCUSDT', 20100, 20100); // a current trade clears the lag but not the wait
    expect(h.reason('BTCUSDT', 20100)).toBe('Waiting for order-book update after a silent connection');
    h.onDepth('BTCUSDT', 20200, 20200);
    expect(h.isFresh('BTCUSDT', 20200)).toBe(true);
  });
  it('a depth update that arrives first after the silence also counts the stretch', () => {
    const h = mk();
    h.onDepth('BTCUSDT', 20000, 20000); // no separate onFrame
    expect(h.isFresh('BTCUSDT', 20000)).toBe(true);
    h.onTrade('ETHUSDT', 20100, 20100);
    expect(h.reason('ETHUSDT', 20100)).toBe('Waiting for order-book update after a silent connection');
  });
  it('a gap of exactly silentMs is not a silent stretch', () => {
    const h = mk();
    h.onTrade('BTCUSDT', 15000, 15000);
    expect(h.isFresh('BTCUSDT', 15000)).toBe(true);
    h.onTrade('BTCUSDT', 30001, 30001); // 15.001 s since the last frame
    expect(h.reason('BTCUSDT', 30001)).toBe('Waiting for order-book update after a silent connection');
  });
  it('applies the clock offset to lag', () => {
    const h = mk();
    h.setClockOffset(-6000); // exchange clock 6s behind local
    h.onDepth('BTCUSDT', 10000, 4000);
    expect(h.isFresh('BTCUSDT', 10000)).toBe(true);
  });
  it('reports resyncing when the book is invalid', () => {
    const h = mk();
    h.setBookValid('BTCUSDT', false);
    expect(h.reason('BTCUSDT', 1000)).toBe('Order book resyncing');
  });
  it('disconnect invalidates all books; reconnect stays stale until resync', () => {
    const h = mk();
    h.onDisconnect(2000);
    expect(h.reason('BTCUSDT', 2000)).toBe('Disconnected');
    h.onConnect(3000);
    h.onFrame(3000);
    expect(h.isFresh('BTCUSDT', 3000)).toBe(false);
    expect(h.reason('BTCUSDT', 3000)).toBe('Order book resyncing');
    h.setBookValid('BTCUSDT', true);
    h.onDepth('BTCUSDT', 3100, 3100);
    expect(h.isFresh('BTCUSDT', 3100)).toBe(true);
  });
  it('poll reports each transition once', () => {
    const h = mk();
    const t1 = h.poll(1000);
    expect(t1.map((t) => [t.symbol, t.fresh, t.reason, t.at])).toEqual([
      ['BTCUSDT', true, null, 1000],
      ['ETHUSDT', true, null, 1000],
    ]);
    expect(h.poll(1001)).toEqual([]);
    h.onDisconnect(2000);
    const t2 = h.poll(2000);
    expect(t2).toHaveLength(2);
    expect(t2[0]).toEqual({ symbol: 'BTCUSDT', fresh: false, reason: 'Disconnected', at: 2000 });
    expect(h.poll(2001)).toEqual([]);
    h.onConnect(3000);
    expect(h.poll(3000)).toEqual([]); // stale -> stale (reason change) is not a transition
    h.setBookValid('BTCUSDT', true);
    h.onDepth('BTCUSDT', 3100, 3100);
    expect(h.poll(3100)).toEqual([{ symbol: 'BTCUSDT', fresh: true, reason: null, at: 3100 }]);
  });
  it('throws on unknown symbol', () => {
    expect(() => mk().reason('XXX', 0)).toThrow('Unknown symbol XXX');
  });
});
