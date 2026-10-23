import { D } from '@sim/engine';
import type { AggTrade, Decimal } from '@sim/engine';
import type { Logger } from '../log.ts';
import type { FeedHealth } from './feedHealth.ts';
import type { BookMode, DepthDiff } from './localBook.ts';

export type Levels = [string, string][];

/** The levels a depth update set, as [price, quantity] (0 removes the level). */
export interface DepthLevels {
  b: Levels;
  a: Levels;
}

export interface Ticker {
  last: Decimal;
  open24h: Decimal;
  change24hPct: Decimal;
}

const LOG_EVERY_MS = 60_000;

/** The exchange event time of a message that parsed; NaN for a malformed one, which proves nothing about lag. */
export function eventTime(parsed: boolean, data: any): number {
  return parsed ? data.E : Number.NaN;
}

/** A finite Decimal > 0 from a string, else null. */
export function positive(x: unknown): Decimal | null {
  if (typeof x !== 'string') return null;
  try {
    const v = D(x);
    return v.isFinite() && v.gt(0) ? v : null;
  } catch {
    return null;
  }
}

export function parseLevels(x: unknown): Levels | null {
  if (!Array.isArray(x)) return null;
  const out: Levels = [];
  for (const l of x) {
    if (!Array.isArray(l) || typeof l[0] !== 'string' || typeof l[1] !== 'string') return null;
    try {
      const p = D(l[0]);
      const q = D(l[1]);
      if (!p.isFinite() || !q.isFinite() || p.isNegative() || q.isNegative()) return null;
    } catch {
      return null;
    }
    out.push([l[0], l[1]]);
  }
  return out;
}

/**
 * A fully validated depth update, or null if anything about it is malformed. Futures updates must
 * also carry pu, the last update id of the previous event.
 */
export function parseDiff(data: any, mode: BookMode): (DepthDiff & DepthLevels) | null {
  if (!data || !Number.isSafeInteger(data.U) || !Number.isSafeInteger(data.u)) return null;
  if (mode === 'futures' && !Number.isSafeInteger(data.pu)) return null;
  if (!Number.isFinite(data.E)) return null;
  const b = parseLevels(data.b);
  const a = parseLevels(data.a);
  if (!b || !a) return null;
  return mode === 'futures' ? { U: data.U, u: data.u, pu: data.pu, b, a } : { U: data.U, u: data.u, b, a };
}

export function parseAggTrade(d: any): AggTrade | null {
  const price = positive(d?.p);
  const qty = positive(d?.q);
  if (price === null || qty === null || !Number.isSafeInteger(d.a) || !Number.isSafeInteger(d.T)) return null;
  return { id: d.a, price, qty, sellerInitiated: Boolean(d.m), time: d.T };
}

export function parseMiniTicker(d: any): Ticker | null {
  const last = positive(d?.c);
  const open = positive(d?.o);
  if (last === null || open === null) return null;
  return { last, open24h: open, change24hPct: last.minus(open).div(open).times(100) };
}

/** Logs at most once per key per minute so a bad stream cannot flood the log. */
export class LimitedWarn {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly log: Logger,
    private readonly now: () => number,
  ) {}

  warn(key: string, msg: string): void {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < LOG_EVERY_MS) return;
    this.last.set(key, t);
    this.log.warn(msg);
  }
}

/** Where a feed's trade and ticker messages go: the connection's health, the rate-limited log and the feed's events. */
export interface StreamSink {
  /** Names the feed in log lines, e.g. 'spot feed'. */
  name: string;
  health: FeedHealth;
  warn: LimitedWarn;
  emit(event: string, ...args: unknown[]): boolean;
}

/** An aggTrade message: its event time counts toward lag; a valid one is emitted as 'trade', an invalid one dropped. */
export function onAggTrade(sink: StreamSink, symbol: string, d: any, now: number): void {
  const trade = parseAggTrade(d);
  sink.health.onTrade(symbol, now, eventTime(trade !== null, d));
  if (!trade) {
    sink.warn.warn(`${symbol}:aggTrade`, `${sink.name}: invalid aggTrade for ${symbol}; dropped`);
    return;
  }
  sink.emit('trade', symbol, trade);
}

/** A miniTicker message: its event time counts toward lag; a valid one is emitted as 'ticker', an invalid one dropped. */
export function onMiniTicker(sink: StreamSink, symbol: string, d: any, now: number): void {
  const ticker = parseMiniTicker(d);
  sink.health.onTicker(symbol, now, eventTime(ticker !== null, d));
  if (!ticker) {
    sink.warn.warn(`${symbol}:miniTicker`, `${sink.name}: invalid miniTicker for ${symbol}; dropped`);
    return;
  }
  sink.emit('ticker', symbol, ticker);
}
