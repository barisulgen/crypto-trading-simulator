import { describe, expect, it } from 'vitest';
import { D, type Decimal } from '../src/decimal.ts';
import type { PerpEvent, PerpFill, Position } from '../src/perp/types.ts';
import type { SimEvent } from '../src/sim.ts';
import { capitalAt, drawdown, pnlSeries, rangePnl, type Scope, type Snapshot } from '../src/stats/equity.ts';
import type { StatsEvent } from '../src/stats/types.ts';
import type { EngineEvent, Fill, Wallet } from '../src/types.ts';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const t = (n: number) => T0 + n * MIN;

const ACCOUNT: Scope = { kind: 'account' };
const SPOT: Scope = { kind: 'wallet', wallet: 'spot' };
const LEVERAGE: Scope = { kind: 'wallet', wallet: 'leverage' };

function rows(events: SimEvent[]): StatsEvent[] {
  return events.map((e, i) => ({ id: i + 1, time: e.time, event: e }));
}

function deposit(time: number, wallet: Wallet, amount: string, totalDeposited: string): EngineEvent {
  return { type: 'deposit', time, wallet, amount: D(amount), totalDeposited: D(totalDeposited) };
}

function transfer(time: number, from: Wallet, to: Wallet, amount: string): EngineEvent {
  return { type: 'transfer', time, from, to, amount: D(amount) };
}

function snap(time: number, total: string, deposited: string, spotValue = total, leverageValue = '0'): Snapshot {
  return {
    time,
    total: D(total),
    deposited: D(deposited),
    spotValue: D(spotValue),
    leverageValue: D(leverageValue),
    btcBid: null,
  };
}

function spotFill(time: number, symbol: string, side: 'buy' | 'sell', realizedPnl: string | null): EngineEvent {
  const fill: Fill = {
    id: `f${time}`,
    orderId: 'o1',
    symbol,
    side,
    qty: D(1),
    price: D(100),
    quote: D(100),
    liquidity: 'taker',
    feeAsset: 'USDT',
    fee: D('0.1'),
    feeUsd: D('0.1'),
    bestAtArrival: null,
    bestAtSubmit: null,
    slippageUsd: D(0),
    driftUsd: D(0),
    triggerPrice: null,
    realizedPnl: realizedPnl === null ? null : D(realizedPnl),
    roundTripId: 'rt1',
    time,
  };
  return { type: 'fill', time, fill, order: {} as never };
}

function perpFill(time: number, symbol: string, fee: string, realizedPnl: string | null): PerpEvent {
  const fill: PerpFill = {
    id: `pf${time}`,
    orderId: 'o2',
    symbol,
    side: 'buy',
    qty: D(1),
    price: D(100),
    quote: D(100),
    liquidity: 'taker',
    feeAsset: 'USDT',
    fee: D(fee),
    feeUsd: D(fee),
    bestAtArrival: null,
    bestAtSubmit: null,
    slippageUsd: D(0),
    driftUsd: D(0),
    triggerPrice: null,
    realizedPnl: realizedPnl === null ? null : D(realizedPnl),
    time,
    market: 'perp',
    positionId: 'p1',
    marginIn: null,
    uncovered: null,
  };
  return { type: 'fill', market: 'perp', time, fill, order: {} as never };
}

function funding(time: number, symbol: string, amount: string): PerpEvent {
  return {
    type: 'funding',
    market: 'perp',
    time,
    symbol,
    positionId: 'p1',
    fundingTime: time,
    rate: D('0.0001'),
    markPrice: D(100),
    qty: D(1),
    side: 'long',
    amount: D(amount),
    target: 'margin',
    uncollected: null,
  };
}

