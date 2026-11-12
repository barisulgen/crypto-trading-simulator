import { describe, expect, it } from 'vitest';
import type { WireStatsReport } from '../src/lib/api.ts';
import { isBackwards, localDayEnd, localDayStart } from '../src/lib/history.ts';
import { fmtDateTime } from '../src/lib/market.ts';
import {
  EMPTY_STATS_FILTER,
  filterNotes,
  parseStatsFilters,
  statsFilterParams,
  statsQuery,
  statsView,
} from '../src/lib/stats.ts';
import type { StatRow, StatsFilter, StatsView } from '../src/lib/stats.ts';

/** Local time, as the owner's clock shows it. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

type WireTrade = NonNullable<WireStatsReport['quality']['best']>;

function trade(over: Partial<WireTrade> = {}): WireTrade {
  return {
    id: 'p1',
    market: 'perp',
    symbol: 'BTCUSDT',
    side: 'long',
    leverage: 10,
    openedAt: at(2026, 11, 9, 23, 30),
    closedAt: at(2026, 11, 10, 1, 0),
    closeEventId: 7,
    result: '30',
    fees: '1',
    funding: '0',
    estimated: false,
    reason: 'closed',
    ...over,
  };
}

/**
 * The worked figures of the engine stats: trade quality over results -12, +30, +20, +10, -36, -27
 * (win rate 0.5, profit factor 0.8) and the cost share of net 75 with costs 25 (share 0.25).
 */
function report(over: Partial<WireStatsReport> = {}): WireStatsReport {
  return {
    headline: {
      scope: { kind: 'account' },
      netPnl: '75',
      returnPct: '0.075',
      capitalMax: '1000',
      currentValue: '1075',
      deposited: '1000',
      live: true,
    },
    series: [
      { time: at(2026, 11, 9, 9, 0), pnl: '0', value: '1000' },
      { time: at(2026, 11, 10, 9, 0), pnl: '75', value: '1075' },
    ],
    markers: [],
    drawdown: { maxUsd: '36', maxPct: '0.0345', periods: [], underwater: [] },
    quality: {
      count: 6,
      wins: 3,
      losses: 3,
      breakEven: 0,
      winRate: '0.5',
      avgWin: '20',
      avgLoss: '-25',
      profitFactor: '0.8',
      noLosses: false,
      expectancy: '-2.5',
      best: trade(),
      worst: trade({ id: 'rt-2', market: 'spot', symbol: 'ETHUSDT', leverage: null, result: '-36', reason: 'round_trip' }),
      longestWinStreak: 3,
      longestLossStreak: 2,
    },
    risk: { liquidations: 1, lostToLiquidations: '148.5', liquidationFees: '8.5', avgLeverage: '9.25', maxLeverage: 20 },
    costs: {
      makerFees: '3',
      takerFees: '15',
      liquidationFees: '0',
      fundingPaid: '4',
      fundingReceived: '2',
      fundingNet: '-2',
      slippage: '5',
      catchUpGapCost: '0',
      drift: '0.7',
      total: '25',
      share: '0.25',
      preCost: '100',
      uncovered: '0',
      estimatedFills: 0,
      estimatedFunding: 0,
      estimatedLiquidations: 0,
    },
    breakdowns: {
      coin: [
        { key: 'BTC', pnl: '21', count: 4, winRate: '0.75' },
        { key: 'ETH', pnl: '-36', count: 2, winRate: '0' },
      ],
      side: [{ key: 'long', pnl: '-15', count: 6, winRate: '0.5' }],
      market: [
        { key: 'spot', pnl: '-36', count: 2, winRate: '0' },
        { key: 'perp', pnl: '21', count: 4, winRate: '0.75' },
      ],
      leverage: [
        { key: '6-10', pnl: '21', count: 4, winRate: '0.75' },
        { key: 'spot', pnl: '-36', count: 2, winRate: '0' },
      ],
      hold: [{ key: '1h-1d', pnl: '-15', count: 6, winRate: '0.5' }],
      hour: [{ key: '23', pnl: '-15', count: 6, winRate: '0.5' }],
      weekday: [{ key: 'Mon', pnl: '-15', count: 6, winRate: '0.5' }],
    },
    benchmark: { scope: 'account', missing: 0, value: '1050', pnl: '50', returnPct: '0.05', series: [] },
    open: { count: 0, unrealized: '0' },
    unattributed: { count: 0, realized: '0' },
    estimated: { trades: 0, fills: 0, funding: 0, liquidations: 0 },
    ...over,
  };
}

