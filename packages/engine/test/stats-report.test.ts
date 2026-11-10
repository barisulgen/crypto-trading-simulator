import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import { emptyLedger } from '../src/account/ledger.ts';
import type { CatchUpTag } from '../src/catchup/types.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import type { PerpEvent, PerpFill, PerpOrderRequest, Position } from '../src/perp/types.ts';
import { SimEngine } from '../src/sim.ts';
import type { SimCtx, SimEvent } from '../src/sim.ts';
import { valueAccount } from '../src/spot/accounting.ts';
import type { AccountValue } from '../src/spot/accounting.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import type { Snapshot } from '../src/stats/equity.ts';
import { computeStats } from '../src/stats/report.ts';
import type { StatsEvent, StatsFilter, StatsInput } from '../src/stats/types.ts';
import type { ActionResult, BookSnapshot, EngineEvent, Fill, SpotOrderRequest, Wallet } from '../src/types.ts';
import { btcRules, FakeMarket, testCtx } from './fixtures.ts';
import { brackets, btcPerpRules, FakePerpMarket } from './perpFixtures.ts';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const t = (n: number) => T0 + n * MIN;
const worst: CatchUpTag = { from: T0, to: T0 + MIN, basis: 'candle_worst_price' };

const ALL: StatsFilter = { from: null, to: null, symbol: null, market: null };
const s = (x: Decimal | null | undefined) => (x == null ? x : x.toString());

function rows(events: SimEvent[]): StatsEvent[] {
  return events.map((event, i) => ({ id: i + 1, time: event.time, event }));
}

function account(over: Partial<AccountValue> = {}): AccountValue {
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
    ...over,
  };
}

function input(over: Partial<StatsInput> = {}): StatsInput {
  return {
    events: [],
    snapshots: [],
    now: t(60),
    account: account(),
    basis: {},
    positions: [],
    live: true,
    benchmarkBuys: [],
    btcRules,
    spotTakerFee: D('0.001'),
    btcBid: null,
    tz: 'UTC',
    ...over,
  };
}

function snap(time: number, total: string, deposited: string, btcBid: string | null = null): Snapshot {
  return {
    time,
    total: D(total),
    deposited: D(deposited),
    spotValue: D(total),
    leverageValue: D(0),
    btcBid: btcBid === null ? null : D(btcBid),
  };
}

function deposit(time: number, wallet: Wallet, amount: string, totalDeposited: string): EngineEvent {
  return { type: 'deposit', time, wallet, amount: D(amount), totalDeposited: D(totalDeposited) };
}

function transfer(time: number, from: Wallet, to: Wallet, amount: string): EngineEvent {
  return { type: 'transfer', time, from, to, amount: D(amount) };
}

function position(over: Partial<Position> & { id: string }): Position {
  return {
    symbol: 'BTCUSDT',
    side: 'long',
    qty: D('0.01'),
    entryPrice: D(60000),
    leverage: 10,
    margin: D(60),
    openedAt: T0,
    realizedPnl: D(0),
    fees: D(0),
    funding: D(0),
    warnLevel: 0,
    ...over,
  };
}

function perpFill(positionId: string, time: number, over: Partial<PerpFill> = {}): PerpEvent {
  const fill: PerpFill = {
    id: `pf${positionId}${time}`,
    orderId: 'o1',
    symbol: 'BTCUSDT',
    side: 'buy',
    qty: D('0.01'),
    price: D(60000),
    quote: D(600),
    liquidity: 'taker',
    feeAsset: 'USDT',
    fee: D('0.3'),
    feeUsd: D('0.3'),
    bestAtArrival: null,
    bestAtSubmit: null,
    slippageUsd: D(0),
    driftUsd: D(0),
    triggerPrice: null,
    realizedPnl: null,
    time,
    market: 'perp',
    positionId,
    marginIn: null,
    uncovered: null,
    ...over,
  };
  return { type: 'fill', market: 'perp', time, fill, order: {} as never };
}

function opened(p: Position): PerpEvent {
  return { type: 'position_opened', market: 'perp', time: p.openedAt, position: p };
}

function closed(
  p: Position,
  time: number,
  realizedPnl: string,
  fees: string,
  reason: 'closed' | 'liquidated' = 'closed',
): PerpEvent {
  return {
    type: 'position_closed',
    market: 'perp',
    time,
    position: { ...p, qty: D(0) },
    exitPrice: D(59000),
    realizedPnl: D(realizedPnl),
    fees: D(fees),
    funding: D(0),
    holdMs: time - p.openedAt,
    reason,
  };
}