function liquidation(time: number, symbol: string, tradingLoss: string, remainder: string, fee: string): PerpEvent {
  const position: Position = {
    id: 'p1',
    symbol,
    side: 'long',
    qty: D(1),
    entryPrice: D(100),
    leverage: 10,
    margin: D(10),
    openedAt: time - MIN,
    realizedPnl: D(0),
    fees: D(0),
    funding: D(0),
    warnLevel: 0,
  };
  return {
    type: 'liquidation',
    market: 'perp',
    time,
    symbol,
    position,
    markPrice: D(90),
    marginLost: D(tradingLoss).plus(remainder).plus(fee),
    tradingLoss: D(tradingLoss),
    liquidationFee: D(fee),
    remainder: D(remainder),
    feeRateKnown: true,
    cancelledOrderIds: [],
  };
}

const str = (series: { time: number; pnl: Decimal; value: Decimal }[]) =>
  series.map((p) => ({ time: p.time, pnl: p.pnl.toString(), value: p.value.toString() }));

describe('account P&L series and drawdown', () => {
  // Total / deposited per snapshot; the second deposit lands just before t4.
  const events = rows([deposit(t(0), 'spot', '1000', '1000'), deposit(t(4) - 1, 'spot', '1000', '2000')]);
  const snapshots = [
    snap(t(1), '1000', '1000'),
    snap(t(2), '1250', '1000'),
    snap(t(3), '1000', '1000'),
    snap(t(4), '1900', '2000'),
    snap(t(5), '2400', '2000'),
    snap(t(6), '2280', '2000'),
  ];
  const input = { events, snapshots, live: null };

  it('deposits cannot hide a drawdown', () => {
    const series = pnlSeries(input, ACCOUNT, null, null);
    expect(series.map((p) => p.pnl.toString())).toEqual(['0', '250', '0', '-100', '400', '280']);
    expect(series.map((p) => p.value.toString())).toEqual(['1000', '1250', '1000', '1900', '2400', '2280']);

    const dd = drawdown(series);
    expect(dd.maxUsd.toString()).toBe('350');
    expect(dd.maxPct?.toString()).toBe('0.28');
    expect(dd.periods.map((p) => ({ ...p, depthUsd: p.depthUsd.toString(), depthPct: p.depthPct?.toString() }))).toEqual([
      { start: t(2), trough: t(4), end: t(5), depthUsd: '350', depthPct: '0.28' },
      { start: t(5), trough: t(6), end: null, depthUsd: '120', depthPct: '0.05' },
    ]);
    // A drawdown measured on the value would be 250 (1250 → 1000) and 20 %: the P&L one is deeper.
    expect(dd.maxUsd.toString()).not.toBe('250');
    expect(dd.maxPct?.toString()).not.toBe('0.2');
    expect(dd.underwater.map((u) => u.usd.toString())).toEqual(['0', '0', '-250', '-350', '0', '-120']);
    expect(dd.underwater.map((u) => u.time)).toEqual(snapshots.map((s) => s.time));

    const r = rangePnl(series, events, ACCOUNT, null, null);
    expect(r.pnl.toString()).toBe('280');
    expect(r.capitalMax.toString()).toBe('2000');
    expect(r.returnPct?.toString()).toBe('0.14');
  });

  it('a range starts at the last point at or before it and resets the peak there', () => {
    const series = pnlSeries(input, ACCOUNT, t(3), t(6));
    expect(series.map((p) => p.time)).toEqual([t(3), t(4), t(5), t(6)]);

    const r = rangePnl(series, events, ACCOUNT, t(3), t(6));
    expect(r.pnl.toString()).toBe('280');
    expect(r.returnPct?.toString()).toBe('0.14');

    const dd = drawdown(series);
    // From t3: 100 below the start (100 ÷ V(t3) 1000 = 10 %), then 120 below the t5 peak (5 %).
    expect(dd.periods[0]).toMatchObject({ start: t(3), trough: t(4), end: t(5) });
    expect(dd.periods[0]?.depthUsd.toString()).toBe('100');
    expect(dd.periods[0]?.depthPct?.toString()).toBe('0.1');
    expect(dd.maxUsd.toString()).toBe('120');
    expect(dd.maxPct?.toString()).toBe('0.1');
  });

  it('a range that ends at t4 holds only the dip below the start', () => {
    const series = pnlSeries(input, ACCOUNT, t(3), t(4));
    const dd = drawdown(series);
    expect(dd.maxUsd.toString()).toBe('100');
    expect(dd.maxPct?.toString()).toBe('0.1');
    expect(dd.periods).toHaveLength(1);
    expect(dd.periods[0]?.end).toBeNull();
  });

  it('a range between snapshots starts at the one before it, at its own time', () => {
    const series = pnlSeries(input, ACCOUNT, t(2) + 1, t(5) - 1);
    expect(series.map((p) => p.time)).toEqual([t(2), t(3), t(4)]);
    expect(rangePnl(series, events, ACCOUNT, t(2) + 1, t(5) - 1).pnl.toString()).toBe('-350');
  });

  it('a range before the first snapshot starts from a zero point at its start', () => {
    const series = pnlSeries(input, ACCOUNT, t(0), t(2));
    expect(str(series)).toEqual([
      { time: t(0), pnl: '0', value: '0' },
      { time: t(1), pnl: '0', value: '1000' },
      { time: t(2), pnl: '250', value: '1250' },
    ]);
  });

  it('appends the live point after the last snapshot, and only when the range reaches it', () => {
    const live = { time: t(7), pnl: D(300), value: D(2300) };
    const open = pnlSeries({ ...input, live }, ACCOUNT, null, null);
    expect(str(open).at(-1)).toEqual({ time: t(7), pnl: '300', value: '2300' });
    expect(open).toHaveLength(7);

    expect(pnlSeries({ ...input, live }, ACCOUNT, null, t(6))).toHaveLength(6);
    expect(pnlSeries({ ...input, live }, ACCOUNT, null, t(7))).toHaveLength(7);
  });

  it('a dip under 1 % of the value at its peak shows underwater but is not a period', () => {
    const evs = rows([deposit(t(0), 'spot', '1000', '1000')]);
    const snaps = [
      snap(t(1), '1000', '1000'),
      snap(t(2), '995', '1000'),
      snap(t(3), '1000', '1000'),
      snap(t(4), '990', '1000'),
    ];
    const dd = drawdown(pnlSeries({ events: evs, snapshots: snaps, live: null }, ACCOUNT, null, null));
    expect(dd.underwater.map((u) => u.usd.toString())).toEqual(['0', '-5', '0', '-10']);
    // 5 is 0.5 % of 1000: not shaded. 10 is exactly 1 %: shaded.
    expect(dd.periods).toHaveLength(1);
    expect(dd.periods[0]).toMatchObject({ start: t(3), trough: t(4), end: null });
    expect(dd.periods[0]?.depthPct?.toString()).toBe('0.01');
  });

  it('is empty with no snapshots and no events', () => {
    const series = pnlSeries({ events: [], snapshots: [], live: null }, ACCOUNT, null, null);
    expect(series).toEqual([]);
    const dd = drawdown(series);
    expect(dd.maxUsd.toString()).toBe('0');
    expect(dd.maxPct).toBeNull();
    expect(dd.periods).toEqual([]);
    expect(dd.underwater).toEqual([]);
    const r = rangePnl(series, [], ACCOUNT, null, null);
    expect(r.pnl.toString()).toBe('0');
    expect(r.capitalMax.toString()).toBe('0');
    expect(r.returnPct).toBeNull();
  });
});

