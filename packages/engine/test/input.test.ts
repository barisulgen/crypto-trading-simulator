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
});