function funding(positionId: string, time: number, amount: string): PerpEvent {
  return {
    type: 'funding',
    market: 'perp',
    time,
    symbol: 'BTCUSDT',
    positionId,
    fundingTime: time,
    rate: D('0.0001'),
    markPrice: D(63000),
    qty: D('0.01'),
    side: 'long',
    amount: D(amount),
    target: 'margin',
    uncollected: null,
  };
}

function spotFill(time: number, over: Partial<Fill>, catchUp?: CatchUpTag): EngineEvent {
  const fill: Fill = {
    id: `sf${time}`,
    orderId: 'o1',
    symbol: 'SOLUSDT',
    side: 'sell',
    qty: D(5),
    price: D(110),
    quote: D(550),
    liquidity: 'maker',
    feeAsset: 'USDT',
    fee: D('0.55'),
    feeUsd: D('0.55'),
    bestAtArrival: null,
    bestAtSubmit: null,
    slippageUsd: D(0),
    driftUsd: D(0),
    triggerPrice: null,
    realizedPnl: null,
    roundTripId: 'rt-1',
    time,
    ...over,
  };
  return { type: 'fill', time, fill, order: {} as never, ...(catchUp ? { catchUp } : {}) };
}

function trip(
  id: string,
  symbol: string,
  openedAt: number,
  closedAt: number,
  pnl: string,
  catchUp?: CatchUpTag,
): EngineEvent {
  return {
    type: 'round_trip_closed',
    time: closedAt,
    roundTrip: { id, symbol, openedAt, closedAt, pnl: D(pnl) },
    ...(catchUp ? { catchUp } : {}),
  };
}

/** A BTC long: opened at `open` (taker fee 0.4), closed at `close` (taker fee 0.39) with trading P&L `pnl`. */
function btcPerpTrade(id: string, open: number, close: number, pnl = '10'): SimEvent[] {
  const p = position({ id, openedAt: open });
  return [
    opened(p),
    perpFill(id, open, { fee: D('0.4'), feeUsd: D('0.4') }),
    perpFill(id, close, { side: 'sell', fee: D('0.39'), feeUsd: D('0.39'), realizedPnl: D(pnl) }),
    closed(p, close, pnl, '0.79'),
  ];
}

/**
 * The three closed trades of the trade-building examples: the BTC long scaled in and out with
 * funding paid, the ETH short liquidated at 20x, and the SOL round trip.
 */
function workedTrades(): SimEvent[] {
  const btc = position({ id: 'p1', openedAt: T0, entryPrice: D(61000) });
  const e0 = T0 + 10_000;
  const eth = position({ id: 'e1', symbol: 'ETHUSDT', side: 'short', leverage: 20, openedAt: e0, margin: D('148.5') });
  const s0 = T0 + 20_000;
  return [
    opened(btc),
    perpFill('p1', T0, { marginIn: D(60) }),
    perpFill('p1', T0 + 1000, { price: D(62000), liquidity: 'maker', fee: D('0.124'), feeUsd: D('0.124') }),
    perpFill('p1', T0 + 2000, {
      side: 'sell',
      price: D(63000),
      fee: D('0.315'),
      feeUsd: D('0.315'),
      realizedPnl: D(20),
    }),
    funding('p1', T0 + 3000, '-0.063'),
    perpFill('p1', T0 + 4000, {
      side: 'sell',
      price: D(59000),
      liquidity: 'maker',
      fee: D('0.118'),
      feeUsd: D('0.118'),
      realizedPnl: D(-20),
    }),
    closed(btc, T0 + 4000, '0', '0.857'),

    opened(eth),
    perpFill('e1', e0, {
      symbol: 'ETHUSDT',
      side: 'sell',
      qty: D(1),
      price: D(3000),
      fee: D('1.5'),
      feeUsd: D('1.5'),
      marginIn: D(150),
    }),
    {
      type: 'liquidation',
      market: 'perp',
      time: e0 + 5000,
      symbol: 'ETHUSDT',
      position: eth,
      markPrice: D(3140),
      marginLost: D('148.5'),
      tradingLoss: D(140),
      liquidationFee: D('8.5'),
      remainder: D(0),
      feeRateKnown: true,
      cancelledOrderIds: [],
    },
    closed(eth, e0 + 5000, '-140', '10', 'liquidated'),

    spotFill(s0, {
      side: 'buy',
      qty: D('10.00'),
      price: D(100),
      quote: D(1001),
      liquidity: 'taker',
      fee: D('0.01001'),
      feeAsset: 'SOL',
      feeUsd: D('1.001'),
    }),
    spotFill(s0 + 1000, { realizedPnl: D('48.95') }),
    spotFill(s0 + 2000, {
      qty: D('4.99'),
      price: D(105),
      quote: D('523.95'),
      fee: D('0.52395'),
      feeUsd: D('0.52395'),
      realizedPnl: D('23.92705'),
    }),
    trip('rt-1', 'SOLUSDT', s0, s0 + 2000, '72.87705'),
  ];
}

