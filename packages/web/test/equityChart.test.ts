import { describe, expect, it } from 'vitest';
import type { WireStatsReport } from '../src/lib/api.ts';
import { baselinePoints, chartCaption, chartData, chartLegend, edgeRoom, linePoints } from '../src/lib/equityChart.ts';
import type { ChartInput, ChartPoint } from '../src/lib/equityChart.ts';

const T0 = Date.UTC(2026, 10, 9, 9, 0);
const MIN = 60_000;
const t = (n: number) => T0 + n * MIN;
/** Chart time: UTC seconds. */
const s = (ms: number) => Math.floor(ms / 1000);

type Marker = WireStatsReport['markers'][number];
const deposit = (time: number, amount: string): Marker => ({ time, kind: 'deposit', amount, wallet: 'spot' });

function input(over: Partial<ChartInput> = {}): ChartInput {
  return {
    headline: { scope: { kind: 'account' } },
    series: [],
    markers: [],
    drawdown: { underwater: [], periods: [] },
    benchmark: { series: [] },
    ...over,
  };
}

const values = (line: ChartPoint[]) => line.map((p) => ('value' in p ? p.value : null));
const times = (line: ChartPoint[]) => line.map((p) => p.time);

describe('equity chart data', () => {
  // Deposit 1000 at t0; total / deposited per snapshot: t1 1000/1000, t2 1250/1000 (peak),
  // t3 1000/1000; a second 1000 deposited just before t4; t4 1900/2000, t5 2400/2000, t6 2280/2000.
  const account = input({
    series: [
      { time: t(0), pnl: '0', value: '1000' },
      { time: t(1), pnl: '0', value: '1000' },
      { time: t(2), pnl: '250', value: '1250' },
      { time: t(3), pnl: '0', value: '1000' },
      { time: t(4), pnl: '-100', value: '1900' },
      { time: t(5), pnl: '400', value: '2400' },
      { time: t(6), pnl: '280', value: '2280' },
    ],
    markers: [deposit(t(0), '1000'), deposit(t(4) - 1, '1000')],
    drawdown: {
      underwater: [0, 1, 2, 3, 4, 5, 6].map((n, i) => ({ time: t(n), usd: ['0', '0', '0', '-250', '-350', '0', '-120'][i]! })),
      periods: [
        { start: t(2), trough: t(4), end: t(5), depthUsd: '350', depthPct: '0.28' },
        { start: t(5), trough: t(6), end: null, depthUsd: '120', depthPct: '0.05' },
      ],
    },
  });

  it('draws the account rows: deposits marked, drawdowns shaded, the t4 deposit not a gain', () => {
    const d = chartData(account);
    expect(times(d.value)).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => s(t(n))));
    expect(values(d.value)).toEqual([1000, 1000, 1250, 1000, 1900, 2400, 2280]);
    // Deposited = value - P&L at each point: it steps up with the second deposit.
    expect(values(d.deposited)).toEqual([1000, 1000, 1000, 1000, 2000, 2000, 2000]);
    expect(d.benchmark).toEqual([]);

    // Each deposit sits on the first point that shows it.
    expect(d.markers).toEqual([
      { time: s(t(0)), kind: 'deposit', text: '+$1,000' },
      { time: s(t(4)), kind: 'deposit', text: '+$1,000' },
    ]);
    // The value rose past the old peak at t4, but it is below what was deposited: a loss.
    const at4 = 4;
    expect(values(d.value)[at4]!).toBeGreaterThan(1250);
    expect(values(d.value)[at4]!).toBeLessThan(values(d.deposited)[at4]!);

    expect(d.shades).toEqual([
      { from: s(t(2)), to: s(t(5)) },
      { from: s(t(5)), to: s(t(6)) },
    ]);
    expect(values(d.underwater)).toEqual([0, 0, 0, -250, -350, 0, -120]);
    expect(Math.min(...values(d.underwater).map(Number))).toBe(-350);
  });

  it('breaks every line with a whitespace point where data was interrupted', () => {
    const d = chartData(
      input({
        series: [
          { time: t(0), pnl: '0', value: '1000' },
          { time: t(5), pnl: '10', value: '1010' },
          // 10 minutes without a snapshot.
          { time: t(15), pnl: '-5', value: '995', gap: true },
          { time: t(20), pnl: '0', value: '1000' },
        ],
        drawdown: {
          underwater: [
            { time: t(0), usd: '0' },
            { time: t(5), usd: '0' },
            { time: t(15), usd: '-15' },
            { time: t(20), usd: '-10' },
          ],
          periods: [],
        },
        benchmark: {
          series: [
            { time: t(0), value: '1000' },
            { time: t(5), value: '1001' },
            { time: t(15), value: '1003', gap: true },
            { time: t(20), value: '1004' },
          ],
        },
      }),
    );
    // One 5-minute step is missing: one break, where it would have been.
    const hole = [s(t(0)), s(t(5)), s(t(10)), s(t(15)), s(t(20))];
    for (const line of [d.value, d.deposited, d.benchmark, d.underwater]) {
      expect(times(line)).toEqual(hole);
      expect(line[2]).toEqual({ time: s(t(10)) });
      // The chart joins points across a time with no value: the segment into the hole is hidden.
      expect(line.map((p) => 'breakAfter' in p)).toEqual([false, true, false, false, false]);
    }
    expect(values(d.value)).toEqual([1000, 1010, null, 995, 1000]);
    expect(values(d.benchmark)).toEqual([1000, 1001, null, 1003, 1004]);
    expect(values(d.underwater)).toEqual([0, 0, null, -15, -10]);
  });

  it('breaks a longer hole once per usual step missing, so its width shows how long it was', () => {
    const series = [0, 5, 10, 15, 105, 110].map((n) => ({ time: t(n), pnl: '0', value: '1000', ...(n === 105 ? { gap: true as const } : {}) }));
    const d = chartData(input({ series }));
    // 90 minutes from t15 to t105 at a usual step of 5: 17 steps missing.
    const breaks = d.value.filter((p) => !('value' in p));
    expect(breaks.map((p) => p.time)).toEqual(Array.from({ length: 17 }, (_, k) => s(t(15 + 5 * (k + 1)))));
    expect(times(d.value)).toEqual([...times(d.value)].sort((a, b) => a - b));
    // Always at least one, however sparse the line.
    const sparse = chartData(input({ series: [series[0]!, { ...series[4]!, gap: true }] }));
    expect(sparse.value.filter((p) => !('value' in p))).toHaveLength(1);
  });

  it('draws the BTC benchmark beside the whole account only', () => {
    const rows = {
      series: [
        { time: t(0), pnl: '0', value: '1000' },
        { time: t(5), pnl: '10', value: '1010' },
      ],
      benchmark: {
        series: [
          { time: t(0), value: '1000' },
          { time: t(5), value: '1020' },
        ],
      },
    };
    expect(values(chartData(input(rows)).benchmark)).toEqual([1000, 1020]);
    for (const scope of [
      { kind: 'wallet', wallet: 'spot' },
      { kind: 'coin', symbol: 'BTCUSDT', market: null },
    ] as const) {
      expect(chartData(input({ ...rows, headline: { scope } })).benchmark).toEqual([]);
    }
  });

  it('merges deposits of the same minute into one marker reading the sum', () => {
    const d = chartData(
      input({
        series: [
          { time: t(0), pnl: '0', value: '0' },
          { time: t(1), pnl: '0', value: '1200.5' },
          { time: t(2), pnl: '0', value: '1500.5' },
        ],
        markers: [deposit(t(0) + 10_000, '500'), deposit(t(0) + 40_000, '700.5'), deposit(t(1) + 5_000, '300')],
      }),
    );
    expect(d.markers).toEqual([
      { time: s(t(1)), kind: 'deposit', text: '+$1,200.50' },
      { time: s(t(2)), kind: 'deposit', text: '+$300' },
    ]);
  });

  it('puts a merged marker at or after the last deposit of its minute, not on a point before it', () => {
    const d = chartData(
      input({
        series: [
          { time: t(0), pnl: '0', value: '0' },
          { time: t(0) + 20_000, pnl: '0', value: '500' },
          { time: t(1), pnl: '0', value: '1200' },
        ],
        markers: [deposit(t(0) + 10_000, '500'), deposit(t(0) + 40_000, '700')],
      }),
    );
    expect(d.markers).toEqual([{ time: s(t(1)), kind: 'deposit', text: '+$1,200' }]);
  });

  describe('markers to the millisecond', () => {
    const base = Date.UTC(2026, 10, 9, 12, 5, 28);

    it('puts two deposits 30 ms apart on the point that holds both, not the earlier one in the same second', () => {
      const d = chartData(
        input({
          series: [
            { time: base + 25, pnl: '0', value: '300' },
            { time: base + 27_000, pnl: '0', value: '600' },
          ],
          markers: [deposit(base + 25, '300'), { time: base + 55, kind: 'deposit', amount: '300', wallet: 'leverage' }],
        }),
      );
      expect(d.markers).toEqual([{ time: s(base + 27_000), kind: 'deposit', text: '+$600' }]);
    });

    it('keeps a deposit exactly at a point on that point', () => {
      const d = chartData(
        input({
          series: [
            { time: base + 25, pnl: '0', value: '300' },
            { time: base + 27_000, pnl: '0', value: '600' },
          ],
          markers: [deposit(base + 25, '300')],
        }),
      );
      expect(d.markers).toEqual([{ time: s(base), kind: 'deposit', text: '+$300' }]);
    });

    it('keeps a deposit on its own second when a later point of that second already includes it', () => {
      const d = chartData(
        input({
          series: [
            { time: base - 5_000, pnl: '0', value: '0' },
            { time: base + 800, pnl: '0', value: '300' },
            { time: base + 27_000, pnl: '0', value: '300' },
          ],
          markers: [deposit(base + 100, '300')],
        }),
      );
      expect(d.markers).toEqual([{ time: s(base), kind: 'deposit', text: '+$300' }]);
    });

    it('ends a shade on the first point at or after its end, to the millisecond', () => {
      const d = chartData(
        input({
          series: [
            { time: base - 10_000, pnl: '0', value: '100' },
            { time: base + 25, pnl: '-5', value: '95' },
            { time: base + 27_000, pnl: '0', value: '100' },
          ],
          drawdown: {
            underwater: [],
            periods: [{ start: base - 10_000, trough: base + 25, end: base + 55, depthUsd: '5', depthPct: '0.05' }],
          },
        }),
      );
      expect(d.shades).toEqual([{ from: s(base - 10_000), to: s(base + 27_000) }]);
    });
  });

  describe('under a coin filter', () => {
    const coin = { headline: { scope: { kind: 'coin', symbol: 'BTCUSDT', market: null } as const } };
    // Deposits 1000 at t0 and 500 at t20; BTC trades realise +50 at t10 and -20 at t30.
    const rows = input({
      ...coin,
      series: [
        { time: t(0), pnl: '0', value: '1000' },
        { time: t(10), pnl: '50', value: '1050' },
        { time: t(30), pnl: '30', value: '1530' },
      ],
      markers: [deposit(t(0), '1000'), deposit(t(20), '500')],
      drawdown: {
        underwater: [
          { time: t(0), usd: '0' },
          { time: t(10), usd: '0' },
          { time: t(30), usd: '-20' },
        ],
        periods: [],
      },
    });

    it('shows a deposit at its own time, and the next trade as only its own P&L', () => {
      const d = chartData(rows);
      expect(times(d.value)).toEqual([t(0), t(10), t(20), t(30)].map(s));
      expect(values(d.value)).toEqual([1000, 1050, 1550, 1530]);
      expect(values(d.deposited)).toEqual([1000, 1000, 1500, 1500]);
      expect(values(d.underwater)).toEqual([0, 0, 0, -20]);
      // The first deposit is already in the origin point: not added twice.
      expect(d.markers).toEqual([
        { time: s(t(0)), kind: 'deposit', text: '+$1,000' },
        { time: s(t(20)), kind: 'deposit', text: '+$500' },
      ]);
    });

    it('shows a deposit after the last trade on the curve too', () => {
      const d = chartData({ ...rows, markers: [...rows.markers, deposit(t(40), '200')] });
      expect(values(d.value)).toEqual([1000, 1050, 1550, 1530, 1730]);
      expect(d.markers.at(-1)).toEqual({ time: s(t(40)), kind: 'deposit', text: '+$200' });
      expect(d.offCurve).toBeNull();
    });
  });

  it('leaves a deposit after the last point off the curve and says so', () => {
    const series = [
      { time: t(0), pnl: '0', value: '1000' },
      { time: t(5), pnl: '10', value: '1010' },
    ];
    const one = chartData(input({ series, markers: [deposit(t(0), '1000'), deposit(t(7), '300')] }));
    expect(one.markers).toEqual([{ time: s(t(0)), kind: 'deposit', text: '+$1,000' }]);
    expect(one.offCurve).toBe('1 deposit after the last point is not on the curve');
    const two = chartData(input({ series, markers: [deposit(t(7), '300'), deposit(t(9), '300')] }));
    expect(two.markers).toEqual([]);
    expect(two.offCurve).toBe('2 deposits after the last point are not on the curve');
    expect(chartData(input({ series })).offCurve).toBeNull();
  });

  it('labels transfers in and out of a wallet, merged per minute and kind', () => {
    const transfer = (time: number, kind: 'transfer_in' | 'transfer_out', amount: string): Marker => ({
      time,
      kind,
      amount,
      wallet: 'leverage',
    });
    const d = chartData(
      input({
        series: [
          { time: t(0), pnl: '0', value: '400' },
          { time: t(1), pnl: '0', value: '100' },
        ],
        markers: [transfer(t(0), 'transfer_in', '400'), transfer(t(1) - 2_000, 'transfer_out', '100'), transfer(t(1) - 1_000, 'transfer_out', '200')],
      }),
    );
    expect(d.markers).toEqual([
      { time: s(t(0)), kind: 'transfer_in', text: '⇢ +$400' },
      { time: s(t(1)), kind: 'transfer_out', text: '⇠ -$300' },
    ]);
  });

  it('keeps one point per second, the last, so chart times only ever rise', () => {
    const d = chartData(
      input({
        series: [
          { time: t(0), pnl: '0', value: '1000' },
          { time: t(1), pnl: '5', value: '1005' },
          { time: t(1) + 400, pnl: '-20', value: '980' },
        ],
      }),
    );
    expect(times(d.value)).toEqual([s(t(0)), s(t(1))]);
    expect(values(d.value)).toEqual([1000, 980]);
  });

  it('snaps a shade whose ends were thinned away onto the points around it', () => {
    const d = chartData(
      input({
        series: [
          { time: t(0), pnl: '0', value: '1000' },
          { time: t(10), pnl: '-50', value: '950' },
          { time: t(20), pnl: '10', value: '1010' },
        ],
        drawdown: { underwater: [], periods: [{ start: t(3), trough: t(10), end: t(15), depthUsd: '50', depthPct: '0.05' }] },
      }),
    );
    expect(d.shades).toEqual([{ from: s(t(0)), to: s(t(20)) }]);
  });

  it('has nothing to draw without points', () => {
    expect(chartData(input())).toEqual({
      value: [],
      deposited: [],
      benchmark: [],
      underwater: [],
      markers: [],
      shades: [],
      offCurve: null,
    });
  });
});