const EMPTY_QUALITY: WireStatsReport['quality'] = {
  count: 0,
  wins: 0,
  losses: 0,
  breakEven: 0,
  winRate: null,
  avgWin: null,
  avgLoss: null,
  profitFactor: null,
  noLosses: false,
  expectancy: null,
  best: null,
  worst: null,
  longestWinStreak: 0,
  longestLossStreak: 0,
};

const NO_BREAKDOWNS: WireStatsReport['breakdowns'] = {
  coin: [],
  side: [],
  market: [],
  leverage: [],
  hold: [],
  hour: [],
  weekday: [],
};

function row(rows: StatRow[], label: string): StatRow {
  const r = rows.find((x) => x.label === label);
  if (!r) throw new Error(`no row ${label} in ${rows.map((x) => x.label).join(', ')}`);
  return r;
}

const allRows = (v: StatsView) => [...v.headline, ...v.quality.rows, ...v.risk, ...v.costs.rows];

describe('stats filters in the URL', () => {
  it('round-trips coin, market and dates through the hash, with the same keys as History', () => {
    const f: StatsFilter = { symbol: 'BTCUSDT', market: 'leverage', from: '2026-11-01', to: '2026-11-10' };
    const params = statsFilterParams(f);
    expect(params).toEqual({ symbol: 'BTCUSDT', market: 'leverage', from: '2026-11-01', to: '2026-11-10' });
    expect(parseStatsFilters(new URLSearchParams(params))).toEqual(f);
  });

  it('no filters is an empty query; unknown values and History-only keys are dropped', () => {
    expect(statsFilterParams(EMPTY_STATS_FILTER)).toEqual({});
    expect(parseStatsFilters(new URLSearchParams(''))).toEqual(EMPTY_STATS_FILTER);
    expect(parseStatsFilters(new URLSearchParams('symbol=NOPE&market=x&from=2026-02-30&types=fill'))).toEqual(EMPTY_STATS_FILTER);
    expect(parseStatsFilters(new URLSearchParams('market=perp')).market).toBe('leverage');
  });

  it('asks the API for whole local days, both ends included, in the given time zone', () => {
    const f: StatsFilter = { symbol: 'ETHUSDT', market: 'spot', from: '2026-11-01', to: '2026-11-10' };
    expect(statsQuery(f, 'Europe/Istanbul')).toEqual({
      symbol: 'ETHUSDT',
      market: 'spot',
      from: localDayStart('2026-11-01'),
      to: localDayEnd('2026-11-10'),
      tz: 'Europe/Istanbul',
    });
    expect(statsQuery(EMPTY_STATS_FILTER, 'UTC')).toEqual({ tz: 'UTC' });
  });

  it('notes what a filter does not narrow: the benchmark, and the curve of a coin', () => {
    const now = at(2026, 11, 11, 12);
    expect(filterNotes(EMPTY_STATS_FILTER, true, now)).toEqual([]);
    expect(filterNotes({ ...EMPTY_STATS_FILTER, market: 'spot' }, true, now)).toEqual([
      'The BTC benchmark always covers the whole account.',
    ]);
    expect(filterNotes({ ...EMPTY_STATS_FILTER, symbol: 'SOLUSDT' }, true, now)).toEqual([
      'The BTC benchmark always covers the whole account.',
      'For one coin, the curve and drawdown follow its realised P&L; unrealised added now.',
    ]);
    // A range reaching today still ends now.
    expect(filterNotes({ ...EMPTY_STATS_FILTER, symbol: 'SOLUSDT', to: '2026-11-11' }, true, now)[1]).toBe(
      'For one coin, the curve and drawdown follow its realised P&L; unrealised added now.',
    );
  });

  it('never says unrealised is added for a coin when nothing is: a range that ended, prices not live, or not known yet', () => {
    const now = at(2026, 11, 11, 12);
    const only = 'For one coin, the curve and drawdown follow its realised P&L only.';
    const coin = { ...EMPTY_STATS_FILTER, symbol: 'SOLUSDT' };
    expect(filterNotes({ ...coin, to: '2026-11-01' }, true, now)[1]).toBe(only);
    expect(filterNotes(coin, false, now)[1]).toBe(only);
    expect(filterNotes(coin, null, now)[1]).toBe(only);
    // The headline label agrees with the note in each case.
    const r = report({ headline: { ...report().headline, scope: { kind: 'coin', symbol: 'SOLUSDT', market: null } } });
    expect(row(statsView(r, { ...coin, to: '2026-11-01' }, now).headline, 'Net P&L').note).toBe('realised P&L only');
    expect(row(statsView(r, coin, now).headline, 'Net P&L').note).toBe('realised P&L; unrealised added now');
  });

  it('knows a From date after the To date, so no request is sent', () => {
    expect(isBackwards({ from: '2026-11-10', to: '2026-11-01' })).toBe(true);
    expect(isBackwards({ from: '2026-11-01', to: '2026-11-01' })).toBe(false);
    expect(isBackwards({ from: '2026-11-01', to: null })).toBe(false);
  });
});

