import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import type { CatchUpTag } from '../src/catchup/types.ts';
import type { PerpEvent, PerpFill, Position } from '../src/perp/types.ts';
import type { SimEvent } from '../src/sim.ts';
import { buildTrades } from '../src/stats/trades.ts';
import type { StatsEvent } from '../src/stats/types.ts';
import type { EngineEvent, Fill } from '../src/types.ts';

const T0 = 1_700_000_000_000;
const tag: CatchUpTag = { from: T0, to: T0 + 60_000, basis: 'candle_worst_price' };

function rows(events: { time: number; event: SimEvent }[]): StatsEvent[] {
  return events.map((e, i) => ({ id: i + 1, time: e.time, event: e.event }));
}

function position(over: Partial<Position> & { id: string }): Position {
  return {
    symbol: 'BTCUSDT',
    side: 'long',
    qty: D(0),
    entryPrice: D(61000),
    leverage: 10,
    margin: D(0),
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
    id: `f${time}`,
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

function funding(positionId: string, time: number, amount: string, target: 'margin' | 'wallet' = 'margin'): PerpEvent {
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
    target,
    uncollected: null,
  };
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
    position: p,
    exitPrice: D(59000),
    realizedPnl: D(realizedPnl),
    fees: D(fees),
    funding: D(0),
    holdMs: time - p.openedAt,
    reason,
  };
}

function opened(p: Position): PerpEvent {
  return { type: 'position_opened', market: 'perp', time: p.openedAt, position: p };
}

function btcLong(id: string, openedAt: number, closeAt: number, withCatchUp = false) {
  const p = position({ id, openedAt, qty: D('0.01') });
  const cu = withCatchUp ? { catchUp: tag } : {};
  return [
    { time: openedAt, event: opened(p) },
    { time: openedAt, event: perpFill(id, openedAt) },
    { time: closeAt - 1, event: { ...perpFill(id, closeAt - 1, { side: 'sell', realizedPnl: D(0) }), ...cu } as PerpEvent },
    { time: closeAt, event: { ...closed(p, closeAt, '0', '0.857'), ...cu } as PerpEvent },
  ];
}

