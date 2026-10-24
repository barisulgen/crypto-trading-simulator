import {
  D,
  Decimal,
  emptyLedger,
  emptyPerpState,
  emptySpotState,
  evictTerminal,
  evictTerminalPerp,
  takeDirty,
  takePerpDirty,
} from '@sim/engine';
import type {
  AccountValue,
  Basis,
  EngineEvent,
  Fill,
  FundingSide,
  FundingState,
  FundingWindow,
  Market,
  PerpEvent,
  PerpFill,
  PerpOrder,
  PerpState,
  Position,
  RoundTrip,
  Ledger,
  SimEngine,
  SimEvent,
  SpotOrder,
  SpotState,
  Wallet,
} from '@sim/engine';
import type { Db } from './db.ts';

export interface FeedGap {
  market: Market;
  symbol: string;
  startedAt: number;
  endedAt: number;
  reason: string;
  /**
   * The engine's trade cursor for the market and symbol when the gap opened: the id of the last
   * trade processed live before it (null if none had been). A later replay starts after it.
   */
  lastTradeIdBefore: number | null;
}

/** A gap in live data that has started and not yet been recorded as a feed_gap. */
export interface OpenGap {
  market: Market;
  symbol: string;
  startedAt: number;
  reason: string;
  /** As FeedGap.lastTradeIdBefore; null also for a gap saved before the cursor was kept with it. */
  lastTradeIdBefore: number | null;
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
export function toJson(value: unknown): string {
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

/** Revive a SpotOrder parsed from JSON (Decimal fields by name; a row from before cancelArrivesAt has none in flight). */
function reviveOrder(raw: Record<string, unknown>): SpotOrder {
  const o = { ...raw };
  for (const k of ORDER_DECIMALS) o[k] = dec(o[k]);
  const attach = o.attach as { stopLoss: string; takeProfit: string } | null | undefined;
  o.attach = attach ? { stopLoss: D(attach.stopLoss), takeProfit: D(attach.takeProfit) } : null;
  o.cancelArrivesAt = typeof o.cancelArrivesAt === 'number' ? o.cancelArrivesAt : null;
  return o as unknown as SpotOrder;
}

const PERP_ORDER_DECIMALS = [...ORDER_DECIMALS, 'realizedPnl'] as const;

/** Revive a PerpOrder parsed from JSON (Decimal fields by name; either attached leg may be absent). */
function revivePerpOrder(raw: Record<string, unknown>): PerpOrder {
  const o = { ...raw };
  for (const k of PERP_ORDER_DECIMALS) o[k] = dec(o[k]);
  const attach = o.attach as { stopLoss: string | null; takeProfit: string | null } | null | undefined;
  o.attach = attach ? { stopLoss: dec(attach.stopLoss), takeProfit: dec(attach.takeProfit) } : null;
  o.cancelArrivesAt = typeof o.cancelArrivesAt === 'number' ? o.cancelArrivesAt : null;
  return o as unknown as PerpOrder;
}

const POSITION_DECIMALS = ['qty', 'entryPrice', 'margin', 'realizedPnl', 'fees', 'funding'] as const;
const WARN_LEVELS: readonly unknown[] = [0.5, 0.8, 0.9];

/** Revive a Position parsed from JSON; a warning level it does not know is none given. */
function revivePosition(raw: Record<string, unknown>): Position {
  const p = { ...raw };
  for (const k of POSITION_DECIMALS) p[k] = D(p[k] as string);
  p.warnLevel = WARN_LEVELS.includes(p.warnLevel) ? p.warnLevel : 0;
  return p as unknown as Position;
}

/**
 * Revive one side of a funding window. A side saved before ownMax and maxPositionId were kept is
 * read as held throughout by its last position: ownMax = max, maxPositionId = positionId.
 */
function reviveFundingSide(raw: Record<string, unknown>): FundingSide {
  const max = D(raw.max as string);
  const positionId = (raw.positionId as string | null | undefined) ?? null;
  return {
    max,
    min: D(raw.min as string),
    positionId,
    ownMax: raw.ownMax === undefined || raw.ownMax === null ? max : D(raw.ownMax as string),
    maxPositionId: raw.maxPositionId === undefined ? positionId : (raw.maxPositionId as string | null),
  };
}

function reviveFundingWindow(raw: Record<string, unknown>): FundingWindow {
  return {
    symbol: raw.symbol as string,
    fundingTime: raw.fundingTime as number,
    long: reviveFundingSide(raw.long as Record<string, unknown>),
    short: reviveFundingSide(raw.short as Record<string, unknown>),
  };
}

function reviveFunding(raw: Partial<Record<keyof FundingState, unknown>>): FundingState {
  const windows: Record<string, FundingWindow> = {};
  for (const [symbol, w] of Object.entries((raw.windows ?? {}) as Record<string, Record<string, unknown>>)) {
    windows[symbol] = reviveFundingWindow(w);
  }
  const pending = ((raw.pending ?? []) as Record<string, unknown>[]).map(reviveFundingWindow);
  const applied: Record<string, number[]> = {};
  for (const [symbol, times] of Object.entries((raw.applied ?? {}) as Record<string, number[]>)) applied[symbol] = [...times];
  return { windows, pending, applied };
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

export function loadLedger(db: Db, seasonId: number, assets: string[]): Ledger {
  const ledger = emptyLedger(assets);

  const balances = db
    .prepare('SELECT wallet, asset, free, locked FROM balances WHERE season_id = ?')
    .all(seasonId) as { wallet: Wallet; asset: string; free: string; locked: string }[];
  for (const b of balances) {
    ledger.balances[b.wallet][b.asset] = { free: D(b.free), locked: D(b.locked) };
  }

  const acct = db.prepare('SELECT total_deposited FROM account WHERE season_id = ?').get(seasonId) as
    | { total_deposited: string }
    | undefined;
  if (acct) ledger.totalDeposited = D(acct.total_deposited);
  return ledger;
}

export function loadSpotState(db: Db, seasonId: number, ledger: Ledger): SpotState {
  const state = emptySpotState(ledger);

  const orders = db
    .prepare(
      `SELECT data FROM orders WHERE season_id = ? AND market = 'spot' AND status IN (${NON_TERMINAL.map(() => '?').join(',')})
       ORDER BY created_at, rowid`,
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

  const cursors = db
    .prepare("SELECT symbol, last_trade_id FROM trade_cursor WHERE season_id = ? AND market = 'spot'")
    .all(seasonId) as { symbol: string; last_trade_id: number }[];
  for (const c of cursors) state.lastTradeId[c.symbol] = c.last_trade_id;

  return state;
}

/** The season's perp state: live perp orders, open positions, leverage settings, funding state and cursors. */
export function loadPerpState(db: Db, seasonId: number, ledger: Ledger): PerpState {
  const state = emptyPerpState(ledger);

  const orders = db
    .prepare(
      `SELECT data FROM orders WHERE season_id = ? AND market = 'perp' AND status IN (${NON_TERMINAL.map(() => '?').join(',')})
       ORDER BY created_at, rowid`,
    )
    .all(seasonId, ...NON_TERMINAL) as { data: string }[];
  for (const r of orders) {
    const o = revivePerpOrder(JSON.parse(r.data) as Record<string, unknown>);
    state.orders.set(o.id, o);
  }

  const positions = db.prepare('SELECT symbol, data FROM positions WHERE season_id = ?').all(seasonId) as {
    symbol: string;
    data: string;
  }[];
  for (const p of positions) state.positions[p.symbol] = revivePosition(JSON.parse(p.data) as Record<string, unknown>);

  const settings = db
    .prepare('SELECT symbol, leverage, margin_mode FROM perp_settings WHERE season_id = ?')
    .all(seasonId) as { symbol: string; leverage: number; margin_mode: 'isolated' }[];
  for (const r of settings) state.settings[r.symbol] = { leverage: r.leverage, marginMode: r.margin_mode };

  const perp = db.prepare('SELECT funding FROM perp_state WHERE season_id = ?').get(seasonId) as
    | { funding: string }
    | undefined;
  if (perp) state.funding = reviveFunding(JSON.parse(perp.funding) as Record<string, unknown>);

  const cursors = db
    .prepare("SELECT symbol, last_trade_id FROM trade_cursor WHERE season_id = ? AND market = 'perp'")
    .all(seasonId) as { symbol: string; last_trade_id: number }[];
  for (const c of cursors) state.lastTradeId[c.symbol] = c.last_trade_id;

  savedPerpKeys(db).set(seasonId, perpStateKey(state));
  return state;
}

// ---- persist ----

function isPerpEvent(e: SimEvent): e is PerpEvent {
  return 'market' in e && e.market === 'perp';
}

function perpEventSymbol(e: PerpEvent): string {
  switch (e.type) {
    case 'leverage_set':
    case 'margin_changed':
    case 'funding':
    case 'liquidation':
      return e.symbol;
    case 'fill':
      return e.fill.symbol;
    case 'position_opened':
    case 'position_closed':
      return e.position.symbol;
    default:
      return e.order.symbol;
  }
}

function eventSymbolMarket(e: SimEvent): { symbol: string | null; market: string | null } {
  if (isPerpEvent(e)) return { symbol: perpEventSymbol(e), market: 'perp' };
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

/** How long applied funding times are kept: a window that old is never opened again. */
const APPLIED_FUNDING_KEEP_MS = 30 * 86_400_000;

/** Drop the applied funding times more than 30 days before `now`, and symbols left with none. */
function pruneAppliedFunding(funding: FundingState, now: number): void {
  for (const [symbol, times] of Object.entries(funding.applied)) {
    const kept = times.filter((t) => t >= now - APPLIED_FUNDING_KEEP_MS);
    if (kept.length === 0) delete funding.applied[symbol];
    else if (kept.length !== times.length) funding.applied[symbol] = kept;
  }
}

/**
 * The perp state persist writes in full on every commit (positions, settings, funding state). They
 * change without an event at times (a margin warning given, a funding window opened or closed), so
 * persist compares this key with the last one saved to know whether they changed.
 */
function perpStateKey(s: PerpState): string {
  return toJson({ positions: s.positions, settings: s.settings, funding: s.funding });
}

const EMPTY_PERP_KEY = perpStateKey(emptyPerpState(emptyLedger([])));

/** Per database, per season: the perp state key last saved or loaded. */
const perpKeys = new WeakMap<Db, Map<number, string>>();

function savedPerpKeys(db: Db): Map<number, string> {
  let keys = perpKeys.get(db);
  if (!keys) {
    keys = new Map();
    perpKeys.set(db, keys);
  }
  return keys;
}

/**
 * Before the first save of a season's perp state on this database handle: it must have been
 * loaded (loadPerpState) when the database already holds positions or funding state, since a
 * commit writes the perp state in full and an empty one would delete every saved position.
 */
function refuseUnloadedPerpState(db: Db, seasonId: number): void {
  const held = db
    .prepare('SELECT 1 FROM positions WHERE season_id = ? UNION ALL SELECT 1 FROM perp_state WHERE season_id = ? LIMIT 1')
    .get(seasonId, seasonId);
  if (held !== undefined) {
    throw new Error(
      `persist: the perp state of season ${seasonId} was never loaded (loadPerpState), but the database holds positions or funding state; refusing to overwrite them`,
    );
  }
}

/**
 * Write everything one engine call changed, in a single transaction. Call it after every engine
 * call, even with no events: pending -> open has none, but the order's row must still follow.
 * Orders written, spot and perp: those changed since the last call (takeDirty) and each one an
 * event names. Each feed gap becomes a feed_gap event and its open_gaps row is deleted in the
 * same transaction. A call with events, changed orders, gaps, or a perp state (positions, leverage
 * settings, funding state) that differs from the one last saved or loaded is a commit: it also
 * writes the balances, basis, account, trade cursors, every open position (deleting the rows of
 * positions no longer open), every leverage setting and the funding state. A call with none of
 * these writes nothing but the trade cursors, and that only when `cursor` is set.
 * Throws, writing nothing, when the season's perp state was never loaded on this database handle
 * while the database holds positions or funding state (see refuseUnloadedPerpState).
 * Applied funding times more than 30 days before `now` (else the latest event's time) are dropped
 * first. Afterwards finished orders leave memory (evictTerminal). Returns whether the cursors were written.
 */
export function persist(
  db: Db,
  seasonId: number,
  sim: SimEngine,
  events: SimEvent[],
  extra: { feedGaps?: FeedGap[]; cursor?: boolean; now?: number } = {},
): boolean {
  const state = sim.spot.state;
  const perp = sim.perp.state;
  const gaps = extra.feedGaps ?? [];
  const now = extra.now ?? events.reduce<number | null>((t, e) => (t === null || e.time > t ? e.time : t), null);
  if (now !== null) pruneAppliedFunding(perp.funding, now);
  const perpKey = perpStateKey(perp);
  const savedKey = savedPerpKeys(db).get(seasonId);
  if (savedKey === undefined) refuseUnloadedPerpState(db, seasonId);
  const perpChanged = perpKey !== (savedKey ?? EMPTY_PERP_KEY);
  const dirty = takeDirty(state);
  const perpDirty = takePerpDirty(perp);
  const changed = events.length > 0 || dirty.length > 0 || perpDirty.length > 0 || gaps.length > 0 || perpChanged;
  if (!changed && !extra.cursor) return false;
  const insEvent = db.prepare(
    'INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insFill = db.prepare(
    `INSERT INTO fills (id, season_id, order_id, symbol, market, side, qty, price, quote, liquidity, fee_asset, fee,
       fee_usd, best_at_arrival, best_at_submit, slippage_usd, drift_usd, trigger_price, realized_pnl, round_trip_id,
       position_id, uncovered, time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upOrder = db.prepare(
    `INSERT INTO orders (id, season_id, symbol, market, status, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    `INSERT INTO trade_cursor (season_id, market, symbol, last_trade_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(season_id, market, symbol) DO UPDATE SET last_trade_id = excluded.last_trade_id`,
  );
  const insTrip = db.prepare(
    'INSERT INTO round_trips (id, season_id, symbol, opened_at, closed_at, pnl) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const delOpenGap = db.prepare('DELETE FROM open_gaps WHERE season_id = ? AND market = ? AND symbol = ?');
  const upPosition = db.prepare(
    `INSERT INTO positions (season_id, symbol, data) VALUES (?, ?, ?)
     ON CONFLICT(season_id, symbol) DO UPDATE SET data = excluded.data`,
  );
  const delClosedPositions = db.prepare(
    'DELETE FROM positions WHERE season_id = ? AND symbol NOT IN (SELECT value FROM json_each(?))',
  );
  const upSetting = db.prepare(
    `INSERT INTO perp_settings (season_id, symbol, leverage, margin_mode) VALUES (?, ?, ?, ?)
     ON CONFLICT(season_id, symbol) DO UPDATE SET leverage = excluded.leverage, margin_mode = excluded.margin_mode`,
  );
  const upPerpState = db.prepare(
    `INSERT INTO perp_state (season_id, funding) VALUES (?, ?)
     ON CONFLICT(season_id) DO UPDATE SET funding = excluded.funding`,
  );

  const writeOrder = (market: Market, o: SpotOrder | PerpOrder, time: number) =>
    upOrder.run(o.id, seasonId, o.symbol, market, o.status, o.createdAt, time, toJson(o));

  const writeFill = (f: Fill | PerpFill) => {
    const p = 'market' in f && f.market === 'perp' ? f : null;
    insFill.run(
      f.id, seasonId, f.orderId, f.symbol, p ? 'perp' : 'spot', f.side, str(f.qty), str(f.price), str(f.quote),
      f.liquidity, f.feeAsset, str(f.fee), str(f.feeUsd), str(f.bestAtArrival), str(f.bestAtSubmit),
      str(f.slippageUsd), str(f.driftUsd), str(f.triggerPrice), str(f.realizedPnl),
      p ? null : (f as Fill).roundTripId, p ? p.positionId : null, p ? str(p.uncovered) : null, f.time,
    );
  };

  const writeCursor = () => {
    for (const [symbol, id] of Object.entries(state.lastTradeId)) upCursor.run(seasonId, 'spot', symbol, id);
    for (const [symbol, id] of Object.entries(perp.lastTradeId)) upCursor.run(seasonId, 'perp', symbol, id);
  };

  const write = db.transaction(() => {
    if (!changed) return writeCursor();
    const touched = new Map<string, { order: SpotOrder; time: number }>();
    const perpTouched = new Map<string, { order: PerpOrder; time: number }>();
    for (const e of events) {
      const { symbol, market } = eventSymbolMarket(e);
      insEvent.run(seasonId, e.time, e.type, symbol, market, toJson(e));
      if (e.type === 'fill') writeFill(e.fill);
      if (e.type === 'round_trip_closed') {
        const t: RoundTrip = e.roundTrip;
        insTrip.run(t.id, seasonId, t.symbol, t.openedAt, t.closedAt, str(t.pnl));
      }
      if ('order' in e) {
        if (isPerpEvent(e)) perpTouched.set(e.order.id, { order: e.order, time: e.time });
        else touched.set(e.order.id, { order: e.order, time: e.time });
      }
    }

    // Each changed order, plus the last snapshot of each order an event names (terminal ones
    // included). The state's own copy wins when it has one.
    for (const id of dirty) {
      const o = state.orders.get(id);
      if (o && !touched.has(id)) writeOrder('spot', o, o.createdAt);
    }
    for (const { order, time } of touched.values()) writeOrder('spot', state.orders.get(order.id) ?? order, time);
    for (const id of perpDirty) {
      const o = perp.orders.get(id);
      if (o && !perpTouched.has(id)) writeOrder('perp', o, o.createdAt);
    }
    for (const { order, time } of perpTouched.values()) writeOrder('perp', perp.orders.get(order.id) ?? order, time);

    for (const wallet of ['spot', 'leverage'] as const) {
      for (const [asset, b] of Object.entries(sim.ledger.balances[wallet])) {
        upBalance.run(seasonId, wallet, asset, str(b.free), str(b.locked));
      }
    }
    for (const [asset, b] of Object.entries(state.basis)) {
      upBasis.run(seasonId, asset, str(b.qty), str(b.cost), b.roundTripId, b.openedAt, str(b.tripRealized));
    }
    upAccount.run(seasonId, str(sim.ledger.totalDeposited));
    writeCursor();

    for (const [symbol, p] of Object.entries(perp.positions)) upPosition.run(seasonId, symbol, toJson(p));
    delClosedPositions.run(seasonId, JSON.stringify(Object.keys(perp.positions)));
    for (const [symbol, st] of Object.entries(perp.settings)) upSetting.run(seasonId, symbol, st.leverage, st.marginMode);
    upPerpState.run(seasonId, toJson(perp.funding));

    for (const g of gaps) {
      insEvent.run(
        seasonId, g.endedAt, 'feed_gap', g.symbol, g.market,
        JSON.stringify({ startedAt: g.startedAt, endedAt: g.endedAt, reason: g.reason, lastTradeIdBefore: g.lastTradeIdBefore }),
      );
      delOpenGap.run(seasonId, g.market, g.symbol);
    }
  });
  try {
    write();
  } catch (e) {
    // Nothing was written: the orders stay marked for the next call, and the perp state still
    // differs from the one last saved.
    for (const id of dirty) state.dirty.add(id);
    for (const id of perpDirty) perp.dirty.add(id);
    throw e;
  }
  if (changed) {
    savedPerpKeys(db).set(seasonId, perpKey);
    evictTerminal(state);
    evictTerminalPerp(perp);
  }
  return true;
}

/** Whether the season has a saved order with this id (finished orders included). */
export function storedOrderExists(db: Db, seasonId: number, id: string): boolean {
  return db.prepare('SELECT 1 FROM orders WHERE id = ? AND season_id = ?').get(id, seasonId) !== undefined;
}

// ---- late cancels ----

type CancelRejected =
  | Extract<EngineEvent, { type: 'cancel_rejected' }>
  | Extract<PerpEvent, { type: 'cancel_rejected' }>;

/**
 * Startup: an order, spot or perp, that finished (filled, rejected, or cancelled with its pair)
 * while the owner's cancel of it was in flight, with the server stopped before that cancel arrived.
 * Finished orders are not loaded, so nothing else answers that cancel: each is recorded now as
 * cancel_rejected in its market and the stored order's cancel in flight is cleared, all in one
 * transaction. Returns the events written.
 */
export function settleLateCancels(db: Db, seasonId: number, now: number): CancelRejected[] {
  const rows = db
    .prepare(
      `SELECT market, data FROM orders WHERE season_id = ? AND status NOT IN (${NON_TERMINAL.map(() => '?').join(',')})
         AND json_extract(data, '$.cancelArrivesAt') IS NOT NULL
       ORDER BY created_at, rowid`,
    )
    .all(seasonId, ...NON_TERMINAL) as { market: string; data: string }[];
  if (rows.length === 0) return [];
  const insEvent = db.prepare(
    "INSERT INTO events (season_id, time, type, symbol, market, payload) VALUES (?, ?, 'cancel_rejected', ?, ?, ?)",
  );
  const upOrder = db.prepare(
    'UPDATE orders SET data = ?, updated_at = max(updated_at, ?) WHERE id = ? AND season_id = ?',
  );
  const events = rows.map((r): CancelRejected => {
    const raw = JSON.parse(r.data) as Record<string, unknown>;
    const reason = (status: string) => `Cancel arrived too late: order already ${status}`;
    if (r.market === 'perp') {
      const order = { ...revivePerpOrder(raw), cancelArrivesAt: null };
      return { type: 'cancel_rejected', market: 'perp', time: now, order, reason: reason(order.status) };
    }
    const order = { ...reviveOrder(raw), cancelArrivesAt: null };
    return { type: 'cancel_rejected', time: now, order, reason: reason(order.status) };
  });
  db.transaction(() => {
    for (const e of events) {
      insEvent.run(seasonId, e.time, e.order.symbol, e.market === 'perp' ? 'perp' : 'spot', toJson(e));
      upOrder.run(toJson(e.order), e.time, e.order.id, seasonId);
    }
  })();
  return events;
}

// ---- open gaps ----

/**
 * Saves a gap as open, at once, so a crash keeps its start and trade cursor. A gap already open
 * for the market and symbol keeps its start, reason and cursor unless this one starts earlier.
 */
export function openGap(db: Db, seasonId: number, g: OpenGap): void {
  db.prepare(
    `INSERT INTO open_gaps (season_id, market, symbol, started_at, reason, last_trade_id_before) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(season_id, market, symbol) DO UPDATE SET started_at = excluded.started_at, reason = excluded.reason,
       last_trade_id_before = excluded.last_trade_id_before
       WHERE excluded.started_at < open_gaps.started_at`,
  ).run(seasonId, g.market, g.symbol, g.startedAt, g.reason, g.lastTradeIdBefore);
}

/** The season's open gaps (left by a crash, or seeded at startup), by market and symbol. */
export function loadOpenGaps(db: Db, seasonId: number): OpenGap[] {
  return db
    .prepare(
      `SELECT market, symbol, started_at AS startedAt, reason, last_trade_id_before AS lastTradeIdBefore
       FROM open_gaps WHERE season_id = ? ORDER BY market, symbol`,
    )
    .all(seasonId) as OpenGap[];
}

// ---- invariants ----

export function checkInvariants(sim: SimEngine): string[] {
  const state = sim.spot.state;
  const out: string[] = [];

  const locks = new Map<string, Decimal>();
  for (const o of state.orders.values()) {
    if (!NON_TERMINAL.includes(o.status)) continue;
    locks.set(o.lockAsset, (locks.get(o.lockAsset) ?? D(0)).plus(o.lockAmount));
  }
  const spot = sim.ledger.balances.spot;
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

  const perp = sim.perp.state;
  let perpLocks = D(0);
  for (const o of perp.orders.values()) {
    if (NON_TERMINAL.includes(o.status)) perpLocks = perpLocks.plus(o.lockAmount);
  }
  const leverageLocked = sim.ledger.balances.leverage.USDT?.locked ?? D(0);
  if (!leverageLocked.eq(perpLocks)) {
    out.push(`Leverage locked USDT ${leverageLocked} != sum of live perp order locks ${perpLocks}`);
  }

  const perSymbol = new Map<string, number>();
  for (const [key, p] of Object.entries(perp.positions)) {
    if (!p.qty.gt(0)) out.push(`Position ${key} qty ${p.qty} is not > 0`);
    if (p.margin.lt(0)) out.push(`Position ${key} margin ${p.margin} is < 0`);
    if (p.symbol !== key) out.push(`Position under ${key} is for ${p.symbol}`);
    perSymbol.set(p.symbol, (perSymbol.get(p.symbol) ?? 0) + 1);
  }
  for (const [symbol, n] of perSymbol) if (n > 1) out.push(`More than one position for ${symbol}`);
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

/** The season's most recently updated orders, any status, as stored (decimals as strings). */
export function recentOrders(db: Db, seasonId: number, limit: number): unknown[] {
  const rows = db
    .prepare('SELECT data FROM orders WHERE season_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?')
    .all(seasonId, limit) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as unknown);
}

export interface FillRow {
  id: string;
  orderId: string;
  symbol: string;
  side: string;
  qty: string;
  price: string;
  quote: string;
  liquidity: string;
  feeAsset: string;
  fee: string;
  feeUsd: string;
  bestAtArrival: string | null;
  bestAtSubmit: string | null;
  slippageUsd: string;
  driftUsd: string;
  triggerPrice: string | null;
  realizedPnl: string | null;
  roundTripId: string | null;
  time: number;
}

/** The season's fills, newest first, optionally for one symbol. */
export function queryFills(db: Db, seasonId: number, q: { symbol?: string; limit: number }): FillRow[] {
  const bySymbol = q.symbol !== undefined;
  return db
    .prepare(
      `SELECT id, order_id AS orderId, symbol, side, qty, price, quote, liquidity, fee_asset AS feeAsset, fee,
         fee_usd AS feeUsd, best_at_arrival AS bestAtArrival, best_at_submit AS bestAtSubmit,
         slippage_usd AS slippageUsd, drift_usd AS driftUsd, trigger_price AS triggerPrice,
         realized_pnl AS realizedPnl, round_trip_id AS roundTripId, time
       FROM fills WHERE season_id = ?${bySymbol ? ' AND symbol = ?' : ''} ORDER BY time DESC, rowid DESC LIMIT ?`,
    )
    .all(...(bySymbol ? [seasonId, q.symbol!, q.limit] : [seasonId, q.limit])) as FillRow[];
}

// ---- equity, heartbeat ----

export function insertEquitySnapshot(db: Db, seasonId: number, v: AccountValue, now: number): void {
  const leverageValue = v.leverage.value;
  const spotValue = v.total.minus(leverageValue);
  db.prepare(
    'INSERT INTO equity_snapshots (season_id, time, total, deposited, spot_value, leverage_value) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(seasonId, now, v.total.toString(), v.totalDeposited.toString(), spotValue.toString(), leverageValue.toString());
}

export function touchAlive(db: Db, now: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(now));
}

export function lastAlive(db: Db): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}
