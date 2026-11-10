import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { benchmarkBuy, benchmarkValue } from '../src/stats/benchmark.ts';

const rules = { stepSize: D('0.00001'), minNotional: D(5) };
const fee = D('0.001');

describe('benchmarkBuy', () => {
  it('buys whole steps and keeps no cash when the amount divides evenly', () => {
    const b = benchmarkBuy(D(1000), D(80000), rules, fee);
    expect(b.fee.toString()).toBe('0.0000125');
    expect(b.btc.toString()).toBe('0.0124875');
    expect(b.cash.toString()).toBe('0');
  });

  it('floors the quantity to the step and keeps the leftover as cash', () => {
    const b = benchmarkBuy(D(500), D(75000), rules, fee);
    expect(b.fee.toString()).toBe('0.00000666');
    expect(b.btc.toString()).toBe('0.00665334');
    expect(b.cash.toString()).toBe('0.5');
  });

  it('values both buys at the bid', () => {
    const buys = [benchmarkBuy(D(1000), D(80000), rules, fee), benchmarkBuy(D(500), D(75000), rules, fee)];
    const value = benchmarkValue(buys, D(90000));
    expect(value.toString()).toBe('1723.1756');
    expect(value.minus(1500).toString()).toBe('223.1756');
  });

  it('stays all cash below the minimum notional', () => {
    const b = benchmarkBuy(D(3), D(80000), rules, fee);
    expect(b.btc.toString()).toBe('0');
    expect(b.cash.toString()).toBe('3');
    expect(b.fee.toString()).toBe('0');
  });

  it('stays all cash when not even one step can be bought', () => {
    const b = benchmarkBuy(D('0.5'), D(80000), rules, fee);
    expect(b.btc.toString()).toBe('0');
    expect(b.cash.toString()).toBe('0.5');
  });

  it('rounds a fee that is not whole at 8 dp up', () => {
    const b = benchmarkBuy(D('12.345'), D(100000), { stepSize: D('0.00000001'), minNotional: D(5) }, fee);
    expect(b.fee.toString()).toBe('0.00000013');
    expect(b.btc.toString()).toBe('0.00012332');
  });
});
