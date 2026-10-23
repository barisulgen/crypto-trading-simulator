import { describe, expect, it } from 'vitest';
import { InputError, parseAmount } from '../src/input.ts';

describe('parseAmount', () => {
  it('accepts dot or comma decimals and trims', () => {
    expect(parseAmount('1.5').toString()).toBe('1.5');
    expect(parseAmount('1,5').toString()).toBe('1.5');
    expect(parseAmount(' 2 ').toString()).toBe('2');
  });
  it('rejects bad input', () => {
    for (const bad of ['', '0', '-1', '1e5', '1,000.5', '1.000,5', 'abc', '1..2', '+3'])
      expect(() => parseAmount(bad)).toThrow(InputError);
  });
  it('caps absurd amounts: 15 integer digits and 18 decimals at most', () => {
    expect(() => parseAmount('1' + '0'.repeat(15))).toThrow('Amount too large: at most 15 digits before the decimal point');
    expect(parseAmount('999999999999999.5').toString()).toBe('999999999999999.5');
    expect(() => parseAmount('0.' + '1'.repeat(19))).toThrow('Too many decimals: at most 18');
    expect(parseAmount('0.' + '1'.repeat(18)).toString()).toBe('0.' + '1'.repeat(18));
  });
});
