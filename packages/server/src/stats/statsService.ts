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
}

/**
 * Computes the stats in one long-lived worker thread, so that reading and computing a large record
 * never holds up the thread the engine runs on. Requests run one at a time, in order. A worker
 * that stops fails the request it was computing; the next request starts a new one.
 */
export class WorkerStats implements StatsService {
  private worker: Worker | null = null;
  private pending: { resolve(json: string): void; reject(e: Error): void } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly o: WorkerStatsOptions) {}

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
    if (w) await w.terminate();
  }

  private run(text: string): Promise<string> {
    if (this.closed) return Promise.reject(new StatsWorkerStoppedError());
    const worker = this.worker ?? this.start();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      worker.postMessage(text);
    });
  }

  private start(): Worker {
    const w = new Worker(new URL('./statsWorker.mjs', import.meta.url), { workerData: { dbPath: this.o.dbPath } });
    w.on('message', (m: StatsReply) => {
      const p = this.pending;
      this.pending = null;
      if (!p) return;
      if ('json' in m) p.resolve(m.json);
      else p.reject(new Error(m.error));
    });
    w.on('error', (e: Error) => this.o.logger.error(`Stats worker failed: ${e.message}`));
    w.on('exit', (code) => {
      if (this.worker === w) this.worker = null;
      const p = this.pending;
      this.pending = null;
      if (!this.closed && p) this.o.logger.error(`Stats worker stopped (exit code ${code}) while computing a request`);
      p?.reject(new StatsWorkerStoppedError());
    });
    this.worker = w;
    return w;
  }
}
