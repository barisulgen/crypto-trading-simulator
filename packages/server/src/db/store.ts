import { D, Decimal, emptySpotState } from '@sim/engine';
import type {
  AccountValue,
  Basis,
  EngineEvent,
  Fill,
  RoundTrip,
  SpotOrder,
  SpotState,
  Wallet,
} from '@sim/engine';
import type { Db } from './db.ts';

export interface FeedGap {
  symbol: string;
  market: 'spot';
  startedAt: number;
  endedAt: number;
  reason: string;
}

export interface HistoryRow {
  id: number;
  time: number;
  type: string;
  symbol: string | null;
  market: string | null;
  payload: unknown;
}

// ---- Decimal <-> string ----

/** JSON with every Decimal written via toString() (JSON.stringify would call valueOf, giving '-0'). */
function toJson(value: unknown): string {
  // JSON.stringify calls Decimal.toJSON before the replacer, so test the holder's raw value instead.
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    return Decimal.isDecimal(raw) ? (raw as Decimal).toString() : v;
  });
}

const ORDER_DECIMALS = [
  'qty', 'quoteQty', 'price', 'triggerPrice', 'filledQty', 'filledQuote', 'fee', 'lockAmount', 'bestAtSubmit',
] as const;

const dec = (v: unknown): Decimal | null => (v === null || v === undefined ? null : D(v as string));

/** Revive a SpotOrder parsed from JSON (Decimal fields by name). */
function reviveOrder(raw: Record<string, unknown>): SpotOrder {
  const o = { ...raw };
  for (const k of ORDER_DECIMALS) o[k] = dec(o[k]);
  const attach = o.attach as { stopLoss: string; takeProfit: string } | null | undefined;
  o.attach = attach ? { stopLoss: D(attach.stopLoss), takeProfit: D(attach.takeProfit) } : null;
  return o as unknown as SpotOrder;
}

interface BasisRow {
  asset: string;
  qty: string;
  cost: string;
  round_trip_id: string | null;
  opened_at: number | null;
  trip_realized: string;
}

function reviveBasis(r: BasisRow): Basis {
  return {
    qty: D(r.qty),
    cost: D(r.cost),
    roundTripId: r.round_trip_id,
    openedAt: r.opened_at,
    tripRealized: D(r.trip_realized),
  };
}

const str = (x: Decimal | null): string | null => (x === null ? null : x.toString());

// ---- load ----

const NON_TERMINAL = ['pending', 'open', 'partially_filled', 'triggered'];

export function loadSpotState(db: Db, seasonId: number, assets: string[]): SpotState {
  const state = emptySpotState(assets);

  const balances = db
    .prepare('SELECT wallet, asset, free, locked FROM balances WHERE season_id = ?')
    .all(seasonId) as { wallet: Wallet; asset: string; free: string; locked: string }[];
  for (const b of balances) {
    state.balances[b.wallet][b.asset] = { free: D(b.free), locked: D(b.locked) };
  }

  const orders = db
    .prepare(
      `SELECT data FROM orders WHERE season_id = ? AND status IN (${NON_TERMINAL.map(() => '?').join(',')}) ORDER BY created_at, rowid`,
    )
    .all(seasonId, ...NON_TERMINAL) as { data: string }[];
  for (const r of orders) {
    const o = reviveOrder(JSON.parse(r.data) as Record<string, unknown>);
    state.orders.set(o.id, o);
  }

  const basis = db
    .prepare('SELECT asset, qty, cost, round_trip_id, opened_at, trip_realized FROM basis WHERE season_id = ?')
    .all(seasonId) as BasisRow[];
  for (const b of basis) state.basis[b.asset] = reviveBasis(b);

  const acct = db.prepare('SELECT total_deposited FROM account WHERE season_id = ?').get(seasonId) as
    | { total_deposited: string }
    | undefined;
  if (acct) state.totalDeposited = D(acct.total_deposited);

  const cursors = db
    .prepare('SELECT symbol, last_trade_id FROM trade_cursor WHERE season_id = ?')
    .all(seasonId) as { symbol: string; last_trade_id: number }[];
  for (const c of cursors) state.lastTradeId[c.symbol] = c.last_trade_id;

  return state;
}

// ---- persist ----

