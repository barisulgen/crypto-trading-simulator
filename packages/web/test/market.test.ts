import { describe, expect, it } from 'vitest';
import type { Candle, WireFill, WireFillRow } from '../src/lib/api.ts';
import {
  addDec,
  applyKline,
  bookView,
  bucketTime,
  fillMarkers,
  fmtClock,
  fmtCountdown,
  fmtFundingPct,
  mergeCandles,
  perpMarkers,
  subDec,
  toBar,
} from '../src/lib/market.ts';

const candle = (time: number, close = '100'): Candle => ({
  time,
  open: '100',
  high: '110',
  low: '90',
  close,
  volume: '5',
});

const fill = (side: 'buy' | 'sell', time: number, qty = '0.5'): WireFill =>
  ({ id: `f${time}`, symbol: 'BTCUSDT', side, qty, price: '100', time }) as WireFill;

describe('decimal strings', () => {
  it('adds and subtracts exactly, keeping the larger scale', () => {
    expect(addDec('0.1', '0.2')).toBe('0.3');
    expect(addDec('12345678901234567.25', '0.00000001')).toBe('12345678901234567.25000001');
    expect(subDec('81232.02', '81232.01')).toBe('0.01');
    expect(subDec('1', '1.5')).toBe('-0.5');
    expect(addDec('3', '4')).toBe('7');
  });
});

describe('order book view', () => {
  it('accumulates depth outward from the best price on each side and scales bars to the deepest side', () => {
    const v = bookView({
      symbol: 'BTCUSDT',
      bids: [
        { price: '99', qty: '1' },
        { price: '98', qty: '3' },
      ],
      asks: [
        { price: '101', qty: '0.5' },
        { price: '102', qty: '1.5' },
      ],
    });
    expect(v.bids.map((r) => [r.price, r.total])).toEqual([
      ['99', '1'],
      ['98', '4'],
    ]);
    expect(v.asks.map((r) => [r.price, r.total])).toEqual([
      ['101', '0.5'],
      ['102', '2'],
    ]);
    expect(v.bids.map((r) => r.depth)).toEqual([0.25, 1]);
    expect(v.asks.map((r) => r.depth)).toEqual([0.125, 0.5]);
  });

  it('gives the spread in dollars and as a percentage of the mid price', () => {
    const v = bookView({ symbol: 'X', bids: [{ price: '99', qty: '1' }], asks: [{ price: '101', qty: '1' }] });
    expect(v.spread).toEqual({ abs: '2', pct: '2.00' });
  });

  it('shows a tiny spread percentage with enough decimals to be non-zero', () => {
    const v = bookView({
      symbol: 'BTCUSDT',
      bids: [{ price: '81232.01', qty: '1' }],
      asks: [{ price: '81232.02', qty: '1' }],
    });
    expect(v.spread).toEqual({ abs: '0.01', pct: '0.000012' });
  });

  it('has no spread when a side is empty', () => {
    const v = bookView({ symbol: 'X', bids: [], asks: [{ price: '1', qty: '1' }] });
    expect(v.spread).toBeNull();
    expect(v.cross).toBeNull();
  });

  it('reports a locked book (best bid = best ask) without a spread', () => {
    const v = bookView({ symbol: 'X', bids: [{ price: '100.00', qty: '1' }], asks: [{ price: '100', qty: '1' }] });
    expect(v.spread).toBeNull();
    expect(v.cross).toBe('locked');
  });

  it('reports a crossed book (best bid above best ask) without a negative spread', () => {
    const v = bookView({ symbol: 'X', bids: [{ price: '100.02', qty: '1' }], asks: [{ price: '100.01', qty: '1' }] });
    expect(v.spread).toBeNull();
    expect(v.cross).toBe('crossed');
  });

  it('has no crossing on a normal book', () => {
    expect(bookView({ symbol: 'X', bids: [{ price: '99', qty: '1' }], asks: [{ price: '101', qty: '1' }] }).cross).toBeNull();
  });
});

