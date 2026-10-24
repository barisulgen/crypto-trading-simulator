import { describe, expect, it } from 'vitest';
import { D, Decimal, PerpEngine, SimEngine, SpotEngine, deposit, emptyLedger, emptyPerpState, emptySpotState } from '@sim/engine';
import type {
  AggTrade,
  EngineCtx,
  EngineEvent,
  Market,
  PerpCtx,
  PerpEvent,
  PerpOrder,
  PerpOrderRequest,
  PerpState,
  SimEvent,
  SpotOrder,
  SpotOrderRequest,
  SpotState,
} from '@sim/engine';
import { FakeMarket, seedCoins, testCtx } from '../../engine/test/fixtures.ts';
import { FakePerpMarket, perpCtx } from '../../engine/test/perpFixtures.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import {
  checkInvariants,
  insertEquitySnapshot,
  loadOpenGaps,
  loadLedger,
  loadPerpState,
  loadSpotState,
  openGap,
  persist,
  queryHistory,
  settleLateCancels,
  touchAlive,
} from '../src/db/store.ts';

const NOW = 1_000_000;
const ASSETS = ['USDT', 'BTC'];

const simOf = (engine: SpotEngine) =>
  new SimEngine(engine.state.ledger, engine, new PerpEngine(emptyPerpState(engine.state.ledger)));

