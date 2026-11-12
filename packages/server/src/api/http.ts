import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { InputError, MARGIN_MARK_UNAVAILABLE, maxLeverage, parseAmount, TIERS_NOT_LOADED } from '@sim/engine';
import type {
  Bracket,
  FeeSchedule,
  Market,
  PerpEvent,
  PerpOrder,
  PerpOrderRequest,
  PerpRules,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
  StatsFilter,
  TierSource,
  Wallet,
} from '@sim/engine';
import type { Db } from '../db/db.ts';
import { isTestData, queryFills, queryHistory, recentOrders, toJson } from '../db/store.ts';
import type { Logger } from '../log.ts';
import { INTERVALS } from '../market/candles.ts';
import type { Candle } from '../market/candles.ts';
import {
  CATCHING_UP_REFUSAL,
  GAP_NOT_APPLIED_REFUSAL,
  LEVERAGE_TRANSFER_REFUSAL,
  LEVERAGE_TRANSFER_STALE_REFUSAL,
  MARGIN_STALE_REFUSAL,
  RefusedError,
  submittedOrder,
} from '../runner.ts';
import type { EngineRunner } from '../runner.ts';
import { statsBounds, statsLive } from '../stats/loadStats.ts';
import { StatsTimeoutError, StatsWorkerStoppedError } from '../stats/statsService.ts';
import type { StatsService } from '../stats/statsService.ts';
import { registerAuth } from './auth.ts';
import type { ClientHub } from './ws.ts';

export interface AppDeps {
  runner: EngineRunner;
  market: { rules(symbol: string): SpotRules };
  /** The futures market data: rules and leverage tiers (each throws until loaded) and where the tiers came from. */
  perpMarket: {
    rules(symbol: string): PerpRules;
    brackets(symbol: string): Bracket[];
    tierInfo(): { source: TierSource; fetchedAt: number } | null;
  };
  hub: ClientHub;
  candles: Record<Market, { history(symbol: string, interval: string, endTime?: number): Promise<Candle[]> }>;
  db: Db;
  seasonId: number;
  /** Computes the stats, off the engine's thread in the running server. */
  stats: StatsService;
  coins: string[];
  symbols: string[];
  fees: { spot: FeeSchedule; perp: FeeSchedule };
  appPassword: string | null;
  logger: Logger;
  /** Clock for session expiry and the login rate limit (ms); defaults to Date.now. */
  now?: () => number;
  /** Built web UI to serve at /, or null. */
  webDist?: string | null;
}

type Body = Record<string, unknown>;
type Query = Record<string, unknown>;

const WALLETS = ['spot', 'leverage'] as const;
const SIDES = ['buy', 'sell'] as const;
const ORDER_TYPES = ['market', 'limit', 'post_only', 'stop_loss', 'take_profit'] as const;
const PERP_ORDER_TYPES = ['market', 'limit', 'post_only'] as const;
const HISTORY_MARKETS: readonly string[] = ['spot', 'leverage', 'perp'];
const HISTORY_MAX = 200;
const FILLS_MAX = 500;
const RECENT_ORDERS = 100;
/** Refusals that are the account's state, not the server's: the request may be repeated once it changes. */
const CONFLICTS: ReadonlySet<string> = new Set([
  CATCHING_UP_REFUSAL,
  GAP_NOT_APPLIED_REFUSAL,
  LEVERAGE_TRANSFER_REFUSAL,
  LEVERAGE_TRANSFER_STALE_REFUSAL,
  MARGIN_STALE_REFUSAL,
]);
/** Engine refusals that are the server's temporary state (data not loaded or not live): 503, like missing rules. */
const UNAVAILABLE: ReadonlySet<string> = new Set([TIERS_NOT_LOADED, MARGIN_MARK_UNAVAILABLE]);

/** An owner action the engine refused: a 400 with its reason, or a 503 when the reason is temporary. */
function refused(reason: string): Error {
  return UNAVAILABLE.has(reason) ? new RefusedError(reason) : new InputError(reason);
}