describe('computeStats: worked figures', () => {
  it('the three worked trades: fees by liquidity, liquidation fees, funding paid and money lost', () => {
    const r = computeStats(input({ events: rows(workedTrades()) }), ALL);
    expect(r.quality.count).toBe(3);
    expect(r.quality.wins).toBe(1);
    expect(r.quality.losses).toBe(2);
    expect(s(r.costs.takerFees)).toBe('3.116');
    expect(s(r.costs.makerFees)).toBe('1.31595');
    expect(s(r.costs.liquidationFees)).toBe('8.5');
    expect(s(r.costs.fundingPaid)).toBe('0.063');
    expect(s(r.risk.lostToLiquidations)).toBe('148.5');
    expect(r.risk.liquidations).toBe(1);
    expect(r.breakdowns.coin.map((b) => b.key)).toEqual(['BTC', 'ETH', 'SOL']);
    expect(r.estimated).toEqual({ trades: 0, fills: 0 });
  });
});

describe('computeStats: filters', () => {
  it('range boundary: a trade opened before `from` and closed inside counts; only its closing fee is a cost', () => {
    const events = rows([
      deposit(T0, 'leverage', '1000', '1000'),
      ...btcPerpTrade('p0', t(1), t(2)),
      ...btcPerpTrade('p1', t(2), t(5)),
    ]);
    const r = computeStats(input({ events }), { ...ALL, from: t(3) });
    expect(r.quality.count).toBe(1);
    expect(r.quality.best!.id).toBe('p1');
    expect(r.quality.best!.openedAt).toBe(t(2));
    expect(s(r.costs.takerFees)).toBe('0.39');
    expect(r.risk.maxLeverage).toBe(10);
  });

  it('coin + market: BTCUSDT on leverage is only the perp BTC trade and its costs', () => {
    const events = rows([
      deposit(T0, 'spot', '2000', '2000'),
      spotFill(t(1), {
        symbol: 'BTCUSDT',
        side: 'buy',
        qty: D('0.01'),
        price: D(80000),
        quote: D(800),
        liquidity: 'taker',
        fee: D('0.00001'),
        feeAsset: 'BTC',
        feeUsd: D('0.8'),
        roundTripId: 'rt-b',
      }),
      spotFill(t(2), {
        symbol: 'BTCUSDT',
        qty: D('0.00999'),
        price: D(90000),
        quote: D('899.1'),
        fee: D('0.8991'),
        feeUsd: D('0.8991'),
        realizedPnl: D('98.2009'),
        roundTripId: 'rt-b',
      }),
      trip('rt-b', 'BTCUSDT', t(1), t(2), '98.2009'),
      ...btcPerpTrade('p1', t(3), t(4)),
      opened(position({ id: 'e1', symbol: 'ETHUSDT', openedAt: t(5) })),
      perpFill('e1', t(5), { symbol: 'ETHUSDT', fee: D('1.5'), feeUsd: D('1.5') }),
    ]);
    const r = computeStats(input({ events }), { ...ALL, symbol: 'BTCUSDT', market: 'leverage' });
    expect(r.headline.scope).toEqual({ kind: 'coin', symbol: 'BTCUSDT', market: 'perp' });
    expect(r.quality.count).toBe(1);
    expect(r.quality.best!.id).toBe('p1');
    expect(r.breakdowns.market.map((b) => [b.key, b.count])).toEqual([['perp', 1]]);
    expect(s(r.costs.takerFees)).toBe('0.79');
    expect(s(r.costs.makerFees)).toBe('0');
    // The perp fills' P&L less their fees: −0.4 + (10 − 0.39).
    expect(s(r.headline.netPnl)).toBe('9.21');
    expect(r.open.count).toBe(0);

    const spot = computeStats(input({ events }), { ...ALL, symbol: 'BTCUSDT', market: 'spot' });
    expect(spot.quality.best!.id).toBe('rt-b');
    expect(s(spot.costs.takerFees)).toBe('0.8');
    expect(s(spot.costs.makerFees)).toBe('0.8991');

    const both = computeStats(input({ events }), { ...ALL, symbol: 'BTCUSDT' });
    expect(both.quality.count).toBe(2);
  });

  it('market only: the wallet scope, valued live, returns on its highest capital', () => {
    const events = rows([deposit(T0, 'spot', '1000', '1000'), transfer(t(1), 'spot', 'leverage', '300')]);
    const acct = account({
      total: D(1050),
      totalDeposited: D(1000),
      leverage: { free: D(320), locked: D(0), positions: [], value: D(320) },
    });
    const spot = computeStats(input({ events, account: acct }), { ...ALL, market: 'spot' });
    expect(spot.headline.scope).toEqual({ kind: 'wallet', wallet: 'spot' });
    expect(s(spot.headline.netPnl)).toBe('30');
    expect(s(spot.headline.currentValue)).toBe('730');
    expect(s(spot.headline.deposited)).toBe('700');
    expect(s(spot.headline.capitalMax)).toBe('1000');
    expect(s(spot.headline.returnPct)).toBe('0.03');
    expect(spot.headline.live).toBe(true);

    const lev = computeStats(input({ events, account: acct }), { ...ALL, market: 'leverage' });
    expect(s(lev.headline.netPnl)).toBe('20');
    expect(s(lev.headline.currentValue)).toBe('320');
    expect(s(lev.headline.deposited)).toBe('300');

    const all = computeStats(input({ events, account: acct }), ALL);
    expect(all.headline.scope).toEqual({ kind: 'account' });
    expect(s(all.headline.netPnl)).toBe('50');
    expect(s(all.headline.currentValue)).toBe('1050');
    expect(s(all.headline.deposited)).toBe('1000');
  });

  it('not live: the series ends at the last snapshot, without the live point', () => {
    const events = rows([deposit(T0, 'spot', '1000', '1000')]);
    const snapshots = [snap(t(1), '1010', '1000')];
    const acct = account({ total: D(1100), totalDeposited: D(1000) });
    const r = computeStats(input({ events, snapshots, account: acct, live: false }), ALL);
    expect(s(r.headline.netPnl)).toBe('10');
    expect(r.headline.live).toBe(false);
    expect(r.series.at(-1)!.time).toBe(t(1));
    expect(s(computeStats(input({ events, snapshots, account: acct }), ALL).headline.netPnl)).toBe('100');
  });

  it('a coin with an open position never marked: counted at 0 and not live', () => {
    const p = position({ id: 'p1', openedAt: t(1) });
    const events = rows([deposit(T0, 'leverage', '1000', '1000'), opened(p), perpFill('p1', t(1))]);
    const acct = account({
      totalDeposited: D(1000),
      leverage: {
        free: D(939.7),
        locked: D(0),
        value: D(999.7),
        positions: [
          {
            symbol: 'BTCUSDT',
            side: 'long',
            qty: D('0.01'),
            margin: D(60),
            markPrice: null,
            markFresh: false,
            markAt: null,
            unrealizedPnl: null,
          },
        ],
      },
    });
    const r = computeStats(input({ events, account: acct, positions: [p] }), { ...ALL, symbol: 'BTCUSDT' });
    expect(s(r.headline.netPnl)).toBe('-0.3');
    expect(r.headline.live).toBe(false);
    expect(r.open).toEqual({ count: 1, unrealized: null });
  });
});