describe('statsView', () => {
  it('formats the trade quality: win rate to 1 dp, profit factor to 2 dp, money with its sign', () => {
    const v = statsView(report());
    const q = v.quality.rows;
    expect(row(q, 'Closed trades').value).toBe('6');
    expect(row(q, 'Win rate').value).toBe('50.0%');
    expect(row(q, 'Profit factor').value).toBe('0.80');
    expect(row(q, 'Average win')).toMatchObject({ value: '+$20.00', tone: 'up' });
    expect(row(q, 'Average loss')).toMatchObject({ value: '-$25.00', tone: 'down' });
    expect(row(q, 'Expected profit per trade')).toMatchObject({ value: '-$2.50', tone: 'down' });
    expect(row(q, 'Longest winning streak').value).toBe('3');
    expect(row(q, 'Longest losing streak').value).toBe('2');
  });

  it('shows the cost share to 2 dp, of the result before costs', () => {
    const v = statsView(report());
    expect(row(v.costs.rows, 'Share of profit eaten by costs')).toMatchObject({
      value: '25.00%',
      note: 'of the $100.00 made before costs',
    });
    expect(row(v.costs.rows, 'Total costs').value).toBe('$25.00');
    const labels = v.costs.rows.map((x) => x.label);
    expect(labels.slice(labels.indexOf('Funding paid'), labels.indexOf('Funding paid') + 3)).toEqual([
      'Funding paid',
      'Funding received',
      'Funding net',
    ]);
    expect(row(v.costs.rows, 'Funding net')).toMatchObject({ value: '-$2.00', tone: 'down' });
    const received = statsView(report({ costs: { ...report().costs, fundingNet: '1.25' } }));
    expect(row(received.costs.rows, 'Funding net')).toMatchObject({ value: '+$1.25', tone: 'up' });
    expect(row(v.costs.rows, 'Delay drift')).toMatchObject({ value: 'cost $0.70', note: 'not in the total: it can be a gain' });
  });

  it('says when costs turned a profit into a loss', () => {
    const v = statsView(report({ costs: { ...report().costs, share: '1.6666666666666666667', preCost: '15' } }));
    expect(row(v.costs.rows, 'Share of profit eaten by costs')).toMatchObject({
      value: '166.67%',
      note: 'of the $15.00 made before costs: the costs turned a profit into a loss',
    });
  });

  it('with no losing trade, the profit factor reads "No losing trades"', () => {
    const v = statsView(report({ quality: { ...report().quality, losses: 0, avgLoss: null, profitFactor: null, noLosses: true } }));
    expect(row(v.quality.rows, 'Profit factor').value).toBe('No losing trades');
    expect(row(v.quality.rows, 'Average loss').value).toBe('–');
  });

  it('with no profit before costs, the share reads "No profit before costs (-$5.00)"', () => {
    const v = statsView(report({ costs: { ...report().costs, share: null, preCost: '-5' } }));
    expect(row(v.costs.rows, 'Share of profit eaten by costs').value).toBe('No profit before costs (-$5.00)');
  });

  it('shows every figure that cannot be computed as "–", never 0', () => {
    const v = statsView(
      report({
        headline: { ...report().headline, returnPct: null },
        quality: EMPTY_QUALITY,
        drawdown: { maxUsd: '0', maxPct: null, periods: [], underwater: [] },
        risk: { liquidations: 0, lostToLiquidations: '0', liquidationFees: '0', avgLeverage: null, maxLeverage: null },
        costs: { ...report().costs, share: null, preCost: '0' },
        benchmark: { scope: 'account', missing: 0, value: null, pnl: null, returnPct: null, series: [] },
        breakdowns: NO_BREAKDOWNS,
        open: { count: 1, unrealized: null },
      }),
    );
    for (const label of ['Win rate', 'Average win', 'Average loss', 'Profit factor', 'Expected profit per trade', 'Best trade', 'Worst trade']) {
      expect(row(v.quality.rows, label).value, label).toBe('–');
    }
    expect(row(v.headline, 'Return').value).toBe('–');
    expect(row(v.headline, 'BTC buy-and-hold P&L').value).toBe('–');
    expect(row(v.headline, 'BTC buy-and-hold return').value).toBe('–');
    expect(row(v.risk, 'Max drawdown %').value).toBe('–');
    expect(row(v.risk, 'Average leverage').value).toBe('–');
    expect(row(v.risk, 'Highest leverage').value).toBe('–');
    expect(row(v.quality.rows, 'Closed trades').value).toBe('0');
    expect(v.open).toBe('Open: 1, unrealised –');
    expect(v.breakdowns).toEqual({ tables: [], empty: 'No closed trades in this range', note: null });
    expect(allRows(v).some((r) => /NaN|Infinity|undefined|null/.test(r.value))).toBe(false);
  });

  it('says so when estimated funding payments or liquidations are in the figures', () => {
    const base = report();
    const v = statsView(
      report({
        estimated: { trades: 1, fills: 2, funding: 3, liquidations: 1 },
        costs: { ...base.costs, estimatedFills: 2, estimatedFunding: 3, estimatedLiquidations: 1 },
      }),
    );
    const all = 'includes 1 estimated trade, 2 estimated fills, 3 estimated funding payments and 1 estimated liquidation';
    expect(row(v.headline, 'Net P&L').note).toBe(all);
    expect(row(v.headline, 'Return').note).toBe(`of the highest capital, $1,000.00 · ${all}`);
    expect(v.riskNote).toBe(all);
    expect(v.costs.note).toBe('includes 2 estimated fills, 3 estimated funding payments and 1 estimated liquidation');
    // Trade figures count trades only: an estimated payment or liquidation already marks its trade.
    expect(v.quality.note).toBe('includes 1 estimated trade');

    // Funding alone, as from an open position's payment during a gap.
    const funding = statsView(
      report({
        estimated: { trades: 0, fills: 0, funding: 1, liquidations: 0 },
        costs: { ...base.costs, estimatedFunding: 1 },
      }),
    );
    expect(row(funding.headline, 'Net P&L').note).toBe('includes 1 estimated funding payment');
    expect(funding.riskNote).toBe('includes 1 estimated funding payment');
    expect(funding.costs.note).toBe('includes 1 estimated funding payment');
    expect(funding.quality.note).toBeNull();
  });

  it('links the best and worst trade to History, filtered to the coin and the days it was open', () => {
    const v = statsView(report());
    const best = row(v.quality.rows, 'Best trade');
    expect(best.value).toBe('+$30.00');
    expect(best.href).toBe('#/history?symbol=BTCUSDT&from=2026-11-09&to=2026-11-10');
    expect(best.note).toBe(`BTC perp long 10x · ${fmtDateTime(at(2026, 11, 9, 23, 30))} to ${fmtDateTime(at(2026, 11, 10, 1, 0))}`);
    const worst = row(v.quality.rows, 'Worst trade');
    expect(worst).toMatchObject({ value: '-$36.00', tone: 'down', href: '#/history?symbol=ETHUSDT&from=2026-11-09&to=2026-11-10' });
    expect(worst.note).toMatch(/^ETH spot long · /);
  });

  it('marks every figure that includes estimated results, and badges an estimated best or worst trade', () => {
    const base = report();
    const v = statsView(
      report({
        estimated: { trades: 2, fills: 3, funding: 0, liquidations: 0 },
        quality: { ...base.quality, worst: { ...base.quality.worst!, estimated: true } },
        costs: { ...base.costs, estimatedFills: 3, catchUpGapCost: '1.5' },
      }),
    );
    expect(row(v.quality.rows, 'Closed trades').note).toBe('3 won · 3 lost · includes 2 estimated trades');
    expect(v.quality.note).toBe('includes 2 estimated trades');
    expect(v.breakdowns.note).toBe('includes 2 estimated trades');
    expect(v.costs.note).toBe('includes 3 estimated fills');
    expect(row(v.costs.rows, 'Slippage').note).toBe('includes $1.50 gap cost of estimated stop and take-profit fills');
    expect(row(v.headline, 'Net P&L').note).toBe('includes 2 estimated trades and 3 estimated fills');
    expect(row(v.headline, 'Return').note).toBe(
      'of the highest capital, $1,000.00 · includes 2 estimated trades and 3 estimated fills',
    );
    expect(v.riskNote).toBe('includes 2 estimated trades and 3 estimated fills');
    expect(row(v.quality.rows, 'Worst trade').estimated).toBe(true);
    expect(row(v.quality.rows, 'Best trade').estimated).toBe(false);

    const none = statsView(report());
    expect(none.quality.note).toBeNull();
    expect(none.costs.note).toBeNull();
    expect(none.riskNote).toBeNull();
    expect(row(none.headline, 'Return').note).toBe('of the highest capital, $1,000.00');
    expect(row(none.headline, 'Net P&L').note).toBeUndefined();
    expect(row(none.quality.rows, 'Closed trades').note).toBe('3 won · 3 lost');
  });

  it('puts the BTC benchmark beside the result, and says it is the whole account under a filter', () => {
    const v = statsView(report());
    expect(row(v.headline, 'Net P&L')).toMatchObject({ value: '+$75.00', tone: 'up' });
    expect(row(v.headline, 'Return')).toMatchObject({ value: '+7.50%', note: 'of the highest capital, $1,000.00' });
    expect(row(v.headline, 'Current value').value).toBe('$1,075.00');
    expect(row(v.headline, 'Deposited').value).toBe('$1,000.00');
    expect(row(v.headline, 'BTC buy-and-hold P&L')).toMatchObject({ value: '+$50.00', tone: 'up' });
    expect(row(v.headline, 'BTC buy-and-hold return').value).toBe('+5.00%');
    expect(v.scope).toBe('Whole account');

    const wallet = statsView(report({ headline: { ...report().headline, scope: { kind: 'wallet', wallet: 'spot' } } }));
    expect(wallet.scope).toBe('Spot wallet');
    expect(row(wallet.headline, 'Wallet value').value).toBe('$1,075.00');
    expect(row(wallet.headline, 'Wallet capital').note).toBe('deposits and transfers in, less transfers out');
    expect(row(wallet.headline, 'BTC buy-and-hold P&L (whole account)').value).toBe('+$50.00');
    expect(row(wallet.headline, 'BTC buy-and-hold return (whole account)').value).toBe('+5.00%');
  });

  it('shows an incomplete benchmark as such, never its figures', () => {
    const one = statsView(report({ benchmark: { scope: 'account', missing: 1, value: null, pnl: null, returnPct: null, series: [] } }));
    expect(row(one.headline, 'BTC buy-and-hold')).toMatchObject({ value: 'incomplete: 1 deposit has no BTC price', tone: 'muted' });
    expect(one.headline.some((r) => r.label.startsWith('BTC buy-and-hold return'))).toBe(false);
    const two = statsView(report({ benchmark: { scope: 'account', missing: 2, value: null, pnl: null, returnPct: null, series: [] } }));
    expect(row(two.headline, 'BTC buy-and-hold').value).toBe('incomplete: 2 deposits have no BTC price');
  });

  it('labels a coin headline as realised P&L with the unrealised added now', () => {
    const coin = report({ headline: { ...report().headline, scope: { kind: 'coin', symbol: 'BTCUSDT', market: 'perp' } } });
    const v = statsView(coin);
    expect(v.scope).toBe('BTC perp');
    expect(row(v.headline, 'Net P&L').note).toBe('realised P&L; unrealised added now');
    expect(row(v.headline, 'Account value').note).toBe('whole account');
    expect(row(v.risk, 'Max drawdown').note).toBe("on the coin's realised P&L: a dip inside a trade that recovered before closing is not seen");
    // A range that ended in the past has nothing added now.
    const past = statsView(coin, { ...EMPTY_STATS_FILTER, symbol: 'BTCUSDT', to: '2026-11-01' }, at(2026, 11, 11));
    expect(row(past.headline, 'Net P&L').note).toBe('realised P&L only');
    const both = statsView(report({ headline: { ...report().headline, scope: { kind: 'coin', symbol: 'SOLUSDT', market: null } } }));
    expect(both.scope).toBe('SOL, spot and perp');
  });

  it('when data is not live, the headline is as of its last point and the benchmark says it uses the current bid', () => {
    const r = report({ headline: { ...report().headline, live: false } });
    const v = statsView(r);
    expect(v.asOf).toBe(`As of ${fmtDateTime(at(2026, 11, 10, 9, 0))}: prices are not live`);
    expect(row(v.headline, 'BTC buy-and-hold P&L').note).toBe('at the current BTC bid, not as of the time above');
    // With a range, both sides are measured at the same snapshots.
    const ranged = statsView(r, { ...EMPTY_STATS_FILTER, from: '2026-11-09' }, at(2026, 11, 11));
    expect(row(ranged.headline, 'BTC buy-and-hold P&L').note).toBeUndefined();
    expect(statsView(report()).asOf).toBeNull();
    // A coin's curve ends at its last realising event, not a snapshot: no time is given.
    const coin = report({ headline: { ...report().headline, live: false, scope: { kind: 'coin', symbol: 'BTCUSDT', market: null } } });
    expect(statsView(coin).asOf).toBe('Prices are not live; realised P&L as recorded, unrealised left out');
    expect(statsView(report({ series: [], headline: { ...report().headline, live: false } })).asOf).toBe(
      'No value recorded yet: prices are not live',
    );
  });

  it('formats risk: drawdown in dollars and percent, liquidations with their fees, leverage', () => {
    const v = statsView(report());
    expect(row(v.risk, 'Max drawdown')).toMatchObject({ value: '$36.00', tone: 'down' });
    expect(row(v.risk, 'Max drawdown %').value).toBe('3.45%');
    expect(row(v.risk, 'Liquidations').value).toBe('1');
    expect(row(v.risk, 'Lost to liquidations')).toMatchObject({ value: '$148.50', note: 'liquidation fees $8.50 of it' });
    expect(row(v.risk, 'Average leverage').value).toBe('9.25x');
    expect(row(v.risk, 'Highest leverage').value).toBe('20x');
  });

  it('builds one breakdown table per dimension, rows as the engine sent them (empty ones omitted)', () => {
    const v = statsView(report());
    expect(v.breakdowns.tables.map((t) => t.title)).toEqual([
      'Coin',
      'Long or short',
      'Market',
      'Leverage',
      'Hold time',
      'Hour opened',
      'Day opened',
    ]);
    const coin = v.breakdowns.tables[0]!;
    expect(coin.rows).toEqual([
      { label: 'BTC', pnl: '+$21.00', tone: 'up', count: '4', winRate: '75.0%' },
      { label: 'ETH', pnl: '-$36.00', tone: 'down', count: '2', winRate: '0.0%' },
    ]);
    expect(v.breakdowns.tables[2]!.rows.map((r) => r.label)).toEqual(['Spot', 'Perp']);
    expect(v.breakdowns.tables[3]!.rows.map((r) => r.label)).toEqual(['6–10x', 'Spot']);
    expect(v.breakdowns.tables[4]!.rows.map((r) => r.label)).toEqual(['1 h – 1 day']);
    expect(v.breakdowns.tables[5]!.rows.map((r) => r.label)).toEqual(['23:00']);
    expect(v.breakdowns.empty).toBeNull();
  });

  it('shows the open trades, and the lines that only matter when not zero', () => {
    const v = statsView(report({ open: { count: 2, unrealized: '-12.5' } }));
    expect(v.open).toBe('Open: 2, unrealised -$12.50');
    expect(v.unattributed).toBeNull();
    expect(v.uncovered).toBeNull();
    const w = statsView(
      report({ unattributed: { count: 1, realized: '0.42' }, costs: { ...report().costs, uncovered: '0.5' } }),
    );
    expect(w.unattributed).toBe('Realised outside any trade: +$0.42');
    expect(w.uncovered).toBe('Losses the wallet could not cover: $0.50 (counted)');
  });

  it('colours a small return by its sign, not as zero', () => {
    const up = statsView(report({ headline: { ...report().headline, returnPct: '0.004' }, benchmark: { ...report().benchmark, returnPct: '-0.004' } }));
    expect(row(up.headline, 'Return')).toMatchObject({ value: '+0.40%', tone: 'up' });
    expect(row(up.headline, 'BTC buy-and-hold return')).toMatchObject({ value: '-0.40%', tone: 'down' });
  });
});