function eventSymbolMarket(e: EngineEvent): { symbol: string | null; market: string | null } {
  switch (e.type) {
    case 'deposit':
      return { symbol: null, market: e.wallet };
    case 'transfer':
      return { symbol: null, market: null };
    case 'round_trip_closed':
      return { symbol: e.roundTrip.symbol, market: 'spot' };
    case 'fill':
      return { symbol: e.fill.symbol, market: 'spot' };
    default:
      return { symbol: e.order.symbol, market: 'spot' };
  }
}

/**
 * Write everything one engine call changed, in a single transaction. Call it after every engine
 * call, even with no events: pending -> open has none, but the order's row must still follow.
 */
export function persist(
  db: Db,
  seasonId: number,
  state: SpotState,
  events: EngineEvent[],
  extra: { feedGaps?: FeedGap[] } = {},
): void {
  const insEvent = db.prepare(
    'INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insFill = db.prepare(
    `INSERT INTO fills (id, season_id, order_id, symbol, market, side, qty, price, quote, liquidity, fee_asset, fee,
       fee_usd, best_at_arrival, best_at_submit, slippage_usd, drift_usd, trigger_price, realized_pnl, round_trip_id, time)
     VALUES (?, ?, ?, ?, 'spot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upOrder = db.prepare(
    `INSERT INTO orders (id, season_id, symbol, market, status, created_at, updated_at, data)
     VALUES (?, ?, ?, 'spot', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
       updated_at = max(orders.updated_at, excluded.updated_at)`,
  );
  const upBalance = db.prepare(
    `INSERT INTO balances (season_id, wallet, asset, free, locked) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(season_id, wallet, asset) DO UPDATE SET free = excluded.free, locked = excluded.locked`,
  );
  const upBasis = db.prepare(
    `INSERT INTO basis (season_id, asset, qty, cost, round_trip_id, opened_at, trip_realized) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(season_id, asset) DO UPDATE SET qty = excluded.qty, cost = excluded.cost,
       round_trip_id = excluded.round_trip_id, opened_at = excluded.opened_at, trip_realized = excluded.trip_realized`,
  );
  const upAccount = db.prepare(
    `INSERT INTO account (season_id, total_deposited) VALUES (?, ?)
     ON CONFLICT(season_id) DO UPDATE SET total_deposited = excluded.total_deposited`,
  );
  const upCursor = db.prepare(
    `INSERT INTO trade_cursor (season_id, symbol, last_trade_id) VALUES (?, ?, ?)
     ON CONFLICT(season_id, symbol) DO UPDATE SET last_trade_id = excluded.last_trade_id`,
  );
  const insTrip = db.prepare(
    'INSERT INTO round_trips (id, season_id, symbol, opened_at, closed_at, pnl) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const writeOrder = (o: SpotOrder, time: number) =>
    upOrder.run(o.id, seasonId, o.symbol, o.status, o.createdAt, time, toJson(o));

  db.transaction(() => {
    const touched = new Map<string, { order: SpotOrder; time: number }>();
    for (const e of events) {
      const { symbol, market } = eventSymbolMarket(e);
      insEvent.run(seasonId, e.time, e.type, symbol, market, toJson(e));
      if (e.type === 'fill') {
        const f: Fill = e.fill;
        insFill.run(
          f.id, seasonId, f.orderId, f.symbol, f.side, str(f.qty), str(f.price), str(f.quote), f.liquidity,
          f.feeAsset, str(f.fee), str(f.feeUsd), str(f.bestAtArrival), str(f.bestAtSubmit), str(f.slippageUsd),
          str(f.driftUsd), str(f.triggerPrice), str(f.realizedPnl), f.roundTripId, f.time,
        );
      }
      if (e.type === 'round_trip_closed') {
        const t: RoundTrip = e.roundTrip;
        insTrip.run(t.id, seasonId, t.symbol, t.openedAt, t.closedAt, str(t.pnl));
      }
      if ('order' in e) touched.set(e.order.id, { order: e.order, time: e.time });
    }

    // Every live order, plus the last snapshot of each order an event names (terminal ones included).
    // The state's own copy wins when it has one.
    for (const o of state.orders.values()) {
      if (NON_TERMINAL.includes(o.status) && !touched.has(o.id)) writeOrder(o, o.createdAt);
    }
    for (const { order, time } of touched.values()) writeOrder(state.orders.get(order.id) ?? order, time);

    for (const wallet of ['spot', 'leverage'] as const) {
      for (const [asset, b] of Object.entries(state.balances[wallet])) {
        upBalance.run(seasonId, wallet, asset, str(b.free), str(b.locked));
      }
    }
    for (const [asset, b] of Object.entries(state.basis)) {
      upBasis.run(seasonId, asset, str(b.qty), str(b.cost), b.roundTripId, b.openedAt, str(b.tripRealized));
    }
    upAccount.run(seasonId, str(state.totalDeposited));
    for (const [symbol, id] of Object.entries(state.lastTradeId)) upCursor.run(seasonId, symbol, id);

    for (const g of extra.feedGaps ?? []) {
      insEvent.run(
        seasonId, g.endedAt, 'feed_gap', g.symbol, g.market,
        JSON.stringify({ startedAt: g.startedAt, endedAt: g.endedAt, reason: g.reason }),
      );
    }
  })();
}

// ---- invariants ----

export function checkInvariants(state: SpotState): string[] {
  const out: string[] = [];

  const locks = new Map<string, Decimal>();
  for (const o of state.orders.values()) {
    if (!NON_TERMINAL.includes(o.status)) continue;
    locks.set(o.lockAsset, (locks.get(o.lockAsset) ?? D(0)).plus(o.lockAmount));
  }
  const spot = state.balances.spot;
  for (const asset of new Set([...Object.keys(spot), ...locks.keys()])) {
    const locked = spot[asset]?.locked ?? D(0);
    const sum = locks.get(asset) ?? D(0);
    if (!locked.eq(sum)) out.push(`Locked ${asset} ${locked} != sum of open order locks ${sum}`);
  }

  const coins = new Set([...Object.keys(spot), ...Object.keys(state.basis)]);
  coins.delete('USDT');
  for (const asset of coins) {
    const b = spot[asset];
    const holdings = (b?.free ?? D(0)).plus(b?.locked ?? D(0));
    const qty = state.basis[asset]?.qty ?? D(0);
    if (!qty.eq(holdings)) out.push(`Basis ${asset} qty ${qty} != holdings ${holdings}`);
  }
  return out;
}

// ---- history ----

export interface HistoryQuery {
  seasonId: number;
  symbol?: string;
  market?: string;
  types?: string[];
  from?: number;
  to?: number;
  before?: number;
  limit: number;
}

export function queryHistory(db: Db, q: HistoryQuery): { rows: HistoryRow[]; nextBefore: number | null } {
  const where = ['season_id = ?'];
  const args: (string | number)[] = [q.seasonId];
  if (q.symbol !== undefined) {
    where.push('symbol = ?');
    args.push(q.symbol);
  }
  if (q.market !== undefined) {
    where.push('(market = ? OR market IS NULL)');
    args.push(q.market);
  }
  if (q.types && q.types.length > 0) {
    where.push(`type IN (${q.types.map(() => '?').join(',')})`);
    args.push(...q.types);
  }
  if (q.from !== undefined) {
    where.push('time >= ?');
    args.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('time <= ?');
    args.push(q.to);
  }
  if (q.before !== undefined) {
    // Keyset on (time, id): the cursor row's time is looked up, so rows written late with an
    // older time (feed gaps) are neither skipped nor repeated.
    const cur = db.prepare('SELECT time FROM events WHERE id = ?').get(q.before) as { time: number } | undefined;
    if (cur) {
      where.push('(time < ? OR (time = ? AND id < ?))');
      args.push(cur.time, cur.time, q.before);
    } else {
      where.push('id < ?');
      args.push(q.before);
    }
  }
  const raw = db
    .prepare(
      `SELECT id, time, type, symbol, market, payload FROM events WHERE ${where.join(' AND ')}
       ORDER BY time DESC, id DESC LIMIT ?`,
    )
    .all(...args, q.limit) as (Omit<HistoryRow, 'payload'> & { payload: string })[];
  const rows: HistoryRow[] = raw.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown }));
  const last = rows[rows.length - 1];
  return { rows, nextBefore: rows.length === q.limit && last ? last.id : null };
}

// ---- equity, heartbeat ----

export function insertEquitySnapshot(db: Db, seasonId: number, v: AccountValue, now: number): void {
  const spotValue = v.total.minus(v.leverageUsdt);
  db.prepare(
    'INSERT INTO equity_snapshots (season_id, time, total, deposited, spot_value, leverage_value) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(seasonId, now, v.total.toString(), v.totalDeposited.toString(), spotValue.toString(), v.leverageUsdt.toString());
}

export function touchAlive(db: Db, now: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(now));
}
