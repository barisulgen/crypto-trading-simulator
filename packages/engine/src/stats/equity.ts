import { D, type Decimal } from '../decimal.ts';
import type { SimEvent } from '../sim.ts';
import type { Market, Wallet } from '../types.ts';
import type { StatsEvent } from './types.ts';

/** One recorded equity snapshot: the account's value, its wallets and what was deposited so far. */
export interface Snapshot {
  time: number;
  total: Decimal;
  deposited: Decimal;
  spotValue: Decimal;
  leverageValue: Decimal;
  btcBid: Decimal | null;
}

/** What a P&L series covers: the whole account, one wallet, or one coin (in one market or both). */
export type Scope =
  | { kind: 'account' }
  | { kind: 'wallet'; wallet: Wallet }
  | { kind: 'coin'; symbol: string; market: Market | null };

/** A moment of a P&L series: the P&L so far and the scope's value then. */
export interface PnlPoint {
  time: number;
  pnl: Decimal;
  value: Decimal;
}

export interface DrawdownPeriod {
  /** The time of the peak the period fell from. */
  start: number;
  /** The time of the lowest point. */
  trough: number;
  /** The first time the P&L was back at or above the peak; null when it has not recovered. */
  end: number | null;
  depthUsd: Decimal;
  /** A fraction of the value at the peak; null when that value is not above zero. */
  depthPct: Decimal | null;
}

export interface Drawdown {
  maxUsd: Decimal;
  /** A fraction; null when no point had a positive value at its peak. */
  maxPct: Decimal | null;
  /** Dips of at least 1 % of the value at their peak (any dip when that value is not above zero). */
  periods: DrawdownPeriod[];
  /** Every point's P&L below its running peak: zero or negative. */
  underwater: { time: number; usd: Decimal }[];
}

export interface RangePnl {
  pnl: Decimal;
  /** The highest capital of the scope during the range. */
  capitalMax: Decimal;
  /** A fraction of capitalMax; null when capitalMax is not above zero. */
  returnPct: Decimal | null;
}

const MIN_PERIOD_DEPTH = D('0.01');

const byTimeThenId = (a: StatsEvent, b: StatsEvent) => a.time - b.time || a.id - b.id;

/**
 * How an event changes the scope's capital, or null when it does not. The account (and a coin)
 * counts deposits only; a wallet counts deposits into it and transfers in and out.
 */
function capitalChange(e: SimEvent, scope: Scope): Decimal | null {
  if (e.type === 'deposit') {
    if (scope.kind === 'wallet' && e.wallet !== scope.wallet) return null;
    return e.amount;
  }
  if (e.type === 'transfer' && scope.kind === 'wallet') {
    if (e.to === scope.wallet) return e.amount;
    if (e.from === scope.wallet) return e.amount.neg();
  }
  return null;
}

/** The scope's capital after each moment it changed, ascending by time, one step per moment. */
function capitalSteps(events: StatsEvent[], scope: Scope): { time: number; capital: Decimal }[] {
  const steps: { time: number; capital: Decimal }[] = [];
  let capital = D(0);
  for (const row of [...events].sort(byTimeThenId)) {
    const change = capitalChange(row.event, scope);
    if (change === null) continue;
    capital = capital.plus(change);
    const last = steps.at(-1);
    if (last && last.time === row.time) last.capital = capital;
    else steps.push({ time: row.time, capital });
  }
  return steps;
}

/** Walks capital steps forward in time: each call must ask for a time no earlier than the last. */
function capitalCursor(steps: { time: number; capital: Decimal }[]): (t: number) => Decimal {
  let i = 0;
  let capital = D(0);
  return (t) => {
    while (i < steps.length && steps[i]!.time <= t) {
      capital = steps[i]!.capital;
      i += 1;
    }
    return capital;
  };
}

/**
 * The scope's capital at `t`, counting events at exactly `t`: total deposited for the account and
 * for a coin; for a wallet, the deposits into it plus the transfers in, minus the transfers out.
 */
export function capitalAt(events: StatsEvent[], scope: Scope, t: number): Decimal {
  return capitalCursor(capitalSteps(events, scope))(t);
}

/** What one event realised on the coin, or null when it is not one of the coin's realising events. */
function coinRealised(e: SimEvent, symbol: string, market: Market | null): Decimal | null {
  const perp = 'market' in e && e.market === 'perp';
  if (market !== null && (market === 'perp') !== perp) return null;
  if (e.type === 'fill') {
    if (e.fill.symbol !== symbol) return null;
    if (e.market === 'perp') return (e.fill.realizedPnl ?? D(0)).minus(e.fill.fee);
    return e.fill.side === 'sell' ? (e.fill.realizedPnl ?? D(0)) : null;
  }
  if (e.type === 'funding') return e.symbol === symbol ? e.amount : null;
  if (e.type === 'liquidation') {
    return e.symbol === symbol ? e.tradingLoss.plus(e.remainder).plus(e.liquidationFee).neg() : null;
  }
  return null;
}

/** Every point of the scope's series, ascending by time, before any range is applied. */
function allPoints(events: StatsEvent[], snapshots: Snapshot[], scope: Scope): PnlPoint[] {
  if (scope.kind === 'coin') {
    const deposited = capitalCursor(capitalSteps(events, { kind: 'account' }));
    const points: PnlPoint[] = [];
    let pnl = D(0);
    for (const row of [...events].sort(byTimeThenId)) {
      const realised = coinRealised(row.event, scope.symbol, scope.market);
      if (realised === null) continue;
      pnl = pnl.plus(realised);
      points.push({ time: row.time, pnl, value: deposited(row.time).plus(pnl) });
    }
    return points;
  }
  const ordered = [...snapshots].sort((a, b) => a.time - b.time);
  if (scope.kind === 'account') {
    return ordered.map((s) => ({ time: s.time, pnl: s.total.minus(s.deposited), value: s.total }));
  }
  const capital = capitalCursor(capitalSteps(events, scope));
  return ordered.map((s) => {
    const value = scope.wallet === 'spot' ? s.spotValue : s.leverageValue;
    return { time: s.time, pnl: value.minus(capital(s.time)), value };
  });
}

