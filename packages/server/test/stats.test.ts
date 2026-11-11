import { describe, expect, it } from 'vitest';
import { computeStats, D, Decimal } from '@sim/engine';
import type {
  AccountValue,
  CatchUpTag,
  EngineEvent,
  Fill,
  PerpEvent,
  PerpFill,
  PerpOrder,
  PerpOrderRequest,
  Position,
  SimCtx,
  SimEvent,
  SpotOrder,
  SpotOrderRequest,
  StatsEvent,
  StatsFilter,
  StatsInput,
  StatsReport,
} from '@sim/engine';
import { btcRules } from '../../engine/test/fixtures.ts';
import { insertEquitySnapshot, persist, toJson } from '../src/db/store.ts';
import { downsampleReport, GAP_MS, loadStatsInput, MAX_POINTS, reviveEvent } from '../src/stats/loadStats.ts';
import type { StatsSource } from '../src/stats/loadStats.ts';
import { RUNNER_FEES, RUNNER_T0, runnerHarness } from './helpers.ts';

const T0 = RUNNER_T0;
const MIN = 60_000;
const ALL: StatsFilter = { from: null, to: null, symbol: null, market: null };
const tag: CatchUpTag = { from: T0 - 10 * MIN, to: T0 - MIN, basis: 'candle_worst_price' };

/** A round trip through the events table's JSON. */
const stored = (e: SimEvent): SimEvent => reviveEvent(JSON.parse(toJson(e)) as Record<string, unknown>);

function spotOrder(over: Partial<SpotOrder> = {}): SpotOrder {
  return {
    id: 'o1',
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'limit',
    qty: D('0.5'),
    quoteQty: D('50.25'),
    price: D('100.5'),
    triggerPrice: D('99'),
    status: 'filled',
    filledQty: D('0.5'),
    filledQuote: D('50.25'),
    fee: D('0.0005'),
    feeAsset: 'BTC',
    lockAsset: 'USDT',
    lockAmount: D('0'),
    ocoGroupId: 'g1',
    parentId: null,
    attach: { stopLoss: D('90'), takeProfit: D('120.5') },
    createdAt: T0,
    arrivesAt: T0 + 100,
    cancelArrivesAt: T0 + 200,
    triggeredAt: null,
    bestAtSubmit: D('100.4'),
    rejectReason: null,
    ...over,
  };
}

function perpOrder(over: Partial<PerpOrder> = {}): PerpOrder {
  return {
    id: 'po1',
    symbol: 'BTCUSDT',
    side: 'sell',
    type: 'market',
    qty: D('0.01'),
    quoteQty: null,
    price: null,
    triggerPrice: D('79000'),
    reduceOnly: true,
    closePosition: false,
    leverage: 20,
    status: 'filled',
    filledQty: D('0.01'),
    filledQuote: D('790'),
    fee: D('0.395'),
    lockAmount: D('0'),
    ocoGroupId: null,
    parentId: 'po0',
    attach: { stopLoss: D('78000'), takeProfit: null },
    createdAt: T0,
    arrivesAt: T0 + 100,
    triggeredAt: T0 + 50,
    cancelArrivesAt: null,
    bestAtSubmit: D('79010'),
    rejectReason: null,
    realizedPnl: D('-10.5'),
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'BTCUSDT',
    side: 'long',
    qty: D('0.01'),
    entryPrice: D('80000.5'),
    leverage: 20,
    margin: D('40.0025'),
    openedAt: T0,
    realizedPnl: D('-1.25'),
    fees: D('0.4'),
    funding: D('-0.08'),
    warnLevel: 0.5,
    ...over,
  };
}

function perpFill(over: Partial<PerpFill> = {}): PerpFill {
  return {
    id: 'pf1',
    orderId: 'po1',
    symbol: 'BTCUSDT',
    side: 'sell',
    qty: D('0.01'),
    price: D('79000'),
    quote: D('790'),
    liquidity: 'taker',
    feeAsset: 'USDT',
    fee: D('0.395'),
    feeUsd: D('0.395'),
    bestAtArrival: D('79005'),
    bestAtSubmit: D('79010'),
    slippageUsd: D('0.05'),
    driftUsd: D('-0.1'),
    triggerPrice: D('79100'),
    realizedPnl: D('-10.005'),
    time: T0 + MIN,
    market: 'perp',
    positionId: 'p1',
    marginIn: D('39.5'),
    uncovered: D('1.75'),
    ...over,
  };
}

