// Pure helpers behind the chart, the order book and the trades list. Book arithmetic stays on
// decimal strings (scaled BigInt); only chart bars and depth-bar widths become JS numbers, and
// those are display only.
import type { Candle, Interval, WireFill, WireLevel } from './api.ts';

// ---- exact decimal strings ----

const DEC = /^(-)?(\d+)(?:\.(\d+))?$/;

/** A decimal string as an integer scaled by 10^scale. */
function scaled(value: string, scale: number): bigint {
  const m = DEC.exec(value.trim());
  if (!m) throw new Error(`Not a decimal: ${value}`);
  const n = BigInt(m[2]! + (m[3] ?? '').padEnd(scale, '0'));
  return m[1] ? -n : n;
}

function scaleOf(value: string): number {
  return DEC.exec(value.trim())?.[3]?.length ?? 0;
}

/** A scaled integer back to a decimal string, trailing fraction zeros dropped. */
function unscaled(n: bigint, scale: number): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export function addDec(a: string, b: string): string {
  const s = Math.max(scaleOf(a), scaleOf(b));
  return unscaled(scaled(a, s) + scaled(b, s), s);
}

export function subDec(a: string, b: string): string {
  const s = Math.max(scaleOf(a), scaleOf(b));
  return unscaled(scaled(a, s) - scaled(b, s), s);
}

/** -1, 0 or 1 as a is below, equal to or above b (exact). */
export function cmpDec(a: string, b: string): -1 | 0 | 1 {
  const s = Math.max(scaleOf(a), scaleOf(b));
  const d = scaled(a, s) - scaled(b, s);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** n / d rounded half away from zero (exact BigInt division; d must not be 0). */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice < (d < 0n ? -d : d)) return q;
  return (n < 0n) !== (d < 0n) ? q - 1n : q + 1n;
}

/** A scaled integer as a decimal string with exactly `dp` decimals (no '-0'). */
function fixed(n: bigint, dp: number): string {
  if (n === 0n) return dp > 0 ? `0.${'0'.repeat(dp)}` : '0';
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(dp + 1, '0');
  const int = digits.slice(0, digits.length - dp);
  return `${neg ? '-' : ''}${int}${dp > 0 ? '.' + digits.slice(digits.length - dp) : ''}`;
}

/** a / b with exactly `dp` decimals, rounded half away from zero. Throws if b is 0. */
export function divDec(a: string, b: string, dp: number): string {
  const s = Math.max(scaleOf(a), scaleOf(b));
  const d = scaled(b, s);
  if (d === 0n) throw new Error('Division by zero');
  return fixed(divRound(scaled(a, s) * 10n ** BigInt(dp), d), dp);
}

/** A non-negative quantity rounded down to a multiple of `step` (as the exchange's LOT_SIZE wants it). */
export function floorToStep(value: string, step: string): string {
  const s = Math.max(scaleOf(value), scaleOf(step));
  const st = scaled(step, s);
  if (st <= 0n) return value;
  const v = scaled(value, s);
  return unscaled(v - (v % st), s);
}

/** a * b, exact. */
export function mulDec(a: string, b: string): string {
  const sa = scaleOf(a);
  const sb = scaleOf(b);
  return unscaled(scaled(a, sa) * scaled(b, sb), sa + sb);
}

/**
 * a / b rounded down to a multiple of `step` (exact BigInt division): how many whole steps of a
 * coin a budget `a` buys at price `b`. Both non-negative; throws if b or step is not positive.
 */
export function floorDivToStep(a: string, b: string, step: string): string {
  const s = Math.max(scaleOf(a), scaleOf(b), scaleOf(step));
  const d = scaled(b, s);
  const st = scaled(step, s);
  if (d <= 0n || st <= 0n) throw new Error('Division by zero');
  const steps = (scaled(a, s) * 10n ** BigInt(s)) / (d * st);
  return unscaled(steps * st, s);
}

/** part / whole * 100 with `dp` decimals (default 2), rounded half away from zero. */
export function pctOf(part: string, whole: string, dp = 2): string {
  const s = Math.max(scaleOf(part), scaleOf(whole));
  const d = scaled(whole, s);
  if (d === 0n) throw new Error('Division by zero');
  return fixed(divRound(scaled(part, s) * 100n * 10n ** BigInt(dp), d), dp);
}

// ---- order book ----

export interface DepthRow {
  price: string;
  qty: string;
  /** Cumulative quantity from the best price out to this level. */
  total: string;
  /** total / the deepest side's total, 0..1 (bar width, display only). */
  depth: number;
}

export interface BookView {
  /** Best (lowest) ask first. */
  asks: DepthRow[];
  /** Best (highest) bid first. */
  bids: DepthRow[];
  /** Best ask minus best bid, and that as a percentage of the mid price; null if a side is empty or the book is locked/crossed. */
  spread: { abs: string; pct: string } | null;
  /** Best bid equal to ('locked') or above ('crossed') the best ask; null on a normal or one-sided book. */
  cross: 'locked' | 'crossed' | null;
}

function cumulative(levels: WireLevel[]): Omit<DepthRow, 'depth'>[] {
  let total = '0';
  return levels.map((l) => {
    total = addDec(total, l.qty);
    return { price: l.price, qty: l.qty, total };
  });
}