describe('equity chart labels', () => {
  it('names the scope the curve follows', () => {
    expect(chartCaption({ kind: 'account' }, false)).toBe('Account value');
    expect(chartCaption({ kind: 'wallet', wallet: 'spot' }, false)).toBe('Spot wallet value');
    expect(chartCaption({ kind: 'wallet', wallet: 'leverage' }, true)).toBe('Leverage wallet value');
    expect(chartCaption({ kind: 'coin', symbol: 'BTCUSDT', market: null }, true)).toBe(
      'BTC realised P&L (on top of deposits); unrealised added now',
    );
    expect(chartCaption({ kind: 'coin', symbol: 'BTCUSDT', market: null }, false)).toBe(
      'BTC realised P&L only (on top of deposits)',
    );
    expect(chartCaption({ kind: 'coin', symbol: 'SOLUSDT', market: 'perp' }, false)).toBe(
      'SOL perp realised P&L only (on top of deposits)',
    );
  });

  it('lists the lines drawn, the benchmark only when it is', () => {
    expect(chartLegend({ kind: 'account' }, true)).toEqual({ value: 'Value', deposited: 'Deposited', benchmark: 'BTC buy and hold' });
    expect(chartLegend({ kind: 'account' }, false)).toEqual({ value: 'Value', deposited: 'Deposited', benchmark: null });
    expect(chartLegend({ kind: 'wallet', wallet: 'spot' }, false)).toEqual({
      value: 'Value',
      deposited: 'Capital (deposits and transfers)',
      benchmark: null,
    });
    expect(chartLegend({ kind: 'coin', symbol: 'BTCUSDT', market: null }, false)).toEqual({
      value: 'Deposits + realised P&L',
      deposited: 'Deposited',
      benchmark: null,
    });
  });
});

