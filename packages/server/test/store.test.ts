import { describe, expect, it } from 'vitest';
import { D, SpotEngine, emptySpotState } from '@sim/engine';
import type { AggTrade, EngineCtx, EngineEvent, SpotOrder, SpotOrderRequest, SpotState } from '@sim/engine';
import { FakeMarket, seedCoins, testCtx } from '../../engine/test/fixtures.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { checkInvariants, insertEquitySnapshot, loadSpotState, persist, queryHistory, touchAlive } from '../src/db/store.ts';

const NOW = 1_000_000;
const ASSETS = ['USDT', 'BTC'];

let tradeId = 0;
function trade(price: string, qty = '1', sellerInitiated = true): AggTrade {
  tradeId += 1;
  return { id: tradeId, price: D(price), qty: D(qty), sellerInitiated, time: NOW };
}

function setup() {
  const market = new FakeMarket();
  const ctx = testCtx(market, { now: NOW });
  const engine = new SpotEngine(emptySpotState(ASSETS));
  const db = openDb(':memory:');
  const seasonId = currentSeasonId(db);
  return { market, ctx, engine, db, seasonId };
}

function arrive(engine: SpotEngine, order: SpotOrder, ctx: EngineCtx): EngineEvent[] {
  ctx.now = Math.max(ctx.now, order.arrivesAt!);
  return engine.arrive(order.id, ctx);
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
    balances: state.balances,
    orders: [...state.orders.values()].filter((o) => ['pending', 'open', 'partially_filled', 'triggered'].includes(o.status)).sort((a, b) => a.id.localeCompare(b.id)),
    basis: state.basis,
    totalDeposited: state.totalDeposited,
    lastTradeId: state.lastTradeId,
  });
}

/** deposit 1000, limit buy 1 @ 99.50 open, partial fill 0.5 -> persisted. */
function partialFillScenario() {
  const t = setup();
  const { engine, ctx, db, seasonId } = t;
  const events: EngineEvent[] = [];
  events.push(...(engine.deposit('spot', D('1000'), ctx) as { events: EngineEvent[] }).events);
  const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
  events.push({ type: 'order_placed', time: ctx.now, order });
  events.push(...arrive(engine, order, ctx));
  events.push(...engine.onTrade('BTCUSDT', trade('99.40', '0.5', true), ctx));
  persist(db, seasonId, engine.state, events);
  return { ...t, events, order };
}