describe('computeStats: estimated and unattributed', () => {
  it('one catch-up stop trade: estimated.trades 1, and it is flagged in best', () => {
    const events = rows([
      deposit(T0, 'spot', '2000', '2000'),
      spotFill(t(1), {
        side: 'buy',
        qty: D(10),
        price: D(80),
        quote: D(800),
        liquidity: 'taker',
        fee: D('0.01'),
        feeAsset: 'SOL',
        feeUsd: D('0.8'),
        roundTripId: 'rt-s',
      }),
      spotFill(
        t(5),
        {
          qty: D('9.99'),
          price: D(93),
          quote: D('929.07'),
          liquidity: 'taker',
          fee: D('0.92907'),
          feeUsd: D('0.92907'),
          triggerPrice: D(95),
          realizedPnl: D('128.14093'),
          roundTripId: 'rt-s',
        },
        worst,
      ),
      trip('rt-s', 'SOLUSDT', t(1), t(5), '128.14093', worst),
      ...btcPerpTrade('p1', t(6), t(7), '0'),
    ]);
    const r = computeStats(input({ events }), ALL);
    expect(r.estimated).toEqual({ trades: 1, fills: 1 });
    expect(r.quality.best!.id).toBe('rt-s');
    expect(r.quality.best!.estimated).toBe(true);
    expect(r.quality.worst!.id).toBe('p1');
    expect(r.quality.worst!.estimated).toBe(false);
    // The stop gapped 2 below its trigger on 9.99 coins.
    expect(s(r.costs.catchUpGapCost)).toBe('19.98');
  });

  it('a dust sale with no closed trip before it is reported, not lost', () => {
    const events = rows([
      deposit(T0, 'spot', '100', '100'),
      spotFill(t(1), {
        qty: D('0.01'),
        price: D(600),
        quote: D(6),
        fee: D('0.006'),
        feeUsd: D('0.006'),
        realizedPnl: D('4.993'),
        roundTripId: null,
      }),
    ]);
    const r = computeStats(input({ events }), ALL);
    expect(r.quality.count).toBe(0);
    expect(r.unattributed.count).toBe(1);
    expect(s(r.unattributed.realized)).toBe('4.993');
    expect(computeStats(input({ events }), { ...ALL, market: 'leverage' }).unattributed.count).toBe(0);
    expect(computeStats(input({ events }), { ...ALL, from: t(2) }).unattributed.count).toBe(0);
  });
});

