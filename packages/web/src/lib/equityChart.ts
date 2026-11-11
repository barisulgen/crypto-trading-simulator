// The equity chart's data (pure): the stats report's curve, capital, benchmark and underwater
// lines as chart points in UTC seconds, the deposit and transfer markers, and the drawdown
// periods to shade. Money becomes a JS number only here, for drawing.
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

/** The time of the first point at or after `t`, else of the last point. */
function snapAfter(times: number[], t: number): number {
  return times.find((x) => x >= t) ?? times.at(-1)!;
}

/** The time of the last point at or before `t`, else of the first point. */
function snapBefore(times: number[], t: number): number {
  return times.findLast((x) => x <= t) ?? times[0]!;
}

/**
 * The equity chart's lines, markers and shading from a stats report. Markers of one kind in the
 * same minute are merged into one with their sum. A marker or shade end that falls between
 * points goes onto the point after it (a shade's start onto the one before), so neither is lost
 * where the line was thinned.
 */
export function chartData(r: ChartInput): ChartData {
  const step = usualStep(r.series);
  const breaks = (before: number, after: number) => breakTimes(before, after, step);
  const value = line(r.series, (p) => p.value, breaks);
  const times = value.flatMap((p) => ('value' in p ? [p.time] : []));
  if (times.length === 0) return { value: [], deposited: [], benchmark: [], underwater: [], markers: [], shades: [] };

  const gapAt = new Set(r.series.filter((p) => p.gap === true).map((p) => p.time));

  const merged: { time: number; kind: MarkerKind; amount: string }[] = [];
  for (const m of r.markers) {
    const same = merged.find((x) => x.kind === m.kind && Math.floor(x.time / MINUTE) === Math.floor(m.time / MINUTE));
    if (same) same.amount = addDec(same.amount, m.amount);
    else merged.push({ time: m.time, kind: m.kind, amount: m.amount });
  }

  return {
    value,
    deposited: line(r.series, (p) => subDec(p.value, p.pnl), breaks),
    benchmark: r.headline.scope.kind === 'account' ? line(r.benchmark.series, (p) => p.value, breaks) : [],
    underwater: line(r.drawdown.underwater, (p) => p.usd, breaks, gapAt),
    markers: merged.map((m) => ({ time: snapAfter(times, seconds(m.time)), kind: m.kind, text: MARKER_TEXT[m.kind](m.amount) })),
    shades: r.drawdown.periods.map((p) => ({
      from: snapBefore(times, seconds(p.start)),
      to: p.end === null ? times.at(-1)! : snapAfter(times, seconds(p.end)),
    })),
  };
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
