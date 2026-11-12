import { D } from '../decimal.ts';
import type { Trade, TradeQuality } from './types.ts';

/**
 * Win rate, averages, profit factor, expectancy, best and worst trade and streaks of closed trades.
 * A win is a result above zero, a loss one below; a break-even trade counts as a trade and ends both
 * streaks. Streaks and ties run in close order: closing time, then the closing event's row id.
 */
export function tradeQuality(trades: Trade[]): TradeQuality {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt || a.closeEventId - b.closeEventId);

  let wins = 0;
  let losses = 0;
  let breakEven = 0;
  let grossWin = D(0);
  let grossLoss = D(0);
  let total = D(0);
  let best: Trade | null = null;
  let worst: Trade | null = null;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let winRun = 0;
  let lossRun = 0;

  for (const t of ordered) {
    total = total.plus(t.result);
    if (best === null || t.result.gt(best.result)) best = t;
    if (worst === null || t.result.lt(worst.result)) worst = t;
    if (t.result.gt(0)) {
      wins += 1;
      grossWin = grossWin.plus(t.result);
      winRun += 1;
      lossRun = 0;
    } else if (t.result.lt(0)) {
      losses += 1;
      grossLoss = grossLoss.plus(t.result);
      lossRun += 1;
      winRun = 0;
    } else {
      breakEven += 1;
      winRun = 0;
      lossRun = 0;
    }
    longestWinStreak = Math.max(longestWinStreak, winRun);
    longestLossStreak = Math.max(longestLossStreak, lossRun);
  }

  const count = ordered.length;
  return {
    count,
    wins,
    losses,
    breakEven,
    winRate: count > 0 ? D(wins).div(count) : null,
    avgWin: wins > 0 ? grossWin.div(wins) : null,
    avgLoss: losses > 0 ? grossLoss.div(losses) : null,
    profitFactor: losses > 0 ? grossWin.div(grossLoss.abs()) : null,
    noLosses: count > 0 && losses === 0,
    expectancy: count > 0 ? total.div(count) : null,
    best,
    worst,
    longestWinStreak,
    longestLossStreak,
  };
}