describe('computeStats: benchmark', () => {
  const deposits = rows([deposit(t(0), 'spot', '1000', '1000'), deposit(t(2), 'spot', '500', '1500')]);
  const buys = [
    { depositEventId: 1, price: D(80000) },
    { depositEventId: 2, price: D(75000) },
  ];

  it('no range: every buy valued at the current bid, against the deposits', () => {
    const r = computeStats(input({ events: deposits, benchmarkBuys: buys, btcBid: D(90000) }), ALL);
    expect(r.benchmark.scope).toBe('account');
    expect(r.benchmark.missing).toBe(0);
    expect(s(r.benchmark.value)).toBe('1723.1756');
    expect(s(r.benchmark.pnl)).toBe('223.1756');
    expect(s(r.benchmark.returnPct)).toBe(s(D('223.1756').div(1500)));
    expect(computeStats(input({ events: deposits, benchmarkBuys: buys }), ALL).benchmark.value).toBeNull();
  });

  it('a range: measured at the btc_bid of the snapshots that give the start and the end', () => {
    const snapshots = [snap(t(1), '1000', '1000', '80000'), snap(t(3), '1500', '1500', '90000')];
    const base = input({ events: deposits, snapshots, benchmarkBuys: buys, btcBid: D(100000) });
    const r = computeStats(base, { ...ALL, from: t(1), to: t(3) });
    // Start: 0.0124875 BTC at 80000 = 999 against 1000. End: 1723.1756 against 1500.
    expect(s(r.benchmark.pnl)).toBe('224.1756');
    expect(s(r.benchmark.value)).toBe('1723.1756');
    expect(r.benchmark.series.map((p) => [p.time, s(p.value)])).toEqual([
      [t(1), '999'],
      [t(3), '1723.1756'],
    ]);
    // Up to t1 only: from the zero origin to 999 held against 1000 deposited.
    expect(s(computeStats(base, { ...ALL, to: t(1) }).benchmark.pnl)).toBe('-1');
    // A coin filter does not change it.
    expect(s(computeStats(base, { ...ALL, from: t(1), to: t(3), symbol: 'SOLUSDT' }).benchmark.pnl)).toBe('224.1756');
  });

  it('a deposit with no BTC price leaves every figure null and is counted', () => {
    const r = computeStats(input({ events: deposits, benchmarkBuys: [buys[0]!], btcBid: D(90000) }), ALL);
    expect(r.benchmark.missing).toBe(1);
    expect([r.benchmark.value, r.benchmark.pnl, r.benchmark.returnPct]).toEqual([null, null, null]);
    const zero = computeStats(
      input({ events: deposits, benchmarkBuys: [buys[0]!, { depositEventId: 2, price: D(0) }], btcBid: D(90000) }),
      ALL,
    );
    expect(zero.benchmark.missing).toBe(1);
    expect(zero.benchmark.pnl).toBeNull();
  });
});

