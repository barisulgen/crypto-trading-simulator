// The equity chart's data (pure): the stats report's curve, capital, benchmark and underwater
// lines as chart points in UTC seconds, the deposit and transfer markers, and the drawdown
// periods to shade. Money becomes a JS number only here, for drawing.
import type { BaselineData, LineData, Time, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { WireStatsReport } from './api.ts';
import { fmtUsd } from './format.ts';
import { addDec, subDec } from './market.ts';

/** The parts of a stats report the chart draws. */
export type ChartInput = Pick<WireStatsReport, 'series' | 'markers'> & {
  headline: Pick<WireStatsReport['headline'], 'scope'>;
  drawdown: Pick<WireStatsReport['drawdown'], 'underwater' | 'periods'>;
  benchmark: Pick<WireStatsReport['benchmark'], 'series'>;
};

/**
 * A point of a line, or a time alone where the line breaks. Times are UTC seconds. `breakAfter`:
 * the line must not be drawn from this point to the next (the chart joins its points across
 * times with no value, so the segment itself has to be hidden).
 */
export type ChartPoint = { time: number; value: number; breakAfter?: true } | { time: number };

export type MarkerKind = WireStatsReport['markers'][number]['kind'];

export interface ChartMarker {
  /** The first point of the value line that shows the money moved. */
  time: number;
  kind: MarkerKind;
  text: string;
}

/** A drawdown period, from its peak to its recovery or the last point, on the value line's times. */
export interface ChartShade {
  from: number;
  to: number;
}

export interface ChartData {
  value: ChartPoint[];
  /** What was put in at each point (value minus P&L): steps with each deposit or transfer. */
  deposited: ChartPoint[];
  /** Beside the whole account only (it is the account's own measure); else empty. */
  benchmark: ChartPoint[];
  /** P&L below its running peak: zero or negative. */
  underwater: ChartPoint[];
  markers: ChartMarker[];
  shades: ChartShade[];
  /** Deposits or transfers after the last point, which the curve cannot show; null when none. */
  offCurve: string | null;
}

type Scope = WireStatsReport['headline']['scope'];

const MINUTE = 60_000;
/** The most breaks one hole gets, so a long outage cannot squeeze the curve into a corner. */
const MAX_BREAKS = 300;

const seconds = (ms: number) => Math.floor(ms / 1000);

/** The usual time between the series' points (the median step, seconds); null with fewer than two. */
function usualStep(points: { time: number }[]): number | null {
  const steps = points
    .slice(1)
    .map((p, i) => seconds(p.time) - seconds(points[i]!.time))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  return steps.length === 0 ? null : steps[Math.floor(steps.length / 2)]!;
}

/**
 * The times with no value that break a line between two points (seconds) where data was
 * interrupted: one per usual step missing, at least one, so the chart's even bar spacing still
 * shows how long the hole was.
 */
function breakTimes(before: number, after: number, step: number | null): number[] {
  const span = after - before;
  const count = Math.min(Math.max(step === null ? 1 : Math.round(span / step) - 1, 1), MAX_BREAKS, span - 1);
  return Array.from({ length: count }, (_, k) => before + Math.round(((k + 1) * span) / (count + 1)));
}

/**
 * A line in chart seconds: one point per second (the last of it), and breaks (times with no value)
 * before each point marked `gap`, the point before them marked `breakAfter`, so the line is never
 * drawn across missing data.
 */
function line<P extends { time: number; gap?: true }>(
  points: P[],
  value: (p: P) => string,
  breaks: (before: number, after: number) => number[],
  gapAt?: Set<number>,
): ChartPoint[] {
  const out: ChartPoint[] = [];
  let last: number | null = null;
  for (const p of points) {
    const time = seconds(p.time);
    const gap = p.gap === true || gapAt?.has(p.time) === true;
    if (last !== null && time === last) out.pop();
    else if (last !== null && gap) {
      out[out.length - 1] = { ...out.at(-1)!, breakAfter: true };
      out.push(...breaks(last, time).map((t) => ({ time: t })));
    }
    out.push({ time, value: Number(value(p)) });
    last = time;
  }
  return out;
}

/** '+$1,000' for whole dollars, '+$1,200.50' otherwise; '-$300' with `negative`. */
function markerUsd(amount: string, negative: boolean): string {
  const text = fmtUsd(negative ? `-${amount}` : amount, { sign: true });
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

const MARKER_TEXT: Record<MarkerKind, (amount: string) => string> = {
  deposit: (a) => markerUsd(a, false),
  transfer_in: (a) => `⇢ ${markerUsd(a, false)}`,
  transfer_out: (a) => `⇠ ${markerUsd(a, true)}`,
};

/**
 * The chart second of the first point at or after `ms` (compared to the millisecond, so a point
 * in the same second but before `ms` does not count), else of the last point.
 */
function snapAfter(points: { time: number }[], ms: number): number {
  return seconds((points.find((p) => p.time >= ms) ?? points.at(-1)!).time);
}

type Point = WireStatsReport['series'][number];
type Underwater = WireStatsReport['drawdown']['underwater'][number];

/**
 * A coin's curve with a point at each deposit. The coin's series only has points where the coin
 * realised P&L, so a deposit would otherwise show up as part of the next trade's step. Each
 * deposit gets a point at its own time: the P&L (and how far below its peak) as at the point
 * before, the value raised by the amount. A deposit at the time of a point is already in it.
 */
function withDeposits(
  series: Point[],
  underwater: Underwater[],
  markers: ChartInput['markers'],
): { series: Point[]; underwater: Underwater[] } {
  const deposits = markers.filter((m) => m.kind === 'deposit').sort((a, b) => a.time - b.time);
  const outSeries: Point[] = [];
  const outUnder: Underwater[] = [];
  let next = 0;
  const addBefore = (time: number) => {
    for (; next < deposits.length && deposits[next]!.time < time; next++) {
      const d = deposits[next]!;
      const prev = outSeries.at(-1);
      if (!prev || prev.time === d.time) continue;
      outSeries.push({ time: d.time, pnl: prev.pnl, value: addDec(prev.value, d.amount) });
      outUnder.push({ time: d.time, usd: outUnder.at(-1)?.usd ?? '0' });
    }
  };
  series.forEach((p, i) => {
    addBefore(p.time);
    // A deposit at exactly this time is counted in its value.
    while (next < deposits.length && deposits[next]!.time === p.time) next++;
    outSeries.push(p);
    const u = underwater[i];
    if (u) outUnder.push(u);
  });
  addBefore(Infinity);
  return { series: outSeries, underwater: outUnder };
}

/** '1 deposit after the last point is not on the curve', or null. */
function offCurveNote(deposits: number, transfers: number): string | null {
  const part = (n: number, noun: string) => (n === 0 ? null : `${n} ${noun}${n === 1 ? '' : 's'}`);
  const parts = [part(deposits, 'deposit'), part(transfers, 'transfer')].filter((x) => x !== null);
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} after the last point ${deposits + transfers === 1 ? 'is' : 'are'} not on the curve`;
}

/** The chart second of the last point at or before `ms` (to the millisecond), else of the first point. */
function snapBefore(points: { time: number }[], ms: number): number {
  return seconds((points.findLast((p) => p.time <= ms) ?? points[0]!).time);
}

/**
 * The equity chart's lines, markers and shading from a stats report. Markers of one kind in the
 * same minute are merged into one with their sum. A marker or shade end that falls between
 * points goes onto the first point at or after it, to the millisecond, so the point really
 * includes the money (a shade's start onto the last point at or before it), and neither is lost
 * where the line was thinned.
 */
export function chartData(r: ChartInput): ChartData {
  const { series, underwater } =
    r.headline.scope.kind === 'coin'
      ? withDeposits(r.series, r.drawdown.underwater, r.markers)
      : { series: r.series, underwater: r.drawdown.underwater };
  const step = usualStep(series);
  const breaks = (before: number, after: number) => breakTimes(before, after, step);
  const value = line(series, (p) => p.value, breaks);
  const times = value.flatMap((p) => ('value' in p ? [p.time] : []));
  if (times.length === 0) {
    return { value: [], deposited: [], benchmark: [], underwater: [], markers: [], shades: [], offCurve: null };
  }

  const gapAt = new Set(series.filter((p) => p.gap === true).map((p) => p.time));

  // Money moved after the last point has no point to show it: it stays off the curve.
  const last = times.at(-1)!;
  const onCurve = r.markers.filter((m) => seconds(m.time) <= last);
  const after = r.markers.filter((m) => seconds(m.time) > last);
  const afterDeposits = after.filter((m) => m.kind === 'deposit').length;

  // One marker per kind and minute, on the first point that shows all of it.
  const merged: { time: number; kind: MarkerKind; amount: string }[] = [];
  for (const m of onCurve) {
    const same = merged.find((x) => x.kind === m.kind && Math.floor(x.time / MINUTE) === Math.floor(m.time / MINUTE));
    if (same) {
      same.amount = addDec(same.amount, m.amount);
      same.time = Math.max(same.time, m.time);
    } else merged.push({ time: m.time, kind: m.kind, amount: m.amount });
  }

  return {
    value,
    deposited: line(series, (p) => subDec(p.value, p.pnl), breaks),
    benchmark: r.headline.scope.kind === 'account' ? line(r.benchmark.series, (p) => p.value, breaks) : [],
    underwater: line(underwater, (p) => p.usd, breaks, gapAt),
    markers: merged.map((m) => ({ time: snapAfter(series, m.time), kind: m.kind, text: MARKER_TEXT[m.kind](m.amount) })),
    shades: r.drawdown.periods.map((p) => ({
      from: snapBefore(series, p.start),
      to: p.end === null ? times.at(-1)! : snapAfter(series, p.end),
    })),
    offCurve: offCurveNote(afterDeposits, after.length - afterDeposits),
  };
}

const NONE = 'transparent';

/** A line's points for the chart; the segment after a point marked `breakAfter` in no colour. */
export function linePoints(points: ChartPoint[]): (LineData<Time> | WhitespaceData<Time>)[] {
  return points.map((p) => {
    const time = p.time as UTCTimestamp;
    return 'value' in p ? { time, value: p.value, ...(p.breakAfter ? { color: NONE } : {}) } : { time };
  });
}

const HIDDEN_BASELINE = {
  topLineColor: NONE,
  topFillColor1: NONE,
  topFillColor2: NONE,
  bottomLineColor: NONE,
  bottomFillColor1: NONE,
  bottomFillColor2: NONE,
};

/** The underwater line's points for the chart; line and fill after a `breakAfter` point in no colour. */
export function baselinePoints(points: ChartPoint[]): (BaselineData<Time> | WhitespaceData<Time>)[] {
  return points.map((p) => {
    const time = p.time as UTCTimestamp;
    return 'value' in p ? { time, value: p.value, ...(p.breakAfter ? HIDDEN_BASELINE : {}) } : { time };
  });
}

/**
 * The empty bars to leave before the first point and after the last so that `roomPx` pixels
 * (half the widest marker label) fit there, for `points` points over `widthPx` pixels. When the
 * chart is too narrow for that, as much room as the curve itself.
 */
export function edgeRoom(points: number, widthPx: number, roomPx: number): number {
  const span = Math.max(points - 1, 1);
  return widthPx > 2 * roomPx ? (roomPx * span) / (widthPx - 2 * roomPx) : span;
}

const coinOf = (scope: Extract<Scope, { kind: 'coin' }>) =>
  `${scope.symbol.replace(/USDT$/, '')}${scope.market === null ? '' : ` ${scope.market}`}`;

/**
 * What the curve follows, said inside the chart. `unrealisedAdded`: a coin's last point includes
 * what it holds now (the same test the headline uses, so the two agree).
 */
export function chartCaption(scope: Scope, unrealisedAdded: boolean): string {
  if (scope.kind === 'account') return 'Account value';
  if (scope.kind === 'wallet') return scope.wallet === 'spot' ? 'Spot wallet value' : 'Leverage wallet value';
  return unrealisedAdded
    ? `${coinOf(scope)} realised P&L (on top of deposits); unrealised added now`
    : `${coinOf(scope)} realised P&L only (on top of deposits)`;
}

/** The legend's names for the lines drawn; `benchmark` null when that line is not. */
export function chartLegend(scope: Scope, benchmark: boolean): { value: string; deposited: string; benchmark: string | null } {
  return {
    value: scope.kind === 'coin' ? 'Deposits + realised P&L' : 'Value',
    deposited: scope.kind === 'wallet' ? 'Capital (deposits and transfers)' : 'Deposited',
    benchmark: benchmark ? 'BTC buy and hold' : null,
  };
}