const ORDER_FIELDS = ['symbol', 'side', 'type', 'qty', 'quoteQty', 'price', 'triggerPrice', 'attach'];
const PERP_ORDER_FIELDS = ['symbol', 'side', 'type', 'qty', 'quoteQty', 'price', 'reduceOnly', 'attach'];
const ATTACH_FIELDS = ['stopLoss', 'takeProfit'];

/** JSON with every Decimal as its decimal string. */
function send(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).type('application/json; charset=utf-8').send(toJson(body));
}

const invalid = (name: string): InputError => new InputError(`Invalid field ${name}`);

function objectBody(req: FastifyRequest): Body {
  const b = req.body;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new InputError('Expected a JSON object body');
  return b as Body;
}

/** The body, once every field in it is one the route takes (`prefix` names a nested object's fields). */
function only(o: Body, fields: readonly string[], prefix = ''): Body {
  for (const key of Object.keys(o)) if (!fields.includes(key)) throw invalid(prefix + key);
  return o;
}

/**
 * A string field, or undefined when absent or null. Decimals travel as strings and are parsed
 * where they are used (a malformed one is the engine's rejection, or a 400 for wallet amounts).
 */
function optStr(o: Body, key: string, prefix = ''): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(prefix + key);
  return v;
}

function reqStr(o: Body, key: string, prefix = ''): string {
  const v = optStr(o, key, prefix);
  if (v === undefined || v.trim() === '') throw new InputError(`Missing field ${prefix}${key}`);
  return v;
}

function oneOf<T extends string>(o: Body, key: string, values: readonly T[], fallback?: T): T {
  const v = fallback !== undefined ? (optStr(o, key) ?? fallback) : reqStr(o, key);
  if (!(values as readonly string[]).includes(v)) throw invalid(key);
  return v as T;
}

function optBool(o: Body, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw invalid(key);
  return v;
}

/** A whole JSON number (not a string). */
function reqInt(o: Body, key: string): number {
  const v = o[key];
  if (v === undefined || v === null) throw new InputError(`Missing field ${key}`);
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(key);
  return v;
}

/** A nested object field taking only `fields`, or undefined when absent or null. */
function optObject(o: Body, key: string, fields: readonly string[]): Body | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid(key);
  return only(v as Body, fields, `${key}.`);
}

function queryStr(q: Query, key: string): string | undefined {
  const v = q[key];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new InputError(`${key} given more than once`);
  return v;
}

function queryInt(q: Query, key: string, min: number, max: number): number | undefined {
  const v = queryStr(q, key);
  if (v === undefined) return undefined;
  const n = /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new InputError(`${key} must be an integer from ${min} to ${max}`);
  }
  return n;
}

/** The `market` query parameter of the order and fill lists: spot (the default) or perp. */
function queryMarket(q: Query): Market {
  const m = queryStr(q, 'market') ?? 'spot';
  if (m !== 'spot' && m !== 'perp') throw new InputError('market must be spot or perp');
  return m;
}

/** The `tz` query parameter: an IANA time zone the platform knows. */
function queryTimeZone(q: Query): string {
  const tz = queryStr(q, 'tz');
  const invalid = new InputError('tz must be a valid time zone');
  if (tz === undefined) throw invalid;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw invalid;
  }
  return tz;
}