let tradeId = 0;
function trade(price: string, qty = '1', sellerInitiated = true): AggTrade {
  tradeId += 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

function setup() {
  const market = new FakeMarket();
  const ctx = testCtx(market, { now: NOW });
  const engine = new SpotEngine(emptySpotState(emptyLedger(ASSETS)));
  const db = openDb(':memory:');
  const seasonId = currentSeasonId(db);
  return { market, ctx, engine, db, seasonId };
}

function arrive(engine: SpotEngine, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
}

/** Request a cancel and deliver it at its arrival time; returns what its arrival did. */
function cancelNow(engine: SpotEngine, id: string, ctx: EngineCtx): EngineEvent[] {
  const r = engine.cancel(id, ctx);
  if (!r.ok) throw new Error(r.reason);
  ctx.now = Math.max(ctx.now, engine.state.orders.get(id)!.cancelArrivesAt!);
  return engine.arriveCancel(id, ctx);
}

const placedOrder = (events: EngineEvent[]): SpotOrder => {
  const e = events.find((x) => x.type === 'order_placed');
  if (!e || e.type !== 'order_placed') throw new Error('no order_placed');
  return e.order;
};

const limitBuy = (price: string, qty: string, extra: Partial<SpotOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', price, qty, ...extra }) as SpotOrderRequest;

/** Whole state as plain JSON (Decimal.toJSON gives decimal strings), orders sorted by id. */
function snapshot(state: SpotState): string {
  return JSON.stringify({
    balances: state.ledger.balances,
    orders: [...state.orders.values()].filter((o) => ['pending', 'open', 'partially_filled', 'triggered'].includes(o.status)).sort((a, b) => a.id.localeCompare(b.id)),
    basis: state.basis,
    totalDeposited: state.ledger.totalDeposited,
    lastTradeId: state.lastTradeId,
  });
}

/** deposit 1000, limit buy 1 @ 99.50 open, partial fill 0.5 -> persisted. */
function partialFillScenario() {
  const t = setup();
  const { engine, ctx, db, seasonId } = t;
  const events: EngineEvent[] = [];
  events.push(...(deposit(engine.state.ledger, 'spot', D('1000'), ctx) as { events: EngineEvent[] }).events);
  const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
  events.push({ type: 'order_placed', time: ctx.now, order });
  events.push(...arrive(engine, order, ctx));
  events.push(...engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx));
  persist(db, seasonId, simOf(engine), events);
  return { ...t, events, order };
}

describe('openDb', () => {
  it('applies migrations once: user_version 4; a fresh database is not marked as test data', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'test_data'").get()).toBeUndefined();
    expect(currentSeasonId(db)).toBe(1);
    expect(currentSeasonId(db)).toBe(1);
    expect(db.prepare('SELECT name FROM seasons').all()).toEqual([{ name: 'Season 1' }]);
  });

  it('a second open of the same file keeps version 4 and its data', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sim-db-'));
    try {
      const file = join(dir, 'nested', 'sim.sqlite');
      const a = openDb(file);
      currentSeasonId(a);
      touchAlive(a, 123);
      a.close();
      const b = openDb(file);
      expect(b.pragma('user_version', { simple: true })).toBe(4);
      expect(b.prepare("SELECT value FROM meta WHERE key = 'test_data'").get()).toBeUndefined();
      expect(b.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get()).toEqual({ value: '123' });
      touchAlive(b, 456);
      expect(b.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get()).toEqual({ value: '456' });
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrations 002 to 004 apply to a Phase 1 database (user_version 1): rows intact, test_data still set', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { default: Database } = await import('better-sqlite3');
    const dir = mkdtempSync(join(tmpdir(), 'sim-db-'));
    const tables = ['meta', 'seasons', 'events', 'orders', 'balances', 'account', 'basis', 'round_trips'];
    const dump = (db: Db) => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    let db: Db | null = null;
    try {
      const file = join(dir, 'sim.sqlite');
      // A database as Phase 1 left it: only 001 applied, with data in it.
      const v1 = new Database(file);
      v1.exec(readFileSync(new URL('../src/db/migrations/001_init.sql', import.meta.url), 'utf8'));
      v1.pragma('user_version = 1');
      v1.exec(`
        INSERT INTO meta (key, value) VALUES ('test_data', '1'), ('last_alive', '777');
        INSERT INTO seasons (name, started_at) VALUES ('Season 1', 5);
        INSERT INTO events (season_id, time, type, symbol, market, payload)
          VALUES (1, 20, 'feed_gap', 'BTCUSDT', 'spot', '{"startedAt":10,"endedAt":20,"reason":"Disconnected"}');
        INSERT INTO orders (id, season_id, symbol, market, status, created_at, updated_at, data)
          VALUES ('o-1', 1, 'BTCUSDT', 'spot', 'open', 30, 30, '{"id":"o-1"}');
        INSERT INTO balances (season_id, wallet, asset, free, locked) VALUES (1, 'spot', 'USDT', '900.5', '99.5');
        INSERT INTO account (season_id, total_deposited) VALUES (1, '1000');
        INSERT INTO trade_cursor (season_id, symbol, last_trade_id) VALUES (1, 'BTCUSDT', 42);
        INSERT INTO basis (season_id, asset, qty, cost, round_trip_id, opened_at, trip_realized)
          VALUES (1, 'BTC', '0.5', '40000', 'rt-1', 25, '0');
        INSERT INTO round_trips (id, season_id, symbol, opened_at, closed_at, pnl) VALUES ('rt-0', 1, 'BTCUSDT', 1, 2, '-3.5');
        INSERT INTO fills (id, season_id, order_id, symbol, market, side, qty, price, quote, liquidity, fee_asset, fee,
          fee_usd, best_at_arrival, best_at_submit, slippage_usd, drift_usd, trigger_price, realized_pnl, round_trip_id, time)
          VALUES ('f-1', 1, 'o-1', 'BTCUSDT', 'spot', 'buy', '0.5', '80000', '40000', 'taker', 'BTC', '0.0005', '40',
            '79990', '79990', '5', '0', NULL, NULL, 'rt-1', 25);
      `);
      const before = dump(v1 as unknown as Db);
      const fillsBefore = v1.prepare('SELECT * FROM fills').all() as Record<string, unknown>[];
      v1.close();

      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(4);
      expect(dump(db)).toEqual(before);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'test_data'").get()).toEqual({ value: '1' });
      // The fill keeps every value; the perp columns are empty on it.
      expect(db.prepare('SELECT * FROM fills').all()).toEqual(
        fillsBefore.map((f) => ({ ...f, position_id: null, uncovered: null })),
      );
      for (const t of ['positions', 'perp_settings', 'perp_state', 'catchup_jobs']) {
        expect(db.prepare(`SELECT count(*) c FROM ${t}`).get()).toEqual({ c: 0 });
      }
      // The spot state reads as before; there is no perp state yet.
      const ledger = loadLedger(db, 1, ASSETS);
      expect([...loadSpotState(db, 1, ledger).orders.keys()]).toEqual(['o-1']);
      const perp = loadPerpState(db, 1, ledger);
      expect([perp.orders.size, perp.positions, perp.settings, perp.lastTradeId]).toEqual([0, {}, {}, {}]);
      expect(db.prepare('SELECT * FROM trade_cursor').all()).toEqual([
        { season_id: 1, market: 'spot', symbol: 'BTCUSDT', last_trade_id: 42 },
      ]);
      expect(db.prepare('SELECT * FROM open_gaps').all()).toEqual([]);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration 003 on a database at user_version 2: cursor rows become spot rows, open gaps and test_data stay', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { default: Database } = await import('better-sqlite3');
    const dir = mkdtempSync(join(tmpdir(), 'sim-db-'));
    let db: Db | null = null;
    try {
      const file = join(dir, 'sim.sqlite');
      // A database with 001 and 002 applied, with data in it.
      const v2 = new Database(file);
      for (const m of ['001_init.sql', '002_open_gaps.sql']) {
        v2.exec(readFileSync(new URL(`../src/db/migrations/${m}`, import.meta.url), 'utf8'));
      }
      v2.pragma('user_version = 2');
      v2.exec(`
        INSERT INTO meta (key, value) VALUES ('test_data', '1'), ('last_alive', '777');
        INSERT INTO seasons (name, started_at) VALUES ('Season 1', 5);
        INSERT INTO trade_cursor (season_id, symbol, last_trade_id) VALUES (1, 'BTCUSDT', 42), (1, 'ETHUSDT', 7), (2, 'BTCUSDT', 9);
        INSERT INTO open_gaps (season_id, market, symbol, started_at, reason) VALUES (1, 'spot', 'BTCUSDT', 700, 'Disconnected');
      `);
      v2.close();

      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(4);
      expect(db.prepare('SELECT * FROM trade_cursor ORDER BY season_id, symbol').all()).toEqual([
        { season_id: 1, market: 'spot', symbol: 'BTCUSDT', last_trade_id: 42 },
        { season_id: 1, market: 'spot', symbol: 'ETHUSDT', last_trade_id: 7 },
        { season_id: 2, market: 'spot', symbol: 'BTCUSDT', last_trade_id: 9 },
      ]);
      expect(db.prepare('SELECT key, value FROM meta ORDER BY key').all()).toEqual([
        { key: 'last_alive', value: '777' },
        { key: 'test_data', value: '1' },
      ]);
      // The gap open before the upgrade does not know its cursor.
      expect(loadOpenGaps(db, 1)).toEqual([
        { market: 'spot', symbol: 'BTCUSDT', startedAt: 700, reason: 'Disconnected', lastTradeIdBefore: null },
      ]);
      // The same symbol on another market is a separate cursor.
      db.prepare("INSERT INTO trade_cursor (season_id, market, symbol, last_trade_id) VALUES (1, 'perp', 'BTCUSDT', 5)").run();
      const state = loadSpotState(db, 1, loadLedger(db, 1, ASSETS));
      expect(state.lastTradeId).toEqual({ BTCUSDT: 42, ETHUSDT: 7 });
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('persist and loadSpotState', () => {
  it('partial fill: reload equals the in-memory state, rows land in every table', () => {
    const { engine, db, seasonId } = partialFillScenario();
    expect(engine.state.lastTradeId.BTCUSDT).toBeGreaterThan(0);
    const reloaded = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    expect(snapshot(reloaded)).toBe(snapshot(engine.state));
    expect(reloaded.orders.size).toBe(1);
    const o = [...reloaded.orders.values()][0]!;
    expect(o.status).toBe('partially_filled');
    expect(o.lockAmount.toString()).toBe('49.75');
    expect(o.price?.toString()).toBe('99.5');

    expect(db.prepare('SELECT count(*) c FROM fills').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT qty, price, liquidity FROM fills').get()).toEqual({ qty: '0.5', price: '99.5', liquidity: 'maker' });
    expect(db.prepare('SELECT total_deposited FROM account').get()).toEqual({ total_deposited: '1000' });
    expect(db.prepare('SELECT last_trade_id FROM trade_cursor WHERE symbol = ?').get('BTCUSDT')).toEqual({ last_trade_id: engine.state.lastTradeId.BTCUSDT });
    expect(db.prepare('SELECT type, symbol, market FROM events ORDER BY id').all()).toEqual([
      { type: 'deposit', symbol: null, market: 'spot' },
      { type: 'order_placed', symbol: 'BTCUSDT', market: 'spot' },
      { type: 'fill', symbol: 'BTCUSDT', market: 'spot' },
    ]);
  });

  it('persist with no events still follows pending -> open', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    persist(db, seasonId, simOf(engine), [{ type: 'order_placed', time: ctx.now, order }]);
    arrive(engine, order, ctx);
    persist(db, seasonId, simOf(engine), []);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).toEqual({ status: 'open' });
    expect(snapshot(loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS)))).toBe(snapshot(engine.state));
  });

  it('a cancel in flight is stored with the order and survives a reload; an older row without it loads as none', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    arrive(engine, order, ctx);
    const other = placedOrder(engine.submit(limitBuy('99.40', '1'), ctx));
    arrive(engine, other, ctx);
    expect(engine.cancel(order.id, ctx)).toEqual({ ok: true, events: [] });
    persist(db, seasonId, simOf(engine), []);
    const at = engine.state.orders.get(order.id)!.cancelArrivesAt!;
    expect(JSON.parse((db.prepare('SELECT data FROM orders WHERE id = ?').get(order.id) as { data: string }).data).cancelArrivesAt).toBe(at);

    // A row written before orders carried the field.
    const row = db.prepare('SELECT data FROM orders WHERE id = ?').get(other.id) as { data: string };
    const { cancelArrivesAt: _dropped, ...old } = JSON.parse(row.data) as Record<string, unknown>;
    db.prepare('UPDATE orders SET data = ? WHERE id = ?').run(JSON.stringify(old), other.id);

    const reloaded = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    expect(reloaded.orders.get(order.id)!.cancelArrivesAt).toBe(at);
    expect(reloaded.orders.get(other.id)!.cancelArrivesAt).toBeNull();
    // Key order aside (the field is added back last), the reloaded state is the same.
    expect(JSON.parse(snapshot(reloaded))).toEqual(JSON.parse(snapshot(engine.state)));
  });

  it('settleLateCancels answers the cancel of an order that finished while it was in flight, once, in one transaction', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const filled = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    arrive(engine, filled, ctx);
    const open = placedOrder(engine.submit(limitBuy('99.40', '1'), ctx));
    arrive(engine, open, ctx);
    engine.cancel(filled.id, ctx);
    engine.cancel(open.id, ctx);
    const openAt = engine.state.orders.get(open.id)!.cancelArrivesAt;
    ctx.now += 1;
    const events = engine.onTrade('BTCUSDT', trade('99.45', '5', true), ctx); // fills the 99.50 buy only
    persist(db, seasonId, simOf(engine), events);
    const dataOf = (id: string) =>
      JSON.parse((db.prepare('SELECT data FROM orders WHERE id = ?').get(id) as { data: string }).data);
    expect(dataOf(filled.id).cancelArrivesAt).not.toBeNull();

    const now = ctx.now + 60_000;
    const written = settleLateCancels(db, seasonId, now);
    expect(written.map((e) => [e.type, e.time, e.order.id, e.reason, e.order.cancelArrivesAt])).toEqual([
      ['cancel_rejected', now, filled.id, 'Cancel arrived too late: order already filled', null],
    ]);
    expect(dataOf(filled.id).cancelArrivesAt).toBeNull();
    expect(db.prepare('SELECT status, updated_at AS updatedAt FROM orders WHERE id = ?').get(filled.id)).toEqual({
      status: 'filled',
      updatedAt: now,
    });
    const rows = db.prepare("SELECT time, symbol, market, payload FROM events WHERE type = 'cancel_rejected'").all() as {
      time: number;
      symbol: string;
      market: string;
      payload: string;
    }[];
    expect(rows.map((r) => [r.time, r.symbol, r.market, JSON.parse(r.payload).reason])).toEqual([
      [now, 'BTCUSDT', 'spot', 'Cancel arrived too late: order already filled'],
    ]);
    // A live order's cancel is left to the engine.
    expect(dataOf(open.id).cancelArrivesAt).toBe(openAt);
    expect(settleLateCancels(db, seasonId, now + 1)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'cancel_rejected'").get()).toEqual({ n: 1 });
  });

  it('terminal orders are stored but not loaded', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    arrive(engine, order, ctx);
    persist(db, seasonId, simOf(engine), cancelNow(engine, order.id, ctx));
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).toEqual({ status: 'cancelled' });
    expect(loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS)).orders.size).toBe(0);
  });

  it('an unknown-type rejected order is storable', () => {
    const { engine, ctx, db, seasonId } = setup();
    const events = engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'iceberg', qty: '1' } as unknown as SpotOrderRequest, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_rejected']);
    persist(db, seasonId, simOf(engine), events);
    expect(db.prepare('SELECT type FROM events').get()).toEqual({ type: 'order_rejected' });
    expect(db.prepare("SELECT status FROM orders WHERE status = 'rejected'").all()).toHaveLength(1);
  });

  it('round trip: a deferred triggered order (arrivesAt null), an attached pair leg and lastTradeId survive', () => {
    const { market, engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    seedCoins(engine.state, 'BTC', D('2'));
    const events: EngineEvent[] = [];
    const stop = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'stop_loss', triggerPrice: '99', qty: '1' }, ctx));
    arrive(engine, stop, ctx);
    const parent = placedOrder(engine.submit(limitBuy('99.50', '1', { attach: { stopLoss: '95', takeProfit: '110' } }), ctx));
    arrive(engine, parent, ctx);
    events.push(...engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx));
    // Trade at 99 triggers the stop (and fills more of the parent) while fresh.
    events.push(...engine.onTrade('BTCUSDT', trade('99.00', '0.1', true), ctx));
    expect(events.some((e) => e.type === 'order_triggered')).toBe(true);
    // Stale: the triggered stop cannot execute (arrivesAt null) and the cancelled parent's pair waits.
    market.setFresh('BTCUSDT', false);
    events.push(...arrive(engine, engine.state.orders.get(stop.id)!, ctx));
    events.push(...cancelNow(engine, parent.id, ctx));

    const deferred = engine.state.orders.get(stop.id)!;
    expect([deferred.status, deferred.arrivesAt]).toEqual(['triggered', null]);
    const legs = [...engine.state.orders.values()].filter((o) => o.parentId === parent.id);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.status === 'pending' && l.arrivesAt === null)).toBe(true);

    persist(db, seasonId, simOf(engine), events);
    const reloaded = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    expect(snapshot(reloaded)).toBe(snapshot(engine.state));
    expect(reloaded.orders.get(stop.id)!.arrivesAt).toBeNull();
    expect(reloaded.orders.get(stop.id)!.triggeredAt).toBe(deferred.triggeredAt);
    for (const l of legs) expect(reloaded.orders.get(l.id)!.parentId).toBe(parent.id);
    expect(reloaded.lastTradeId).toEqual(engine.state.lastTradeId);
    expect(Object.keys(reloaded.lastTradeId).length).toBeGreaterThan(0);
    expect(checkInvariants(simOf(new SpotEngine(reloaded)))).toEqual([]);
  });

  it('feed gaps become feed_gap events with the gap payload, the trade cursor at the gap start included', () => {
    const { engine, db, seasonId } = setup();
    persist(db, seasonId, simOf(engine), [], {
      feedGaps: [
        { symbol: 'BTCUSDT', market: 'spot', startedAt: 10, endedAt: 20, reason: 'resync', lastTradeIdBefore: 41 },
        { symbol: 'ETHUSDT', market: 'spot', startedAt: 12, endedAt: 21, reason: 'resync', lastTradeIdBefore: null },
      ],
    });
    const { rows } = queryHistory(db, { seasonId, limit: 10 });
    expect(rows).toEqual([
      {
        id: 2, time: 21, type: 'feed_gap', symbol: 'ETHUSDT', market: 'spot',
        payload: { startedAt: 12, endedAt: 21, reason: 'resync', lastTradeIdBefore: null },
      },
      {
        id: 1, time: 20, type: 'feed_gap', symbol: 'BTCUSDT', market: 'spot',
        payload: { startedAt: 10, endedAt: 20, reason: 'resync', lastTradeIdBefore: 41 },
      },
    ]);
  });

  it('the spot trade cursor is saved and loaded as market spot; a perp cursor of the same symbol is left alone', () => {
    const { engine, ctx, db, seasonId } = setup();
    db.prepare("INSERT INTO trade_cursor (season_id, market, symbol, last_trade_id) VALUES (?, 'perp', 'BTCUSDT', 999)").run(seasonId);
    engine.onTrade('BTCUSDT', trade('99.40'), ctx);
    const id = engine.state.lastTradeId.BTCUSDT!;
    persist(db, seasonId, simOf(engine), [], { cursor: true });
    expect(db.prepare('SELECT market, symbol, last_trade_id AS id FROM trade_cursor ORDER BY market').all()).toEqual([
      { market: 'perp', symbol: 'BTCUSDT', id: 999 },
      { market: 'spot', symbol: 'BTCUSDT', id },
    ]);
    expect(loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS)).lastTradeId).toEqual({ BTCUSDT: id });
  });

  it('a failure midway rolls back everything from that call', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const depositEvent = { type: 'deposit', time: NOW, wallet: 'spot', amount: D('1000'), totalDeposited: D('1000') } as const;
    const dupFill = {
      type: 'fill',
      time: NOW,
      order: { id: 'o1', symbol: 'BTCUSDT', status: 'filled', createdAt: NOW },
      fill: {
        id: 'f1', orderId: 'o1', symbol: 'BTCUSDT', side: 'buy', qty: D(1), price: D(1), quote: D(1),
        liquidity: 'taker', feeAsset: 'BTC', fee: D(0), feeUsd: D(0), bestAtArrival: null, bestAtSubmit: null,
        slippageUsd: D(0), driftUsd: D(0), triggerPrice: null, realizedPnl: null, roundTripId: null, time: NOW,
      },
    } as unknown as EngineEvent;
    expect(() => persist(db, seasonId, simOf(engine), [depositEvent, dupFill, dupFill])).toThrow();
    for (const table of ['events', 'fills', 'orders', 'balances', 'account']) {
      expect(db.prepare(`SELECT count(*) c FROM ${table}`).get()).toEqual({ c: 0 });
    }
  });
});

