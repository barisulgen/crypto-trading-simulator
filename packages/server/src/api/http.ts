import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { InputError, parseAmount } from '@sim/engine';
import type { FeeSchedule, SpotOrder, SpotOrderRequest, SpotRules, Wallet } from '@sim/engine';
import type { Db } from '../db/db.ts';
import { queryFills, queryHistory, recentOrders, toJson } from '../db/store.ts';
import type { Logger } from '../log.ts';
import { INTERVALS } from '../market/candles.ts';
import type { Candle } from '../market/candles.ts';
import { RefusedError, submittedOrder } from '../runner.ts';
import type { EngineRunner } from '../runner.ts';
import { registerAuth } from './auth.ts';
import type { ClientHub } from './ws.ts';

export interface AppDeps {
  runner: EngineRunner;
  market: { rules(symbol: string): SpotRules };
  hub: ClientHub;
  candles: { history(symbol: string, interval: string, endTime?: number): Promise<Candle[]> };
  db: Db;
  seasonId: number;
  coins: string[];
  symbols: string[];
  fees: { spot: FeeSchedule; perp: FeeSchedule };
  appPassword: string | null;
  logger: Logger;
  /** Built web UI to serve at /, or null. */
  webDist?: string | null;
}

type Body = Record<string, unknown>;
type Query = Record<string, unknown>;

const WALLETS: readonly string[] = ['spot', 'leverage'];
const HISTORY_MAX = 200;
const FILLS_MAX = 500;
const RECENT_ORDERS = 100;

/** JSON with every Decimal as its decimal string. */
function send(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).type('application/json; charset=utf-8').send(toJson(body));
}

function objectBody(req: FastifyRequest): Body {
  const b = req.body;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new InputError('Expected a JSON object body');
  return b as Body;
}

function optStr(o: Body, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new InputError(`${key} must be a string`);
  return v;
}

function reqStr(o: Body, key: string): string {
  const v = optStr(o, key);
  if (v === undefined || v.trim() === '') throw new InputError(`Missing field ${key}`);
  return v;
}

