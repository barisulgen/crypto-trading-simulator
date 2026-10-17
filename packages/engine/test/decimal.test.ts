import { describe, expect, it } from 'vitest';
import { D, floorToStep, isMultipleOf, roundUp8 } from '../src/decimal.ts';

describe('decimal helpers', () => {
  it('floors to a step', () => {
    expect(floorToStep(D('0.5004995'), D('0.00001')).toString()).toBe('0.50049');
  });
  it('checks multiples of a step', () => {
    expect(isMultipleOf(D('100.005'), D('0.01'))).toBe(false);
    expect(isMultipleOf(D('100.10'), D('0.01'))).toBe(true);
    expect(isMultipleOf(D('1.23'), D('0'))).toBe(true);
  });
  it('rounds up to 8 decimals', () => {
    expect(roundUp8(D('0.149660001')).toString()).toBe('0.14966001');
  });
});