describe('wallet P&L series', () => {
  // The deposit lands before the transfer out, so the spot wallet holds 1000 for a moment: its
  // return divides by that highest capital, not by the 900 it holds at the end.
  const events = rows([
    deposit(t(0), 'spot', '1000', '1000'),
    transfer(t(0) + 1, 'spot', 'leverage', '400'),
    transfer(t(3) - 1, 'leverage', 'spot', '300'),
  ]);
  const snapshots = [
    snap(t(1), '1000', '1000', '600', '400'),
    snap(t(2), '970', '1000', '640', '330'),
    snap(t(3), '970', '1000', '950', '20'),
  ];
  const input = { events, snapshots, live: null };

  it('nets the wallet value against its capital, and the wallets add up to the account', () => {
    expect(capitalAt(events, SPOT, t(3)).toString()).toBe('900');
    expect(capitalAt(events, LEVERAGE, t(3)).toString()).toBe('100');
    expect(capitalAt(events, ACCOUNT, t(3)).toString()).toBe('1000');

    const spot = pnlSeries(input, SPOT, null, null);
    const lev = pnlSeries(input, LEVERAGE, null, null);
    const account = pnlSeries(input, ACCOUNT, null, null);
    expect(spot.map((p) => p.pnl.toString())).toEqual(['0', '40', '50']);
    expect(lev.map((p) => p.pnl.toString())).toEqual(['0', '-70', '-80']);
    expect(lev.map((p) => p.value.toString())).toEqual(['400', '330', '20']);
    expect(account.map((p) => p.pnl.toString())).toEqual(['0', '-30', '-30']);
    spot.forEach((p, i) => expect(p.pnl.plus(lev[i]!.pnl).toString()).toBe(account[i]!.pnl.toString()));

    const dd = drawdown(lev);
    expect(dd.maxUsd.toString()).toBe('80');
    expect(dd.maxPct?.toString()).toBe('0.2');
  });

  it('divides each return by the highest capital in the range', () => {
    const lev = rangePnl(pnlSeries(input, LEVERAGE, null, null), events, LEVERAGE, null, null);
    expect(lev.pnl.toString()).toBe('-80');
    expect(lev.capitalMax.toString()).toBe('400');
    expect(lev.returnPct?.toString()).toBe('-0.2');

    const spot = rangePnl(pnlSeries(input, SPOT, null, null), events, SPOT, null, null);
    expect(spot.pnl.toString()).toBe('50');
    expect(spot.capitalMax.toString()).toBe('1000');
    expect(spot.returnPct?.toString()).toBe('0.05');

    const account = rangePnl(pnlSeries(input, ACCOUNT, null, null), events, ACCOUNT, null, null);
    expect(account.pnl.toString()).toBe('-30');
    expect(account.capitalMax.toString()).toBe('1000');
    expect(account.returnPct?.toString()).toBe('-0.03');
  });

  it('has no return when the scope holds no capital in the range', () => {
    const evs = rows([deposit(t(0), 'spot', '1000', '1000'), transfer(t(1), 'spot', 'leverage', '1000')]);
    const snaps = [snap(t(2), '1000', '1000', '0', '1000'), snap(t(3), '1010', '1000', '0', '1010')];
    const inp = { events: evs, snapshots: snaps, live: null };

    const afterOut = rangePnl(pnlSeries(inp, SPOT, t(2), null), evs, SPOT, t(2), null);
    expect(afterOut.capitalMax.toString()).toBe('0');
    expect(afterOut.returnPct).toBeNull();

    const spotOnly = rows([deposit(t(0), 'spot', '1000', '1000')]);
    const never = rangePnl(
      pnlSeries({ events: spotOnly, snapshots: [snap(t(1), '1000', '1000')], live: null }, LEVERAGE, null, null),
      spotOnly,
      LEVERAGE,
      null,
      null,
    );
    expect(never.capitalMax.toString()).toBe('0');
    expect(never.returnPct).toBeNull();
  });

  it('a range that starts before a transfer out divides by the capital before it', () => {
    const evs = rows([deposit(t(0), 'spot', '1000', '1000'), transfer(t(3), 'spot', 'leverage', '500')]);
    const snaps = [
      snap(t(1), '1000', '1000', '1000', '0'),
      snap(t(2), '1100', '1000', '1100', '0'),
      snap(t(4), '1100', '1000', '600', '500'),
    ];
    const series = pnlSeries({ events: evs, snapshots: snaps, live: null }, SPOT, t(1), null);
    expect(series.map((p) => p.pnl.toString())).toEqual(['0', '100', '100']);
    const r = rangePnl(series, evs, SPOT, t(1), null);
    expect(r.pnl.toString()).toBe('100');
    expect(r.capitalMax.toString()).toBe('1000');
    expect(r.returnPct?.toString()).toBe('0.1');
  });
});