function wallet(o: Body, key: string, fallback?: Wallet): Wallet {
  const v = fallback !== undefined ? (optStr(o, key) ?? fallback) : reqStr(o, key);
  if (!WALLETS.includes(v)) throw new InputError(`${key} must be spot or leverage`);
  return v as Wallet;
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

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  registerAuth(app, { appPassword: d.appPassword, logger: d.logger });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof InputError) return send(reply, 400, { error: err.message });
    if (err instanceof RefusedError) return send(reply, 503, { error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    // Fastify's own client errors: invalid JSON, body too large, unsupported content type.
    if (status !== undefined && status >= 400 && status < 500) return send(reply, status, { error: message });
    d.logger.error(`${req.method} ${req.url.split('?')[0]} failed: ${message}`);
    return send(reply, 500, { error: 'Internal error' });
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
  const orderRequest = (b: Body): SpotOrderRequest => {
    const s = tradable(reqStr(b, 'symbol'));
    const side = reqStr(b, 'side');
    if (side !== 'buy' && side !== 'sell') throw new InputError('side must be buy or sell');
    const req: SpotOrderRequest = { symbol: s, side, type: reqStr(b, 'type') as SpotOrderRequest['type'] };
    for (const key of ['qty', 'quoteQty', 'price', 'triggerPrice'] as const) {
      const v = optStr(b, key);
      if (v !== undefined) req[key] = v;
    }
    if (b.attach !== undefined && b.attach !== null) {
      if (typeof b.attach !== 'object' || Array.isArray(b.attach)) throw new InputError('attach must be an object');
      const a = b.attach as Body;
      req.attach = { stopLoss: reqStr(a, 'stopLoss'), takeProfit: reqStr(a, 'takeProfit') };
    }
    return req;
  };
  const current = (o: SpotOrder): SpotOrder => d.runner.state.orders.get(o.id) ?? o;

  app.get('/api/meta', async (_req, reply) => {
    const rules: Record<string, SpotRules> = {};
    for (const s of d.symbols) {
      try {
        rules[s] = d.market.rules(s);
      } catch {
        // not loaded yet: left out
      }
    }
    const season = d.db
      .prepare('SELECT id, name, started_at AS startedAt FROM seasons WHERE id = ?')
      .get(d.seasonId) as { id: number; name: string; startedAt: number };
    return send(reply, 200, {
      coins: d.coins,
      symbols: d.symbols,
      rules,
      fees: { spot: { ...d.fees.spot }, perp: { ...d.fees.perp } },
      testData: true,
      season,
    });
  });

  app.get('/api/account', async (_req, reply) => send(reply, 200, d.runner.account()));

  app.get('/api/orders', async (req, reply) => {
    const status = queryStr(req.query as Query, 'status') ?? 'open';
    if (status === 'open') return send(reply, 200, { orders: d.runner.openOrders() });
    if (status === 'recent') return send(reply, 200, { orders: recentOrders(d.db, d.seasonId, RECENT_ORDERS) });
    throw new InputError('status must be open or recent');
  });

  app.get('/api/fills', async (req, reply) => {
    const q = req.query as Query;
    const s = queryStr(q, 'symbol');
    const limit = queryInt(q, 'limit', 1, FILLS_MAX) ?? 50;
    return send(reply, 200, { fills: queryFills(d.db, d.seasonId, { ...(s ? { symbol: symbol(s) } : {}), limit }) });
  });

  app.post('/api/deposit', async (req, reply) => {
    const b = objectBody(req);
    const w = wallet(b, 'wallet', 'spot');
    const amount = parseAmount(reqStr(b, 'amount'));
    const r = d.runner.deposit(w, amount);
    if (!r.ok) throw new InputError(r.reason);
    return send(reply, 200, { account: d.runner.account() });
  });

  app.post('/api/transfer', async (req, reply) => {
    const b = objectBody(req);
    const from = wallet(b, 'from');
    const to = wallet(b, 'to');
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
    return send(reply, 200, { order: current(order) });
  });

  app.delete('/api/orders/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = d.runner.cancel(id);
    if (!r.ok) return send(reply, r.reason === 'Order not found' ? 404 : 400, { error: r.reason });
    const order = d.runner.state.orders.get(id);
    return send(reply, 200, { order });
  });

  app.post('/api/oco', async (req, reply) => {
    const b = objectBody(req);
    const events = d.runner.attachOco({
      symbol: tradable(reqStr(b, 'symbol')),
      qty: reqStr(b, 'qty'),
      stopLoss: reqStr(b, 'stopLoss'),
      takeProfit: reqStr(b, 'takeProfit'),
    });
    const orders = events.flatMap((e) => (e.type === 'order_placed' || e.type === 'order_rejected' ? [current(e.order)] : []));
    return send(reply, 200, { orders });
  });

  app.get('/api/history', async (req, reply) => {
    const q = req.query as Query;
    const s = queryStr(q, 'symbol');
    const market = queryStr(q, 'market');
    if (market !== undefined && !WALLETS.includes(market)) throw new InputError('market must be spot or leverage');
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

  app.get('/api/candles', async (req, reply) => {
    const q = req.query as Query;
    const s = symbol(queryStr(q, 'symbol') ?? '');
    const interval = queryStr(q, 'interval') ?? '';
    if (!(INTERVALS as readonly string[]).includes(interval)) throw new InputError(`Unsupported interval ${interval}`);
    const endTime = queryInt(q, 'endTime', 0, Number.MAX_SAFE_INTEGER);
    let candles: Candle[];
    try {
      candles = await d.candles.history(s, interval, endTime);
    } catch (e) {
      d.logger.warn(`candles ${s} ${interval} failed: ${(e as Error).message}`);
      return send(reply, 502, { error: 'Candle history unavailable' });
    }
    return send(reply, 200, { candles });
  });

  app.get('/ws', { websocket: true }, (socket) => d.hub.add(socket));

  if (d.webDist) await app.register(fastifyStatic, { root: d.webDist, prefix: '/' });
  return app;
}
