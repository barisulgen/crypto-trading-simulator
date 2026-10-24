import { FUNDING_WINDOW_MS, floorMinute } from '@sim/engine';
import type { AggTrade, Candle1m, CatchUpInput, CatchUpNeeds, Decimal } from '@sim/engine';
import { loadPendingJobs } from '../db/store.ts';
import type { CatchUpJob, FeedGap, JobWrite } from '../db/store.ts';
import type { Db } from '../db/db.ts';
import type { Logger } from '../log.ts';
import { marketKey, splitKey } from '../market/marketKey.ts';
import type { MarketKey } from '../market/marketKey.ts';
import type { SetTimer } from '../market/ws.ts';
import type { CatchUpHistory } from './history.ts';

export const CATCHING_UP_REFUSAL = 'Catching up after a data gap; trading resumes when it is done';
/**
 * Gap times are local receive times, and data up to this late still counted as fresh, so a run
 * starts this much before its gap: its candle checks then cover what the last "fresh" data may
 * have missed. Trades are bounded by trade ids, not times, so none is replayed twice for it.
 */
export const LAG_ALLOWANCE_MS = 5000;
/** Live trades held back per key while it catches up: at most this many, and over at most this long. */
export const BUFFER_MAX_TRADES = 50_000;
export const BUFFER_MAX_MS = 600_000;
/** A failed run is tried again after 5 s, then 10, 20, 40, and every 60 s from then on. */
export const RETRY_FIRST_MS = 5000;
export const RETRY_MAX_MS = 60_000;
/** Binance's futures trade history covers 2 days: a perp run starting earlier than this before now has none. */
export const PERP_TRADES_WINDOW_MS = 47 * 3_600_000;

/**
 * The job change a closed gap makes: an interval to catch up, from one lag allowance before the
 * gap to its end, replayed after the trade cursor the gap opened with; merged into the key's
 * pending job, clipped to the end of a done one (writeJob).
 */
export function gapJob(g: FeedGap, now: number): JobWrite {
  return {
    kind: 'merge',
    market: g.market,
    symbol: g.symbol,
    startedAt: g.startedAt - LAG_ALLOWANCE_MS,
    endedAt: g.endedAt,
    lastTradeIdBefore: g.lastTradeIdBefore,
    now,
  };
}

/** A market and symbol's state: data live, a gap open, or catching up after one. */
export type Gate = 'live' | 'stale' | 'catching_up';

/** What the service needs of the runner: reads of the account, and engine calls persisted as every call is. */
export interface CatchUpHost {
  /** Whether anything a run looks after exists for the key: an order, a cancel in flight, a position or a funding window. */
  somethingOpen(key: MarketKey): boolean;
  /** Whether the key has a gap open now. */
  gapOpen(key: MarketKey): boolean;
  /** The trigger minutes of the key's triggered orders still waiting to execute. */
  triggerMinutes(key: MarketKey): number[];
  needs(key: MarketKey, from: number, to: number, candles: Candle1m[]): CatchUpNeeds;
  /** The funding times a perp run over [from, to] models though they may have no settlement yet. */
  fundingTimes(symbol: string, from: number, to: number): Promise<number[]>;
  /** Throws when the exchange rules (perps: and leverage tiers) the run needs are not loaded. */
  assertReady(key: MarketKey): void;
  /** The closed gaps and the job changes they make, in one transaction. */
  commitGaps(gaps: FeedGap[], jobs: JobWrite[]): void;
  /** The run's events, the state it leaves and the job's `done`, in one transaction. */
  apply(input: CatchUpInput, done: Extract<JobWrite, { kind: 'done' }>): void;
  /**
   * After the run: the held-back trades and marks are handled and the key goes live. `since`: the
   * end of the interval the run covered, from which the key's position has not changed.
   */
  resume(key: MarketKey, trades: AggTrade[], marks: { low: Decimal; high: Decimal } | null, since: number): void;
  recordFailure(jobId: number, error: string): void;
  extendJob(jobId: number, endedAt: number): void;
  /** Called with an error that must stop the runner (a run that did not end in a known way). */
  fatal(what: string, e: unknown): void;
}

