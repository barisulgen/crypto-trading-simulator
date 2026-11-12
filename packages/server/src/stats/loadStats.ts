import { computeStats, D } from '@sim/engine';
import type {
  AccountValue,
  Basis,
  Decimal,
  Drawdown,
  PnlPoint,
  Position,
  SimEvent,
  Snapshot,
  SpotRules,
  StatsBenchmark,
  StatsEvent,
  StatsFilter,
  StatsInput,
  StatsReport,
} from '@sim/engine';
import type { Db } from '../db/db.ts';
import { reviveOrder, revivePerpOrder, revivePosition, toJson } from '../db/store.ts';

/** The event types the stats read. */
const STATS_EVENT_TYPES = [
  'deposit',
  'transfer',
  'fill',
  'round_trip_closed',
  'position_opened',
  'position_closed',
  'funding',
  'liquidation',
] as const;

type Raw = Record<string, unknown>;

/**
 * The named Decimal fields of `raw` revived from their strings: null stays null, and a field the
 * payload does not carry (an optional one, or one added after it was written) stays absent.
 */
function decimals(raw: Raw, keys: readonly string[]): Raw {
  const o = { ...raw };
  for (const k of keys) {
    if (!(k in o)) continue;
    const v = o[k];
    o[k] = v === null || v === undefined ? v : D(v as string);
  }
  return o;
}

const FILL_DECIMALS = [
  'qty', 'price', 'quote', 'fee', 'feeUsd', 'bestAtArrival', 'bestAtSubmit', 'slippageUsd', 'driftUsd',
  'triggerPrice', 'realizedPnl',
] as const;
const PERP_FILL_DECIMALS = [...FILL_DECIMALS, 'marginIn', 'uncovered', 'uncappedPrice'] as const;

/**
 * A stored event payload (decimals as strings) back as the SimEvent the engine wrote, for the event
 * types the stats read; throws for any other type.
 */
export function reviveEvent(raw: Raw): SimEvent {
  switch (raw.type) {
    case 'deposit':
      return decimals(raw, ['amount', 'totalDeposited', 'btcAsk']) as unknown as SimEvent;
    case 'transfer':
      return decimals(raw, ['amount']) as unknown as SimEvent;
    case 'fill': {
      const perp = raw.market === 'perp';
      const e: Raw = {
        ...raw,
        fill: decimals(raw.fill as Raw, perp ? PERP_FILL_DECIMALS : FILL_DECIMALS),
        order: perp ? revivePerpOrder(raw.order as Raw) : reviveOrder(raw.order as Raw),
      };
      if (Array.isArray(raw.consumed)) e.consumed = (raw.consumed as Raw[]).map((l) => decimals(l, ['price', 'qty']));
      return e as unknown as SimEvent;
    }
    case 'round_trip_closed':
      return { ...raw, roundTrip: decimals(raw.roundTrip as Raw, ['pnl']) } as unknown as SimEvent;
    case 'position_opened':
      return { ...raw, position: revivePosition(raw.position as Raw) } as unknown as SimEvent;
    case 'position_closed':
      return {
        ...decimals(raw, ['exitPrice', 'realizedPnl', 'fees', 'funding', 'uncappedPrice']),
        position: revivePosition(raw.position as Raw),
      } as unknown as SimEvent;
    case 'funding':
      return decimals(raw, ['rate', 'markPrice', 'qty', 'amount', 'uncollected']) as unknown as SimEvent;
    case 'liquidation':
      return {
        ...decimals(raw, ['markPrice', 'marginLost', 'tradingLoss', 'liquidationFee', 'remainder']),
        position: revivePosition(raw.position as Raw),
      } as unknown as SimEvent;
    default:
      throw new Error(`reviveEvent: the stats do not read ${String(raw.type)} events`);
  }
}

/** What the stats read of the running account (the engine runner provides it). */
export interface StatsSource {
  account(): AccountValue;
  readonly state: { basis: Record<string, Basis> };
  positions(): Position[];
  /** The market keys catching up after a data gap. */
  catchingUp(): readonly string[];
  statsMarket(): { btcRules: SpotRules; btcBid: Decimal | null; spotTakerFee: Decimal };
}

/** What the stats read of the account as it is now: cheap to gather, on the thread that runs it. */
export interface StatsLive {
  account: AccountValue;
  basis: Record<string, Basis>;
  positions: Position[];
  /** No price or mark is paused or loading and nothing is catching up. */
  live: boolean;
  btcRules: SpotRules;
  btcBid: Decimal | null;
  spotTakerFee: Decimal;
}

/**
 * The account now, from the runner. The current value counts as live only while no price or mark
 * is paused or loading and nothing is catching up. Throws while the BTC spot rules are not loaded.
 */
