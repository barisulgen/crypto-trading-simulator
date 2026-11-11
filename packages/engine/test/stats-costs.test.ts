import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { CatchUpTag } from '../src/catchup/types.ts';
import type { PerpFill, Position } from '../src/perp/types.ts';
import type { SimEvent } from '../src/sim.ts';
import { costs, risk } from '../src/stats/costs.ts';
import type { StatsEvent } from '../src/stats/types.ts';
import type { Fill } from '../src/types.ts';

const T0 = 1_700_000_000_000;
const worst: CatchUpTag = { from: T0, to: T0 + 60_000, basis: 'candle_worst_price' };
const replay: CatchUpTag = { from: T0, to: T0 + 60_000, basis: 'aggtrade_replay' };

let n = 0;
function row(event: SimEvent, time = T0): StatsEvent {
  return { id: ++n, time, event };
}

function fillBase(over: Partial<Fill>): Fill {
  return {
    id: `f${++n}`,
    orderId: 'o1',
    symbol: 'BTCUSDT',
    side: 'buy',
    qty: D(1),
    price: D(100),
    quote: D(100),
    liquidity: 'taker',
    feeAsset: 'USDT',
    fee: D(0),
    feeUsd: D(0),
    bestAtArrival: null,
    bestAtSubmit: null,
    slippageUsd: D(0),
    driftUsd: D(0),
    triggerPrice: null,
    realizedPnl: null,
    roundTripId: null,
    time: T0,
    ...over,
  };
}

function spot(over: Partial<Fill>, catchUp?: CatchUpTag): StatsEvent {
  return row({
    type: 'fill',
    market: 'spot',
    time: T0,
    fill: fillBase(over),
    order: {} as never,
    ...(catchUp ? { catchUp } : {}),
  } as SimEvent);
}

function perp(over: Partial<PerpFill>, catchUp?: CatchUpTag): StatsEvent {
  const fill = { ...fillBase(over), market: 'perp', positionId: 'p1', marginIn: null, uncovered: null, ...over } as PerpFill;
  return row({
    type: 'fill',
    market: 'perp',
    time: T0,
    fill,
    order: {} as never,
    ...(catchUp ? { catchUp } : {}),
  } as SimEvent);
}

function fundingRow(amount: string, uncollected: string | null = null): StatsEvent {
  return row({
    type: 'funding',
    market: 'perp',
    time: T0,
    symbol: 'BTCUSDT',
    positionId: 'p1',
    fundingTime: T0,
    rate: D('0.0001'),
    markPrice: D(60000),
    qty: D(1),
    side: 'long',
    amount: D(amount),
    target: 'margin',
    uncollected: uncollected === null ? null : D(uncollected),
  });
}

function position(id: string, leverage: number, openedAt = T0): Position {
  return {
    id,
    symbol: 'BTCUSDT',
    side: 'long',
    qty: D(1),
    entryPrice: D(100),
    leverage,
    margin: D(10),
    openedAt,
    realizedPnl: D(0),
    fees: D(0),
    funding: D(0),
    warnLevel: 0,
  };
}

function opened(p: Position): StatsEvent {
  return row({ type: 'position_opened', market: 'perp', time: p.openedAt, position: p });
}

function closed(p: Position, time: number): StatsEvent {
  return row({
    type: 'position_closed',
    market: 'perp',
    time,
    position: { ...p, qty: D(0) },
    exitPrice: D(100),
    realizedPnl: D(0),
    fees: D(0),
    funding: D(0),
    holdMs: time - p.openedAt,
    reason: 'closed',
  });
}

function liquidation(time: number, marginLost: string, fee: string): StatsEvent {
  return row(
    {
      type: 'liquidation',
      market: 'perp',
      time,
      symbol: 'BTCUSDT',
      position: position('pl', 10),
      markPrice: D(90),
      marginLost: D(marginLost),
      tradingLoss: D(0),
      liquidationFee: D(fee),
      remainder: D(0),
      feeRateKnown: true,
      cancelledOrderIds: [],
    },
    time,
  );
}

const s = (d: { toString(): string }) => d.toString();

