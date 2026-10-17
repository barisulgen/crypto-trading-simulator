import { describe, expect, it } from 'vitest';
import type { AccountSnapshot } from '../src/lib/api.ts';
import { avgFill, holdingRows } from '../src/lib/holdings.ts';
import { divDec, floorToStep, pctOf } from '../src/lib/market.ts';

describe('decimal division', () => {
  it('divides exactly to the given decimals, rounding half away from zero', () => {
    expect(divDec('100.05', '0.999', 2)).toBe('100.15'); // 100.1501...
    expect(divDec('1', '3', 8)).toBe('0.33333333');
    expect(divDec('2', '3', 8)).toBe('0.66666667');
    expect(divDec('0.125', '1', 2)).toBe('0.13');
    expect(divDec('-0.125', '1', 2)).toBe('-0.13');
    expect(divDec('12345678901234567.89', '1', 1)).toBe('12345678901234567.9');
    expect(divDec('81094.7', '1', 2)).toBe('81094.70');
    expect(divDec('5', '2', 0)).toBe('3');
  });

  it('floors a quantity to a step size (what an exchange accepts), exactly', () => {
    expect(floorToStep('0.00121878', '0.00001000')).toBe('0.00121');
    expect(floorToStep('0.00121878', '0.00001')).toBe('0.00121');
    expect(floorToStep('12.5', '1.00000000')).toBe('12');
    expect(floorToStep('300', '1')).toBe('300');
    expect(floorToStep('0.000009', '0.00001')).toBe('0');
    expect(floorToStep('7.35', '0.25')).toBe('7.25');
  });

  it('gives a part as a percentage of a whole with 2 decimals', () => {
    expect(pctOf('0.849', '100.05')).toBe('0.85'); // 0.84857...
    expect(pctOf('-1.149', '100.05')).toBe('-1.15'); // -1.14842...
    expect(pctOf('-0.125', '100')).toBe('-0.13'); // exactly half: away from zero
    expect(pctOf('0', '100')).toBe('0.00');
  });
});

const account = (over: Partial<AccountSnapshot> = {}): AccountSnapshot =>
  ({
    spotUsdtFree: '899.95',
    spotUsdtLocked: '0',
    leverageUsdt: '0',
    coins: [{ asset: 'BTC', qty: '0.999', bid: '101', value: '100.899', fresh: true }],
    total: '1000.849',
    totalDeposited: '1000',
    netPnl: '0.849',
    netPnlPct: '0.0849',
    balances: {
      spot: { USDT: { free: '899.95', locked: '0' }, BTC: { free: '0.499', locked: '0.5' } },
      leverage: { USDT: { free: '0', locked: '0' } },
    },
    basis: { BTC: { qty: '0.999', cost: '100.05' } },
    ...over,
  }) as AccountSnapshot;

describe('holdings', () => {
  it('average cost is cost / qty and unrealised P&L is value at bid minus cost, exactly', () => {
    expect(holdingRows(account(), () => 2)).toEqual([
      {
        asset: 'BTC',
        symbol: 'BTCUSDT',
        qty: '0.999',
        free: '0.499',
        locked: '0.5',
        bid: '101',
        value: '100.899',
        fresh: true,
        cost: '100.05',
        avgCost: '100.15',
        pnl: '0.849',
        pnlPct: '0.85',
      },
    ]);
  });

  it('a loss is negative in dollars and percent', () => {
    const rows = holdingRows(
      account({ coins: [{ asset: 'BTC', qty: '0.999', bid: '99', value: '98.901', fresh: true }] }),
      () => 2,
    );
    expect(rows[0]).toMatchObject({ pnl: '-1.149', pnlPct: '-1.15' });
  });

  it('uses the symbol\'s price decimals for the average cost', () => {
    const rows = holdingRows(
      account({
        coins: [{ asset: 'DOGE', qty: '300', bid: '0.07824', value: '23.472', fresh: true }],
        balances: {
          spot: { USDT: { free: '0', locked: '0' }, DOGE: { free: '300', locked: '0' } },
          leverage: { USDT: { free: '0', locked: '0' } },
        },
        basis: { DOGE: { qty: '300', cost: '23.5' } },
      }),
      (s) => (s === 'DOGEUSDT' ? 5 : 2),
    );
    expect(rows[0]).toMatchObject({ symbol: 'DOGEUSDT', avgCost: '0.07833', pnl: '-0.028', pnlPct: '-0.12' });
  });

  it('without a bid there is no value to compare, so no P&L (never against a zero price)', () => {
    const rows = holdingRows(
      account({ coins: [{ asset: 'BTC', qty: '0.999', bid: '0', value: '0', fresh: false }] }),
      () => 2,
    );
    expect(rows[0]).toMatchObject({ avgCost: '100.15', pnl: null, pnlPct: null, fresh: false });
  });

  it('without a cost basis there is no average cost or P&L', () => {
    const rows = holdingRows(account({ basis: {} }), () => 2);
    expect(rows[0]).toMatchObject({ cost: null, avgCost: null, pnl: null, pnlPct: null });
  });
});

describe('average fill price of an order', () => {
  it('is filled quote / filled qty, null before any fill', () => {
    expect(avgFill('50.03', '0.5', 4)).toBe('100.0600');
    expect(avgFill('0', '0', 4)).toBeNull();
  });
});
