import { afterEach, describe, expect, it } from 'vitest';
import { fmtBalance, fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsd, setRules, signOf, tickDecimals } from '../src/lib/format.ts';

describe('tickDecimals', () => {
  it('counts the significant decimals of a tick or step size', () => {
    expect(tickDecimals('0.01000000')).toBe(2);
    expect(tickDecimals('0.00001')).toBe(5);
    expect(tickDecimals('1.00000000')).toBe(0);
    expect(tickDecimals('10')).toBe(0);
    expect(tickDecimals('0.10')).toBe(1);
  });
});

describe('fmtNum', () => {
  it('rounds half away from zero on the string, with thousands separators', () => {
    expect(fmtNum('1234567.891', 2)).toBe('1,234,567.89');
    expect(fmtNum('0.005', 2)).toBe('0.01');
    expect(fmtNum('-0.005', 2)).toBe('-0.01');
    expect(fmtNum('999.995', 2)).toBe('1,000.00');
    expect(fmtNum('12', 3)).toBe('12.000');
    expect(fmtNum('12.7', 0)).toBe('13');
  });

  it('never parses into a float: digits beyond double precision survive', () => {
    expect(fmtNum('12345678901234567.25', 1)).toBe('12,345,678,901,234,567.3');
    expect(fmtNum('0.1000000000000000055', 18)).toBe('0.100000000000000006');
  });

  it('shows a value that rounds to zero without a minus sign', () => {
    expect(fmtNum('-0.004', 2)).toBe('0.00');
    expect(fmtNum('-0', 0)).toBe('0');
  });

  it('can leave out the separators and returns non-numbers untouched', () => {
    expect(fmtNum('1234.5', 2, { group: false })).toBe('1234.50');
    expect(fmtNum('abc', 2)).toBe('abc');
  });
});

describe('fmtPrice and fmtQty', () => {
  afterEach(() => setRules({}));

  it('use the symbol tick size and step size decimals', () => {
    setRules({
      BTCUSDT: { tickSize: '0.01000000', stepSize: '0.00001000' },
      DOGEUSDT: { tickSize: '0.00001000', stepSize: '1.00000000' },
    });
    expect(fmtPrice('BTCUSDT', '67123.4')).toBe('67,123.40');
    expect(fmtPrice('DOGEUSDT', '0.123456')).toBe('0.12346');
    expect(fmtQty('BTCUSDT', '0.5')).toBe('0.50000');
    expect(fmtQty('DOGEUSDT', '1500')).toBe('1,500');
  });

  it('fmtBalance shows a balance in full (step decimals at least, up to 8), never rounded up', () => {
    setRules({
      BTCUSDT: { tickSize: '0.01000000', stepSize: '0.00001000' },
      DOGEUSDT: { tickSize: '0.00001000', stepSize: '1.00000000' },
    });
    expect(fmtBalance('BTCUSDT', '0.00121878')).toBe('0.00121878'); // fmtQty would say 0.00122
    expect(fmtBalance('BTCUSDT', '0.5')).toBe('0.50000');
    expect(fmtBalance('DOGEUSDT', '1498.5')).toBe('1,498.5');
    expect(fmtBalance('DOGEUSDT', '1500')).toBe('1,500');
    expect(fmtBalance('ETHUSDT', undefined)).toBe('-');
  });

  it('fall back to the value as given (trailing zeros trimmed) without rules, and a dash for no value', () => {
    expect(fmtPrice('ETHUSDT', '2450.1200')).toBe('2,450.12');
    expect(fmtPrice('ETHUSDT', null)).toBe('-');
    expect(fmtQty('ETHUSDT', undefined)).toBe('-');
  });
});

describe('fmtUsd', () => {
  it('has a dollar sign, 2 decimals and thousands separators', () => {
    expect(fmtUsd('1000')).toBe('$1,000.00');
    expect(fmtUsd('1234567.891')).toBe('$1,234,567.89');
    expect(fmtUsd('-12.345')).toBe('-$12.35');
    expect(fmtUsd('0')).toBe('$0.00');
  });

  it('adds a plus sign for gains when asked, never for zero', () => {
    expect(fmtUsd('12.3', { sign: true })).toBe('+$12.30');
    expect(fmtUsd('-12.3', { sign: true })).toBe('-$12.30');
    expect(fmtUsd('0', { sign: true })).toBe('$0.00');
    expect(fmtUsd('0.001', { sign: true })).toBe('$0.00');
  });
});

describe('fmtPct and signOf', () => {
  it('formats a signed percentage with 2 decimals', () => {
    expect(fmtPct('2.3456')).toBe('+2.35%');
    expect(fmtPct('-0.5')).toBe('-0.50%');
    expect(fmtPct('0')).toBe('0.00%');
    expect(fmtPct('-0.001')).toBe('0.00%');
    expect(fmtPct(null)).toBe('-');
  });

  it('gives the sign of the value as displayed', () => {
    expect(signOf('3.2')).toBe(1);
    expect(signOf('-0.2')).toBe(-1);
    expect(signOf('0')).toBe(0);
    expect(signOf('-0.004', 2)).toBe(0);
    expect(signOf('-0.005', 2)).toBe(-1);
    expect(signOf(null)).toBe(0);
  });
});