describe('candles', () => {
  it('converts a candle to a chart bar in seconds (display only)', () => {
    expect(toBar(candle(1_700_000_040_000, '101.5'))).toEqual({
      time: 1_700_000_040,
      open: 100,
      high: 110,
      low: 90,
      close: 101.5,
    });
  });

  it('prepends older candles in time order without duplicates; the newer copy wins', () => {
    const merged = mergeCandles([candle(1000), candle(2000, '1')], [candle(2000, '2'), candle(3000)]);
    expect(merged.map((c) => [c.time, c.close])).toEqual([
      [1000, '100'],
      [2000, '2'],
      [3000, '100'],
    ]);
  });

  it('applies a live kline: replaces the last candle, appends a newer one, ignores an older one', () => {
    const base = [candle(1000), candle(2000)];
    expect(applyKline(base, candle(2000, '105'))?.map((c) => c.close)).toEqual(['100', '105']);
    expect(applyKline(base, candle(3000))?.map((c) => c.time)).toEqual([1000, 2000, 3000]);
    expect(applyKline(base, candle(1000))).toBeNull();
    expect(applyKline([], candle(1000))).toBeNull();
  });
});

describe('fill markers', () => {
  it('floors a fill time to the start of its interval bucket', () => {
    expect(bucketTime(Date.UTC(2026, 9, 18, 9, 7, 31, 500), '15m')).toBe(Date.UTC(2026, 9, 18, 9, 0));
    expect(bucketTime(Date.UTC(2026, 9, 18, 9, 7, 31), '1m')).toBe(Date.UTC(2026, 9, 18, 9, 7));
    expect(bucketTime(Date.UTC(2026, 9, 18, 9, 7), '4h')).toBe(Date.UTC(2026, 9, 18, 8, 0));
    expect(bucketTime(Date.UTC(2026, 9, 18, 23, 59), '1d')).toBe(Date.UTC(2026, 9, 18));
  });

  it('marks buys with an up arrow below the bar and sells with a down arrow above, oldest first', () => {
    const t = Date.UTC(2026, 9, 18, 9, 0);
    const markers = fillMarkers(
      [fill('sell', t + 20 * 60_000, '0.25'), fill('buy', t + 7 * 60_000, '0.5')],
      '15m',
      { from: t, to: t + 15 * 60_000 },
      { up: 'U', down: 'D' },
      (q) => `${q} BTC`,
    );
    expect(markers).toEqual([
      { time: t / 1000, position: 'belowBar', shape: 'arrowUp', color: 'U', text: '0.5 BTC' },
      { time: (t + 15 * 60_000) / 1000, position: 'aboveBar', shape: 'arrowDown', color: 'D', text: '0.25 BTC' },
    ]);
  });

  it('leaves out fills outside the loaded candles', () => {
    const t = Date.UTC(2026, 9, 18, 9, 0);
    const markers = fillMarkers(
      [fill('buy', t - 1), fill('buy', t + 31 * 60_000)],
      '15m',
      { from: t, to: t + 15 * 60_000 },
      { up: 'U', down: 'D' },
      (q) => q,
    );
    expect(markers).toEqual([]);
  });
});

describe('clock', () => {
  it('shows local time as HH:MM:SS', () => {
    expect(fmtClock(new Date(2026, 9, 18, 9, 5, 7).getTime())).toBe('09:05:07');
    expect(fmtClock(new Date(2026, 9, 18, 23, 59, 0).getTime())).toBe('23:59:00');
  });
});

describe('funding', () => {
  it('counts down to the next funding as HH:MM:SS, never below zero', () => {
    expect(fmtCountdown(3_600_000 + 12 * 60_000 + 45_000)).toBe('01:12:45');
    expect(fmtCountdown(3 * 3_600_000 + 12 * 60_000 + 45_000)).toBe('03:12:45');
    // A part second left still counts as that second.
    expect(fmtCountdown(999)).toBe('00:00:01');
    expect(fmtCountdown(0)).toBe('00:00:00');
    expect(fmtCountdown(-5000)).toBe('00:00:00');
  });

  it('shows the funding rate as a percent to 4 dp, rounded half-up', () => {
    expect(fmtFundingPct('0.00005355')).toBe('0.0054%');
    expect(fmtFundingPct('0.0001')).toBe('0.0100%');
    expect(fmtFundingPct('0.00000049')).toBe('0.0000%');
    expect(fmtFundingPct('0.0000005')).toBe('0.0001%');
    expect(fmtFundingPct('-0.00012345')).toBe('-0.0123%');
    expect(fmtFundingPct('-0.00000004')).toBe('0.0000%');
    expect(fmtFundingPct(undefined)).toBe('-');
  });
});