export function statsLive(runner: StatsSource): StatsLive {
  const market = runner.statsMarket();
  const account = runner.account();
  const live =
    account.pricesPaused.length === 0 &&
    account.marksPaused.length === 0 &&
    !account.pricesLoading &&
    runner.catchingUp().length === 0;
  return {
    account,
    basis: runner.state.basis,
    positions: runner.positions(),
    live,
    btcRules: market.btcRules,
    btcBid: market.btcBid,
    spotTakerFee: market.spotTakerFee,
  };
}

interface EventRow {
  id: number;
  time: number;
  payload: string;
}

interface SnapshotRow {
  time: number;
  total: string;
  deposited: string;
  spot_value: string;
  leverage_value: string;
  btc_bid: string | null;
}

/** The stored rows the stats are computed from, as read. */
export interface StatsRows {
  events: EventRow[];
  snapshots: SnapshotRow[];
}

/**
 * The newest event id and snapshot rowid at one moment. Reading only rows up to them gives the
 * record as it stood then, even when it is read later, after more has been written.
 */
export interface StatsBounds {
  eventId: number;
  snapshotRowid: number;
}

/** The record's bounds now: two index lookups. */
export function statsBounds(db: Db): StatsBounds {
  const e = db.prepare('SELECT max(id) AS m FROM events').get() as { m: number | null };
  const s = db.prepare('SELECT max(rowid) AS m FROM equity_snapshots').get() as { m: number | null };
  return { eventId: e.m ?? 0, snapshotRowid: s.m ?? 0 };
}

/**
 * The season's deposits, transfers, fills, round trips, positions opened and closed, funding and
 * liquidations in (time, id) order, and every equity snapshot in time order; with `bounds`, only
 * the rows that existed at that moment.
 */
export function readStatsRows(db: Db, seasonId: number, bounds?: StatsBounds): StatsRows {
  const maxEvent = bounds?.eventId ?? Number.MAX_SAFE_INTEGER;
  const maxSnapshot = bounds?.snapshotRowid ?? Number.MAX_SAFE_INTEGER;
  const events = db
    .prepare(
      `SELECT id, time, payload FROM events
       WHERE season_id = ? AND id <= ? AND type IN (${STATS_EVENT_TYPES.map(() => '?').join(',')})
       ORDER BY time, id`,
    )
    .all(seasonId, maxEvent, ...STATS_EVENT_TYPES) as EventRow[];
  const snapshots = db
    .prepare(
      `SELECT time, total, deposited, spot_value, leverage_value, btc_bid FROM equity_snapshots
       WHERE season_id = ? AND rowid <= ? ORDER BY time, rowid`,
    )
    .all(seasonId, maxSnapshot) as SnapshotRow[];
  return { events, snapshots };
}

/**
 * Everything the stats are computed from: the stored rows revived, the BTC ask each deposit
 * recorded (for the benchmark), and the account as it is now.
 */
export function statsInputFromRows(rows: StatsRows, live: StatsLive, tz: string, now: number): StatsInput {
  const events: StatsEvent[] = rows.events.map((r) => ({ id: r.id, time: r.time, event: reviveEvent(JSON.parse(r.payload) as Raw) }));

  const benchmarkBuys: StatsInput['benchmarkBuys'] = [];
  for (const { id, event } of events) {
    if (event.type === 'deposit' && event.btcAsk !== undefined) benchmarkBuys.push({ depositEventId: id, price: event.btcAsk });
  }

  const snapshots: Snapshot[] = rows.snapshots.map((r) => ({
    time: r.time,
    total: D(r.total),
    deposited: D(r.deposited),
    spotValue: D(r.spot_value),
    leverageValue: D(r.leverage_value),
    btcBid: r.btc_bid === null ? null : D(r.btc_bid),
  }));

  return {
    events,
    snapshots,
    now,
    account: live.account,
    basis: live.basis,
    positions: live.positions,
    live: live.live,
    benchmarkBuys,
    btcRules: live.btcRules,
    spotTakerFee: live.spotTakerFee,
    btcBid: live.btcBid,
    tz,
  };
}

/** The stats input from the database and the runner, on the calling thread. */
export function loadStatsInput(db: Db, seasonId: number, runner: StatsSource, tz: string, now: number): StatsInput {
  return statsInputFromRows(readStatsRows(db, seasonId), statsLive(runner), tz, now);
}

/** One stats request: the account now and the record's bounds then, gathered when it was made. */
export interface StatsRequest {
  seasonId: number;
  bounds: StatsBounds;
  live: StatsLive;
  filter: StatsFilter;
  tz: string;
  now: number;
}

/** The report a request asks for, as the JSON the API sends. */
export function statsJson(db: Db, req: StatsRequest): string {
  const input = statsInputFromRows(readStatsRows(db, req.seasonId, req.bounds), req.live, req.tz, req.now);
  return toJson(downsampleReport(computeStats(input, req.filter)));
}

// ---- the report as it is sent ----

/** The most points a chart series is sent with. */
export const MAX_POINTS = 1500;
/** Snapshots further apart than this mean data was interrupted: the line breaks there. */
export const GAP_MS = 5 * 60_000;

