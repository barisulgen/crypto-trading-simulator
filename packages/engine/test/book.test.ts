import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { walkBook } from '../src/book.ts';
import { sampleBook } from './fixtures.ts';

const step = D('0.00001');

describe('walkBook', () => {
  it('market buy 1.2', () => {
    const r = walkBook(sampleBook, 'buy', { qty: D('1.2') }, step);
    expect(r.quote.toString()).toBe('120.07');
    expect(r.qty.toString()).toBe('1.2');
    expect(r.avgPrice!.toFixed(8)).toBe('100.05833333');
    expect(r.bestPrice!.toString()).toBe('100');
    expect(r.slippageUsd.toString()).toBe('0.07');
    expect(r.levelsUsed).toBe(2);
    expect(r.exhausted).toBe(false);
  });
  it('market sell 1.5', () => {
    const r = walkBook(sampleBook, 'sell', { qty: D('1.5') }, step);
    expect(r.quote.toString()).toBe('149.66');
    expect(r.avgPrice!.toFixed(8)).toBe('99.77333333');
    expect(r.slippageUsd.toString()).toBe('0.19');
    expect(r.exhausted).toBe(false);
  });
  it('thin book', () => {
    const r = walkBook(sampleBook, 'buy', { qty: D('5.0') }, step);
    expect(r.qty.toString()).toBe('3.5');
    expect(r.quote.toString()).toBe('351.1');
    expect(r.exhausted).toBe(true);
  });
  it('by dollars', () => {
    const r = walkBook(sampleBook, 'buy', { quote: D('100.10') }, step);
    expect(r.qty.toString()).toBe('1.00049');
    expect(r.quote.toString()).toBe('100.099049');
    expect(r.avgPrice!.toFixed(8)).toBe('100.05002449');
    expect(r.slippageUsd.toString()).toBe('0.050049');
    expect(r.exhausted).toBe(false);
  });
  it('limit-capped', () => {
    const r = walkBook(sampleBook, 'buy', { qty: D('2.0') }, step, D('100.10'));
    expect(r.qty.toString()).toBe('1.5');
    expect(r.quote.toString()).toBe('150.1');
    expect(r.exhausted).toBe(true);
  });
  it('sell limit stops before lower levels', () => {
    const r = walkBook(sampleBook, 'sell', { qty: D('1.5') }, step, D('99.80'));
    expect(r.qty.toString()).toBe('1.4');
    expect(r.exhausted).toBe(true);
  });
  it('empty side', () => {
    const r = walkBook({ bids: [], asks: [] }, 'buy', { qty: D('1') }, step);
    expect(r.qty.toString()).toBe('0');
    expect(r.avgPrice).toBeNull();
    expect(r.bestPrice).toBeNull();
    expect(r.slippageUsd.toString()).toBe('0');
    expect(r.levelsUsed).toBe(0);
    expect(r.exhausted).toBe(true);
  });
});
