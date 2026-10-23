import { describe, expect, it } from 'vitest';
import { D } from '@sim/engine';
import type { PriceLevel } from '@sim/engine';
import { OwnLiquidity } from '../src/market/ownLiquidity.ts';
import { sampleBook } from '../../engine/test/fixtures.ts';

const show = (levels: PriceLevel[]) => levels.map((l) => `${l.price}x${l.qty}`);
const lvl = (price: string, qty: string): PriceLevel => ({ price: D(price), qty: D(qty) });

describe('OwnLiquidity', () => {
  it('after consuming asks 100.00 x 0.5, the asks start at 100.10 x 1.0', () => {
    const own = new OwnLiquidity();
    own.consume('asks', [lvl('100.00', '0.5')]);
    expect(show(own.apply('asks', sampleBook.asks))).toEqual(['100.1x1', '100.5x2']);
    // The other side is untouched.
    expect(show(own.apply('bids', sampleBook.bids))).toEqual(['99.9x0.4', '99.8x1', '99x3']);
  });

  it('a depth update at 100.00 ends the claim there: 100.00 x 0.5 is back', () => {
    const own = new OwnLiquidity();
    own.consume('asks', [lvl('100.00', '0.5'), lvl('100.10', '0.2')]);
    own.onLevelUpdate('asks', D('100'));
    expect(show(own.apply('asks', sampleBook.asks))).toEqual(['100x0.5', '100.1x0.8', '100.5x2']);
  });

  it('claims at one price add up; a level is dropped once they reach its quantity', () => {
    const own = new OwnLiquidity();
    own.consume('asks', [lvl('100.10', '0.3')]);
    own.consume('asks', [lvl('100.1', '0.3')]);
    expect(show(own.apply('asks', sampleBook.asks))).toEqual(['100x0.5', '100.1x0.4', '100.5x2']);
    own.consume('asks', [lvl('100.10', '0.4')]);
    expect(show(own.apply('asks', sampleBook.asks))).toEqual(['100x0.5', '100.5x2']);
  });

  it('an update on one side leaves the claims of the other side', () => {
    const own = new OwnLiquidity();
    own.consume('bids', [lvl('99.90', '0.4')]);
    own.onLevelUpdate('asks', D('99.90'));
    expect(show(own.apply('bids', sampleBook.bids))).toEqual(['99.8x1', '99x3']);
    expect(own.count('bids')).toBe(1);
    expect(own.count('asks')).toBe(0);
  });

  it('clear() (a resync or snapshot) ends every claim', () => {
    const own = new OwnLiquidity();
    own.consume('asks', [lvl('100.00', '0.5')]);
    own.consume('bids', [lvl('99.90', '0.1')]);
    own.clear();
    expect(show(own.apply('asks', sampleBook.asks))).toEqual(['100x0.5', '100.1x1', '100.5x2']);
    expect(show(own.apply('bids', sampleBook.bids))).toEqual(['99.9x0.4', '99.8x1', '99x3']);
    expect(own.count('asks') + own.count('bids')).toBe(0);
  });

  it('apply returns new levels and leaves the ones it is given unchanged', () => {
    const own = new OwnLiquidity();
    const asks = [lvl('100.00', '0.5'), lvl('100.10', '1.0')];
    own.consume('asks', [lvl('100.10', '0.25')]);
    const out = own.apply('asks', asks);
    expect(show(out)).toEqual(['100x0.5', '100.1x0.75']);
    expect(show(asks)).toEqual(['100x0.5', '100.1x1']);
  });
});
