import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { breakdowns, type BreakdownRow } from '../src/stats/breakdowns.ts';
import type { Trade } from '../src/stats/types.ts';

function trade(
  n: number,
  closed: string,
  holdMs: number,
  result: number,
  market: 'spot' | 'perp',
  symbol: string,
  side: 'long' | 'short',
  leverage: number | null,
): Trade {
  const closedAt = Date.parse(closed);
  return {
    id: `t${n}`,
    market,
    symbol,
    side,
    leverage,
    openedAt: closedAt - holdMs,
    closedAt,
    closeEventId: n,
    result: D(result),
    fees: D(0),
    funding: D(0),
    estimated: false,
    reason: market === 'spot' ? 'round_trip' : 'closed',
  };
}

const trades: Trade[] = [
  trade(1, '2026-11-09T21:34:00Z', 240_000, -12, 'perp', 'BTCUSDT', 'long', 5),
  trade(2, '2026-11-10T11:00:00Z', 7_200_000, 30, 'spot', 'SOLUSDT', 'long', null),
  trade(3, '2026-11-10T11:30:00Z', 1_800_000, 20, 'perp', 'BTCUSDT', 'short', 20),
  trade(4, '2026-11-11T13:05:00Z', 300_000, 10, 'perp', 'ETHUSDT', 'short', 2),
  trade(5, '2026-11-11T14:00:00Z', 172_800_000, -36, 'spot', 'SOLUSDT', 'long', null),
  trade(6, '2026-11-11T15:00:00Z', 3_599_999, -27, 'perp', 'ETHUSDT', 'short', 10),
];

const flat = (rows: BreakdownRow[]) =>
  rows.map((r) => [r.key, r.pnl.toString(), r.count, r.winRate === null ? null : r.winRate.toFixed(4)]);

describe('breakdowns', () => {
  const b = breakdowns(trades, 'Europe/Istanbul');

  it('groups by coin in the configured order', () => {
    expect(flat(b.coin)).toEqual([
      ['BTC', '8', 2, '0.5000'],
      ['ETH', '-17', 2, '0.5000'],
      ['SOL', '-6', 2, '0.5000'],
    ]);
  });

  it('groups by side and market', () => {
    expect(flat(b.side)).toEqual([
      ['long', '-18', 3, '0.3333'],
      ['short', '3', 3, '0.6667'],
    ]);
    expect(flat(b.market)).toEqual([
      ['spot', '-6', 2, '0.5000'],
      ['perp', '-9', 4, '0.5000'],
    ]);
  });

  it('groups by leverage with a separate spot row', () => {
    expect(flat(b.leverage)).toEqual([
      ['1-2', '10', 1, '1.0000'],
      ['3-5', '-12', 1, '0.0000'],
      ['6-10', '-27', 1, '0.0000'],
      ['>10', '20', 1, '1.0000'],
      ['spot', '-6', 2, '0.5000'],
    ]);
  });

  it('groups by hold time with half-open boundaries', () => {
    expect(flat(b.hold)).toEqual([
      ['<5m', '-12', 1, '0.0000'],
      ['5m-1h', '3', 3, '0.6667'],
      ['1h-1d', '30', 1, '1.0000'],
      ['>=1d', '-36', 1, '0.0000'],
    ]);
  });

  it('groups by open hour and weekday in the given zone', () => {
    expect(flat(b.hour)).toEqual([
      ['00', '-12', 1, '0.0000'],
      ['12', '30', 1, '1.0000'],
      ['14', '20', 1, '1.0000'],
      ['16', '10', 1, '1.0000'],
      ['17', '-63', 2, '0.0000'],
    ]);
    expect(flat(b.weekday)).toEqual([
      ['Mon', '-36', 1, '0.0000'],
      ['Tue', '38', 3, '0.6667'],
      ['Wed', '-17', 2, '0.5000'],
    ]);
  });

  it('uses the zone it is given, not the machine zone', () => {
    const utc = breakdowns(trades, 'UTC');
    expect(utc.hour[utc.hour.length - 1]?.key).toBe('21');
    expect(utc.weekday[0]?.key).toBe('Mon');
    expect(utc.hour.find((r) => r.key === '21')?.pnl.toString()).toBe('-12');
  });

  it('puts unknown coins last, alphabetically, and honours a custom order', () => {
    const odd = [
      trade(1, '2026-11-10T11:00:00Z', 1000, 1, 'spot', 'ZZZUSDT', 'long', null),
      trade(2, '2026-11-10T11:00:00Z', 1000, 1, 'spot', 'AAAUSDT', 'long', null),
      trade(3, '2026-11-10T11:00:00Z', 1000, 1, 'spot', 'ETHUSDT', 'long', null),
      trade(4, '2026-11-10T11:00:00Z', 1000, 1, 'spot', 'BTCUSDT', 'long', null),
    ];
    expect(breakdowns(odd, 'UTC').coin.map((r) => r.key)).toEqual(['BTC', 'ETH', 'AAA', 'ZZZ']);
    expect(breakdowns(odd, 'UTC', ['ETH', 'BTC']).coin.map((r) => r.key)).toEqual(['ETH', 'BTC', 'AAA', 'ZZZ']);
  });

  it('returns empty lists for no trades and rejects an invalid zone', () => {
    const e = breakdowns([], 'UTC');
    expect(e.coin).toEqual([]);
    expect(e.hour).toEqual([]);
    expect(() => breakdowns(trades, 'Not/AZone')).toThrow();
  });
});