describe('openDb', () => {
  it('applies migrations once: user_version 1, reopening a file db raises no error', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'test_data'").get()).toEqual({ value: '1' });
    expect(currentSeasonId(db)).toBe(1);
    expect(currentSeasonId(db)).toBe(1);
    expect(db.prepare('SELECT name FROM seasons').all()).toEqual([{ name: 'Season 1' }]);
  });

  it('a second open of the same file keeps version 1 and its data', async () => {
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
      expect(b.pragma('user_version', { simple: true })).toBe(1);
      expect(b.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get()).toEqual({ value: '123' });
      touchAlive(b, 456);
      expect(b.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get()).toEqual({ value: '456' });
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('persist and loadSpotState', () => {
  it('partial fill: reload equals the in-memory state, rows land in every table', () => {
    const { engine, db, seasonId } = partialFillScenario();
    expect(engine.state.lastTradeId.BTCUSDT).toBeGreaterThan(0);
    const reloaded = loadSpotState(db, seasonId, ASSETS);
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
    engine.deposit('spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    persist(db, seasonId, engine.state, [{ type: 'order_placed', time: ctx.now, order }]);
    arrive(engine, order, ctx);
    persist(db, seasonId, engine.state, []);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).toEqual({ status: 'open' });
    expect(snapshot(loadSpotState(db, seasonId, ASSETS))).toBe(snapshot(engine.state));
  });

  it('terminal orders are stored but not loaded', () => {
    const { engine, ctx, db, seasonId } = setup();
    engine.deposit('spot', D('1000'), ctx);
    const order = placedOrder(engine.submit(limitBuy('99.50', '1'), ctx));
    arrive(engine, order, ctx);
    const r = engine.cancel(order.id, ctx);
    if (!r.ok) throw new Error(r.reason);
    persist(db, seasonId, engine.state, r.events);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).toEqual({ status: 'cancelled' });
    expect(loadSpotState(db, seasonId, ASSETS).orders.size).toBe(0);
  });

  it('an unknown-type rejected order is storable', () => {
    const { engine, ctx, db, seasonId } = setup();
    const events = engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'iceberg', qty: '1' } as unknown as SpotOrderRequest, ctx);
    expect(events.map((e) => e.type)).toEqual(['order_rejected']);
    persist(db, seasonId, engine.state, events);
    expect(db.prepare('SELECT type FROM events').get()).toEqual({ type: 'order_rejected' });
    expect(db.prepare("SELECT status FROM orders WHERE status = 'rejected'").all()).toHaveLength(1);
  });

  it('round trip: a deferred triggered order (arrivesAt null), an attached pair leg and lastTradeId survive', () => {
    const { market, engine, ctx, db, seasonId } = setup();
    engine.deposit('spot', D('1000'), ctx);
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
    const r = engine.cancel(parent.id, ctx);
    if (!r.ok) throw new Error(r.reason);
    events.push(...r.events);

    const deferred = engine.state.orders.get(stop.id)!;
    expect([deferred.status, deferred.arrivesAt]).toEqual(['triggered', null]);
    const legs = [...engine.state.orders.values()].filter((o) => o.parentId === parent.id);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.status === 'pending' && l.arrivesAt === null)).toBe(true);

    persist(db, seasonId, engine.state, events);
    const reloaded = loadSpotState(db, seasonId, ASSETS);
    expect(snapshot(reloaded)).toBe(snapshot(engine.state));
    expect(reloaded.orders.get(stop.id)!.arrivesAt).toBeNull();
    expect(reloaded.orders.get(stop.id)!.triggeredAt).toBe(deferred.triggeredAt);
    for (const l of legs) expect(reloaded.orders.get(l.id)!.parentId).toBe(parent.id);
    expect(reloaded.lastTradeId).toEqual(engine.state.lastTradeId);
    expect(Object.keys(reloaded.lastTradeId).length).toBeGreaterThan(0);
    expect(checkInvariants(reloaded)).toEqual([]);
  });

  it('feed gaps become feed_gap events with the gap payload', () => {
    const { engine, db, seasonId } = setup();
    persist(db, seasonId, engine.state, [], {
      feedGaps: [{ symbol: 'BTCUSDT', market: 'spot', startedAt: 10, endedAt: 20, reason: 'resync' }],
    });
    const { rows } = queryHistory(db, { seasonId, limit: 10 });
    expect(rows).toEqual([
      { id: 1, time: 20, type: 'feed_gap', symbol: 'BTCUSDT', market: 'spot', payload: { startedAt: 10, endedAt: 20, reason: 'resync' } },
    ]);
  });

  it('a failure midway rolls back everything from that call', () => {
    const { engine, ctx, db, seasonId } = setup();
    engine.deposit('spot', D('1000'), ctx);
    const deposit = { type: 'deposit', time: NOW, wallet: 'spot', amount: D('1000'), totalDeposited: D('1000') } as const;
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
    expect(() => persist(db, seasonId, engine.state, [deposit, dupFill, dupFill])).toThrow();
    for (const table of ['events', 'fills', 'orders', 'balances', 'account']) {
      expect(db.prepare(`SELECT count(*) c FROM ${table}`).get()).toEqual({ c: 0 });
    }
  });
});

describe('checkInvariants', () => {
  it('reloaded state is consistent; corrupting locked USDT by +1 is reported', () => {
    const { db, seasonId } = partialFillScenario();
    const reloaded = loadSpotState(db, seasonId, ASSETS);
    expect(checkInvariants(reloaded)).toEqual([]);
    reloaded.balances.spot.USDT!.locked = reloaded.balances.spot.USDT!.locked.plus(1);
    expect(checkInvariants(reloaded)).toEqual(['Locked USDT 50.75 != sum of open order locks 49.75']);
  });

  it('basis quantity must equal spot holdings', () => {
    const state = emptySpotState(ASSETS);
    seedCoins(state, 'BTC', D('2'));
    expect(checkInvariants(state)).toEqual([]);
    state.balances.spot.BTC!.free = D('1.5');
    expect(checkInvariants(state)).toEqual(['Basis BTC qty 2 != holdings 1.5']);
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
      { total: D('1010.5'), totalDeposited: D('1000'), leverageUsdt: D('10') } as Parameters<typeof insertEquitySnapshot>[2],
      555,
    );
    expect(db.prepare('SELECT time, total, deposited, spot_value, leverage_value FROM equity_snapshots').get()).toEqual({
      time: 555, total: '1010.5', deposited: '1000', spot_value: '1000.5', leverage_value: '10',
    });
  });
});