/** One event of every type the stats read, with every optional Decimal field set (and also left null or out). */
function everyEvent(): SimEvent[] {
  const deposit: EngineEvent = {
    type: 'deposit',
    time: T0,
    wallet: 'spot',
    amount: D('1000'),
    totalDeposited: D('1500.25'),
    btcAsk: D('80000.01'),
  };
  const oldDeposit: EngineEvent = { type: 'deposit', time: T0, wallet: 'leverage', amount: D('5'), totalDeposited: D('5') };
  const transfer: EngineEvent = { type: 'transfer', time: T0, from: 'spot', to: 'leverage', amount: D('300.5') };
  const fullFill: Fill = {
    id: 'f1',
    orderId: 'o1',
    symbol: 'BTCUSDT',
    side: 'buy',
    qty: D('0.5'),
    price: D('100.5'),
    quote: D('50.25'),
    liquidity: 'taker',
    feeAsset: 'BTC',
    fee: D('0.0005'),
    feeUsd: D('0.05025'),
    bestAtArrival: D('100.4'),
    bestAtSubmit: D('100.3'),
    slippageUsd: D('0.05'),
    driftUsd: D('0.1'),
    triggerPrice: D('99'),
    realizedPnl: D('-2.5'),
    roundTripId: 'rt1',
    time: T0 + 1,
  };
  const spotFill: EngineEvent = {
    type: 'fill',
    time: T0 + 1,
    fill: fullFill,
    order: spotOrder(),
    consumed: [
      { price: D('100.4'), qty: D('0.2') },
      { price: D('100.6'), qty: D('0.3') },
    ],
    catchUp: tag,
  };
  const plainSpotFill: EngineEvent = {
    type: 'fill',
    market: 'spot',
    time: T0 + 2,
    fill: {
      ...fullFill,
      id: 'f2',
      time: T0 + 2,
      bestAtArrival: null,
      bestAtSubmit: null,
      triggerPrice: null,
      realizedPnl: null,
      roundTripId: null,
    },
    order: spotOrder({ quoteQty: null, price: null, triggerPrice: null, attach: null, bestAtSubmit: null, cancelArrivesAt: null }),
  };
  const trip: EngineEvent = {
    type: 'round_trip_closed',
    time: T0 + 3,
    roundTrip: { id: 'rt1', symbol: 'BTCUSDT', openedAt: T0, closedAt: T0 + 3, pnl: D('-3.75') },
    catchUp: tag,
  };
  const opened: PerpEvent = { type: 'position_opened', market: 'perp', time: T0 + 4, position: position() };
  const fill: PerpEvent = {
    type: 'fill',
    market: 'perp',
    time: T0 + 5,
    fill: perpFill({ bankruptcyCapped: true, uncappedPrice: D('78500.5') }),
    order: perpOrder(),
    consumed: [{ price: D('79005'), qty: D('0.01') }],
    catchUp: tag,
  };
  const plainFill: PerpEvent = {
    type: 'fill',
    market: 'perp',
    time: T0 + 6,
    fill: perpFill({ id: 'pf2', bestAtArrival: null, bestAtSubmit: null, triggerPrice: null, realizedPnl: null, marginIn: null, uncovered: null }),
    order: perpOrder({ qty: null, quoteQty: D('800'), price: D('80000'), triggerPrice: null, attach: null, bestAtSubmit: null }),
  };
  const funding: PerpEvent = {
    type: 'funding',
    market: 'perp',
    time: T0 + 7,
    symbol: 'BTCUSDT',
    positionId: 'p1',
    fundingTime: T0 + 7,
    rate: D('0.0001'),
    markPrice: D('80001.5'),
    qty: D('0.01'),
    side: 'long',
    amount: D('-0.08'),
    target: 'margin',
    uncollected: D('0.02'),
  };
  const fundingCovered: PerpEvent = { ...funding, time: T0 + 8, amount: D('0.04'), target: 'wallet', uncollected: null };
  const liquidation: PerpEvent = {
    type: 'liquidation',
    market: 'perp',
    time: T0 + 9,
    symbol: 'BTCUSDT',
    position: position({ side: 'short', warnLevel: 0.9 }),
    markPrice: D('84000.1'),
    marginLost: D('40.0025'),
    tradingLoss: D('39.9975'),
    liquidationFee: D('0.004'),
    remainder: D('0.001'),
    feeRateKnown: true,
    cancelledOrderIds: ['po2'],
    catchUp: tag,
  };
  const closed: PerpEvent = {
    type: 'position_closed',
    market: 'perp',
    time: T0 + 10,
    position: position({ qty: D(0), warnLevel: 0 }),
    exitPrice: D('79000.5'),
    realizedPnl: D('-10.005'),
    fees: D('0.795'),
    funding: D('-0.04'),
    holdMs: 10,
    reason: 'stop_loss',
    bankruptcyCapped: true,
    uncappedPrice: D('78500.5'),
    catchUp: tag,
  };
  const plainClosed: PerpEvent = {
    type: 'position_closed',
    market: 'perp',
    time: T0 + 11,
    position: position({ id: 'p2', qty: D(0), warnLevel: 0 }),
    exitPrice: D('81000'),
    realizedPnl: D('10'),
    fees: D('0.8'),
    funding: D('0'),
    holdMs: 11,
    reason: 'closed',
  };
  return [deposit, oldDeposit, transfer, spotFill, plainSpotFill, trip, opened, fill, plainFill, funding, fundingCovered, liquidation, closed, plainClosed];
}