/** A point of a chart line; `gap` when snapshots were interrupted since the point before it. */
type Gapped<P> = P & { gap?: true };

/** The report with its chart lines thinned to at most MAX_POINTS each and their gaps marked. */
export interface StatsResponse extends Omit<StatsReport, 'series' | 'drawdown' | 'benchmark'> {
  series: Gapped<PnlPoint>[];
  drawdown: Drawdown;
  benchmark: Omit<StatsBenchmark, 'series'> & { series: Gapped<StatsBenchmark['series'][number]>[] };
}

/**
 * The indices of the points kept, ascending: all of them when there are at most `max`. Otherwise
 * the last point; then the `required` points, in the order given, while they fit; then, over equal
 * buckets of the points before the last, as many as the room left allows, each bucket's first
 * point, its lowest and highest value and, with `underwater`, its deepest point below the peak.
 */
function keptIndices(values: Decimal[], opts: { underwater?: Decimal[]; required?: number[]; max?: number } = {}): number[] {
  const n = values.length;
  const max = opts.max ?? MAX_POINTS;
  if (n <= max) return values.map((_, i) => i);
  const kept = new Set<number>([n - 1]);
  for (const i of opts.required ?? []) {
    if (kept.size >= max) break;
    kept.add(i);
  }
  const under = opts.underwater;
  const perBucket = under ? 4 : 3;
  const body = n - 1;
  const buckets = Math.floor((max - kept.size) / perBucket);
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * body) / buckets);
    const end = Math.floor(((b + 1) * body) / buckets);
    if (start >= end) continue;
    let lo = start;
    let hi = start;
    let deep = start;
    for (let i = start + 1; i < end; i++) {
      if (values[i]!.lt(values[lo]!)) lo = i;
      if (values[i]!.gt(values[hi]!)) hi = i;
      if (under && under[i]!.lt(under[deep]!)) deep = i;
    }
    kept.add(start).add(lo).add(hi).add(deep);
  }
  return [...kept].sort((x, y) => x - y);
}

/**
 * The series indices of the drawdown periods' peaks and troughs (every point at those times),
 * deepest period first, so that the deepest are kept when not all of them fit.
 */
function periodIndices(series: PnlPoint[], drawdown: Drawdown): number[] {
  const byTime = new Map<number, number[]>();
  series.forEach((p, i) => byTime.set(p.time, [...(byTime.get(p.time) ?? []), i]));
  return [...drawdown.periods]
    .sort((a, b) => b.depthUsd.comparedTo(a.depthUsd))
    .flatMap((p) => [...(byTime.get(p.start) ?? []), ...(byTime.get(p.trough) ?? [])]);
}

/**
 * The kept points of a line. With `gaps`, each is marked `gap` when a point of the full line is
 * more than GAP_MS after the one before it anywhere since the previous kept point, so the line
 * also breaks where the points dropped spanned the gap.
 */
function pick<P extends { time: number }>(line: P[], kept: number[], gaps: boolean): Gapped<P>[] {
  const out: Gapped<P>[] = [];
  let prev = -1;
  for (const k of kept) {
    let gap = false;
    for (let i = Math.max(prev + 1, 1); gaps && i <= k; i++) {
      if (line[i]!.time - line[i - 1]!.time > GAP_MS) gap = true;
    }
    out.push(gap ? { ...line[k]!, gap: true } : line[k]!);
    prev = k;
  }
  return out;
}

/**
 * The report as the API sends it. The P&L series, and the underwater line beside it, keep at most
 * MAX_POINTS points (see keptIndices), among them each bucket's deepest point below the peak and
 * the peak and trough of every drawdown period (the deepest periods first, while they fit). The
 * benchmark line keeps the series' times when it is drawn on them, else it is thinned on its own
 * values. Every drawdown figure was computed on the full series. On the account and wallet curves, which are snapshots, a kept point is marked `gap` where
 * they were interrupted before it (see pick). A coin's curve steps at its trades' times, so neither
 * it nor the benchmark beside it is ever marked.
 */
export function downsampleReport(report: StatsReport): StatsResponse {
  const { series, drawdown, benchmark } = report;
  const gaps = report.headline.scope.kind !== 'coin';
  const kept = keptIndices(
    series.map((p) => p.pnl),
    { underwater: drawdown.underwater.map((u) => u.usd), required: periodIndices(series, drawdown) },
  );
  const seriesTimes = new Set(series.map((p) => p.time));
  const keptTimes = new Set(kept.map((i) => series[i]!.time));
  const line = benchmark.series;
  const lineKept = line.every((b) => seriesTimes.has(b.time))
    ? line.flatMap((b, i) => (keptTimes.has(b.time) ? [i] : []))
    : keptIndices(line.map((b) => b.value));
  return {
    ...report,
    series: pick(series, kept, gaps),
    drawdown: { ...drawdown, underwater: kept.map((i) => drawdown.underwater[i]!) },
    benchmark: { ...benchmark, series: pick(line, lineKept, gaps) },
  };
}
