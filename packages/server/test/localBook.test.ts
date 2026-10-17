import { describe, it, expect } from 'vitest';
import { LocalBook } from '../src/market/localBook.ts';

const snap = () => ({ lastUpdateId: 100, bids: [['99.9', '1']] as [string, string][], asks: [['100', '1']] as [string, string][] });

describe('LocalBook', () => {
  it('is invalid before any snapshot and reports gap on diffs', () => {
    const b = new LocalBook();
    expect(b.valid).toBe(false);
    expect(b.applyDiff({ U: 1, u: 2, b: [], a: [] })).toBe('gap');
    expect(b.valid).toBe(false);
    expect(b.bestBid()).toBeNull();
    expect(b.bestAsk()).toBeNull();
  });

  it('drops stale first diff, applies the bridging one, removes zero-qty levels', () => {
    const b = new LocalBook();
    b.applySnapshot(snap());
    expect(b.applyDiff({ U: 95, u: 100, b: [], a: [] })).toBe('dropped');
    expect(b.applyDiff({ U: 99, u: 102, b: [], a: [['100', '0'], ['100.1', '2']] })).toBe('applied');
    expect(b.valid).toBe(true);
    expect(b.bestAsk()!.price.toString()).toBe('100.1');
    expect(b.bestAsk()!.qty.toString()).toBe('2');
    expect(b.applyDiff({ U: 103, u: 105, b: [], a: [] })).toBe('applied');
    expect(b.applyDiff({ U: 107, u: 108, b: [], a: [] })).toBe('gap');
    expect(b.valid).toBe(false);
    expect(b.applyDiff({ U: 106, u: 109, b: [['50', '1']], a: [] })).toBe('gap');
    expect(b.bestBid()!.price.toString()).toBe('99.9');
  });

  it('gaps when the first diff starts beyond lastUpdateId+1', () => {
    const b = new LocalBook();
    b.applySnapshot(snap());
    expect(b.applyDiff({ U: 105, u: 106, b: [], a: [] })).toBe('gap');
    expect(b.valid).toBe(false);
  });

  it('recovers with a new snapshot', () => {
    const b = new LocalBook();
    b.applySnapshot(snap());
    b.applyDiff({ U: 105, u: 106, b: [], a: [] });
    b.applySnapshot({ lastUpdateId: 200, bids: [['1', '1']], asks: [['2', '1']] });
    expect(b.applyDiff({ U: 201, u: 201, b: [], a: [] })).toBe('applied');
    expect(b.valid).toBe(true);
  });

  it('keeps sides sorted and snapshot limits levels', () => {
    const b = new LocalBook();
    b.applySnapshot({ lastUpdateId: 1, bids: [['10', '1'], ['8', '1']], asks: [['11', '1'], ['13', '1']] });
    b.applyDiff({ U: 2, u: 2, b: [['9', '2'], ['10', '3'], ['11.5', '0']], a: [['12', '1'], ['10.5', '1']] });
    const s = b.snapshot();
    expect(s.bids.map((l) => l.price.toString())).toEqual(['10', '9', '8']);
    expect(s.bids[0]!.qty.toString()).toBe('3');
    expect(s.asks.map((l) => l.price.toString())).toEqual(['10.5', '11', '12', '13']);
    const t = b.snapshot(2);
    expect(t.bids).toHaveLength(2);
    expect(t.asks).toHaveLength(2);
  });
});