/** Every string anywhere in a value, with its path. */
function strings(v: unknown, path = ''): string[] {
  if (typeof v === 'string') return [path];
  if (v === null || typeof v !== 'object' || Decimal.isDecimal(v)) return [];
  return Object.entries(v as object).flatMap(([k, x]) => strings(x, `${path}.${k}`));
}

describe('reviveEvent', () => {
  it('every event type the stats read comes back equal to the event persisted, every Decimal a Decimal', () => {
    const events = everyEvent();
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(['deposit', 'transfer', 'fill', 'round_trip_closed', 'position_opened', 'position_closed', 'funding', 'liquidation']),
    );
    for (const e of events) {
      const back = stored(e);
      expect(back).toEqual(e);
      // The only strings left are the ones the event holds as strings (ids, symbols, kinds).
      expect(strings(back)).toEqual(strings(e));
    }
  });

  it('a deposit recorded before the BTC ask was kept comes back without one', () => {
    const back = stored({ type: 'deposit', time: T0, wallet: 'spot', amount: D(5), totalDeposited: D(5) });
    expect(back).not.toHaveProperty('btcAsk');
  });

  it('refuses an event type the stats do not read', () => {
    expect(() => reviveEvent({ type: 'order_placed', time: T0 })).toThrow('order_placed');
  });
});

// ---- the loader over a real engine's record ----

/**
 * Drives the harness's own SimEngine over its test markets: two deposits, a BTC spot round trip,
 * a BTC long through a funding settlement, then a BTC short liquidated by the mark; persists each
 * step's events (with their row ids) as the runner does.
 */
