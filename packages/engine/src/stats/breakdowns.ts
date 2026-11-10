import { D, type Decimal } from '../decimal.ts';
import type { Trade } from './types.ts';

export interface BreakdownRow {
  key: string;
  pnl: Decimal;
  count: number;
  /** A fraction: wins (result above zero) over trades. */
  winRate: Decimal | null;
}

export interface Breakdowns {
  coin: BreakdownRow[];
  side: BreakdownRow[];
  market: BreakdownRow[];
  leverage: BreakdownRow[];
  hold: BreakdownRow[];
  hour: BreakdownRow[];
  weekday: BreakdownRow[];
}

export const DEFAULT_COIN_ORDER = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];

const SIDES = ['long', 'short'];
const MARKETS = ['spot', 'perp'];
const LEVERAGES = ['1-2', '3-5', '6-10', '>10', 'spot'];
const HOLDS = ['<5m', '5m-1h', '1h-1d', '>=1d'];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function leverageKey(t: Trade): string {
  if (t.leverage === null) return 'spot';
  if (t.leverage <= 2) return '1-2';
  if (t.leverage <= 5) return '3-5';
  if (t.leverage <= 10) return '6-10';
  return '>10';
}

function holdKey(t: Trade): string {
  const held = t.closedAt - t.openedAt;
  if (held < 5 * MINUTE) return '<5m';
  if (held < HOUR) return '5m-1h';
  if (held < DAY) return '1h-1d';
  return '>=1d';
}

function coinKey(t: Trade): string {
  return t.symbol.endsWith('USDT') ? t.symbol.slice(0, -4) : t.symbol;
}

function group(trades: Trade[], keyOf: (t: Trade) => string, order: string[]): BreakdownRow[] {
  const buckets = new Map<string, { pnl: Decimal; count: number; wins: number }>();
  for (const t of trades) {
    const key = keyOf(t);
    const b = buckets.get(key) ?? { pnl: D(0), count: 0, wins: 0 };
    b.pnl = b.pnl.plus(t.result);
    b.count += 1;
    if (t.result.gt(0)) b.wins += 1;
    buckets.set(key, b);
  }
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...buckets.keys()]
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => {
      const b = buckets.get(key)!;
      return { key, pnl: b.pnl, count: b.count, winRate: D(b.wins).div(b.count) };
    });
}

/**
 * P&L, trade count and win rate of closed trades by coin, side, market, leverage, hold time, and
 * the hour and weekday the trade was opened, read in the time zone `tz`. Empty buckets are omitted.
 */
export function breakdowns(trades: Trade[], tz: string, coinOrder: string[] = DEFAULT_COIN_ORDER): Breakdowns {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const parts = (t: Trade): { hour: string; weekday: string } => {
    let hour = '';
    let weekday = '';
    for (const p of fmt.formatToParts(new Date(t.openedAt))) {
      if (p.type === 'hour') hour = p.value;
      else if (p.type === 'weekday') weekday = p.value;
    }
    return { hour, weekday };
  };
  return {
    coin: group(trades, coinKey, coinOrder),
    side: group(trades, (t) => t.side, SIDES),
    market: group(trades, (t) => t.market, MARKETS),
    leverage: group(trades, leverageKey, LEVERAGES),
    hold: group(trades, holdKey, HOLDS),
    hour: group(trades, (t) => parts(t).hour, HOURS),
    weekday: group(trades, (t) => parts(t).weekday, WEEKDAYS),
  };
}
