import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { D, Decimal } from '@sim/engine';
import type { AccountValue, SimEvent } from '@sim/engine';
import { btcRules } from '../../engine/test/fixtures.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { toJson } from '../src/db/store.ts';
import { readStatsRows, statsBounds, statsJson } from '../src/stats/loadStats.ts';
import type { StatsLive, StatsRequest } from '../src/stats/loadStats.ts';
import { decodeStatsRequest, encodeStatsRequest, StatsWorkerStoppedError, WorkerStats } from '../src/stats/statsService.ts';

const T0 = 1_762_000_000_000;
const MIN = 60_000;
const logged: string[] = [];
const logger = { info: () => {}, warn: () => {}, error: (m: string) => void logged.push(m) };

function account(over: Partial<AccountValue> = {}): AccountValue {
  return {
    spotUsdtFree: D(0),
    spotUsdtLocked: D(0),
    leverageUsdt: D(0),
    coins: [],
    leverage: { free: D(0), locked: D(0), positions: [], value: D(0) },
    total: D(1000),
    totalDeposited: D(1000),
    netPnl: D(0),
    netPnlPct: null,
    pricesPaused: [],
    marksPaused: [],
    pricesLoading: false,
    ...over,
  };
}

const LIVE: StatsLive = {
  account: account(),
  basis: {},
  positions: [],
  live: true,
  btcRules,
  btcBid: D('80000.5'),
  spotTakerFee: D('0.001'),
};

let dir: string;
let file: string;
let db: Db;
let seasonId: number;
const services: WorkerStats[] = [];

function service(): WorkerStats {
  const s = new WorkerStats({ dbPath: file, logger });
  services.push(s);
  return s;
}

function request(over: Partial<StatsRequest> = {}): StatsRequest {
  return {
    seasonId,
    bounds: statsBounds(db),
    live: LIVE,
    filter: { from: null, to: null, symbol: null, market: null },
    tz: 'UTC',
    now: T0 + 400_000 * MIN,
    ...over,
  };
}

function insertEvent(e: SimEvent): void {
  db.prepare('INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, ?, NULL, NULL, ?)').run(
    seasonId,
    e.time,
    e.type,
    toJson(e),
  );
}

/** `n` snapshots a minute apart from T0 + 1 min, after a deposit of 1000 at T0. */
function insertSnapshots(n: number, start = T0 + MIN): void {
  const ins = db.prepare(
    'INSERT INTO equity_snapshots (season_id, time, total, deposited, spot_value, leverage_value, btc_bid) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const total = String(1000 + ((i * 7919) % 201) - 100);
      ins.run(seasonId, start + i * MIN, total, '1000', total, '0', '80000');
    }
  })();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sim-stats-worker-'));
  file = join(dir, 'sim.sqlite');
  db = openDb(file);
  seasonId = currentSeasonId(db, () => T0);
  insertEvent({ type: 'deposit', time: T0, wallet: 'spot', amount: D(1000), totalDeposited: D(1000), btcAsk: D(80000) });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  db.prepare('DELETE FROM equity_snapshots').run();
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a stats request across threads', () => {
  it('keeps every Decimal exact and a Decimal, and everything else as it was', () => {
    const req = request({
      live: { ...LIVE, account: account({ netPnlPct: D('-0.000000001'), total: D('123456789.123456789') }), btcBid: null },
      filter: { from: 1, to: 2, symbol: 'BTCUSDT', market: 'leverage' },
    });
    const back = decodeStatsRequest(encodeStatsRequest(req));
    expect(back).toEqual(req);
    expect(back.live.account.total).toBeInstanceOf(Decimal);
    expect(back.live.account.total.toString()).toBe('123456789.123456789');
    expect(back.live.btcRules.stepSize).toBeInstanceOf(Decimal);
    expect(back.live.btcBid).toBeNull();
  });
});

describe('reading the record as of the request', () => {
  it('rows written after the bounds were taken are not read', () => {
    insertSnapshots(3);
    const bounds = statsBounds(db);
    insertSnapshots(2, T0 + 10 * MIN);
    insertEvent({ type: 'deposit', time: T0 + 11 * MIN, wallet: 'spot', amount: D(5), totalDeposited: D(1005) });
    const then = readStatsRows(db, seasonId, bounds);
    expect(then.snapshots.map((s) => s.time)).toEqual([T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN]);
    expect(then.events).toHaveLength(1);
    expect(readStatsRows(db, seasonId).snapshots).toHaveLength(5);
    expect(readStatsRows(db, seasonId).events).toHaveLength(2);
  });
});