describe('buildTrades: perp', () => {
  it('partial closes, adds and funding make ONE trade', () => {
    const p = position({ id: 'p1', openedAt: T0 });
    const list = rows([
      { time: T0, event: opened(p) },
      { time: T0, event: perpFill('p1', T0, { marginIn: D(60) }) },
      {
        time: T0 + 1000,
        event: perpFill('p1', T0 + 1000, { price: D(62000), liquidity: 'maker', fee: D('0.124'), feeUsd: D('0.124') }),
      },
      {
        time: T0 + 2000,
        event: perpFill('p1', T0 + 2000, {
          side: 'sell',
          price: D(63000),
          fee: D('0.315'),
          feeUsd: D('0.315'),
          realizedPnl: D(20),
        }),
      },
      { time: T0 + 3000, event: funding('p1', T0 + 3000, '-0.063') },
      {
        time: T0 + 4000,
        event: perpFill('p1', T0 + 4000, {
          side: 'sell',
          price: D(59000),
          liquidity: 'maker',
          fee: D('0.118'),
          feeUsd: D('0.118'),
          realizedPnl: D(-20),
        }),
      },
      { time: T0 + 4000, event: closed(p, T0 + 4000, '0', '0.857') },
    ]);
    const { trades, open } = buildTrades(list);
    expect(open).toEqual([]);
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.result.toString()).toBe('-0.92');
    expect(t.fees.toString()).toBe('0.857');
    expect(t.funding.toString()).toBe('-0.063');
    expect(t.side).toBe('long');
    expect(t.leverage).toBe(10);
    expect(t.reason).toBe('closed');
    expect(t.market).toBe('perp');
    expect(t.symbol).toBe('BTCUSDT');
    expect(t.openedAt).toBe(T0);
    expect(t.closedAt).toBe(T0 + 4000);
    expect(t.closeEventId).toBe(7);
    expect(t.estimated).toBe(false);
  });

  it('post-close funding belongs to the same trade: -0.93', () => {
    const p = position({ id: 'p1', openedAt: T0 });
    const list = rows([
      { time: T0, event: opened(p) },
      { time: T0 + 3000, event: funding('p1', T0 + 3000, '-0.063') },
      { time: T0 + 4000, event: closed(p, T0 + 4000, '0', '0.857') },
      { time: T0 + 14000, event: funding('p1', T0 + 14000, '-0.01', 'wallet') },
    ]);
    const { trades } = buildTrades(list);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.result.toString()).toBe('-0.93');
    expect(trades[0]!.funding.toString()).toBe('-0.073');
    expect(trades[0]!.closedAt).toBe(T0 + 4000);
  });

  it('a liquidation ends the trade: ETH short 20x', () => {
    const p = position({ id: 'e1', symbol: 'ETHUSDT', side: 'short', leverage: 20, openedAt: T0, margin: D('148.5') });
    const list = rows([
      { time: T0, event: opened(p) },
      {
        time: T0,
        event: perpFill('e1', T0, {
          symbol: 'ETHUSDT',
          side: 'sell',
          qty: D(1),
          price: D(3000),
          fee: D('1.5'),
          feeUsd: D('1.5'),
          marginIn: D(150),
        }),
      },
      {
        time: T0 + 5000,
        event: {
          type: 'liquidation',
          market: 'perp',
          time: T0 + 5000,
          symbol: 'ETHUSDT',
          position: p,
          markPrice: D(3140),
          marginLost: D('148.5'),
          tradingLoss: D(140),
          liquidationFee: D('8.5'),
          remainder: D(0),
          feeRateKnown: true,
          cancelledOrderIds: [],
        },
      },
      { time: T0 + 5000, event: closed(p, T0 + 5000, '-140', '10', 'liquidated') },
    ]);
    const t = buildTrades(list).trades[0]!;
    expect(t.result.toString()).toBe('-150');
    expect(t.reason).toBe('liquidated');
    expect(t.side).toBe('short');
    expect(t.leverage).toBe(20);
    expect(t.symbol).toBe('ETHUSDT');
  });

  it('two positions on BTC in a row are two trades, ordered by close', () => {
    const list = rows([...btcLong('p1', T0, T0 + 10_000), ...btcLong('p2', T0 + 20_000, T0 + 30_000)]);
    const { trades } = buildTrades(list);
    expect(trades.map((t) => t.id)).toEqual(['p1', 'p2']);
  });

  it('an open position is in `open`, not in trades', () => {
    const p = position({ id: 'p1', openedAt: T0, qty: D('0.01') });
    const list = rows([
      { time: T0, event: opened(p) },
      { time: T0, event: perpFill('p1', T0) },
      { time: T0 + 100, event: funding('p1', T0 + 100, '-0.01') },
    ]);
    const { trades, open } = buildTrades(list);
    expect(trades).toEqual([]);
    expect(open).toEqual([{ market: 'perp', symbol: 'BTCUSDT', id: 'p1' }]);
  });
});