describe('costs', () => {
  it('sums maker and taker fees, spot by feeUsd and perp by the charged fee', () => {
    const c = costs(
      [
        spot({ liquidity: 'taker', feeUsd: D('0.30') }),
        spot({ liquidity: 'maker', feeUsd: D('0.124') }),
        perp({ liquidity: 'taker', fee: D('1.5'), feeUsd: D('1.4999') }),
        perp({ liquidity: 'maker', fee: D('0.55'), feeUsd: D('0.5499') }),
        liquidation(T0, '100', '8.5'),
      ],
      D(0),
    );
    expect(s(c.takerFees)).toBe('1.8');
    expect(s(c.makerFees)).toBe('0.674');
    expect(s(c.liquidationFees)).toBe('8.5');
  });

  it('counts funding paid and received', () => {
    const c = costs([fundingRow('-0.063')], D(0));
    expect(s(c.fundingPaid)).toBe('0.063');
    expect(s(c.fundingReceived)).toBe('0');
    expect(s(c.fundingNet)).toBe('-0.063');
  });

  const shareEvents = () => [
    spot({ liquidity: 'taker', feeUsd: D(15) }),
    spot({ liquidity: 'maker', feeUsd: D(3) }),
    fundingRow('-4'),
    fundingRow('2'),
    spot({ slippageUsd: D(5) }),
  ];

  it('computes the cost share of the P&L before costs', () => {
    // funding net is -2, so total = 15 + 3 + 5 + 2 = 25
    const a = costs(shareEvents(), D(75));
    expect(s(a.total)).toBe('25');
    expect(s(a.preCost)).toBe('100');
    expect(s(a.share!)).toBe('0.25');
    const b = costs(shareEvents(), D(-10));
    expect(s(b.preCost)).toBe('15');
    expect(b.share!.toFixed(4)).toBe('1.6667');
    const c = costs(shareEvents(), D(-30));
    expect(s(c.preCost)).toBe('-5');
    expect(c.share).toBeNull();
  });

  it('adds nothing for funding when it was net received', () => {
    const c = costs([fundingRow('-2'), fundingRow('6')], D(10));
    expect(s(c.fundingNet)).toBe('4');
    expect(s(c.total)).toBe('0');
  });

  it('adds the catch-up gap cost to slippage', () => {
    const c = costs(
      [
        spot({ side: 'sell', price: D('98.5'), qty: D(2), triggerPrice: D(100), slippageUsd: D('0.2') }, worst),
        spot(
          { side: 'buy', price: D('50.4'), qty: D(10), triggerPrice: D(50) },
          { ...worst, basis: 'trigger_minute_worst_price' },
        ),
        spot({ side: 'sell', price: D(105), qty: D(1), triggerPrice: D(100) }, worst),
        spot({ side: 'sell', price: D(90), qty: D(1), triggerPrice: D(100) }, replay),
        spot({ side: 'sell', price: D(90), qty: D(1), triggerPrice: D(100) }),
      ],
      D(0),
    );
    expect(s(c.catchUpGapCost)).toBe('7');
    expect(s(c.slippage)).toBe('7.2');
    expect(c.estimatedFills).toBe(4);
  });

  it('keeps drift out of the total', () => {
    const c = costs([spot({ driftUsd: D('1.2') }), spot({ driftUsd: D('-0.5') })], D(0));
    expect(s(c.drift)).toBe('0.7');
    expect(s(c.total)).toBe('0');
  });

  it('sums uncovered losses and still counts them', () => {
    const c = costs([perp({ uncovered: D('0.4'), fee: D(1) }), fundingRow('-0.3', '0.1')], D(0));
    expect(s(c.uncovered)).toBe('0.5');
    expect(s(c.takerFees)).toBe('1');
    expect(s(c.fundingPaid)).toBe('0.3');
  });

  it('is all zero with no events', () => {
    const c = costs([], D(0));
    const keys = [
      'makerFees',
      'takerFees',
      'liquidationFees',
      'fundingPaid',
      'fundingReceived',
      'fundingNet',
      'slippage',
      'catchUpGapCost',
      'drift',
      'total',
      'preCost',
      'uncovered',
    ] as const;
    for (const k of keys) expect(s(c[k])).toBe('0');
    expect(c.share).toBeNull();
    expect(c.estimatedFills).toBe(0);
  });
});

describe('risk', () => {
  const all = { from: null, to: null };

  it('counts liquidations in the range', () => {
    const events = [
      liquidation(T0 + 10, '100', '5'),
      liquidation(T0 + 20, '48.5', '3.5'),
      liquidation(T0 + 1000, '9', '1'),
    ];
    const r = risk(events, [], { from: T0, to: T0 + 100 });
    expect(r.liquidations).toBe(2);
    expect(s(r.lostToLiquidations)).toBe('148.5');
    expect(s(r.liquidationFees)).toBe('8.5');
    expect(risk(events, [], { from: T0 + 20, to: T0 + 20 }).liquidations).toBe(1);
  });

  it('averages leverage over positions and adds open ones', () => {
    const ps = [position('a', 5), position('b', 20), position('c', 2), position('d', 10)];
    const events = ps.flatMap((p) => [opened(p), closed(p, T0 + 1000)]);
    const r = risk(events, [], all);
    expect(s(r.avgLeverage!)).toBe('9.25');
    expect(r.maxLeverage).toBe(20);
    const r2 = risk(events, [position('e', 50)], all);
    expect(s(r2.avgLeverage!)).toBe('17.4');
    expect(r2.maxLeverage).toBe(50);
  });

  it('counts a position once when it is both in the events and open', () => {
    const p = position('a', 4);
    const r = risk([opened(p)], [p], all);
    expect(s(r.avgLeverage!)).toBe('4');
  });

  it('keeps only positions open at some moment of the range', () => {
    const early = position('early', 3, T0);
    const late = position('late', 7, T0 + 5000);
    const mid = position('mid', 11, T0 + 1000);
    const events = [opened(early), closed(early, T0 + 500), opened(mid), closed(mid, T0 + 3000), opened(late)];
    const r = risk(events, [], { from: T0 + 1000, to: T0 + 2000 });
    expect(s(r.avgLeverage!)).toBe('11');
    expect(r.maxLeverage).toBe(11);
    const r2 = risk(events, [], { from: T0 + 600, to: T0 + 5000 });
    expect(r2.maxLeverage).toBe(11);
    expect(s(r2.avgLeverage!)).toBe('9');
  });

  it('takes the highest leverage of 200,000 positions without overflowing the stack', () => {
    const open = Array.from({ length: 200_000 }, (_, i) => position(`p${i}`, i === 123_456 ? 125 : 1 + (i % 20)));
    expect(risk([], open, all).maxLeverage).toBe(125);
  });

  it('is empty with no events', () => {
    const r = risk([], [], all);
    expect(r.liquidations).toBe(0);
    expect(s(r.lostToLiquidations)).toBe('0');
    expect(s(r.liquidationFees)).toBe('0');
    expect(r.avgLeverage).toBeNull();
    expect(r.maxLeverage).toBeNull();
  });
});