describe('WorkerStats', () => {
  it('in WAL mode, so its read-only connection reads beside the engine writing', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('the worker sends the report the calling thread would compute', async () => {
    insertSnapshots(3000);
    const s = service();
    for (const filter of [
      { from: null, to: null, symbol: null, market: null },
      { from: T0 + 100 * MIN, to: T0 + 2000 * MIN, symbol: null, market: 'spot' as const },
      { from: null, to: null, symbol: 'BTCUSDT', market: null },
    ]) {
      const req = request({ filter });
      expect(await s.report(req)).toBe(statsJson(db, req));
    }
  }, 30_000);

  it('runs requests one at a time, each answered with its own report', async () => {
    insertSnapshots(500);
    const s = service();
    const reqs = ['UTC', 'Europe/Istanbul', 'Asia/Tokyo'].map((tz, i) =>
      request({ tz, filter: { from: null, to: T0 + (100 + i * 100) * MIN, symbol: null, market: null } }),
    );
    const replies = await Promise.all(reqs.map((r) => s.report(r)));
    expect(replies).toEqual(reqs.map((r) => statsJson(db, r)));
  }, 30_000);

  it('a failure inside the worker fails that request only', async () => {
    const s = service();
    // No BTC rules to buy the benchmark under: the computation throws in the worker.
    await expect(s.report(request({ live: { ...LIVE, btcRules: {} as never } }))).rejects.toThrow(/undefined/);
    expect(JSON.parse(await s.report(request())).headline.scope).toEqual({ kind: 'account' });
  }, 30_000);

  it('a worker that stops fails its request with a plain message; the next request starts a new one', async () => {
    insertSnapshots(100_000);
    const s = service();
    const failed = s.report(request());
    await new Promise((r) => setImmediate(r));
    // The worker is started for the request: stop it under the request, as a crash would.
    const worker = (s as unknown as { worker: { terminate(): Promise<number> } }).worker;
    await worker.terminate();
    await expect(failed).rejects.toThrow(StatsWorkerStoppedError);
    await expect(failed).rejects.toThrow('The stats could not be computed: the stats worker stopped. Try again.');
    expect(logged.at(-1)).toMatch(/^Stats worker stopped \(exit code \d+\) while computing a request$/);
    const req = request({ filter: { from: T0 + 99_000 * MIN, to: null, symbol: null, market: null } });
    expect(await s.report(req)).toBe(statsJson(db, req));
  }, 60_000);

  it('once closed, a request it was computing and any made after fail', async () => {
    insertSnapshots(100_000);
    const s = service();
    const running = s.report(request());
    const queued = s.report(request());
    await new Promise((r) => setImmediate(r));
    await s.close();
    await expect(running).rejects.toThrow(StatsWorkerStoppedError);
    await expect(queued).rejects.toThrow(StatsWorkerStoppedError);
    await expect(s.report(request())).rejects.toThrow(StatsWorkerStoppedError);
  }, 60_000);

  it('300,000 snapshots: the calling thread keeps running while the worker computes', async () => {
    insertSnapshots(300_000);
    const s = service();
    let last = performance.now();
    let longest = 0;
    const tick = () => {
      const t = performance.now();
      longest = Math.max(longest, t - last);
      last = t;
    };
    const timer = setInterval(tick, 10);
    const started = performance.now();
    let json: string;
    try {
      json = await s.report(request());
      // The time since the last tick counts too: a stall that ends with the report is still a stall.
      tick();
    } finally {
      clearInterval(timer);
    }
    const took = performance.now() - started;
    const report = JSON.parse(json);
    expect(report.series.length).toBeLessThanOrEqual(1500);
    expect(report.series.at(-1).time).toBe(T0 + 400_000 * MIN);
    // The worker took about as long as the calling thread would have stalled for.
    expect(took).toBeGreaterThan(500);
    expect(longest).toBeLessThan(200);
  }, 60_000);
});