/** The orders a call's events placed or rejected, in event order. */
function placedOrRejected<O>(events: { type: string; order?: O }[]): O[] {
  return events.flatMap((e) => (e.type === 'order_placed' || e.type === 'order_rejected' ? [e.order as O] : []));
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  // @fastify/static serves the UI under the wildcard route '/*' (and its HEAD twin).
  const auth = registerAuth(app, {
    appPassword: d.appPassword,
    logger: d.logger,
    ...(d.now ? { now: d.now } : {}),
    publicRoutes: d.webDist ? ['/*'] : [],
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof InputError) return send(reply, 400, { error: err.message });
    // A key catching up or stale refuses with its reason (409: retry once it is live); a stopped engine is 503.
    if (err instanceof RefusedError) return send(reply, CONFLICTS.has(err.message) ? 409 : 503, { error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    // Fastify's own client errors: invalid JSON, body too large, unsupported content type.
    if (status !== undefined && status >= 400 && status < 500) return send(reply, status, { error: message });
    d.logger.error(`${req.method} ${req.url.split('?')[0]} failed: ${message}`);
    if (err instanceof StatsTimeoutError) return send(reply, 503, { error: message });
    return send(reply, 500, { error: err instanceof StatsWorkerStoppedError ? message : 'Internal error' });
  });

  const symbol = (s: string): string => {
    if (!d.symbols.includes(s)) throw new InputError(`Unknown symbol ${s}`);
    return s;
  };
  /** A known symbol whose exchange rules are loaded (the engine needs them to record an order). */
  const tradable = (s: string): string => {
    symbol(s);
    try {
      d.market.rules(s);
    } catch {
      throw new RefusedError(`Trading rules not loaded for ${s}`);
    }
    return s;
  };
  /** A known symbol whose futures rules are loaded (the perp engine needs them to record an order). */
  const perpTradable = (s: string): string => {
    symbol(s);
    try {
      d.perpMarket.rules(s);
    } catch {
      throw new RefusedError(`Trading rules not loaded for ${s} perp`);
    }
    return s;
  };
  const orderRequest = (b: Body): SpotOrderRequest => {
    only(b, ORDER_FIELDS);
    const req: SpotOrderRequest = {
      symbol: tradable(reqStr(b, 'symbol')),
      side: oneOf(b, 'side', SIDES),
      type: oneOf(b, 'type', ORDER_TYPES),
    };
    for (const key of ['qty', 'quoteQty', 'price', 'triggerPrice'] as const) {
      const v = optStr(b, key);
      if (v !== undefined) req[key] = v;
    }
    const a = optObject(b, 'attach', ATTACH_FIELDS);
    if (a) req.attach = { stopLoss: reqStr(a, 'stopLoss', 'attach.'), takeProfit: reqStr(a, 'takeProfit', 'attach.') };
    return req;
  };
  const perpOrderRequest = (b: Body): PerpOrderRequest => {
    only(b, PERP_ORDER_FIELDS);
    const req: PerpOrderRequest = {
      symbol: perpTradable(reqStr(b, 'symbol')),
      side: oneOf(b, 'side', SIDES),
      type: oneOf(b, 'type', PERP_ORDER_TYPES),
    };
    for (const key of ['qty', 'quoteQty', 'price'] as const) {
      const v = optStr(b, key);
      if (v !== undefined) req[key] = v;
    }
    const reduceOnly = optBool(b, 'reduceOnly');
    if (reduceOnly !== undefined) req.reduceOnly = reduceOnly;
    const a = optObject(b, 'attach', ATTACH_FIELDS);
    if (a) {
      const stopLoss = optStr(a, 'stopLoss', 'attach.');
      const takeProfit = optStr(a, 'takeProfit', 'attach.');
      req.attach = { ...(stopLoss !== undefined ? { stopLoss } : {}), ...(takeProfit !== undefined ? { takeProfit } : {}) };
    }
    return req;
  };
  /**
   * The order as it is now (a call's event holds it as it was then; a finished one is as the event
   * left it), with its market.
   */
  const current = <O extends SpotOrder | PerpOrder>(o: O, market: Market): O & { market: Market } => ({
    ...((d.runner.order(o.id)?.order as O | undefined) ?? o),
    market,
  });
  const position = (s: string) => d.runner.positions().find((p) => p.symbol === s) ?? null;
  /** The symbol's perp settings, after an owner action on them. */
  const settings = (s: string) => ({ symbol: s, ...d.runner.perpSetting(s) });

  app.get('/api/meta', async (_req, reply) => {
    const rules: Record<string, SpotRules> = {};
    for (const s of d.symbols) {
      try {
        rules[s] = d.market.rules(s);
      } catch {
        // not loaded yet: left out
      }
    }
    // Every symbol, with null for what has not loaded yet.
    const perp: Record<string, object> = {};
    for (const s of d.symbols) {
      const loaded = <T>(read: () => T): T | null => {
        try {
          return read();
        } catch {
          return null;
        }
      };
      const brackets = loaded(() => d.perpMarket.brackets(s));
      perp[s] = {
        rules: loaded(() => d.perpMarket.rules(s)),
        maxLeverage: brackets ? maxLeverage(brackets) : null,
        brackets,
        ...d.runner.perpSetting(s),
      };
    }
    const season = d.db
      .prepare('SELECT id, name, started_at AS startedAt FROM seasons WHERE id = ?')
      .get(d.seasonId) as { id: number; name: string; startedAt: number };
    return send(reply, 200, {
      coins: d.coins,
      symbols: d.symbols,
      rules,
      perp,
      tiers: d.perpMarket.tierInfo(),
      fees: { spot: { ...d.fees.spot }, perp: { ...d.fees.perp } },
      testData: isTestData(d.db),
      season,
    });
  });

  app.get('/api/account', async (_req, reply) => send(reply, 200, d.runner.account()));

  app.get('/api/positions', async (_req, reply) => send(reply, 200, { positions: d.runner.positions() }));

  // One market's orders (spot unless market=perp), each with its market.
  app.get('/api/orders', async (req, reply) => {
    const q = req.query as Query;
    const status = queryStr(q, 'status') ?? 'open';
    const market = queryMarket(q);
    if (status === 'open') {
      const orders = market === 'spot' ? d.runner.openOrders() : d.runner.openPerpOrders();
      return send(reply, 200, { orders: orders.map((o) => ({ ...o, market })) });
    }
    if (status === 'recent') return send(reply, 200, { orders: recentOrders(d.db, d.seasonId, RECENT_ORDERS, market) });
    throw new InputError('status must be open or recent');
  });

  // One market's fills (spot unless market=perp), each with its market.
  app.get('/api/fills', async (req, reply) => {
    const q = req.query as Query;
    const s = queryStr(q, 'symbol');
    const market = queryMarket(q);
    const limit = queryInt(q, 'limit', 1, FILLS_MAX) ?? 50;
    return send(reply, 200, { fills: queryFills(d.db, d.seasonId, { market, ...(s ? { symbol: symbol(s) } : {}), limit }) });
  });

  app.post('/api/deposit', async (req, reply) => {
    const b = only(objectBody(req), ['wallet', 'amount']);
    const w: Wallet = oneOf(b, 'wallet', WALLETS, 'spot');
    const amount = parseAmount(reqStr(b, 'amount'));
    const r = d.runner.deposit(w, amount);
    if (!r.ok) throw new InputError(r.reason);
    return send(reply, 200, { account: d.runner.account() });
  });

  app.post('/api/transfer', async (req, reply) => {
    const b = only(objectBody(req), ['from', 'to', 'amount']);
    const from = oneOf(b, 'from', WALLETS);
    const to = oneOf(b, 'to', WALLETS);
    const amount = parseAmount(reqStr(b, 'amount'));
    const r = d.runner.transfer(from, to, amount);
    if (!r.ok) throw new InputError(r.reason);
    return send(reply, 200, { account: d.runner.account() });
  });

  app.post('/api/orders/preview', async (req, reply) =>
    send(reply, 200, d.runner.preview(orderRequest(objectBody(req)))),
  );

  // An engine rejection is not an HTTP error: the order is recorded as rejected and returned.
  app.post('/api/orders', async (req, reply) => {
    const order = submittedOrder(d.runner.submit(orderRequest(objectBody(req))));
    return send(reply, 200, { order: current(order, 'spot') });
  });

  // A cancel is a request, for an order of either market: 200 means it is on its way. The order
  // comes back still live with its cancelArrivesAt; the cancel takes effect (or is recorded as too
  // late) when it arrives.
  app.delete('/api/orders/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = d.runner.cancel(id);
    if (!r.ok) return send(reply, r.reason === 'Order not found' ? 404 : 400, { error: r.reason });
    const found = d.runner.order(id);
    return send(reply, 200, { order: found ? { ...found.order, market: found.market } : undefined });
  });

  app.post('/api/oco', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'qty', 'stopLoss', 'takeProfit']);
    const events = d.runner.attachOco({
      symbol: tradable(reqStr(b, 'symbol')),
      qty: reqStr(b, 'qty'),
      stopLoss: reqStr(b, 'stopLoss'),
      takeProfit: reqStr(b, 'takeProfit'),
    });
    return send(reply, 200, { orders: placedOrRejected<SpotOrder>(events).map((o) => current(o, 'spot')) });
  });

  // ---- perpetuals ----

  app.post('/api/perp/orders/preview', async (req, reply) =>
    send(reply, 200, d.runner.previewPerp(perpOrderRequest(objectBody(req)))),
  );

  // As for spot: an engine rejection is recorded and returned with 200.
  app.post('/api/perp/orders', async (req, reply) => {
    const order = submittedOrder(d.runner.submitPerp(perpOrderRequest(objectBody(req))));
    return send(reply, 200, { order: current(order, 'perp') });
  });

  app.post('/api/perp/leverage', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'leverage']);
    const s = symbol(reqStr(b, 'symbol'));
    const r = d.runner.setLeverage(s, reqInt(b, 'leverage'));
    if (!r.ok) throw refused(r.reason);
    return send(reply, 200, settings(s));
  });

  app.post('/api/perp/margin-mode', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'mode']);
    const s = symbol(reqStr(b, 'symbol'));
    const r = d.runner.setMarginMode(s, oneOf(b, 'mode', ['isolated', 'cross'] as const));
    if (!r.ok) throw refused(r.reason);
    return send(reply, 200, settings(s));
  });

  // The amount is a decimal string, parsed by the engine (a malformed one is a 400 with its reason).
  app.post('/api/perp/margin', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'action', 'amount']);
    const s = symbol(reqStr(b, 'symbol'));
    const action = oneOf(b, 'action', ['add', 'remove'] as const);
    const amount = reqStr(b, 'amount');
    const r = action === 'add' ? d.runner.addMargin(s, amount) : d.runner.removeMargin(s, amount);
    if (!r.ok) throw refused(r.reason);
    return send(reply, 200, { position: position(s) });
  });

  // Read-only: what the same body would do on POST /api/perp/margin; a refusal is its rejectReason (200).
  app.post('/api/perp/margin/preview', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'action', 'amount']);
    const s = symbol(reqStr(b, 'symbol'));
    const action = oneOf(b, 'action', ['add', 'remove'] as const);
    return send(reply, 200, d.runner.previewMargin(s, action, reqStr(b, 'amount')));
  });

  // The owner has seen the alert of this liquidation (alerts come oldest first): it and every
  // earlier one are not alerted again on the next connect. Only a liquidation's own event id.
  app.post('/api/liquidations/ack', async (req, reply) => {
    const b = only(objectBody(req), ['eventId']);
    const eventId = reqInt(b, 'eventId');
    if (eventId < 1 || !d.runner.acknowledgeLiquidations(eventId)) throw new InputError('Unknown liquidation');
    return send(reply, 200, { acknowledged: eventId });
  });

  // Close-position stops on the symbol's position; refused ones are recorded and returned with 200.
  app.post('/api/perp/tpsl', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'stopLoss', 'takeProfit']);
    const s = perpTradable(reqStr(b, 'symbol'));
    const stopLoss = optStr(b, 'stopLoss');
    const takeProfit = optStr(b, 'takeProfit');
    if (stopLoss === undefined && takeProfit === undefined) throw new InputError('Missing field stopLoss or takeProfit');
    const events = d.runner.setPositionTpSl(s, {
      ...(stopLoss !== undefined ? { stopLoss } : {}),
      ...(takeProfit !== undefined ? { takeProfit } : {}),
    });
    return send(reply, 200, { orders: placedOrRejected<PerpOrder>(events).map((o) => current(o, 'perp')) });
  });

  // A reduce-only market order on the opposite side of the position: `qty` of it, or all of it.
  app.post('/api/perp/close', async (req, reply) => {
    const b = only(objectBody(req), ['symbol', 'qty']);
    const s = perpTradable(reqStr(b, 'symbol'));
    const qty = optStr(b, 'qty');
    const p = position(s);
    if (!p) throw new InputError(`No open position on ${s}`);
    const events: PerpEvent[] = d.runner.submitPerp({
      symbol: s,
      side: p.side === 'long' ? 'sell' : 'buy',
      type: 'market',
      qty: qty ?? p.qty.toString(),
      reduceOnly: true,
    });
    return send(reply, 200, { order: current(submittedOrder(events), 'perp') });
  });

  // ---- history and charts ----

  app.get('/api/history', async (req, reply) => {
    const q = req.query as Query;
    const s = queryStr(q, 'symbol');
    const market = queryStr(q, 'market');
    if (market !== undefined && !HISTORY_MARKETS.includes(market)) throw new InputError('market must be spot, leverage or perp');
    const types = queryStr(q, 'types');
    const from = queryInt(q, 'from', 0, Number.MAX_SAFE_INTEGER);
    const to = queryInt(q, 'to', 0, Number.MAX_SAFE_INTEGER);
    const before = queryInt(q, 'before', 1, Number.MAX_SAFE_INTEGER);
    const result = queryHistory(d.db, {
      seasonId: d.seasonId,
      ...(s !== undefined ? { symbol: symbol(s) } : {}),
      ...(market !== undefined ? { market } : {}),
      ...(types !== undefined ? { types: types.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(before !== undefined ? { before } : {}),
      limit: queryInt(q, 'limit', 1, HISTORY_MAX) ?? 50,
    });
    return send(reply, 200, result);
  });

  // The stats of the current season, filtered by range, coin and market; hours and weekdays in `tz`.
  app.get('/api/stats', async (req, reply) => {
    const q = req.query as Query;
    const tz = queryTimeZone(q);
    const s = queryStr(q, 'symbol');
    const market = queryStr(q, 'market');
    if (market !== undefined && market !== 'spot' && market !== 'leverage') throw new InputError('market must be spot or leverage');
    const from = queryInt(q, 'from', 0, Number.MAX_SAFE_INTEGER) ?? null;
    const to = queryInt(q, 'to', 0, Number.MAX_SAFE_INTEGER) ?? null;
    if (from !== null && to !== null && from > to) throw new InputError('from must not be after to');
    const filter: StatsFilter = { from, to, symbol: s === undefined ? null : symbol(s), market: market ?? null };
    // Only the account now and the record's bounds are read here; the record is read and the
    // report computed by the stats service, as of this moment.
    const live = statsLive(d.runner);
    const now = (d.now ?? Date.now)();
    const json = await d.stats.report({ seasonId: d.seasonId, bounds: statsBounds(d.db), live, filter, tz, now });
    return reply.code(200).type('application/json; charset=utf-8').send(json);
  });

  app.get('/api/candles', async (req, reply) => {
    const q = req.query as Query;
    const s = symbol(queryStr(q, 'symbol') ?? '');
    const interval = queryStr(q, 'interval') ?? '';
    if (!(INTERVALS as readonly string[]).includes(interval)) throw new InputError(`Unsupported interval ${interval}`);
    const endTime = queryInt(q, 'endTime', 0, Number.MAX_SAFE_INTEGER);
    const market = queryStr(q, 'market') ?? 'spot';
    if (market !== 'spot' && market !== 'perp') throw new InputError(`Unknown market ${market}`);
    let candles: Candle[];
    try {
      candles = await d.candles[market].history(s, interval, endTime);
    } catch (e) {
      d.logger.warn(`candles ${s} ${interval} failed: ${(e as Error).message}`);
      return send(reply, 502, { error: 'Candle history unavailable' });
    }
    return send(reply, 200, { candles });
  });

  // The socket keeps its LAN session: closed once that expires, renewed by its messages (not its pongs).
  app.get('/ws', { websocket: true }, (socket, req) => d.hub.add(socket, auth.sessionOf(req)));

  // dotfiles: 'deny' - never serve a dotfile (e.g. an editor's .env copy) that lands in web/dist.
  if (d.webDist) await app.register(fastifyStatic, { root: d.webDist, prefix: '/', dotfiles: 'deny' });
  return app;
}