export interface CatchUpServiceDeps {
  db: Db;
  seasonId: number;
  host: CatchUpHost;
  history: CatchUpHistory;
  now: () => number;
  setTimer: SetTimer;
  logger: Logger;
}

/** One key catching up. */
interface Catching {
  job: CatchUpJob;
  /** Live trades held back, in receive order, and when the first arrived. */
  trades: AggTrade[];
  since: number | null;
  /** Perps: the lowest and highest live mark held back. */
  low: Decimal | null;
  high: Decimal | null;
  /** Bumped whenever the job's interval or the held-back trades change under a run, which then runs again. */
  gen: number;
  running: boolean;
  /** Consecutive failed runs, for the backoff. */
  failures: number;
  cancelRetry: (() => void) | null;
}

/**
 * Catch-up after gaps in live data, per market and symbol. When a key's data is fresh again and
 * anything was open for it, its gap becomes a catch-up job (merged with a pending one, clipped to
 * the end of a done one: no interval is run twice) and the key is catching up: no orders, cancels,
 * leverage or margin changes; live trades and marks held back. A run fetches the history (candles,
 * then for perps mark candles and funding, then only the trades of the minutes the engine asks
 * for), applies it in one transaction with the job marked done, then the held-back trades and marks
 * go through and the key is live. A failed run is retried with backoff, the key catching up
 * meanwhile; it never resumes without catching up. Pending jobs found at start run once their key
 * is first fresh.
 */
export class CatchUpService {
  private readonly d: CatchUpServiceDeps;
  private readonly catching = new Map<MarketKey, Catching>();
  /** Keys with a pending job saved. */
  private readonly pending = new Set<MarketKey>();
  /**
   * Fresh live trades of a key whose gap is still open (it closes only at a health poll), held for
   * its run, and when the first arrived.
   */
  private readonly held = new Map<MarketKey, { trades: AggTrade[]; since: number }>();
  private stopped = false;

  constructor(deps: CatchUpServiceDeps) {
    this.d = deps;
    for (const j of loadPendingJobs(deps.db, deps.seasonId)) this.pending.add(marketKey(j.market, j.symbol));
  }

  isCatchingUp(key: MarketKey): boolean {
    return this.catching.has(key);
  }

  /** The keys catching up now. */
  keys(): MarketKey[] {
    return [...this.catching.keys()];
  }

  hasPendingJob(key: MarketKey): boolean {
    return this.pending.has(key);
  }

  /** Stops every retry; a run in flight is dropped when it returns. Pending jobs stay saved for the next start. */
  stop(): void {
    this.stopped = true;
    for (const c of this.catching.values()) c.cancelRetry?.();
  }

  /**
   * The key's data is fresh again with `gaps` closed (none: a pending job found at start). The
   * gaps and their job changes are saved in one transaction, each gap starting one lag allowance
   * early. Returns whether a job is pending: the key is then catching up and a run starts (or runs
   * again, when one is in flight, for the longer interval). When none is, the trades held for the
   * key are left for the live path (takeHeld).
   */
  enter(key: MarketKey, gaps: FeedGap[]): boolean {
    const now = this.d.now();
    this.d.host.commitGaps(gaps, gaps.map((g) => gapJob(g, now)));
    const { market, symbol } = splitKey(key);
    const job = loadPendingJobs(this.d.db, this.d.seasonId).find((j) => j.market === market && j.symbol === symbol);
    if (!job) {
      this.pending.delete(key);
      return false;
    }
    const held = this.takeHeld(key);
    this.pending.add(key);
    const c = this.catching.get(key);
    if (c) {
      c.job = job;
      c.gen += 1;
    } else {
      this.catching.set(key, {
        job,
        trades: held,
        since: held.length > 0 ? now : null,
        low: null,
        high: null,
        gen: 0,
        running: false,
        failures: 0,
        cancelRetry: null,
      });
    }
    this.start(key);
    return true;
  }

