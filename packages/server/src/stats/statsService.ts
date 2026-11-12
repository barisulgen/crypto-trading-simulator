import { Worker } from 'node:worker_threads';
import { D, Decimal } from '@sim/engine';
import type { Db } from '../db/db.ts';
import type { Logger } from '../log.ts';
import { statsJson } from './loadStats.ts';
import type { StatsRequest } from './loadStats.ts';

/** Computes a stats request into the JSON the API sends. */
export interface StatsService {
  report(req: StatsRequest): Promise<string>;
  close(): Promise<void>;
}

/** The request failed because the stats worker stopped (or was stopped); a new one serves the next. */
export class StatsWorkerStoppedError extends Error {
  constructor() {
    super('The stats could not be computed: the stats worker stopped. Try again.');
  }
}

/** The request ran past its time limit and was stopped; a new worker serves the next. */
export class StatsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The stats took longer than ${Math.round(timeoutMs / 1000)} s to compute and were stopped. Try again, or choose a shorter date range.`,
    );
  }
}

/** How long one stats request may take in the worker, in milliseconds. */
export const STATS_TIMEOUT_MS = 30_000;

// ---- a request across threads ----

/** A Decimal's tag in a request's JSON: a decimal does not survive a structured clone as one. */
const DECIMAL_TAG = '$decimal';

/** The request as text, every Decimal tagged with its exact digits. */
export function encodeStatsRequest(req: StatsRequest): string {
  // JSON.stringify calls Decimal.toJSON before the replacer, so test the holder's raw value instead.
  return JSON.stringify(req, function (this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    return Decimal.isDecimal(raw) ? { [DECIMAL_TAG]: (raw as Decimal).toString() } : v;
  });
}

/** The request back from encodeStatsRequest, its Decimals revived. */
export function decodeStatsRequest(text: string): StatsRequest {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    return keys.length === 1 && keys[0] === DECIMAL_TAG && typeof o[DECIMAL_TAG] === 'string' ? D(o[DECIMAL_TAG]) : v;
  }) as StatsRequest;
}

/** What the worker sends back for one request. */
export type StatsReply = { json: string } | { error: string };

// ---- services ----

/** On the calling thread: for a database the worker cannot open (in memory), and for tests. */
export function inProcessStats(db: Db): StatsService {
  return {
    report: async (req) => statsJson(db, req),
    close: async () => {},
  };
}

export interface WorkerStatsOptions {
  /** The database file; the worker opens its own read-only connection to it. */
  dbPath: string;
  logger: Logger;
  /** The longest one request may take once handed to the worker (not counting its wait in the queue). */
  timeoutMs?: number;
  /** The worker's entry module; for tests, which substitute a worker that misbehaves. */
  workerUrl?: URL;
}

/** The request a worker is computing, with the timer that limits it. */
interface Pending {
  worker: Worker;
  resolve(json: string): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Computes the stats in one long-lived worker thread, so that reading and computing a large record
 * never holds up the thread the engine runs on. Requests run one at a time, in order. A worker
 * that stops fails the request it was computing; the next request starts a new one. A request that
 * takes longer than the time limit (30 s unless set) fails with a StatsTimeoutError: its worker is
 * terminated and a new one started at once, so the requests behind it are still served.
 */
export class WorkerStats implements StatsService {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly o: WorkerStatsOptions) {
    this.timeoutMs = o.timeoutMs ?? STATS_TIMEOUT_MS;
  }

  report(req: StatsRequest): Promise<string> {
    const text = encodeStatsRequest(req);
    const run = this.queue.then(() => this.run(text));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Stops the worker; a request it was computing, and any made after, fail. */
  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    this.settle(w, (p) => p.reject(new StatsWorkerStoppedError()));
    if (w) await w.terminate();
  }

  private run(text: string): Promise<string> {
    if (this.closed) return Promise.reject(new StatsWorkerStoppedError());
    const worker = this.worker ?? this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.timeOut(worker), this.timeoutMs);
      timer.unref();
      this.pending = { worker, resolve, reject, timer };
      worker.postMessage(text);
    });
  }

  /** Takes the request `w` is computing, if there is one, and stops its timer; then hands it to `then`. */
  private settle(w: Worker | null, then: (p: Pending) => void): boolean {
    const p = this.pending;
    if (!p || p.worker !== w) return false;
    this.pending = null;
    clearTimeout(p.timer);
    then(p);
    return true;
  }

  private timeOut(w: Worker): void {
    if (!this.settle(w, (p) => p.reject(new StatsTimeoutError(this.timeoutMs)))) return;
    this.o.logger.error(`Stats worker timed out after ${this.timeoutMs} ms; it was stopped and restarted`);
    if (this.worker === w) this.worker = null;
    void w.terminate();
    if (!this.closed) this.start();
  }

  private start(): Worker {
    const w = new Worker(this.o.workerUrl ?? new URL('./statsWorker.mjs', import.meta.url), {
      workerData: { dbPath: this.o.dbPath },
    });
    // A handler acts only on the request its own worker is computing: after a timeout, the stopped
    // worker's late message or exit arrives while the next request is already pending on its successor.
    w.on('message', (m: StatsReply) => {
      this.settle(w, (p) => ('json' in m ? p.resolve(m.json) : p.reject(new Error(m.error))));
    });
    w.on('error', (e: Error) => this.o.logger.error(`Stats worker failed: ${e.message}`));
    w.on('exit', (code) => {
      if (this.worker === w) this.worker = null;
      this.settle(w, (p) => {
        if (!this.closed) this.o.logger.error(`Stats worker stopped (exit code ${code}) while computing a request`);
        p.reject(new StatsWorkerStoppedError());
      });
    });
    this.worker = w;
    return w;
  }
}