/** The spread percentage gets at least 2 decimals, more for a tiny spread (two significant digits, at most 8). */
const PCT_MAX_DP = 8;

/** (a - b) * 200 / (a + b) with `dp` decimals: the spread as a percentage of the mid price. */
function pctScaled(a: bigint, b: bigint, dp: number, round: boolean): bigint {
  const num = (a - b) * 200n * 10n ** BigInt(dp);
  const den = a + b;
  return round ? (num * 2n + den) / (den * 2n) : num / den;
}

function spreadOf(bid: string, ask: string): Pick<BookView, 'spread' | 'cross'> {
  const s = Math.max(scaleOf(bid), scaleOf(ask));
  const b = scaled(bid, s);
  const a = scaled(ask, s);
  if (b === a) return { spread: null, cross: 'locked' };
  if (b > a) return { spread: null, cross: 'crossed' };
  if (a + b <= 0n) return { spread: null, cross: null };
  // Under 1%: keep two significant digits (0.000012%), else 2 decimals.
  const raw = pctScaled(a, b, PCT_MAX_DP, false);
  const firstNonZero = raw.toString().padStart(PCT_MAX_DP, '0').search(/[1-9]/);
  const dp = raw >= 10n ** BigInt(PCT_MAX_DP) || raw === 0n ? 2 : Math.min(PCT_MAX_DP, Math.max(2, firstNonZero + 2));
  const digits = pctScaled(a, b, dp, true).toString().padStart(dp + 1, '0');
  return { spread: { abs: unscaled(a - b, s), pct: `${digits.slice(0, -dp)}.${digits.slice(-dp)}` }, cross: null };
}

export function bookView(book: { symbol: string; bids: WireLevel[]; asks: WireLevel[] }): BookView {
  const bids = cumulative(book.bids);
  const asks = cumulative(book.asks);
  const deepest = Math.max(Number(bids.at(-1)?.total ?? 0), Number(asks.at(-1)?.total ?? 0));
  const withDepth = (r: Omit<DepthRow, 'depth'>): DepthRow => ({
    ...r,
    depth: deepest > 0 ? Number(r.total) / deepest : 0,
  });
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  return {
    asks: asks.map(withDepth),
    bids: bids.map(withDepth),
    ...(bestBid !== undefined && bestAsk !== undefined ? spreadOf(bestBid, bestAsk) : { spread: null, cross: null }),
  };
}

// ---- candles ----

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** A chart bar: time in seconds (UTC), prices as numbers for the chart library (display only). */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function toBar(c: Candle): Bar {
  return { time: c.time / 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) };
}

/** Older and current candles in time order, one per open time; the copy in `current` wins. */
export function mergeCandles(older: Candle[], current: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of older) byTime.set(c.time, c);
  for (const c of current) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** The candles after a live kline (last one replaced or a new one appended); null if it is older. */
export function applyKline(candles: Candle[], k: Candle): Candle[] | null {
  const last = candles.at(-1);
  if (!last || k.time < last.time) return null;
  return k.time === last.time ? [...candles.slice(0, -1), k] : [...candles, k];
}

/** Open time (ms) of the interval bucket a moment falls in (Binance buckets align to UTC epoch). */
export function bucketTime(ms: number, interval: Interval): number {
  const size = INTERVAL_MS[interval];
  return Math.floor(ms / size) * size;
}

export interface FillMarker {
  time: number;
  position: 'belowBar' | 'aboveBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
  text: string;
}

/**
 * Chart markers for the owner's fills: buys an up arrow below the bar, sells a down arrow above,
 * at the candle the fill happened in, oldest first. Fills outside [range.from, range.to] (candle
 * open times, ms) are left out because the chart has no bar for them.
 */
export function fillMarkers(
  fills: WireFill[],
  interval: Interval,
  range: { from: number; to: number },
  colors: { up: string; down: string },
  fmtQty: (qty: string) => string,
): FillMarker[] {
  return fills
    .map((f) => ({ f, at: bucketTime(f.time, interval) }))
    .filter(({ at }) => at >= range.from && at <= range.to)
    .sort((a, b) => a.at - b.at || a.f.time - b.f.time)
    .map(({ f, at }) => {
      const buy = f.side === 'buy';
      return {
        time: at / 1000,
        position: buy ? 'belowBar' : 'aboveBar',
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? colors.up : colors.down,
        text: fmtQty(f.qty),
      };
    });
}

// ---- time ----

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time HH:MM:SS. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local date and time for the chart crosshair: '18 Oct 2026 09:05'. */
export function fmtChartTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date and time with seconds, for records: '18 Oct 2026 09:05:07'. */
export function fmtDateTime(ms: number): string {
  return `${fmtChartTime(ms)}:${pad(new Date(ms).getSeconds())}`;
}

/** Local date only: '18 Oct 2026'. */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Axis tick labels in local time: year, month, day of month, or HH:MM. */
export function fmtTick(ms: number, kind: 'year' | 'month' | 'day' | 'time'): string {
  const d = new Date(ms);
  if (kind === 'year') return String(d.getFullYear());
  if (kind === 'month') return MONTHS[d.getMonth()]!;
  if (kind === 'day') return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
