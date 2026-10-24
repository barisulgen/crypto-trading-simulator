import { D, floorMinute, MINUTE_MS } from '@sim/engine';
import type { AggTrade, Candle1m, Decimal, Market } from '@sim/engine';
import type { FundingRateQuery } from '../binance/futuresRest.ts';
import type { AggTradesQuery, RawJson } from '../binance/restCore.ts';
import { BUDGET_EXHAUSTED } from '../binance/weightBudget.ts';
import type { Lane } from '../binance/weightBudget.ts';

/** A funding settlement as Binance published it. */
export interface Settlement {
  time: number;
  rate: Decimal;
  markPrice: Decimal;
}

/**
 * The funding records of a span: the usable settlements, and the time of every record, usable or
 * not (a record shows its funding time happened, though it may have no mark price yet).
 */
export interface FundingHistory {
  settlements: Settlement[];
  recorded: number[];
}

/** The market history a catch-up run reads. Every time bound is inclusive, in epoch ms. */
export interface CatchUpHistory {
  /** The 1-minute last-price candles opening from floorMinute(start) to end, oldest first. */
  candles(market: Market, symbol: string, start: number, end: number): Promise<Candle1m[]>;
  /** The 1-minute mark-price candles of a perpetual, likewise. */
  markCandles(symbol: string, start: number, end: number): Promise<Candle1m[]>;
  /** Every trade of the minute opening at `minute`, oldest first, each id once. */
  minuteTrades(market: Market, symbol: string, minute: number): Promise<AggTrade[]>;
  /** The id of the latest trade; null when the market has none. */
  latestTradeId(market: Market, symbol: string): Promise<number | null>;
  /**
   * The perpetual's funding settlements from start to end, oldest first, each funding time once,
   * and the times of all its funding records then, usable or not, oldest first, each once.
   */
  funding(symbol: string, start: number, end: number): Promise<FundingHistory>;
}

/** What the history reads of the spot REST client. */
export interface SpotHistoryRest {
  klines(
    symbol: string,
    interval: string,
    limit: number,
    endTime?: number,
    opts?: { startTime?: number; lane?: Lane },
  ): Promise<RawJson>;
  aggTrades(q: AggTradesQuery): Promise<RawJson>;
}

/** What the history reads of the futures REST client. */
export interface FuturesHistoryRest {
  klines(symbol: string, interval: string, limit: number, startTime?: number, endTime?: number, lane?: Lane): Promise<RawJson>;
  markPriceKlines(symbol: string, interval: '1m', limit: number, startTime: number, endTime: number, lane?: Lane): Promise<RawJson>;
  aggTrades(q: AggTradesQuery, lane?: Lane): Promise<RawJson>;
  fundingRate(q: FundingRateQuery): Promise<RawJson>;
}

/** Klines and trades per request: Binance's largest page at the lowest weight. */
export const PAGE = 1000;
/** A request that found no room in the weight budget is asked for again this many times before the run fails. */
const BUDGET_RETRIES = 10;

/**
 * Catch-up's reads of Binance's history, spot and futures. Every request goes in the bulk lane of
 * its market's weight budget (funding history in the funding lane), so the live requests (depth
 * resyncs, rules, prices, funding polls) go first and catch-up never takes the last of the budget:
 * a long catch-up just takes longer. A request that waited its whole limit for budget is asked for
 * again rather than failing the run. Rows that do not parse fail the run (it is retried).
 */
export class BinanceHistory implements CatchUpHistory {
  constructor(
    private readonly spot: SpotHistoryRest,
    private readonly futures: FuturesHistoryRest,
  ) {}

  candles(market: Market, symbol: string, start: number, end: number): Promise<Candle1m[]> {
    return pagedCandles(start, end, (from, limit) =>
      market === 'spot'
        ? this.spot.klines(symbol, '1m', limit, end, { startTime: from, lane: 'bulk' })
        : this.futures.klines(symbol, '1m', limit, from, end, 'bulk'),
    );
  }

  markCandles(symbol: string, start: number, end: number): Promise<Candle1m[]> {
    return pagedCandles(start, end, (from, limit) => this.futures.markPriceKlines(symbol, '1m', limit, from, end, 'bulk'));
  }

  /**
   * One request by the minute's start and end time; while a page comes back full, the next is asked
   * for from the id after its last (`fromId`), until a page reaches past the minute.
   */
  async minuteTrades(market: Market, symbol: string, minute: number): Promise<AggTrade[]> {
    const end = minute + MINUTE_MS - 1;
    const byId = new Map<number, AggTrade>();
    let page = await this.trades(market, { symbol, startTime: minute, endTime: end, limit: PAGE });
    for (;;) {
      let past = false;
      for (const t of page) {
        if (t.time > end) past = true;
        else if (t.time >= minute && !byId.has(t.id)) byId.set(t.id, t);
      }
      if (page.length < PAGE || past) break;
      const last = page.reduce((m, t) => Math.max(m, t.id), -Infinity);
      page = await this.trades(market, { symbol, fromId: last + 1, limit: PAGE });
    }
    return [...byId.values()].sort((a, b) => a.time - b.time || a.id - b.id);
  }