describe('computeStats: empty', () => {
  it('no events and no snapshots: every figure null or 0, no throw', () => {
    const filters: StatsFilter[] = [
      ALL,
      { ...ALL, market: 'spot' },
      { ...ALL, market: 'leverage' },
      { ...ALL, symbol: 'BTCUSDT' },
      { ...ALL, from: t(1), to: t(2) },
    ];
    for (const filter of filters) {
      const r = computeStats(input(), filter);
      expect(s(r.headline.netPnl)).toBe('0');
      expect(r.headline.returnPct).toBeNull();
      expect(s(r.drawdown.maxUsd)).toBe('0');
      expect(r.drawdown.maxPct).toBeNull();
      expect(r.quality.count).toBe(0);
      expect(r.quality.winRate).toBeNull();
      expect(r.quality.best).toBeNull();
      expect(r.risk.liquidations).toBe(0);
      expect(r.risk.avgLeverage).toBeNull();
      expect(s(r.costs.total)).toBe('0');
      expect(r.costs.share).toBeNull();
      expect(r.breakdowns.coin).toEqual([]);
      expect(r.benchmark.missing).toBe(0);
      expect(s(r.benchmark.pnl)).toBe('0');
      expect(r.benchmark.returnPct).toBeNull();
      expect(r.open).toEqual({ count: 0, unrealized: D(0) });
      expect(r.unattributed.count).toBe(0);
      expect(r.estimated).toEqual({ trades: 0, fills: 0 });
    }
  });
});

// ---- the real engine ----

function book(bid: string, ask: string, qty = '100'): BookSnapshot {
  return { bids: [{ price: D(bid), qty: D(qty) }], asks: [{ price: D(ask), qty: D(qty) }] };
}