/**
 * The scope's P&L over time. The account's P&L is its value minus what was deposited, so a deposit
 * never moves it; a wallet's is its value minus its capital; a coin's is what its trades, funding
 * and liquidations realised, cumulatively, valued against the account's deposits.
 *
 * Without `from` the series starts at a zero origin, at the scope's first deposit or transfer (or
 * its first point, whichever is earlier), valued at the capital then. With `from` set it starts at
 * the last point at or before `from` (at that point's own time), or, when there is none, at a zero
 * point at `from` valued at the capital then. When the scope has no capital at `from` either, it
 * starts as without `from`: at the first capital step after `from` (or the first point in range,
 * whichever is earlier), so no point is valued at zero before the money arrives. Then come the
 * points after `from` up to `to`.
 * The live point, when given, closes the series if the range reaches it.
 */
export function pnlSeries(
  input: { events: StatsEvent[]; snapshots: Snapshot[]; live: PnlPoint | null },
  scope: Scope,
  from: number | null,
  to: number | null,
): PnlPoint[] {
  const points = allPoints(input.events, input.snapshots, scope);
  const inRange = points.filter((p) => (from === null || p.time > from) && (to === null || p.time <= to));
  const steps = capitalSteps(input.events, scope);
  const capitalThen = (t: number) => capitalCursor(steps)(t);
  const series: PnlPoint[] = [];
  const before = from === null ? undefined : points.filter((p) => p.time <= from).at(-1);
  if (before) series.push(before);
  else if (from !== null && capitalThen(from).gt(0)) series.push({ time: from, pnl: D(0), value: capitalThen(from) });
  else {
    // No point to start from and no capital yet: the series opens where the money first arrives.
    const starts: number[] = [];
    const firstCapital = steps.find((s) => from === null || s.time > from);
    if (firstCapital && (to === null || firstCapital.time <= to)) starts.push(firstCapital.time);
    const firstPoint = inRange[0];
    if (firstPoint) starts.push(firstPoint.time);
    if (starts.length > 0) {
      const origin = Math.min(...starts);
      series.push({ time: origin, pnl: D(0), value: capitalThen(origin) });
    }
  }
  // A loop, not push(...inRange): spreading a year of snapshots into one call overflows the stack.
  for (const p of inRange) series.push(p);

  const live = input.live;
  const last = series.at(-1);
  if (live && (to === null || live.time <= to) && (last === undefined || live.time >= last.time)) {
    series.push(live);
  }
  return series;
}

/**
 * Drawdown measured on P&L, so a deposit cannot hide a loss. The peak starts at the first point;
 * each point's drawdown is the peak's P&L minus its own, and its percent divides that by the value
 * at the peak. A period runs from a peak to the first point back at or above it.
 */
export function drawdown(series: PnlPoint[]): Drawdown {
  let maxUsd = D(0);
  let maxPct: Decimal | null = null;
  const periods: DrawdownPeriod[] = [];
  const underwater: { time: number; usd: Decimal }[] = [];
  const first = series[0];
  if (first === undefined) return { maxUsd, maxPct, periods, underwater };

  let peak = first;
  let trough: PnlPoint | null = null;

  const close = (end: number | null) => {
    if (trough === null) return;
    const depthUsd = peak.pnl.minus(trough.pnl);
    const depthPct = peak.value.gt(0) ? depthUsd.div(peak.value) : null;
    const kept = depthPct === null ? depthUsd.gt(0) : depthPct.gte(MIN_PERIOD_DEPTH);
    if (kept) periods.push({ start: peak.time, trough: trough.time, end, depthUsd, depthPct });
    trough = null;
  };

  for (const p of series) {
    if (p.pnl.gte(peak.pnl)) {
      close(p.time);
      peak = p;
    } else if (trough === null || p.pnl.lt(trough.pnl)) {
      trough = p;
    }
    const usd = peak.pnl.minus(p.pnl);
    underwater.push({ time: p.time, usd: p.pnl.minus(peak.pnl) });
    if (usd.gt(maxUsd)) maxUsd = usd;
    if (peak.value.gt(0)) {
      const pct = usd.div(peak.value);
      if (maxPct === null || pct.gt(maxPct)) maxPct = pct;
    }
  }
  close(null);
  return { maxUsd, maxPct, periods, underwater };
}

/**
 * The series' P&L over the range (last point minus first) and its return on the highest capital
 * the scope held during the range: the capital at `from` (zero without a start), and after every
 * deposit or transfer of the scope inside the range.
 */
export function rangePnl(
  series: PnlPoint[],
  events: StatsEvent[],
  scope: Scope,
  from: number | null,
  to: number | null,
): RangePnl {
  const first = series[0];
  const last = series.at(-1);
  const pnl = first && last ? last.pnl.minus(first.pnl) : D(0);

  const steps = capitalSteps(events, scope);
  const capital = capitalCursor(steps);
  let capitalMax = from === null ? D(0) : capital(from);
  for (const step of steps) {
    if ((from !== null && step.time <= from) || (to !== null && step.time > to)) continue;
    if (step.capital.gt(capitalMax)) capitalMax = step.capital;
  }
  return { pnl, capitalMax, returnPct: capitalMax.gt(0) ? pnl.div(capitalMax) : null };
}
