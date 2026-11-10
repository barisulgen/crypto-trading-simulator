import { describe, expect, it } from 'vitest';
import { D, floorToStep, grouped, isMultipleOf, roundDown8, roundUp8 } from '../src/decimal.ts';

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
  it('rounds down to 8 decimals', () => {
    expect(roundDown8(D('0.149660019')).toString()).toBe('0.14966001');
    expect(roundDown8(D('-0.149660019')).toString()).toBe('-0.14966001');
  });
  it('groups the whole part by thousands without rounding anything', () => {
    expect(grouped('73596.0')).toBe('73,596.0');
    expect(grouped(D('76353.31325301'))).toBe('76,353.31325301');
    expect(grouped('-1234567.891')).toBe('-1,234,567.891');
    expect(grouped('999.99')).toBe('999.99');
    expect(grouped('1000')).toBe('1,000');
    expect(grouped('0.00012345')).toBe('0.00012345');
    expect(grouped('n/a')).toBe('n/a');
  });
  it('never uses exponent notation', () => {
    expect(D('0.00000012').toString()).toBe('0.00000012');
    expect(D('123456789012345678901234').toString()).toBe('123456789012345678901234');
  });
});