describe('computeStats against the real engine', () => {
  it('Σ over coins of coin-scope Net P&L + uncovered losses == the account net P&L, exactly', () => {
    const spotMarket = new FakeMarket();
    const solRules = { ...btcRules, symbol: 'SOLUSDT', base: 'SOL', stepSize: D('0.01'), minQty: D('0.01') };
    spotMarket.setRules('SOLUSDT', solRules);
    spotMarket.setFresh('SOLUSDT', true);
    const sol = (bid: string, ask: string) => {
      spotMarket.setBook('SOLUSDT', book(bid, ask));
      spotMarket.setAvgPrice('SOLUSDT', D(bid));
      spotMarket.setLastPrice('SOLUSDT', D(bid));
    };

    const perpMarket = new FakePerpMarket();
    const ethRules = { ...btcPerpRules, symbol: 'ETHUSDT', base: 'ETH', tickSize: D('0.01'), minPrice: D('1') };
    perpMarket.setRules('ETHUSDT', ethRules);
    perpMarket.setBrackets('ETHUSDT', brackets([['0', '1000000', '0.005', '0', 100]]));
    perpMarket.setFresh('ETHUSDT', true);
    perpMarket.setMarkFresh('ETHUSDT', true);
    const perpAt = (symbol: string, bid: string, ask: string, mark: string) => {
      perpMarket.setBook(symbol, book(bid, ask, '10'));
      perpMarket.setMarkPrice(symbol, D(mark));
      perpMarket.setLastPrice(symbol, D(mark));
    };

    const { rng, newId } = testCtx(spotMarket);
    const ctx: SimCtx = {
      now: T0,
      rng,
      newId,
      spotMarket,
      perpMarket,
      fees: { spot: { maker: D('0.001'), taker: D('0.001') }, perp: { maker: D('0.0002'), taker: D('0.0005') } },
    };
    const ledger = emptyLedger(['USDT', 'BTC', 'SOL']);
    const sim = new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));

    const events: StatsEvent[] = [];
    const record = (list: SimEvent[]) => {
      for (const event of list) events.push({ id: events.length + 1, time: event.time, event });
    };
    const ok = (r: ActionResult) => {
      if (!r.ok) throw new Error(r.reason);
      record(r.events);
    };
    const at = (time: number) => {
      ctx.now = time;
    };
    const execute = (...order: ['spot', SpotOrderRequest] | ['perp', PerpOrderRequest]) => {
      const placed = order[0] === 'spot' ? sim.submit('spot', order[1], ctx) : sim.submit('perp', order[1], ctx);
      record(placed);
      const e = placed[0];
      if (placed.length !== 1 || e?.type !== 'order_placed') throw new Error(`not placed: ${JSON.stringify(placed)}`);
      ctx.now = Math.max(ctx.now, e.order.arrivesAt!);
      record(sim.arrive(order[0], e.order.id, ctx));
    };

    at(t(0));
    ok(sim.deposit('spot', D(2000), ctx));
    ok(sim.deposit('leverage', D(200), ctx));

    // SOL round trip: buy 10, sell 5 higher, sell all but dust lower; the dust stays held.
    at(t(1));
    sol('99.9', '100');
    execute('spot', { symbol: 'SOLUSDT', side: 'buy', type: 'market', qty: '10' });
    at(t(2));
    sol('110', '110.1');
    execute('spot', { symbol: 'SOLUSDT', side: 'sell', type: 'market', qty: '5' });
    at(t(3));
    sol('105', '105.1');
    execute('spot', { symbol: 'SOLUSDT', side: 'sell', type: 'market', qty: '4.98' });

    // BTC long held through a funding settlement, closed higher.
    at(t(4));
    execute('perp', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' });
    const fundingTime = t(6);
    at(fundingTime - 15_000);
    sim.openFundingWindow('BTCUSDT', fundingTime, ctx);
    at(fundingTime + 15_000);
    sim.closeFundingWindow('BTCUSDT', fundingTime, ctx);
    at(fundingTime + 60_000);
    record(sim.applyFunding('BTCUSDT', fundingTime, D('0.0001'), D('80000'), ctx));
    at(t(8));
    perpAt('BTCUSDT', '80500', '80510', '80500');
    execute('perp', { symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.01', reduceOnly: true });

    // ETH short 1 at 20x, liquidated as the mark rises.
    at(t(9));
    perpAt('ETHUSDT', '3000', '3000.5', '3000');
    execute('perp', { symbol: 'ETHUSDT', side: 'sell', type: 'market', qty: '1' });
    at(t(10));
    perpMarket.setMarkPrice('ETHUSDT', D(3140));
    record(sim.onMark('ETHUSDT', D(3140), ctx).events);

    // A BTC long still open at the end, valued at the mark.
    at(t(11));
    execute('perp', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' });
    perpAt('BTCUSDT', '80900', '80910', '81000');
    sol('120', '120.1');

    const types = new Set(events.map((e) => e.event.type));
    for (const type of ['funding', 'liquidation', 'round_trip_closed', 'position_closed']) expect(types).toContain(type);

    const quote = (price: Decimal | null) => (price === null ? null : { price, fresh: true });
    const acct = valueAccount(
      sim,
      (symbol) => quote(spotMarket.best(symbol, 'sell')),
      { mark: (symbol) => quote(perpMarket.markPrice(symbol)) },
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    );
    const base = input({
      events,
      now: ctx.now,
      account: acct,
      basis: sim.spot.state.basis,
      positions: Object.values(sim.perp.state.positions),
    });

    const whole = computeStats(base, ALL);
    expect(whole.quality.count).toBe(3);
    expect(whole.open.count).toBe(1);
    expect(whole.risk.liquidations).toBe(1);
    expect(s(whole.headline.netPnl)).toBe(s(acct.netPnl));
    expect(acct.netPnl.isZero()).toBe(false);

    const coins = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const sum = coins.reduce((acc, symbol) => acc.plus(computeStats(base, { ...ALL, symbol }).headline.netPnl), D(0));
    expect(s(sum.plus(whole.costs.uncovered))).toBe(s(acct.netPnl));

    // The two markets of BTC add up to the coin.
    const btc = computeStats(base, { ...ALL, symbol: 'BTCUSDT' }).headline.netPnl;
    const btcPerp = computeStats(base, { ...ALL, symbol: 'BTCUSDT', market: 'leverage' }).headline.netPnl;
    const btcSpot = computeStats(base, { ...ALL, symbol: 'BTCUSDT', market: 'spot' }).headline.netPnl;
    expect(s(btcPerp.plus(btcSpot))).toBe(s(btc));
  });
});