  async latestTradeId(market: Market, symbol: string): Promise<number | null> {
    const page = await this.trades(market, { symbol, limit: 1 });
    return page.reduce<number | null>((m, t) => (m === null || t.id > m ? t.id : m), null);
  }

  /**
   * fundingRate pages of up to 1000 records. A record's time is taken at its whole minute: Binance
   * may record a settlement a few milliseconds past the funding time, which falls on the minute.
   * Records without a decimal rate and a positive mark price are no settlement and are skipped as
   * settlements; every record's time is still kept in `recorded`.
   */
  async funding(symbol: string, start: number, end: number): Promise<FundingHistory> {
    const byTime = new Map<number, Settlement>();
    const recorded = new Set<number>();
    let from = start;
    for (;;) {
      const rows = await patiently(() => this.futures.fundingRate({ symbol, startTime: from, endTime: end, limit: PAGE }));
      if (!Array.isArray(rows)) throw new Error(`fundingRate for ${symbol} did not return a list`);
      let latest = -Infinity;
      for (const r of rows) {
        const raw = Number(r?.fundingTime);
        if (!Number.isSafeInteger(raw)) throw new Error(`fundingRate for ${symbol}: bad fundingTime`);
        latest = Math.max(latest, raw);
        const time = Math.round(raw / MINUTE_MS) * MINUTE_MS;
        recorded.add(time);
        const rate = typeof r.fundingRate === 'string' && /^-?\d+(\.\d+)?$/.test(r.fundingRate) ? D(r.fundingRate) : null;
        const mark = typeof r.markPrice === 'string' && /^\d+(\.\d+)?$/.test(r.markPrice) ? D(r.markPrice) : null;
        if (rate === null || mark === null || !mark.gt(0)) continue;
        if (!byTime.has(time)) byTime.set(time, { time, rate, markPrice: mark });
      }
      if (rows.length < PAGE || latest + 1 > end) break;
      from = latest + 1;
    }
    return {
      settlements: [...byTime.values()].sort((a, b) => a.time - b.time),
      recorded: [...recorded].sort((a, b) => a - b),
    };
  }

  private async trades(market: Market, q: AggTradesQuery): Promise<AggTrade[]> {
    const rows = await patiently(() => (market === 'spot' ? this.spot.aggTrades(q) : this.futures.aggTrades(q, 'bulk')));
    return parseTrades(rows, q.symbol);
  }
}

/**
 * The candles opening from floorMinute(start) to end, a page at a time: each page asks for no more
 * minutes than are left (a smaller limit costs less weight on futures).
 */
async function pagedCandles(
  start: number,
  end: number,
  page: (from: number, limit: number) => Promise<RawJson>,
): Promise<Candle1m[]> {
  const byMinute = new Map<number, Candle1m>();
  let from = floorMinute(start);
  while (from <= end) {
    const limit = Math.min(PAGE, Math.floor((end - from) / MINUTE_MS) + 1);
    const rows = parseCandles(await patiently(() => page(from, limit)));
    for (const c of rows) if (c.openTime >= from && c.openTime <= end && !byMinute.has(c.openTime)) byMinute.set(c.openTime, c);
    const last = rows.reduce((m, c) => Math.max(m, c.openTime), -Infinity);
    if (rows.length < limit || last < from) break;
    from = last + MINUTE_MS;
  }
  return [...byMinute.values()].sort((a, b) => a.openTime - b.openTime);
}

/** A request asked for again (at most BUDGET_RETRIES times) while it only waited out its limit for weight budget. */
async function patiently<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== BUDGET_EXHAUSTED || attempt >= BUDGET_RETRIES) throw e;
    }
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

function dec(v: unknown, what: string): Decimal {
  if (typeof v !== 'string' || !DECIMAL.test(v)) throw new Error(`Binance history: bad ${what}`);
  return D(v);
}

/** Kline rows: [openTime, open, high, low, close, ...]. */
export function parseCandles(rows: RawJson): Candle1m[] {
  if (!Array.isArray(rows)) throw new Error('Binance history: klines did not return a list');
  return rows.map((r) => {
    const openTime = Number(Array.isArray(r) ? r[0] : Number.NaN);
    if (!Number.isSafeInteger(openTime)) throw new Error('Binance history: bad kline open time');
    return { openTime, open: dec(r[1], 'kline open'), high: dec(r[2], 'kline high'), low: dec(r[3], 'kline low'), close: dec(r[4], 'kline close') };
  });
}

/** aggTrades rows: { a: id, p: price, q: qty, T: time, m: buyer is maker (the seller initiated) }. */
export function parseTrades(rows: RawJson, symbol: string): AggTrade[] {
  if (!Array.isArray(rows)) throw new Error(`Binance history: aggTrades for ${symbol} did not return a list`);
  return rows.map((r) => {
    const id = Number(r?.a);
    const time = Number(r?.T);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(time) || typeof r.m !== 'boolean') {
      throw new Error(`Binance history: bad aggTrade for ${symbol}`);
    }
    return { id, price: dec(r.p, 'trade price'), qty: dec(r.q, 'trade qty'), sellerInitiated: r.m, time };
  });
}