  /**
   * A live trade of a key catching up, held back until its run has been applied. Past 50 000 trades
   * or 10 minutes the held trades are dropped and the job's interval is extended to now, so the
   * run replays them from history instead; the next trade is then the first after it.
   */
  holdTrade(key: MarketKey, trade: AggTrade): void {
    const c = this.catching.get(key);
    if (!c) return;
    const now = this.d.now();
    if (c.trades.length >= BUFFER_MAX_TRADES || (c.since !== null && now - c.since >= BUFFER_MAX_MS)) {
      this.d.logger.warn(
        `${label(key)}: ${c.trades.length} live trades held back while catching up; dropped, the catch-up now runs to ${iso(now)}`,
      );
      this.extend(key, c, now);
    }
    if (c.trades.length === 0) c.since = now;
    c.trades.push(trade);
  }

  /**
   * A fresh live trade of a key whose gap is still open but closes only at a health poll; held for
   * its run. Past 50 000 trades or 10 minutes, as while catching up, the held trades are dropped and
   * this one is the first held: the job, which runs to the poll that closes the gap, replays them.
   */
  holdBeforeClose(key: MarketKey, trade: AggTrade): void {
    const now = this.d.now();
    const held = this.held.get(key);
    if (held && (held.trades.length >= BUFFER_MAX_TRADES || now - held.since >= BUFFER_MAX_MS)) {
      this.d.logger.warn(
        `${label(key)}: ${held.trades.length} live trades held back before its gap closed; dropped, its catch-up replays them`,
      );
      this.held.delete(key);
    }
    const list = this.held.get(key) ?? { trades: [], since: now };
    list.trades.push(trade);
    this.held.set(key, list);
  }

  /** The trades held for the key before its gap closed, in receive order; no longer held. */
  takeHeld(key: MarketKey): AggTrade[] {
    const list = this.held.get(key)?.trades ?? [];
    this.held.delete(key);
    return list;
  }

  /** The key is stale again before its gap closed: the trades held for it are dropped (its run replays them). */
  dropHeld(key: MarketKey): void {
    this.held.delete(key);
  }

  /** A fresh live mark of a perp catching up: its lowest and highest are kept. */
  holdMark(symbol: string, mark: Decimal): void {
    const c = this.catching.get(marketKey('perp', symbol));
    if (!c) return;
    if (c.low === null || mark.lt(c.low)) c.low = mark;
    if (c.high === null || mark.gt(c.high)) c.high = mark;
  }

  /**
   * A gap opened on a key catching up: what was held back is dropped (the job is extended over the
   * new gap when it closes, so its run replays it all), and a run in flight is not applied.
   */
  gapOpened(key: MarketKey): void {
    const c = this.catching.get(key);
    if (!c) return;
    c.trades = [];
    c.since = null;
    c.low = null;
    c.high = null;
    c.gen += 1;
  }

  // ---- runs ----

  private extend(key: MarketKey, c: Catching, now: number): void {
    c.trades = [];
    c.since = null;
    c.low = null;
    c.high = null;
    c.gen += 1;
    c.job = { ...c.job, endedAt: Math.max(c.job.endedAt, now) };
    this.d.host.extendJob(c.job.id, now);
  }

  /** Starts a run now (a retry waiting is cancelled), unless one is in flight: that one runs again when it returns. */
  private start(key: MarketKey): void {
    const c = this.catching.get(key);
    if (!c || c.running || this.stopped) return;
    c.cancelRetry?.();
    c.cancelRetry = null;
    void this.run(key, c);
  }

  /**
   * One run: fetch, then (still current, the key fresh, nothing changed meanwhile) apply and
   * resume. A run whose interval or held-back trades changed while it fetched runs again; one
   * whose key has a gap open again waits for the gap to close (enter starts the next).
   */
  private async run(key: MarketKey, c: Catching): Promise<void> {
    c.running = true;
    const gen = c.gen;
    let input: CatchUpInput | null = null;
    let error: unknown = null;
    try {
      input = await this.prepare(key, c);
    } catch (e) {
      error = e;
    }
    c.running = false;
    if (this.stopped || this.catching.get(key) !== c || this.d.host.gapOpen(key)) return;
    if (c.gen !== gen) return this.start(key);
    if (error === null) {
      try {
        this.d.host.assertReady(key);
      } catch (e) {
        error = e;
      }
    }
    if (error !== null || input === null) return this.failed(key, c, error);
    try {
      this.finish(key, c, input);
    } catch (e) {
      this.d.host.fatal('catch-up failed', e);
    }
  }