const T = Date.UTC(2026, 9, 18, 9, 0);
const MIN = 60_000;

/** A perp fill row; `pnl` set makes it a reducing fill (opening fills realise nothing). */
const pfill = (id: string, positionId: string, side: 'buy' | 'sell', qty: string, time: number, pnl: string | null = null) =>
  ({ id, positionId, side, qty, time, realizedPnl: pnl, symbol: 'BTCUSDT', market: 'perp' }) as unknown as WireFillRow;

describe('perp chart markers', () => {
  const colors = { up: 'U', down: 'D' };
  const range = { from: T, to: T + 60 * MIN };
  const qty = (q: string) => q;

  it('marks entries, increases, reductions and closes, buys below the bar and sells above', () => {
    // Newest first, as GET /api/fills returns them.
    const fills = [
      pfill('f5', 'p2', 'buy', '1', T + 5 * MIN),
      pfill('f4', 'p1', 'sell', '0.5', T + 4 * MIN, '3'),
      pfill('f3', 'p1', 'sell', '0.25', T + 3 * MIN, '1'),
      pfill('f2', 'p1', 'buy', '0.25', T + 2 * MIN),
      pfill('f1', 'p1', 'buy', '0.5', T + 1 * MIN),
    ];
    const m = perpMarkers(fills, [], { complete: true }, '1m', range, colors, qty);
    expect(m).toEqual([
      { time: (T + 1 * MIN) / 1000, position: 'belowBar', shape: 'arrowUp', color: 'U', text: 'Open 0.5' },
      { time: (T + 2 * MIN) / 1000, position: 'belowBar', shape: 'arrowUp', color: 'U', text: 'Add 0.25' },
      { time: (T + 3 * MIN) / 1000, position: 'aboveBar', shape: 'arrowDown', color: 'D', text: 'Reduce 0.25' },
      { time: (T + 4 * MIN) / 1000, position: 'aboveBar', shape: 'arrowDown', color: 'D', text: 'Close 0.5' },
      { time: (T + 5 * MIN) / 1000, position: 'belowBar', shape: 'arrowUp', color: 'U', text: 'Open 1' },
    ]);
  });

  it('marks a liquidation with a red square on the side of the forced trade', () => {
    const fills = [pfill('f2', 'p1', 'sell', '0.1', T + 2 * MIN), pfill('f1', 'p1', 'sell', '0.2', T + 1 * MIN)];
    const liqs = [{ time: T + 7 * MIN, side: 'short' as const, qty: '0.3' }, { time: T + 9 * MIN, side: 'long' as const, qty: '2' }];
    const m = perpMarkers(fills, liqs, { complete: true }, '1m', range, colors, qty);
    expect(m.map((x) => [x.text, x.shape, x.position, x.color])).toEqual([
      ['Open 0.2', 'arrowDown', 'aboveBar', 'D'],
      ['Add 0.1', 'arrowDown', 'aboveBar', 'D'],
      // A short is liquidated by a forced buy (below the bar), a long by a forced sell (above).
      ['Liq. 0.3', 'square', 'belowBar', 'D'],
      ['Liq. 2', 'square', 'aboveBar', 'D'],
    ]);
  });

  it('does not guess for a position whose earlier fills were cut off by the fill limit', () => {
    // A full page: p1's first fills may be older than the page.
    const fills = [
      pfill('f4', 'p2', 'sell', '1', T + 4 * MIN),
      pfill('f3', 'p1', 'sell', '0.5', T + 3 * MIN, '2'),
      pfill('f2', 'p1', 'buy', '0.5', T + 2 * MIN),
      pfill('f1', 'p1', 'sell', '0.5', T + 1 * MIN, '1'),
    ];
    const m = perpMarkers(fills, [], { complete: false }, '1m', range, colors, qty);
    expect(m.map((x) => x.text)).toEqual(['0.5', '0.5', '0.5', 'Open 1']);
  });

  it('leaves out fills and liquidations outside the loaded candles', () => {
    const fills = [pfill('f1', 'p1', 'buy', '1', T - 1)];
    const liqs = [{ time: T + 61 * MIN, side: 'long' as const, qty: '1' }];
    expect(perpMarkers(fills, liqs, { complete: true }, '1m', range, colors, qty)).toEqual([]);
  });
});