describe('open gaps', () => {
  const gap = (symbol: string, startedAt: number, reason: string, lastTradeIdBefore: number | null = null, market: Market = 'spot') => ({
    market,
    symbol,
    startedAt,
    reason,
    lastTradeIdBefore,
  });

  it('openGap keeps the earliest start (with its reason) per symbol; loadOpenGaps reads one season', () => {
    const { db, seasonId } = setup();
    expect(loadOpenGaps(db, seasonId)).toEqual([]);
    openGap(db, seasonId, gap('BTCUSDT', 2000, 'Disconnected'));
    openGap(db, seasonId, gap('BTCUSDT', 3000, 'Feed lagging by 6.0s')); // later: the open gap stays
    openGap(db, seasonId, gap('ETHUSDT', 5000, 'Order book resyncing'));
    openGap(db, seasonId + 1, gap('BTCUSDT', 1, 'Server offline'));
    expect(loadOpenGaps(db, seasonId)).toEqual([gap('BTCUSDT', 2000, 'Disconnected'), gap('ETHUSDT', 5000, 'Order book resyncing')]);
    openGap(db, seasonId, gap('ETHUSDT', 4000, 'Server offline')); // earlier: it starts there
    expect(loadOpenGaps(db, seasonId)).toEqual([gap('BTCUSDT', 2000, 'Disconnected'), gap('ETHUSDT', 4000, 'Server offline')]);
  });

  it('persist records a feed_gap and deletes its open gap row in one transaction', () => {
    const { engine, db, seasonId } = setup();
    openGap(db, seasonId, gap('BTCUSDT', 10, 'Disconnected'));
    openGap(db, seasonId, gap('ETHUSDT', 15, 'Disconnected'));
    const feedGaps = [{ symbol: 'BTCUSDT', market: 'spot' as const, startedAt: 10, endedAt: 20, reason: 'Disconnected', lastTradeIdBefore: null }];
    const gapEvents = () => db.prepare("SELECT count(*) AS n FROM events WHERE type = 'feed_gap'").get();

    // The event insert fails: the row stays.
    db.exec("CREATE TEMP TRIGGER no_gap BEFORE INSERT ON events WHEN NEW.type = 'feed_gap' BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => persist(db, seasonId, simOf(engine), [], { feedGaps })).toThrow('no');
    expect(loadOpenGaps(db, seasonId).map((g) => g.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    db.exec('DROP TRIGGER no_gap');

    // The row delete fails: no feed_gap event either.
    db.exec("CREATE TEMP TRIGGER keep_gap BEFORE DELETE ON open_gaps BEGIN SELECT RAISE(ABORT, 'keep'); END");
    expect(() => persist(db, seasonId, simOf(engine), [], { feedGaps })).toThrow('keep');
    expect(gapEvents()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER keep_gap');

    persist(db, seasonId, simOf(engine), [], { feedGaps });
    expect(gapEvents()).toEqual({ n: 1 });
    expect(loadOpenGaps(db, seasonId)).toEqual([gap('ETHUSDT', 15, 'Disconnected')]);
  });

  it('gaps are kept per market: a perp gap of the same symbol is separate, and recording the spot one leaves it open', () => {
    const { engine, db, seasonId } = setup();
    openGap(db, seasonId, gap('BTCUSDT', 2000, 'Disconnected', 41));
    openGap(db, seasonId, gap('BTCUSDT', 1500, 'Mark price stale', 7, 'perp'));
    openGap(db, seasonId, gap('BTCUSDT', 2500, 'Feed lagging by 6.0s', 50)); // later: the spot gap stays
    expect(loadOpenGaps(db, seasonId)).toEqual([
      gap('BTCUSDT', 1500, 'Mark price stale', 7, 'perp'),
      gap('BTCUSDT', 2000, 'Disconnected', 41),
    ]);
    openGap(db, seasonId, gap('BTCUSDT', 1000, 'Server offline', 40)); // earlier: it starts there, with its cursor
    expect(loadOpenGaps(db, seasonId)).toEqual([
      gap('BTCUSDT', 1500, 'Mark price stale', 7, 'perp'),
      gap('BTCUSDT', 1000, 'Server offline', 40),
    ]);

    persist(db, seasonId, simOf(engine), [], {
      feedGaps: [{ market: 'spot', symbol: 'BTCUSDT', startedAt: 1000, endedAt: 3000, reason: 'Server offline', lastTradeIdBefore: 40 }],
    });
    expect(loadOpenGaps(db, seasonId)).toEqual([gap('BTCUSDT', 1500, 'Mark price stale', 7, 'perp')]);
  });
});

describe('loadLedger', () => {
  it('reads balances and totals from rows written by the spot-only schema', () => {
    const { db, seasonId } = setup();
    const ins = db.prepare('INSERT INTO balances (season_id, wallet, asset, free, locked) VALUES (?, ?, ?, ?, ?)');
    ins.run(seasonId, 'spot', 'USDT', '700.5', '49.75');
    ins.run(seasonId, 'spot', 'BTC', '0.25', '0');
    ins.run(seasonId, 'leverage', 'USDT', '300', '0');
    db.prepare('INSERT INTO account (season_id, total_deposited) VALUES (?, ?)').run(seasonId, '1000');
    const l = loadLedger(db, seasonId, ASSETS);
    expect(l.balances.spot.USDT!.free.toString()).toBe('700.5');
    expect(l.balances.spot.USDT!.locked.toString()).toBe('49.75');
    expect(l.balances.spot.BTC!.free.toString()).toBe('0.25');
    expect(l.balances.leverage.USDT!.free.toString()).toBe('300');
    expect(l.totalDeposited.toString()).toBe('1000');
    expect(loadSpotState(db, seasonId, l).ledger).toBe(l);
  });
});

describe('checkInvariants', () => {
  it('reloaded state is consistent; corrupting locked USDT by +1 is reported', () => {
    const { db, seasonId } = partialFillScenario();
    const reloaded = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    expect(checkInvariants(simOf(new SpotEngine(reloaded)))).toEqual([]);
    reloaded.ledger.balances.spot.USDT!.locked = reloaded.ledger.balances.spot.USDT!.locked.plus(1);
    expect(checkInvariants(simOf(new SpotEngine(reloaded)))).toEqual(['Locked USDT 50.75 != sum of open order locks 49.75']);
  });

  it('basis quantity must equal spot holdings', () => {
    const state = emptySpotState(emptyLedger(ASSETS));
    seedCoins(state, 'BTC', D('2'));
    expect(checkInvariants(simOf(new SpotEngine(state)))).toEqual([]);
    state.ledger.balances.spot.BTC!.free = D('1.5');
    expect(checkInvariants(simOf(new SpotEngine(state)))).toEqual(['Basis BTC qty 2 != holdings 1.5']);
  });
});

describe('events are append-only', () => {
  it('UPDATE and DELETE are rejected', () => {
    const { db } = partialFillScenario();
    expect(() => db.prepare("UPDATE events SET type = 'x'").run()).toThrow('events are append-only');
    expect(() => db.prepare('DELETE FROM events').run()).toThrow('events are append-only');
    expect(db.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: 3 });
  });
});

describe('queryHistory', () => {
  function seeded(): { db: Db; seasonId: number } {
    const db = openDb(':memory:');
    const seasonId = currentSeasonId(db);
    const ins = db.prepare('INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(seasonId, 100, 'deposit', null, 'spot', '{"amount":"1000"}');
    ins.run(seasonId, 200, 'fill', 'BTCUSDT', 'spot', '{"n":1}');
    ins.run(seasonId, 300, 'fill', 'ETHUSDT', 'spot', '{"n":2}');
    ins.run(seasonId, 300, 'order_placed', 'BTCUSDT', 'spot', '{"n":3}');
    ins.run(seasonId, 400, 'transfer', null, null, '{}');
    ins.run(seasonId, 500, 'fill', 'BTCUSDT', 'leverage', '{"n":4}');
    ins.run(2, 600, 'fill', 'BTCUSDT', 'spot', '{"n":5}');
    return { db, seasonId };
  }

  it('newest first by (time, id); other seasons excluded; payload parsed', () => {
    const { db, seasonId } = seeded();
    const { rows, nextBefore } = queryHistory(db, { seasonId, limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(rows[0]!.payload).toEqual({ n: 4 });
    expect(nextBefore).toBeNull();
  });

  it('filters: types, symbol, market (or null market), from/to', () => {
    const { db, seasonId } = seeded();
    const ids = (q: Partial<Parameters<typeof queryHistory>[1]>) => queryHistory(db, { seasonId, limit: 50, ...q }).rows.map((r) => r.id);
    expect(ids({ types: ['fill'] })).toEqual([6, 3, 2]);
    expect(ids({ types: ['fill', 'order_placed'], symbol: 'BTCUSDT' })).toEqual([6, 4, 2]);
    expect(ids({ market: 'spot' })).toEqual([5, 4, 3, 2, 1]);
    expect(ids({ from: 200, to: 300 })).toEqual([4, 3, 2]);
  });

  it('paginates with nextBefore until exhausted', () => {
    const { db, seasonId } = seeded();
    const p1 = queryHistory(db, { seasonId, limit: 4 });
    expect(p1.rows.map((r) => r.id)).toEqual([6, 5, 4, 3]);
    expect(p1.nextBefore).toBe(3);
    const p2 = queryHistory(db, { seasonId, limit: 4, before: p1.nextBefore! });
    expect(p2.rows.map((r) => r.id)).toEqual([2, 1]);
    expect(p2.nextBefore).toBeNull();
  });
});

describe('equity snapshot and heartbeat', () => {
  it('stores the account value as decimal strings', () => {
    const { db, seasonId } = setup();
    insertEquitySnapshot(
      db,
      seasonId,
      { total: D('1010.5'), totalDeposited: D('1000'), leverage: { value: D('10') } } as Parameters<typeof insertEquitySnapshot>[2],
      555,
    );
    expect(db.prepare('SELECT time, total, deposited, spot_value, leverage_value FROM equity_snapshots').get()).toEqual({
      time: 555, total: '1010.5', deposited: '1000', spot_value: '1000.5', leverage_value: '10',
    });
  });
});

describe('history cursor with time order different from id order', () => {
  it('a late-written feed_gap (older time, higher id) is visited exactly once, in order', () => {
    const { db, seasonId } = setup();
    const ins = db.prepare('INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(seasonId, 1000, 'fill', 'BTCUSDT', 'spot', '{}');
    ins.run(seasonId, 990, 'feed_gap', 'BTCUSDT', 'spot', '{}');
    const seen: number[] = [];
    let before: number | undefined;
    for (let i = 0; i < 5; i++) {
      const page = queryHistory(db, { seasonId, limit: 1, before });
      seen.push(...page.rows.map((r) => r.id));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual([1, 2]);
  });

  it('a full walk over a mixed set returns every row exactly once in (time DESC, id DESC) order', () => {
    const { db, seasonId } = setup();
    const ins = db.prepare('INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, ?, ?, ?, ?)');
    for (const time of [500, 300, 500, 100, 300, 900, 300, 100, 700, 500]) ins.run(seasonId, time, 'fill', 'BTCUSDT', 'spot', '{}');
    const expected = (db.prepare('SELECT id FROM events ORDER BY time DESC, id DESC').all() as { id: number }[]).map((r) => r.id);
    for (const limit of [1, 2, 3, 4]) {
      const seen: number[] = [];
      let before: number | undefined;
      for (let i = 0; i < 50; i++) {
        const page = queryHistory(db, { seasonId, limit, before });
        seen.push(...page.rows.map((r) => r.id));
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }
      expect(seen).toEqual(expected);
    }
  });
});

describe('revived Decimals', () => {
  it('every Decimal field of a reloaded state is a Decimal instance', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    seedCoins(engine.state, 'BTC', D('2'));
    const buy = placedOrder(engine.submit(limitBuy('99.50', '1', { attach: { stopLoss: '95', takeProfit: '110' } }), ctx));
    const stop = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'stop_loss', triggerPrice: '99', qty: '0.5' }, ctx));
    const mkt = placedOrder(engine.submit({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.1' }, ctx));
    persist(db, seasonId, simOf(engine), []);
    const r = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    expect(r.orders.size).toBe(3);
    const isD = (v: unknown) => v === null || v instanceof Decimal;
    for (const o of r.orders.values()) {
      for (const k of ['qty', 'quoteQty', 'price', 'triggerPrice', 'bestAtSubmit'] as const) expect(isD(o[k]), `${o.id}.${k}`).toBe(true);
      for (const k of ['filledQty', 'filledQuote', 'fee', 'lockAmount'] as const) expect(o[k]).toBeInstanceOf(Decimal);
    }
    const reBuy = r.orders.get(buy.id)!;
    expect(reBuy.attach!.stopLoss).toBeInstanceOf(Decimal);
    expect(reBuy.attach!.takeProfit).toBeInstanceOf(Decimal);
    expect(r.orders.get(stop.id)!.triggerPrice).toBeInstanceOf(Decimal);
    expect(r.orders.get(mkt.id)).toBeDefined();
    for (const wallet of ['spot', 'leverage'] as const) {
      for (const b of Object.values(r.ledger.balances[wallet])) {
        expect(b.free).toBeInstanceOf(Decimal);
        expect(b.locked).toBeInstanceOf(Decimal);
      }
    }
    for (const b of Object.values(r.basis)) {
      expect(b.qty).toBeInstanceOf(Decimal);
      expect(b.cost).toBeInstanceOf(Decimal);
      expect(b.tripRealized).toBeInstanceOf(Decimal);
    }
    expect(Object.keys(r.basis).length).toBeGreaterThan(0);
    expect(r.ledger.totalDeposited).toBeInstanceOf(Decimal);
  });

  it('an engine on the reloaded state cancels a reloaded open limit order and releases its lock', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    arrive(engine, order, ctx);
    persist(db, seasonId, simOf(engine), []);
    const reloaded = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    const events = cancelNow(new SpotEngine(reloaded), order.id, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_cancelled']);
    expect(reloaded.ledger.balances.spot.USDT!.locked.toString()).toBe('0');
    expect(reloaded.ledger.balances.spot.USDT!.free.toString()).toBe('1000');
    expect(checkInvariants(simOf(new SpotEngine(reloaded)))).toEqual([]);
  });

  it('a negative-zero Decimal is stored as "0" in order data and event payloads', () => {
    const { engine, ctx, db, seasonId } = setup();
    deposit(engine.state.ledger, 'spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    const negZero = { ...order, filledQty: D('-0') };
    persist(db, seasonId, simOf(engine), [{ type: 'order_placed', time: ctx.now, order: negZero }]);
    const { data } = db.prepare('SELECT data FROM orders WHERE id = ?').get(order.id) as { data: string };
    expect(JSON.parse(data).filledQty).toBe('0');
    const { payload } = db.prepare('SELECT payload FROM events').get() as { payload: string };
    expect(JSON.parse(payload).order.filledQty).toBe('0');
  });
});

describe('currentSeasonId clock', () => {
  it('uses the injected time for started_at', () => {
    const db = openDb(':memory:');
    currentSeasonId(db, () => 4242);
    expect(db.prepare('SELECT started_at FROM seasons').get()).toEqual({ started_at: 4242 });
  });
});

describe('openDb durability', () => {
  it('sets PRAGMA synchronous = FULL (2)', async () => {
    expect(openDb(':memory:').pragma('synchronous', { simple: true })).toBe(2);
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sim-db-'));
    let db: Db | null = null;
    try {
      db = openDb(join(dir, 'sim.sqlite'));
      expect(db.pragma('synchronous', { simple: true })).toBe(2);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('persist writes what changed', () => {
  /** Counts rows inserted or updated in `table` from now on (an upsert counts once). */
  function countWrites(db: Db, table: string): () => number {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS writes (tbl TEXT NOT NULL)');
    for (const op of ['INSERT', 'UPDATE']) {
      db.exec(`CREATE TEMP TRIGGER count_${table}_${op} AFTER ${op} ON ${table} BEGIN INSERT INTO writes VALUES ('${table}'); END`);
    }
    return () => (db.prepare('SELECT count(*) AS n FROM writes WHERE tbl = ?').get(table) as { n: number }).n;
  }

  /** deposit 1000; limit buys 1 @ 99.50 and 1 @ 99.00 resting; persisted. */
  function twoResting() {
    const t = setup();
    const { engine, ctx, db, seasonId } = t;
    const events: EngineEvent[] = [...(deposit(engine.state.ledger, 'spot', D('1000'), ctx) as { events: EngineEvent[] }).events];
    const a = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    const b = placedOrder(engine.submit(limitBuy('99.00', '1'), ctx));
    events.push(...arrive(engine, a, ctx), ...arrive(engine, b, ctx));
    persist(db, seasonId, simOf(engine), events);
    return { ...t, a, b };
  }

  it('a trade that changes nothing upserts no order; a fill upserts only the order it fills', () => {
    const { engine, ctx, db, seasonId, a } = twoResting();
    const orderWrites = countWrites(db, 'orders');
    persist(db, seasonId, simOf(engine), engine.onTrade('BTCUSDT', trade('99.60', '1', true), ctx));
    expect(orderWrites()).toBe(0);
    const events = engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx);
    expect(events.map((e) => e.type)).toEqual(['fill']);
    persist(db, seasonId, simOf(engine), events);
    expect(orderWrites()).toBe(1);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id)).toEqual({ status: 'partially_filled' });
  });

  it('a call with no events and no changed order writes nothing, the trade cursor only when asked', () => {
    const { engine, ctx, db, seasonId } = twoResting();
    const cursorOf = () => db.prepare('SELECT last_trade_id AS id FROM trade_cursor').get() as { id: number } | undefined;
    const before = cursorOf();
    const writes = ['orders', 'balances', 'basis', 'account', 'trade_cursor', 'events'].map((tbl) => countWrites(db, tbl));
    const noop = trade('99.60', '1', true);
    expect(persist(db, seasonId, simOf(engine), engine.onTrade('BTCUSDT', noop, ctx))).toBe(false);
    expect(writes.map((n) => n())).toEqual([0, 0, 0, 0, 0, 0]);
    expect(cursorOf()).toEqual(before);

    expect(persist(db, seasonId, simOf(engine), [], { cursor: true })).toBe(true);
    expect(cursorOf()).toEqual({ id: noop.id });
    expect(writes.map((n) => n())).toEqual([0, 0, 0, 0, 1, 0]);
  });

  it('a call with events writes the trade cursor in its own transaction', () => {
    const { engine, ctx, db, seasonId } = twoResting();
    const fill = trade('99.40', '0.5', true);
    expect(persist(db, seasonId, simOf(engine), engine.onTrade('BTCUSDT', fill, ctx))).toBe(true);
    expect(db.prepare('SELECT last_trade_id AS id FROM trade_cursor').get()).toEqual({ id: fill.id });
  });

  it('after persist a finished order leaves memory; loadSpotState still finds only the live ones', () => {
    const { engine, ctx, db, seasonId, a, b } = twoResting();
    persist(db, seasonId, simOf(engine), engine.onTrade('BTCUSDT', trade('99.40', '5', true), ctx));
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id)).toEqual({ status: 'filled' });
    expect([...engine.state.orders.keys()]).toEqual([b.id]);
    const reloaded = loadSpotState(db, seasonId, loadLedger(db, seasonId, ASSETS));
    expect([...reloaded.orders.keys()]).toEqual([b.id]);
    expect(snapshot(reloaded)).toBe(snapshot(engine.state));
  });

  it('an order that fills while its cancel is in flight stays in memory until the cancel arrives, which is recorded as too late', () => {
    const { engine, ctx, db, seasonId, a } = twoResting();
    expect(engine.cancel(a.id, ctx).ok).toBe(true);
    persist(db, seasonId, simOf(engine), []);
    ctx.now += 1;
    persist(db, seasonId, simOf(engine), engine.onTrade('BTCUSDT', trade('99.40', '1', true), ctx));
    expect(engine.state.orders.get(a.id)!.status).toBe('filled');

    ctx.now = engine.state.orders.get(a.id)!.cancelArrivesAt!;
    const events = engine.arriveCancel(a.id, ctx);
    expect(events.map((e) => (e.type === 'cancel_rejected' ? e.reason : e.type))).toEqual([
      'Cancel arrived too late: order already filled',
    ]);
    persist(db, seasonId, simOf(engine), events);
    expect(engine.state.orders.has(a.id)).toBe(false);
    const row = db.prepare('SELECT status, data FROM orders WHERE id = ?').get(a.id) as { status: string; data: string };
    expect([row.status, JSON.parse(row.data).cancelArrivesAt]).toEqual(['filled', null]);
    expect(settleLateCancels(db, seasonId, ctx.now + 60_000)).toEqual([]);
  });

  it('a failed write keeps the changed orders marked, so the next persist still writes them', () => {
    const { engine, ctx, db, seasonId, a } = twoResting();
    expect(engine.cancel(a.id, ctx).ok).toBe(true);
    db.exec("CREATE TEMP TRIGGER no_orders BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => persist(db, seasonId, simOf(engine), [])).toThrow('no');
    db.exec('DROP TRIGGER no_orders');
    persist(db, seasonId, simOf(engine), []);
    const row = db.prepare('SELECT data FROM orders WHERE id = ?').get(a.id) as { data: string };
    expect(JSON.parse(row.data).cancelArrivesAt).toBe(engine.state.orders.get(a.id)!.cancelArrivesAt);
  });
});


// ---- perps ----

const DAY = 86_400_000;

function perpSetup() {
  const market = new FakePerpMarket();
  const ctx = perpCtx(market, { now: NOW });
  const ledger = emptyLedger(ASSETS);
  const sim = new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));
  const db = openDb(':memory:');
  const seasonId = currentSeasonId(db);
  return { market, ctx, sim, perp: sim.perp, db, seasonId };
}

const perpMarketOrder = (side: 'buy' | 'sell', qty: string, more: Partial<PerpOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'market', qty, ...more }) as PerpOrderRequest;
const perpLimit = (side: 'buy' | 'sell', price: string, qty: string, more: Partial<PerpOrderRequest> = {}) =>
  ({ symbol: 'BTCUSDT', side, type: 'limit', price, qty, ...more }) as PerpOrderRequest;

function perpPlaced(events: PerpEvent[]): PerpOrder[] {
  return events.flatMap((e) => (e.type === 'order_placed' ? [e.order] : []));
}

/** Arrive each order at its arrival time; returns everything that happened. */
function perpArrive(engine: PerpEngine, orders: PerpOrder[], ctx: PerpCtx): PerpEvent[] {
  const out: PerpEvent[] = [];
  for (const o of orders) {
    ctx.now = Math.max(ctx.now, o.arrivesAt!);
    out.push(...engine.arrive(o.id, ctx));
  }
  return out;
}

function perpTrade(price: string, qty = '1', sellerInitiated = true): AggTrade {
  tradeId += 1;
  return { id: 1_000 + tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

const LIVE = ['pending', 'open', 'partially_filled', 'triggered'];

/** The whole perp state as plain JSON (Decimal.toJSON gives decimal strings), live orders sorted by id. */
function perpSnapshot(s: PerpState): string {
  return JSON.stringify({
    balances: s.ledger.balances,
    totalDeposited: s.ledger.totalDeposited,
    orders: [...s.orders.values()].filter((o) => LIVE.includes(o.status)).sort((a, b) => a.id.localeCompare(b.id)),
    positions: s.positions,
    settings: s.settings,
    lastTradeId: s.lastTradeId,
    funding: s.funding,
  });
}

const PERP_ORDER_DECIMALS = [
  'qty', 'quoteQty', 'price', 'triggerPrice', 'filledQty', 'filledQuote', 'fee', 'lockAmount', 'bestAtSubmit', 'realizedPnl',
] as const;

/** Every decimal field of the order is a Decimal (or null), never a string. */
function expectRevivedOrder(o: PerpOrder): void {
  for (const k of PERP_ORDER_DECIMALS) {
    const v = o[k];
    expect(v === null || Decimal.isDecimal(v), `${o.id}.${k}`).toBe(true);
  }
  for (const v of [o.attach?.stopLoss ?? null, o.attach?.takeProfit ?? null]) {
    expect(v === null || Decimal.isDecimal(v)).toBe(true);
  }
}

/** What a restart builds from the database. */
function reloadSim(db: Db, seasonId: number): SimEngine {
  const ledger = loadLedger(db, seasonId, ASSETS);
  return new SimEngine(
    ledger,
    new SpotEngine(loadSpotState(db, seasonId, ledger)),
    new PerpEngine(loadPerpState(db, seasonId, ledger)),
  );
}

/**
 * Leverage wallet 5000, leverage 10 on BTCUSDT, a market long 0.1 at 80000 whose attached
 * stop-loss 78000 / take-profit 82000 pair is armed, a limit buy 0.05 @ 79000 resting, and a
 * futures trade processed: all persisted.
 */
function perpScenario() {
  const t = perpSetup();
  const { ctx, sim, perp, db, seasonId } = t;
  const events: SimEvent[] = [];
  const dep = sim.deposit('leverage', D('5000'), ctx);
  if (!dep.ok) throw new Error(dep.reason);
  events.push(...dep.events);
  const lev = perp.setLeverage('BTCUSDT', 10, ctx);
  if (!lev.ok) throw new Error(lev.reason);
  events.push(...lev.events);

  const open = perp.submit(perpMarketOrder('buy', '0.1', { attach: { stopLoss: '78000', takeProfit: '82000' } }), ctx);
  const opened = perpArrive(perp, perpPlaced(open), ctx);
  const legs = perpPlaced(opened);
  events.push(...open, ...opened, ...perpArrive(perp, legs, ctx));
  const rest = perp.submit(perpLimit('buy', '79000', '0.05'), ctx);
  events.push(...rest, ...perpArrive(perp, perpPlaced(rest), ctx));
  events.push(...perp.onTrade('BTCUSDT', perpTrade('80000', '0.01', false), ctx));

  persist(db, seasonId, sim, events);
  const limitId = perpPlaced(rest)[0]!.id;
  const [sl, tp] = legs;
  return { ...t, events, limitId, slId: sl!.id, tpId: tp!.id };
}

describe('perps: persist and loadPerpState', () => {
  it('a long, a resting limit and a stop-loss/take-profit pair round-trip exactly; the invariants hold', () => {
    const { perp, db, seasonId, limitId, slId, tpId } = perpScenario();
    const s = perp.state;
    expect(s.positions.BTCUSDT?.qty.toString()).toBe('0.1');
    expect(s.orders.get(limitId)?.status).toBe('open');
    expect([s.orders.get(slId)?.status, s.orders.get(tpId)?.status]).toEqual(['open', 'open']);
    expect(s.lastTradeId.BTCUSDT).toBeGreaterThan(0);
    expect(s.ledger.balances.leverage.USDT!.locked.gt(0)).toBe(true);

    const reloaded = reloadSim(db, seasonId);
    const r = reloaded.perp.state;
    expect(perpSnapshot(r)).toBe(perpSnapshot(s));
    expect([...r.orders.keys()].sort()).toEqual([limitId, slId, tpId].sort());
    for (const o of r.orders.values()) expectRevivedOrder(o);
    expect(r.orders.get(slId)!.qty).toBeNull();
    expect(r.orders.get(slId)!.closePosition).toBe(true);
    const p = r.positions.BTCUSDT!;
    for (const v of [p.qty, p.entryPrice, p.margin, p.realizedPnl, p.fees, p.funding]) expect(Decimal.isDecimal(v)).toBe(true);
    expect(r.settings).toEqual({ BTCUSDT: { leverage: 10, marginMode: 'isolated' } });
    expect(r.ledger.balances.leverage.USDT!.locked.toString()).toBe(r.orders.get(limitId)!.lockAmount.toString());
    expect(r.dirty.size).toBe(0);
    expect(checkInvariants(reloaded)).toEqual([]);
    expect(checkInvariants(new SimEngine(s.ledger, new SpotEngine(emptySpotState(s.ledger)), perp))).toEqual([]);

    // The spot state sees none of it, and the cursors are kept per market.
    expect(reloaded.spot.state.orders.size).toBe(0);
    expect(reloaded.spot.state.lastTradeId).toEqual({});
    expect(db.prepare('SELECT market, symbol, last_trade_id AS id FROM trade_cursor').all()).toEqual([
      { market: 'perp', symbol: 'BTCUSDT', id: s.lastTradeId.BTCUSDT },
    ]);
    expect(db.prepare('SELECT symbol, leverage, margin_mode AS mode FROM perp_settings').all()).toEqual([
      { symbol: 'BTCUSDT', leverage: 10, mode: 'isolated' },
    ]);
    expect(db.prepare("SELECT count(*) c FROM orders WHERE market = 'perp'").get()).toEqual({ c: 4 });
  });

  it('a resting order with one attached leg round-trips with the other leg null', () => {
    const { ctx, sim, perp, db, seasonId } = perpSetup();
    sim.deposit('leverage', D('5000'), ctx);
    const placed = perp.submit(perpLimit('buy', '79000', '0.05', { attach: { stopLoss: '77000' } }), ctx);
    const events = [...placed, ...perpArrive(perp, perpPlaced(placed), ctx)];
    persist(db, seasonId, sim, events);
    const id = perpPlaced(placed)[0]!.id;
    const o = reloadSim(db, seasonId).perp.state.orders.get(id)!;
    expect(o.status).toBe('open');
    expect(o.attach).toEqual({ stopLoss: D('77000'), takeProfit: null });
    expect(Decimal.isDecimal(o.attach!.stopLoss)).toBe(true);
    expectRevivedOrder(o);
    expect(JSON.stringify(o)).toBe(JSON.stringify(perp.state.orders.get(id)));
  });

  it('perp events and fills are written as perp rows; a second persist with nothing changed writes nothing', () => {
    const { sim, perp, db, seasonId } = perpScenario();
    const rows = db.prepare('SELECT type, symbol, market FROM events ORDER BY id').all() as {
      type: string;
      symbol: string | null;
      market: string | null;
    }[];
    expect(rows[0]).toEqual({ type: 'deposit', symbol: null, market: 'leverage' });
    expect(rows[1]).toEqual({ type: 'leverage_set', symbol: 'BTCUSDT', market: 'perp' });
    expect(rows.slice(1).every((t) => t.market === 'perp' && t.symbol === 'BTCUSDT')).toBe(true);
    expect(rows.map((t) => t.type)).toContain('position_opened');

    const pos = perp.state.positions.BTCUSDT!;
    const fills = db.prepare('SELECT market, fee_asset, position_id, uncovered, realized_pnl, round_trip_id, qty FROM fills');
    expect(fills.all()).toEqual([
      { market: 'perp', fee_asset: 'USDT', position_id: pos.id, uncovered: null, realized_pnl: null, round_trip_id: null, qty: '0.1' },
    ]);

    const count = () => db.prepare('SELECT count(*) c FROM events').get();
    const before = count();
    expect(persist(db, seasonId, sim, [])).toBe(false);
    expect(count()).toEqual(before);
  });

  it('closing the position deletes its row; the reducing fill carries its realized P&L', () => {
    const { ctx, sim, perp, db, seasonId } = perpScenario();
    const positionId = perp.state.positions.BTCUSDT!.id;
    const close = perp.submit(perpMarketOrder('sell', '0.1', { reduceOnly: true }), ctx);
    const events = [...close, ...perpArrive(perp, perpPlaced(close), ctx)];
    expect(events.map((e) => e.type)).toContain('position_closed');
    expect(perp.state.positions.BTCUSDT).toBeUndefined();
    persist(db, seasonId, sim, events);

    expect(db.prepare('SELECT count(*) c FROM positions').get()).toEqual({ c: 0 });
    expect(reloadSim(db, seasonId).perp.state.positions).toEqual({});
    // Sold 0.1 at the best bid 79990 against an entry of 80000.
    expect(db.prepare("SELECT position_id, realized_pnl, uncovered FROM fills WHERE side = 'sell'").get()).toEqual({
      position_id: positionId,
      realized_pnl: '-1',
      uncovered: null,
    });
    expect(checkInvariants(reloadSim(db, seasonId))).toEqual([]);
  });

  it('a change with no event (a warning level, a funding window) is still saved, and round-trips', () => {
    const { ctx, sim, perp, db, seasonId } = perpScenario();
    const p = perp.state.positions.BTCUSDT!;
    perp.state.positions.BTCUSDT = { ...p, warnLevel: 0.8 };
    expect(persist(db, seasonId, sim, [])).toBe(true);
    expect(reloadSim(db, seasonId).perp.state.positions.BTCUSDT!.warnLevel).toBe(0.8);

    const fundingTime = 8 * 3_600_000;
    perp.openFundingWindow('BTCUSDT', fundingTime, ctx);
    expect(persist(db, seasonId, sim, [])).toBe(true);
    let r = reloadSim(db, seasonId).perp.state;
    expect(JSON.stringify(r.funding)).toBe(JSON.stringify(perp.state.funding));
    const w = r.funding.windows.BTCUSDT!;
    expect([w.fundingTime, w.long.positionId, w.long.maxPositionId, w.long.ownMax.toString()]).toEqual([
      fundingTime, p.id, p.id, '0.1',
    ]);
    expect(Decimal.isDecimal(w.long.max) && Decimal.isDecimal(w.short.min) && Decimal.isDecimal(w.short.ownMax)).toBe(true);

    perp.closeFundingWindow('BTCUSDT', fundingTime, ctx);
    expect(persist(db, seasonId, sim, [])).toBe(true);
    r = reloadSim(db, seasonId).perp.state;
    expect(r.funding.windows).toEqual({});
    expect(JSON.stringify(r.funding.pending)).toBe(JSON.stringify(perp.state.funding.pending));
    expect(r.funding.pending[0]!.long.max.toString()).toBe('0.1');
  });

  it('a reload followed by a persist with nothing changed writes nothing', () => {
    const { ctx, db, seasonId } = perpScenario();
    const reloaded = reloadSim(db, seasonId);
    reloaded.perp.openFundingWindow('BTCUSDT', 8 * 3_600_000, ctx);
    expect(persist(db, seasonId, reloaded, [])).toBe(true);
    const again = reloadSim(db, seasonId);
    expect(persist(db, seasonId, again, [])).toBe(false);
  });

  it('applied funding times older than 30 days are pruned when the funding state is written', () => {
    const { perp, sim, db, seasonId } = perpScenario();
    const now = 100 * DAY;
    perp.state.funding.applied = { BTCUSDT: [now - 31 * DAY, now - 30 * DAY, now - DAY], ETHUSDT: [now - 40 * DAY] };
    persist(db, seasonId, sim, [], { now });
    const expected = { BTCUSDT: [now - 30 * DAY, now - DAY] };
    expect(perp.state.funding.applied).toEqual(expected);
    expect(reloadSim(db, seasonId).perp.state.funding.applied).toEqual(expected);

    // Without `now`, the latest event's time is the reference.
    perp.state.funding.applied.BTCUSDT!.push(now + DAY);
    persist(db, seasonId, sim, [{ type: 'leverage_set', market: 'perp', time: now + 31 * DAY, symbol: 'ETHUSDT', leverage: 5 }]);
    expect(reloadSim(db, seasonId).perp.state.funding.applied).toEqual({ BTCUSDT: [now + DAY] });
  });

  it('a funding side saved without ownMax and maxPositionId loads with its max and position', () => {
    const { db, seasonId } = perpSetup();
    const side = (max: string, min: string, positionId: string | null) => ({ max, min, positionId });
    const funding = {
      windows: { BTCUSDT: { symbol: 'BTCUSDT', fundingTime: 5, long: side('0.3', '0.1', 'p-1'), short: side('0', '0', null) } },
      pending: [{ symbol: 'ETHUSDT', fundingTime: 4, long: side('0', '0', null), short: side('2', '2', 'p-2') }],
      applied: { BTCUSDT: [1, 2] },
    };
    db.prepare('INSERT INTO perp_state (season_id, funding) VALUES (?, ?)').run(seasonId, JSON.stringify(funding));
    const f = loadPerpState(db, seasonId, loadLedger(db, seasonId, ASSETS)).funding;
    const long = f.windows.BTCUSDT!.long;
    expect([long.max.toString(), long.min.toString(), long.ownMax.toString(), long.positionId, long.maxPositionId]).toEqual([
      '0.3', '0.1', '0.3', 'p-1', 'p-1',
    ]);
    expect(Decimal.isDecimal(long.ownMax)).toBe(true);
    const short = f.pending[0]!.short;
    expect([short.ownMax.toString(), short.maxPositionId]).toEqual(['2', 'p-2']);
    expect([f.windows.BTCUSDT!.short.ownMax.toString(), f.windows.BTCUSDT!.short.maxPositionId]).toEqual(['0', null]);
    expect(f.applied).toEqual({ BTCUSDT: [1, 2] });
  });

  it('a failed write keeps the perp orders marked and the next persist writes them with the position', () => {
    const { ctx, sim, perp, db, seasonId } = perpSetup();
    sim.deposit('leverage', D('5000'), ctx);
    const open = perp.submit(perpMarketOrder('buy', '0.1'), ctx);
    const events = [...open, ...perpArrive(perp, perpPlaced(open), ctx)];
    db.exec("CREATE TEMP TRIGGER no_positions BEFORE INSERT ON positions BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => persist(db, seasonId, sim, events)).toThrow('no');
    for (const t of ['events', 'orders', 'fills', 'positions']) {
      expect(db.prepare(`SELECT count(*) c FROM ${t}`).get()).toEqual({ c: 0 });
    }
    db.exec('DROP TRIGGER no_positions');
    expect(persist(db, seasonId, sim, [])).toBe(true);
    expect(reloadSim(db, seasonId).perp.state.positions.BTCUSDT?.qty.toString()).toBe('0.1');
    expect(db.prepare("SELECT status FROM orders WHERE market = 'perp'").all()).toEqual([{ status: 'filled' }]);
  });

  it('settleLateCancels answers a perp order that finished with its cancel in flight, as a perp event', () => {
    const { ctx, sim, perp, db, seasonId, limitId } = perpScenario();
    expect(perp.cancel(limitId, ctx).ok).toBe(true);
    persist(db, seasonId, sim, []);
    ctx.now += 1;
    persist(db, seasonId, sim, perp.onTrade('BTCUSDT', perpTrade('78900', '1', true), ctx));
    expect(perp.state.orders.get(limitId)!.status).toBe('filled');

    // The server stops before the cancel arrives; on restart the finished order is not loaded.
    expect(reloadSim(db, seasonId).perp.state.orders.has(limitId)).toBe(false);
    const settled = settleLateCancels(db, seasonId, ctx.now + 60_000);
    expect(settled.map((e) => [e.type, e.market, e.order.id, e.order.status, e.order.cancelArrivesAt])).toEqual([
      ['cancel_rejected', 'perp', limitId, 'filled', null],
    ]);
    expect(Decimal.isDecimal(settled[0]!.order.filledQty)).toBe(true);
    expect(db.prepare("SELECT market, symbol FROM events WHERE type = 'cancel_rejected'").all()).toEqual([
      { market: 'perp', symbol: 'BTCUSDT' },
    ]);
    expect(settleLateCancels(db, seasonId, ctx.now + 60_000)).toEqual([]);
  });
});

describe('checkInvariants: perps', () => {
  it('leverage locked USDT must equal the sum of live perp order locks', () => {
    const { db, seasonId } = perpScenario();
    const sim = reloadSim(db, seasonId);
    const lev = sim.ledger.balances.leverage.USDT!;
    const sum = lev.locked;
    lev.locked = lev.locked.plus(1);
    expect(checkInvariants(sim)).toEqual([`Leverage locked USDT ${sum.plus(1)} != sum of live perp order locks ${sum}`]);
  });

  it('every position has qty > 0 and margin >= 0, and at most one per symbol', () => {
    const { db, seasonId } = perpScenario();
    const sim = reloadSim(db, seasonId);
    const s = sim.perp.state;
    const p = s.positions.BTCUSDT!;
    s.positions.BTCUSDT = { ...p, qty: D(0), margin: D('-0.5') };
    expect(checkInvariants(sim)).toEqual(['Position BTCUSDT qty 0 is not > 0', 'Position BTCUSDT margin -0.5 is < 0']);
    s.positions.BTCUSDT = p;
    s.positions.ETHUSDT = { ...p, id: 'p-other' };
    expect(checkInvariants(sim)).toEqual(['Position under ETHUSDT is for BTCUSDT', 'More than one position for BTCUSDT']);
  });
});