function seededEngine() {
  const h = runnerHarness();
  let n = 0;
  const ctx: SimCtx = {
    now: T0,
    rng: () => 0,
    newId: (prefix) => `${prefix}-${++n}`,
    spotMarket: h.market,
    perpMarket: h.perp,
    fees: RUNNER_FEES,
  };
  const recorded: StatsEvent[] = [];
  const save = (events: SimEvent[]) => {
    const ids = new Map<SimEvent, number>();
    persist(h.db, h.seasonId, h.sim, events, { eventIds: ids, now: ctx.now });
    for (const e of events) recorded.push({ id: ids.get(e)!, time: e.time, event: e });
  };
  const ok = (r: { ok: true; events: SimEvent[] } | { ok: false; reason: string }) => {
    if (!r.ok) throw new Error(r.reason);
    save(r.events);
  };
  const execute = (...order: ['spot', SpotOrderRequest] | ['perp', PerpOrderRequest]) => {
    const placed = order[0] === 'spot' ? h.sim.submit('spot', order[1], ctx) : h.sim.submit('perp', order[1], ctx);
    save(placed);
    const e = placed[0];
    if (placed.length !== 1 || e?.type !== 'order_placed') throw new Error(`not placed: ${toJson(placed)}`);
    ctx.now = Math.max(ctx.now, e.order.arrivesAt!);
    save(h.sim.arrive(order[0], e.order.id, ctx));
  };

  ok(h.sim.deposit('spot', D(1000), ctx, D('100.00')));
  ctx.now = T0 + MIN;
  ok(h.sim.deposit('leverage', D(500), ctx, D('100.10')));

  ctx.now = T0 + 2 * MIN;
  execute('spot', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
  ctx.now = T0 + 3 * MIN;
  execute('spot', { symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.999' });

  ctx.now = T0 + 4 * MIN;
  execute('perp', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' });
  const fundingTime = T0 + 8 * MIN;
  ctx.now = fundingTime - 15_000;
  h.sim.openFundingWindow('BTCUSDT', fundingTime, ctx);
  ctx.now = fundingTime + 15_000;
  h.sim.closeFundingWindow('BTCUSDT', fundingTime, ctx);
  ctx.now = fundingTime + 60_000;
  save(h.sim.applyFunding('BTCUSDT', fundingTime, D('0.0001'), D('80000'), ctx));
  ctx.now = T0 + 10 * MIN;
  execute('perp', { symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.01', reduceOnly: true });

  ctx.now = T0 + 11 * MIN;
  execute('perp', { symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.01' });
  ctx.now = T0 + 12 * MIN;
  h.perp.setMarkPrice('BTCUSDT', D('90000'));
  save(h.sim.onMark('BTCUSDT', D('90000'), ctx).events);
  h.perp.setMarkPrice('BTCUSDT', D('80000'));

  h.clock.now = ctx.now + MIN;
  return { h, recorded };
}

const READ = new Set(['deposit', 'transfer', 'fill', 'round_trip_closed', 'position_opened', 'position_closed', 'funding', 'liquidation']);

describe('loadStatsInput', () => {
  it('loads a real engine record: the events the stats read, as persisted, in (time, id) order', () => {
    const { h, recorded } = seededEngine();
    const types = new Set(recorded.map((r) => r.event.type));
    for (const type of ['round_trip_closed', 'position_closed', 'funding', 'liquidation']) expect(types).toContain(type);

    const input = loadStatsInput(h.db, h.seasonId, h.runner, 'Europe/Istanbul', h.clock.now);
    const expected = recorded
      .filter((r) => READ.has(r.event.type))
      .sort((a, b) => a.time - b.time || a.id - b.id);
    expect(input.events).toEqual(expected);
    expect(input.events.flatMap((r) => strings(r.event))).toEqual(expected.flatMap((r) => strings(r.event)));
    expect(input.tz).toBe('Europe/Istanbul');
    expect(input.now).toBe(h.clock.now);
    expect(input.benchmarkBuys).toEqual([
      { depositEventId: expected[0]!.id, price: D('100.00') },
      { depositEventId: expected[1]!.id, price: D('100.10') },
    ]);

    // The stats over the stored record are the stats over the engine's own events.
    const fromEngine: StatsInput = { ...input, events: expected };
    for (const filter of [ALL, { ...ALL, market: 'leverage' as const }, { ...ALL, symbol: 'BTCUSDT', from: T0 + 3 * MIN, to: null }]) {
      expect(toJson(computeStats(input, filter))).toBe(toJson(computeStats(fromEngine, filter)));
    }
    const report = computeStats(input, ALL);
    expect(report.quality.count).toBe(3);
    expect(report.risk.liquidations).toBe(1);
    expect(report.markers.map((m) => m.kind)).toEqual(['deposit', 'deposit']);
  });

  it('loads every snapshot of the season, with its BTC bid or none, in time order', () => {
    const { h } = seededEngine();
    const v = h.runner.account();
    insertEquitySnapshot(h.db, h.seasonId, v, T0 + 7 * MIN, null);
    insertEquitySnapshot(h.db, h.seasonId, v, T0 + 5 * MIN, D('99.9'));
    h.db
      .prepare('INSERT INTO equity_snapshots (season_id, time, total, deposited, spot_value, leverage_value) VALUES (?, ?, ?, ?, ?, ?)')
      .run(h.seasonId + 1, T0 + 6 * MIN, '1', '1', '1', '0');
    const input = loadStatsInput(h.db, h.seasonId, h.runner, 'UTC', h.clock.now);
    const spotValue = v.total.minus(v.leverage.value);
    expect(input.snapshots).toEqual([
      { time: T0 + 5 * MIN, total: v.total, deposited: v.totalDeposited, spotValue, leverageValue: v.leverage.value, btcBid: D('99.9') },
      { time: T0 + 7 * MIN, total: v.total, deposited: v.totalDeposited, spotValue, leverageValue: v.leverage.value, btcBid: null },
    ]);
  });

  it('the account now, the BTC rules, bid and spot taker fee from the runner', () => {
    const { h } = seededEngine();
    const input = loadStatsInput(h.db, h.seasonId, h.runner, 'UTC', h.clock.now);
    expect(input.account).toEqual(h.runner.account());
    expect(input.basis).toBe(h.runner.state.basis);
    expect(input.positions).toEqual(h.runner.positions());
    expect(input.btcRules).toEqual(btcRules);
    expect(input.btcBid).toEqual(D('99.90'));
    expect(input.spotTakerFee).toEqual(RUNNER_FEES.spot.taker);
    expect(input.live).toBe(true);

    h.market.setFresh('BTCUSDT', false);
    expect(loadStatsInput(h.db, h.seasonId, h.runner, 'UTC', h.clock.now).btcBid).toBeNull();
  });
});

describe('loadStatsInput: live', () => {
  const { h } = seededEngine();
  const account = h.runner.account();
  const source = (over: { account?: Partial<AccountValue>; catchingUp?: string[] } = {}): StatsSource => ({
    account: () => ({ ...account, ...over.account }),
    state: { basis: {} },
    positions: () => [],
    catchingUp: () => over.catchingUp ?? [],
    statsMarket: () => ({ btcRules, btcBid: null, spotTakerFee: D('0.001') }),
  });
  const live = (s: StatsSource) => loadStatsInput(h.db, h.seasonId, s, 'UTC', h.clock.now).live;

  it('only with no price or mark paused, no price loading and nothing catching up', () => {
    expect(live(source())).toBe(true);
    expect(live(source({ account: { pricesPaused: ['BTC'] } }))).toBe(false);
    expect(live(source({ account: { marksPaused: ['BTCUSDT'] } }))).toBe(false);
    expect(live(source({ account: { pricesLoading: true } }))).toBe(false);
    expect(live(source({ catchingUp: ['perp:ETHUSDT'] }))).toBe(false);
  });
});

// ---- downsampling ----

function account(): AccountValue {
  return {
    spotUsdtFree: D(0),
    spotUsdtLocked: D(0),
    leverageUsdt: D(0),
    coins: [],
    leverage: { free: D(0), locked: D(0), positions: [], value: D(0) },
    total: D(0),
    totalDeposited: D(0),
    netPnl: D(0),
    netPnlPct: null,
    pricesPaused: [],
    marksPaused: [],
    pricesLoading: false,
  };
}

/**
 * The account report over snapshots at `times` with P&L `pnl(i)`, after a deposit of 1000 a minute
 * before the first, each with a BTC bid; not live. Its series starts at the deposit.
 */
function reportOver(times: number[], pnl: (i: number) => number): StatsReport {
  const input: StatsInput = {
    events: [{ id: 1, time: times[0]! - MIN, event: { type: 'deposit', time: times[0]! - MIN, wallet: 'spot', amount: D(1000), totalDeposited: D(1000) } }],
    snapshots: times.map((time, i) => ({
      time,
      total: D(1000 + pnl(i)),
      deposited: D(1000),
      spotValue: D(1000 + pnl(i)),
      leverageValue: D(0),
      btcBid: D(100 + (i % 7)),
    })),
    now: times.at(-1)! + 1000,
    account: account(),
    basis: {},
    positions: [],
    live: false,
    benchmarkBuys: [{ depositEventId: 1, price: D(100) }],
    btcRules,
    spotTakerFee: D('0.001'),
    btcBid: null,
    tz: 'UTC',
  };
  return computeStats(input, ALL);
}

const minutes = (n: number, start = T0) => Array.from({ length: n }, (_, i) => start + i * MIN);
/** Noise within ±100, with one deep dip at point 1234 and one high at point 2345. */
const wave = (i: number) => (i === 1234 ? -500 : i === 2345 ? 400 : ((i * 7919) % 201) - 100);

describe('downsampleReport', () => {
  it('3000 points: at most 1500, in time order, the first, the lowest, the highest and the last kept', () => {
    const times = minutes(3000);
    const report = reportOver(times, wave);
    expect(report.series).toHaveLength(3001);
    const out = downsampleReport(report);
    expect(out.series.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(out.series.length).toBeGreaterThan(1000);
    const t = out.series.map((p) => p.time);
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(new Set(t).size).toBe(t.length);
    expect(out.series[0]).toEqual(report.series[0]);
    expect(out.series.at(-1)).toEqual(report.series.at(-1));
    expect(out.series.map((p) => p.pnl.toString())).toContain('-500');
    expect(out.series.map((p) => p.pnl.toString())).toContain('400');
    // Each kept point is the full series' point at that time.
    const byTime = new Map(report.series.map((p) => [p.time, p]));
    for (const p of out.series) expect(byTime.get(p.time)!.pnl).toEqual(p.pnl);
  });

  it('drawdown figures stay those of the full series; underwater and benchmark keep the same times', () => {
    const report = reportOver(minutes(3000), wave);
    const out = downsampleReport(report);
    expect(out.drawdown.maxUsd).toEqual(report.drawdown.maxUsd);
    expect(out.drawdown.maxPct).toEqual(report.drawdown.maxPct);
    expect(out.drawdown.periods).toEqual(report.drawdown.periods);
    const kept = out.series.map((p) => p.time);
    expect(out.drawdown.underwater.map((u) => u.time)).toEqual(kept);
    const fullUnderwater = new Map(report.drawdown.underwater.map((u) => [u.time, u.usd]));
    for (const u of out.drawdown.underwater) expect(u.usd).toEqual(fullUnderwater.get(u.time));
    expect(report.benchmark.series.length).toBeGreaterThan(MAX_POINTS);
    expect(out.benchmark.series.map((b) => b.time)).toEqual(kept.filter((t) => report.benchmark.series.some((b) => b.time === t)));
    expect(out.benchmark.pnl).toEqual(report.benchmark.pnl);
    // Everything else is the report as computed.
    expect(toJson({ ...out, series: 0, drawdown: 0, benchmark: 0 })).toBe(toJson({ ...report, series: 0, drawdown: 0, benchmark: 0 }));
  });

  it('a series of at most 1500 points is kept whole', () => {
    const report = reportOver(minutes(MAX_POINTS - 1), wave);
    expect(report.series).toHaveLength(MAX_POINTS);
    const out = downsampleReport(report);
    expect(out.series.map(({ time, pnl, value }) => ({ time, pnl, value }))).toEqual(report.series);
    expect(out.drawdown.underwater).toEqual(report.drawdown.underwater);
  });

  it('gap: a point more than 5 min after the one before it', () => {
    const times = [T0, T0 + MIN, T0 + 11 * MIN, T0 + 16 * MIN, T0 + 16 * MIN + GAP_MS + 1];
    const out = downsampleReport(reportOver(times, (i) => i));
    expect(out.series.map((p) => [p.time, p.gap ?? false])).toEqual([
      [T0 - MIN, false], // the origin, at the deposit
      [T0, false],
      [T0 + MIN, false],
      [T0 + 11 * MIN, true],
      [T0 + 16 * MIN, false], // exactly 5 min: not a gap
      [T0 + 16 * MIN + GAP_MS + 1, true],
    ]);
    expect(out.benchmark.series.map((p) => p.gap ?? false)).toEqual([false, false, true, false, true]);
  });

  it('a gap among the points dropped breaks the line at the next point kept', () => {
    const times = minutes(3000);
    // Points 1500.. are 10 min later: the gap sits between 1499 and 1500.
    for (let i = 1500; i < times.length; i++) times[i]! += 10 * MIN;
    const flat = (i: number) => (i === 1000 ? -5 : i === 2000 ? 5 : 0);
    const report = reportOver(times, flat);
    const out = downsampleReport(report);
    const gaps = out.series.filter((p) => p.gap);
    expect(gaps).toHaveLength(1);
    const before = out.series.filter((p) => p.time < gaps[0]!.time).at(-1)!;
    expect(before.time).toBeLessThanOrEqual(times[1499]!);
    expect(gaps[0]!.time).toBeGreaterThanOrEqual(times[1500]!);
  });
});

describe('downsampleReport: a coin series', () => {
  it('the benchmark, on other times than the series, is thinned on its own values', () => {
    const report = reportOver(minutes(3000), wave);
    const coinSeries = report.series.map((p) => ({ ...p, time: p.time + 1 }));
    const out = downsampleReport({ ...report, series: coinSeries, drawdown: { ...report.drawdown, underwater: coinSeries.map((p) => ({ time: p.time, usd: D(0) })) } });
    expect(out.benchmark.series.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(out.benchmark.series.length).toBeGreaterThan(1000);
    expect(out.benchmark.series.at(-1)!.time).toBe(report.benchmark.series.at(-1)!.time);
    const lowest = report.benchmark.series.reduce((a, b) => (b.value.lt(a.value) ? b : a));
    expect(out.benchmark.series.map((b) => b.time)).toContain(lowest.time);
  });
});

