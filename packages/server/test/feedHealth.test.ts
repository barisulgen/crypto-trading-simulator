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
    h.onFrame(60000);
    expect(h.isFresh('BTCUSDT', 60000)).toBe(true);
    h.onFrame(120001);
    expect(h.reason('BTCUSDT', 120001)).toBe('No order-book updates for 120s');
  });
  it('uses connectAt for a symbol that never had depth', () => {
    const h = mk();
    h.onFrame(120001);
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