  /** Everything the run needs, fetched; reads the account (sync) between the fetches. */
  private async prepare(key: MarketKey, c: Catching): Promise<CatchUpInput> {
    const { market, symbol } = splitKey(key);
    const { startedAt: from, endedAt: to } = c.job;
    const h = this.d.history;
    const candles = await h.candles(market, symbol, from, to);
    // A stop triggered before the gap closes at the worst price of its trigger minute.
    const before = [...new Set(this.d.host.triggerMinutes(key))].filter((m) => m < floorMinute(from));
    for (const m of before.sort((a, b) => a - b)) candles.unshift(...(await h.candles(market, symbol, m, m)));
    const needs = this.d.host.needs(key, from, to, candles);
    const input: CatchUpInput = {
      market,
      symbol,
      from,
      to,
      lastTradeIdBefore: c.job.lastTradeIdBefore,
      endTradeId: c.trades[0]?.id ?? null,
      candles,
      trades: [],
    };
    if (market === 'perp') {
      if (needs.markCandles) input.markCandles = await h.markCandles(symbol, from, to);
      if (needs.funding) {
        const funding = await h.funding(symbol, from - FUNDING_WINDOW_MS, to);
        input.funding = funding.settlements;
        input.fundingRecords = funding.recorded;
        input.fundingTimes = await this.d.host.fundingTimes(symbol, from, to);
      }
      if (from < this.d.now() - PERP_TRADES_WINDOW_MS) {
        input.trades = 'unavailable';
        return input;
      }
    }
    // With no minute to replay, endTradeId is unused: it stays the first held trade, or null when
    // none is held yet (finish takes one held meanwhile); no request is spent on it.
    if (needs.tradeMinutes.length === 0) return input;
    // Replayed trades stop before the first trade the live path processes after the run: the
    // first held back, or else the one after the latest trade now.
    if (input.endTradeId === null) {
      const latest = await h.latestTradeId(market, symbol);
      input.endTradeId = latest === null ? null : latest + 1;
    }
    const byId = new Map<number, AggTrade>();
    for (const minute of needs.tradeMinutes) {
      for (const t of await h.minuteTrades(market, symbol, minute)) if (!byId.has(t.id)) byId.set(t.id, t);
    }
    input.trades = [...byId.values()].sort((a, b) => a.time - b.time || a.id - b.id);
    return input;
  }

  /** Apply (the job marked done in the same transaction), then resume the key. Synchronous: nothing comes between. */
  private finish(key: MarketKey, c: Catching, input: CatchUpInput): void {
    // The first trade held back bounds the replay; one held after the run began is no earlier.
    const endTradeId = input.endTradeId ?? c.trades[0]?.id ?? null;
    this.d.host.apply({ ...input, endTradeId }, { kind: 'done', id: c.job.id, endTradeId, now: this.d.now() });
    this.catching.delete(key);
    this.pending.delete(key);
    const marks = c.low !== null && c.high !== null ? { low: c.low, high: c.high } : null;
    this.d.host.resume(key, c.trades, marks, c.job.endedAt);
  }

  private failed(key: MarketKey, c: Catching, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    c.failures += 1;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** (c.failures - 1), RETRY_MAX_MS);
    this.d.logger.warn(`Catch-up of ${label(key)} failed (attempt ${c.job.attempts + c.failures}): ${message}; retrying in ${delay / 1000}s`);
    try {
      this.d.host.recordFailure(c.job.id, message);
    } catch (err) {
      this.d.host.fatal('persist failed', err);
      return;
    }
    c.cancelRetry = this.d.setTimer(() => {
      c.cancelRetry = null;
      this.start(key);
    }, delay);
  }
}

/** How a key is named in the log: the symbol for spot, `BTCUSDT perp` for a perpetual. */
function label(key: MarketKey): string {
  const { market, symbol } = splitKey(key);
  return market === 'spot' ? symbol : `${symbol} perp`;
}

const iso = (t: number) => new Date(t).toISOString();