describe('equity chart drawing', () => {
  const line: ChartPoint[] = [{ time: 1, value: 2, breakAfter: true }, { time: 3 }, { time: 5, value: 4 }];

  it('hides the segment after a break, as the chart joins points across a time with no value', () => {
    expect(linePoints(line)).toEqual([{ time: 1, value: 2, color: 'transparent' }, { time: 3 }, { time: 5, value: 4 }]);
    const hidden = {
      topLineColor: 'transparent',
      topFillColor1: 'transparent',
      topFillColor2: 'transparent',
      bottomLineColor: 'transparent',
      bottomFillColor1: 'transparent',
      bottomFillColor2: 'transparent',
    };
    expect(baselinePoints(line)).toEqual([{ time: 1, value: 2, ...hidden }, { time: 3 }, { time: 5, value: 4 }]);
  });

  it('leaves room at each end, in bars, as wide as the widest label needs', () => {
    // 101 points over 400 px with 50 px of room each side: 100 + 2r bars, r bars = 50 px.
    const r = edgeRoom(101, 400, 50);
    expect(r).toBeCloseTo((50 * 100) / 300, 6);
    expect((r * 400) / (100 + 2 * r)).toBeCloseTo(50, 6);
    // Too narrow to fit the room at all: still a finite, generous room.
    expect(Number.isFinite(edgeRoom(101, 90, 50))).toBe(true);
    expect(edgeRoom(101, 90, 50)).toBeGreaterThanOrEqual(100);
  });
});