function spotFill(id: string, time: number, over: Partial<Fill>): EngineEvent {
  const fill: Fill = {
    id,
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
  return { type: 'fill', time, fill, order: {} as never };
}

function trip(id: string, openedAt: number, closedAt: number, pnl: string, catchUp?: CatchUpTag): EngineEvent {
  return {
    type: 'round_trip_closed',
    time: closedAt,
    roundTrip: { id, symbol: 'SOLUSDT', openedAt, closedAt, pnl: D(pnl) },
    ...(catchUp ? { catchUp } : {}),
  };
}

function solTrip(extra: { time: number; event: SimEvent }[] = [], catchUp?: CatchUpTag) {
  return [
    {
      time: T0,
      event: spotFill('b1', T0, {
        side: 'buy',
        qty: D('10.00'),
        price: D(100),
        quote: D(1001),
        liquidity: 'taker',
        fee: D('0.01001'),
        feeAsset: 'SOL',
        feeUsd: D('1.001'),
      }),
    },
    { time: T0 + 1000, event: spotFill('s1', T0 + 1000, { realizedPnl: D('48.95') }) },
    {
      time: T0 + 2000,
      event: spotFill('s2', T0 + 2000, {
        qty: D('4.99'),
        price: D(105),
        quote: D('523.95'),
        fee: D('0.52395'),
        feeUsd: D('0.52395'),
        realizedPnl: D('23.92705'),
      }),
    },
    { time: T0 + 2000, event: trip('rt-1', T0, T0 + 2000, '72.87705', catchUp) },
    ...extra,
  ];
}

describe('buildTrades: spot', () => {
  it('a round trip is one long trade with no leverage', () => {
    const { trades, open } = buildTrades(rows(solTrip()));
    expect(open).toEqual([]);
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.id).toBe('rt-1');
    expect(t.market).toBe('spot');
    expect(t.symbol).toBe('SOLUSDT');
    expect(t.result.toString()).toBe('72.87705');
    expect(t.side).toBe('long');
    expect(t.leverage).toBeNull();
    expect(t.reason).toBe('round_trip');
    expect(t.openedAt).toBe(T0);
    expect(t.closedAt).toBe(T0 + 2000);
    expect(t.closeEventId).toBe(4);
    expect(t.funding.toString()).toBe('0');
    expect(t.fees.toString()).toBe('2.07495');
  });

  it('every sell fill of a closed trip carries its roundTripId, and the result is their P&L', () => {
    const list = rows(solTrip());
    const sells = list
      .map((r) => r.event)
      .filter((e): e is Extract<EngineEvent, { type: 'fill' }> => e.type === 'fill' && e.fill.side === 'sell');
    expect(sells).toHaveLength(2);
    expect(sells.every((e) => e.fill.roundTripId === 'rt-1')).toBe(true);
    const sum = sells.reduce((a, e) => a.plus(e.fill.realizedPnl ?? 0), D(0));
    expect(buildTrades(list).trades[0]!.result.toString()).toBe(sum.toString());
  });

  it("a dust sale joins the coin's latest closed trip: result changes, close time does not", () => {
    const dust = {
      time: T0 + 100_000,
      event: spotFill('s3', T0 + 100_000, {
        qty: D('0.01'),
        price: D(600),
        quote: D(6),
        fee: D('0.006'),
        feeUsd: D('0.006'),
        realizedPnl: D('4.993'),
        roundTripId: null,
      }),
    };
    const { trades } = buildTrades(rows(solTrip([dust])));
    expect(trades).toHaveLength(1);
    expect(trades[0]!.result.toString()).toBe('77.87005');
    expect(trades[0]!.closedAt).toBe(T0 + 2000);
    expect(trades[0]!.fees.toString()).toBe('2.08095');
  });

  it('an open round trip is in `open`, not in trades', () => {
    const { trades, open } = buildTrades(rows([solTrip()[0]!]));
    expect(trades).toEqual([]);
    expect(open).toEqual([{ market: 'spot', symbol: 'SOLUSDT', id: 'rt-1' }]);
  });
});

describe('buildTrades: estimated', () => {
  it('a perp trade is estimated when any of its events carries catchUp', () => {
    expect(buildTrades(rows(btcLong('p1', T0, T0 + 10_000, true))).trades[0]!.estimated).toBe(true);
    expect(buildTrades(rows(btcLong('p1', T0, T0 + 10_000))).trades[0]!.estimated).toBe(false);
  });

  it('a perp trade is estimated when only its funding carries catchUp', () => {
    const list = rows([
      ...btcLong('p1', T0, T0 + 10_000),
      { time: T0 + 5000, event: { ...funding('p1', T0 + 5000, '-0.01'), catchUp: tag } },
    ]);
    expect(buildTrades(list).trades[0]!.estimated).toBe(true);
  });

  it('a spot trade is estimated when its round_trip_closed carries catchUp', () => {
    expect(buildTrades(rows(solTrip([], tag))).trades[0]!.estimated).toBe(true);
    expect(buildTrades(rows(solTrip())).trades[0]!.estimated).toBe(false);
  });
});