describe('coin P&L series', () => {
  it('is the cumulative realised stream of the coin, plus the live point', () => {
    const events = rows([
      deposit(t(0), 'spot', '1000', '1000'),
      spotFill(t(1), 'SOLUSDT', 'buy', null),
      spotFill(t(2), 'BTCUSDT', 'sell', '7'),
      spotFill(t(3), 'SOLUSDT', 'sell', '48.95'),
      spotFill(t(4), 'SOLUSDT', 'sell', '23.92705'),
    ]);
    const scope: Scope = { kind: 'coin', symbol: 'SOLUSDT', market: null };
    // Snapshots are ignored for a coin.
    const snapshots = [snap(t(2), '5000', '1000')];

    const series = pnlSeries({ events, snapshots, live: null }, scope, t(1), null);
    expect(str(series)).toEqual([
      { time: t(1), pnl: '0', value: '0' },
      { time: t(3), pnl: '48.95', value: '1048.95' },
      { time: t(4), pnl: '72.87705', value: '1072.87705' },
    ]);

    // Dust 0.01 SOL left at a bid of 105 with a remaining cost of 1.001.
    const unrealised = D('0.01').mul(105).minus('1.001');
    const live = { time: t(5), pnl: D('72.87705').plus(unrealised), value: D('1072.92605') };
    const withLive = pnlSeries({ events, snapshots, live }, scope, t(1), null);
    expect(withLive.map((p) => p.pnl.toString())).toEqual(['0', '48.95', '72.87705', '72.92605']);
  });

  it('counts perp fees, funding and liquidations, and keeps to the chosen market', () => {
    const events = rows([
      deposit(t(0), 'leverage', '500', '500'),
      perpFill(t(1), 'SOLUSDT', '0.3', null),
      funding(t(2), 'SOLUSDT', '-0.1'),
      perpFill(t(3), 'SOLUSDT', '0.3', '10'),
      spotFill(t(4), 'SOLUSDT', 'sell', '2'),
      liquidation(t(5), 'SOLUSDT', '5', '1', '0.5'),
      funding(t(6), 'ETHUSDT', '3'),
    ]);
    const input = { events, snapshots: [], live: null };

    const both = pnlSeries(input, { kind: 'coin', symbol: 'SOLUSDT', market: null }, null, null);
    expect(str(both)).toEqual([
      { time: t(1), pnl: '-0.3', value: '499.7' },
      { time: t(2), pnl: '-0.4', value: '499.6' },
      { time: t(3), pnl: '9.3', value: '509.3' },
      { time: t(4), pnl: '11.3', value: '511.3' },
      { time: t(5), pnl: '4.8', value: '504.8' },
    ]);

    const perp = pnlSeries(input, { kind: 'coin', symbol: 'SOLUSDT', market: 'perp' }, null, null);
    expect(perp.map((p) => p.pnl.toString())).toEqual(['-0.3', '-0.4', '9.3', '2.8']);

    const spot = pnlSeries(input, { kind: 'coin', symbol: 'SOLUSDT', market: 'spot' }, null, null);
    expect(spot.map((p) => p.pnl.toString())).toEqual(['2']);

    expect(capitalAt(events, { kind: 'coin', symbol: 'SOLUSDT', market: null }, t(5)).toString()).toBe('500');
  });
});

describe('capitalAt', () => {
  it('counts an event exactly at the moment, and nothing before the first deposit', () => {
    const events = rows([deposit(t(1), 'spot', '1000', '1000'), transfer(t(2), 'spot', 'leverage', '250')]);
    expect(capitalAt(events, ACCOUNT, t(1) - 1).toString()).toBe('0');
    expect(capitalAt(events, ACCOUNT, t(1)).toString()).toBe('1000');
    expect(capitalAt(events, SPOT, t(2)).toString()).toBe('750');
    expect(capitalAt(events, LEVERAGE, t(2)).toString()).toBe('250');
    expect(capitalAt(events, ACCOUNT, t(2)).toString()).toBe('1000');
  });
});
