import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { tradeQuality } from '../src/stats/quality.ts';
import type { Trade } from '../src/stats/types.ts';

const T0 = 1_700_000_000_000;

function trade(result: number, closedAt: number, closeEventId = 1): Trade {
  return {
    id: `t-${closedAt}-${closeEventId}`,
    market: 'perp',
    symbol: 'BTCUSDT',
    side: 'long',
    leverage: 10,
    openedAt: closedAt - 60_000,
    closedAt,
    closeEventId,
    result: D(result),
    fees: D(0),
    funding: D(0),
    estimated: false,
    reason: 'closed',
  };
}

const inOrder = (results: number[]): Trade[] => results.map((r, i) => trade(r, T0 + i * 1000, i + 1));

describe('tradeQuality', () => {
  it('summarises wins, losses, averages, profit factor, expectancy, extremes and streaks', () => {
    const trades = inOrder([-12, 30, 20, 10, -36, -27]);
    const q = tradeQuality(trades);
    expect(q.count).toBe(6);
    expect(q.wins).toBe(3);
    expect(q.losses).toBe(3);
    expect(q.breakEven).toBe(0);
    expect(q.winRate?.toString()).toBe('0.5');
    expect(q.avgWin?.toString()).toBe('20');
    expect(q.avgLoss?.toString()).toBe('-25');
    expect(q.profitFactor?.toString()).toBe('0.8');
    expect(q.noLosses).toBe(false);
    expect(q.expectancy?.toString()).toBe('-2.5');
    expect(q.best).toBe(trades[1]);
    expect(q.worst).toBe(trades[4]);
    expect(q.longestWinStreak).toBe(3);
    expect(q.longestLossStreak).toBe(2);
  });

  it('counts a break-even trade as a trade that is neither a win nor a loss and ends both streaks', () => {
    const q = tradeQuality(inOrder([5, 0, 5, -1]));
    expect(q.count).toBe(4);
    expect(q.wins).toBe(2);
    expect(q.losses).toBe(1);
    expect(q.breakEven).toBe(1);
    expect(q.winRate?.toString()).toBe('0.5');
    expect(q.expectancy?.toString()).toBe('2.25');
    expect(q.profitFactor?.toString()).toBe('10');
    expect(q.longestWinStreak).toBe(1);
    expect(q.longestLossStreak).toBe(1);
  });

  it('has no profit factor or average loss without a losing trade', () => {
    const q = tradeQuality(inOrder([5, 5]));
    expect(q.profitFactor).toBeNull();
    expect(q.noLosses).toBe(true);
    expect(q.avgLoss).toBeNull();
    expect(q.avgWin?.toString()).toBe('5');
  });

  it('has no profit factor or average win when the only trade broke even', () => {
    const q = tradeQuality(inOrder([0]));
    expect(q.profitFactor).toBeNull();
    expect(q.avgWin).toBeNull();
    expect(q.winRate?.toString()).toBe('0');
  });

  it('is empty for no trades', () => {
    const q = tradeQuality([]);
    expect(q.count).toBe(0);
    expect(q.winRate).toBeNull();
    expect(q.avgWin).toBeNull();
    expect(q.avgLoss).toBeNull();
    expect(q.profitFactor).toBeNull();
    expect(q.noLosses).toBe(false);
    expect(q.expectancy).toBeNull();
    expect(q.best).toBeNull();
    expect(q.worst).toBeNull();
    expect(q.longestWinStreak).toBe(0);
    expect(q.longestLossStreak).toBe(0);
  });

  it('orders trades closing at the same millisecond by closeEventId, whatever the input order', () => {
    const a = trade(10, T0, 1);
    const b = trade(-10, T0, 2);
    const c = trade(10, T0, 3);
    const q = tradeQuality([c, a, b]);
    expect(q.longestWinStreak).toBe(1);
    expect(q.longestLossStreak).toBe(1);
    // In id order the two wins are split by the loss; by input order they would be adjacent.
    expect(tradeQuality([a, c, b]).longestWinStreak).toBe(1);
  });

  it('breaks best and worst ties towards the earlier trade', () => {
    const a = trade(10, T0, 1);
    const b = trade(10, T0, 2);
    expect(tradeQuality([b, a]).best).toBe(a);
  });
});
