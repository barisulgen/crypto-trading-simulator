import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { D, liquidationPrice, maxRemovableMargin, PerpEngine, SimEngine, SpotEngine } from '@sim/engine';
import { btcBrackets } from '../../engine/test/perpFixtures.ts';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../src/api/auth.ts';
import { buildApp } from '../src/api/http.ts';
import { ClientHub } from '../src/api/ws.ts';
import { COINS, loadConfig } from '../src/config.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { loadLedger, loadPerpState, loadSpotState } from '../src/db/store.ts';
import { createLogger } from '../src/log.ts';
import type { Candle } from '../src/market/candles.ts';
import {
  CATCHING_UP_REFUSAL,
  EngineRunner,
  FEED_NOTICE_WINDOW_MS,
  GAP_NOT_APPLIED_REFUSAL,
  LEVERAGE_TRANSFER_REFUSAL,
  LEVERAGE_TRANSFER_STALE_REFUSAL,
  MARGIN_STALE_REFUSAL,
  RefusedError,
} from '../src/runner.ts';
import { FakeClock, FakeHealth, FakeHistory, settle, TestMarket, TestPerpMarket } from './helpers.ts';

const T0 = 1_700_000_000_000;
const SECRET_ENV = { BINANCE_KEY: 'kKEY-9f3a1e', BINANCE_SECRET: 'sSECRET-77b2c4', APP_PASSWORD: 'pw-LAN-4c1d0a' };
const config = loadConfig('test/fixtures/does-not-exist.env', SECRET_ENV);
const SECRET_VALUES = Object.values(SECRET_ENV);

/** Every response body, response header and WS message seen in this file, plus every log line. */
const seen: string[] = [];
const logs: string[] = [];

class FakeCandles {
  constructor(private readonly tag = '') {}
  subs: { symbol: string; interval: string; active: boolean; cb: (c: Candle) => void }[] = [];
  async history(symbol: string, interval: string, endTime?: number): Promise<Candle[]> {
    return [{ time: endTime ?? T0, open: '1', high: '2', low: '0.5', close: `${this.tag}${symbol}:${interval}`, volume: '3' }];
  }
  subscribe(symbol: string, interval: string, cb: (c: Candle) => void): () => void {
    const s = { symbol, interval, active: true, cb };
    this.subs.push(s);
    return () => {
      s.active = false;
    };
  }
}

async function makeApp(opts: { password?: boolean; webDist?: string; db?: Db; clock?: FakeClock; history?: FakeHistory } = {}) {
  const db = opts.db ?? openDb(':memory:');
  const clock = opts.clock ?? new FakeClock(T0);
  const seasonId = currentSeasonId(db, () => clock.now);
  const market = new TestMarket(config.symbols);
  const perpMarket = new TestPerpMarket(config.symbols);
  perpMarket.now = () => clock.now;
  const logger = createLogger(config.secrets, (_s, line) => logs.push(line));
  const ledger = loadLedger(db, seasonId, ['USDT', ...COINS]);
  const engine = new SpotEngine(loadSpotState(db, seasonId, ledger));
  const sim = new SimEngine(ledger, engine, new PerpEngine(loadPerpState(db, seasonId, ledger)));
  let hub: ClientHub | null = null;
  const runner = new EngineRunner({
    db,
    seasonId,
    sim,
    spotMarket: market,
    perpMarket,
    health: { spot: new FakeHealth(() => clock.now), perp: new FakeHealth(() => clock.now) },
    symbols: config.symbols,
    fees: config.fees,
    now: () => clock.now,
    rng: () => 0,
    setTimer: clock.setTimer,
    onBroadcast: (m) => hub?.broadcast(m),
    onFatal: () => {},
    logger,
    history: opts.history ?? new FakeHistory(),
  });
  const candles = new FakeCandles();
  const perpCandles = new FakeCandles('perp:');
  hub = new ClientHub({
    market,
    perpMarket,
    candles: { spot: candles, perp: perpCandles },
    runner,
    symbols: config.symbols,
    setTimer: clock.setTimer,
    logger,
    health: () => runner.healthMessage(),
  });
  runner.start();
  hub.start();
  const app = await buildApp({
    runner,
    market,
    perpMarket,
    hub,
    candles: { spot: candles, perp: perpCandles },
    db,
    seasonId,
    coins: config.coins,
    symbols: config.symbols,
    fees: config.fees,
    appPassword: opts.password === false ? null : config.appPassword,
    logger,
    now: () => clock.now,
    webDist: opts.webDist ?? null,
  });

  let cookie = '';
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, withCookie = true) => {
    const res = await app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      headers: withCookie && cookie ? { cookie } : {},
    });
    seen.push(res.body, JSON.stringify(res.headers));
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
  const login = async () => {
    const res = await call('POST', '/api/login', { password: SECRET_ENV.APP_PASSWORD }, false);
    expect(res.status).toBe(200);
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
    return res;
  };
  const connect = async () => {
    const msgs: any[] = [];
    const closed: { code: number; reason: string }[] = [];
    // Listen from onInit: the server sends its snapshot as soon as the socket opens.
    const ws = await app.injectWS(
      '/ws',
      { headers: { cookie } },
      {
        onInit: (client) => {
          client.on('message', (data: Buffer) => {
            const text = data.toString();
            seen.push(text);
            msgs.push(JSON.parse(text));
          });
          client.on('close', (code: number, reason: Buffer) => closed.push({ code, reason: reason.toString() }));
        },
      },
    );
    return { ws, msgs, closed };
  };
  return { app, db, clock, market, perpMarket, runner, hub, candles, perpCandles, call, login, connect, cookie: () => cookie };
}

async function waitFor<T>(find: () => T | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = find();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});

/** Moves the fake clock without running its timers (days of ticking would be slow and pointless here). */
const jump = (clock: { now: number }, ms: number) => {
  clock.now += ms;
};

describe('auth', () => {
  it('with a LAN password, /api and /ws need the session cookie set by POST /api/login', async () => {
    const t = await makeApp();
    apps.push(t.app);
    expect((await t.call('GET', '/api/account')).status).toBe(401);
    expect((await t.call('POST', '/api/login', { password: 'wrong' })).status).toBe(401);
    expect((await t.call('POST', '/api/login', {})).status).toBe(400);
    await expect(t.app.injectWS('/ws')).rejects.toThrow();

    const res = await t.login();
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^sim_session=[0-9a-f]{64}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect((await t.call('GET', '/api/account')).status).toBe(200);
    const { ws } = await t.connect();
    ws.terminate();
  });

  it('refuses a sixth login within 15 minutes of five failures, then lets the owner back in', async () => {
    const t = await makeApp();
    apps.push(t.app);
    for (let i = 0; i < 5; i++) {
      expect((await t.call('POST', '/api/login', { password: `wrong${i}` }, false)).status).toBe(401);
      jump(t.clock, 1000);
    }
    const right = { password: SECRET_ENV.APP_PASSWORD };
    const blocked = await t.call('POST', '/api/login', right, false);
    expect(blocked.status).toBe(429);
    // The oldest failure was 5 s ago: 14 min 55 s remain, shown rounded up.
    expect(blocked.body).toEqual({ error: 'Too many failed logins; try again in 15 min' });
    expect(blocked.headers['set-cookie']).toBeUndefined();
    jump(t.clock, 15 * 60_000 - 5000 - 1);
    expect((await t.call('POST', '/api/login', right, false)).status).toBe(429);
    jump(t.clock, 1);
    expect((await t.call('POST', '/api/login', right, false)).status).toBe(200);
  });

  it('a successful login clears the failures, and failures older than 15 minutes do not count', async () => {
    const t = await makeApp();
    apps.push(t.app);
    for (let i = 0; i < 4; i++) await t.call('POST', '/api/login', { password: 'wrong' }, false);
    await t.login();
    for (let i = 0; i < 4; i++) expect((await t.call('POST', '/api/login', { password: 'wrong' }, false)).status).toBe(401);
    jump(t.clock, 15 * 60_000);
    for (let i = 0; i < 4; i++) expect((await t.call('POST', '/api/login', { password: 'wrong' }, false)).status).toBe(401);
    expect((await t.call('POST', '/api/login', { password: SECRET_ENV.APP_PASSWORD }, false)).status).toBe(200);
  });

  it('a session idle for 24 h, or 7 days old, is refused with a message the login screen can show', async () => {
    const t = await makeApp();
    apps.push(t.app);
    const res = await t.login();
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=604800');
    jump(t.clock, 24 * 3_600_000 - 1);
    expect((await t.call('GET', '/api/account')).status).toBe(200); // use renews the idle timer
    jump(t.clock, 24 * 3_600_000);
    expect(await t.call('GET', '/api/account')).toMatchObject({
      status: 401,
      body: { error: 'Session expired; log in again' },
    });

    await t.login();
    for (let day = 1; day <= 6; day++) {
      jump(t.clock, 24 * 3_600_000 - 1000);
      expect((await t.call('GET', '/api/account')).status).toBe(200);
    }
    jump(t.clock, 24 * 3_600_000 - 1000); // 7 days - 7 s
    expect((await t.call('GET', '/api/account')).status).toBe(200);
    jump(t.clock, 7000); // now 7 days after login, though never idle
    expect(await t.call('GET', '/api/account')).toMatchObject({
      status: 401,
      body: { error: 'Session expired; log in again' },
    });
  });

  it('LAN mode gates the matched route: percent-encoded /api and /ws paths still need the session', async () => {
    const t = await makeApp();
    apps.push(t.app);
    expect((await t.call('GET', '/%61pi/account')).status).toBe(401);
    expect((await t.call('GET', '/%61%70%69/account')).status).toBe(401);
    expect((await t.call('GET', '/api/%61ccount')).status).toBe(401);
    expect((await t.call('POST', '/%61pi/deposit', { wallet: 'spot', amount: '1000' })).status).toBe(401);
    expect(t.runner.state.ledger.totalDeposited.toString()).toBe('0');
    expect(t.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'deposit'").get()).toEqual({ n: 0 });
    await expect(t.app.injectWS('/%77s')).rejects.toThrow('Unexpected server response: 401');
    // Unknown routes are denied too (deny by default); only POST /api/login is open.
    expect((await t.call('GET', '/nothing-here')).status).toBe(401);
    expect((await t.call('GET', '/api/login')).status).toBe(401);
    await t.login();
    expect((await t.call('GET', '/%61pi/account')).status).toBe(200);
  });

  it('LAN mode serves the static web UI without a session, but nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>sim</title>');
    writeFileSync(join(dir, '.env.local'), 'APP_PASSWORD=leaked');
    try {
      const t = await makeApp({ webDist: dir });
      apps.push(t.app);
      const index = await t.app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('<title>sim</title>');
      expect((await t.app.inject({ method: 'GET', url: '/index.html' })).statusCode).toBe(200);
      const dotfile = await t.app.inject({ method: 'GET', url: '/.env.local' });
      expect(dotfile.statusCode).toBe(403);
      expect(dotfile.body).not.toContain('leaked');
      expect((await t.call('GET', '/%61pi/account')).status).toBe(401);
      // An unknown /api path falls to the static wildcard: a plain 404 from web/dist, no data.
      expect(await t.call('GET', '/api/nothing')).toMatchObject({ status: 404 });
      await expect(t.app.injectWS('/%77s')).rejects.toThrow('Unexpected server response: 401');
      seen.push(index.body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a password, needs no login but refuses foreign Host and Origin headers', async () => {
    const t = await makeApp({ password: false });
    apps.push(t.app);
    expect((await t.call('GET', '/api/account')).status).toBe(200);
    const evil = await t.app.inject({ method: 'GET', url: '/api/account', headers: { host: 'evil.example:8787' } });
    expect(evil.statusCode).toBe(403);
    const origin = await t.app.inject({
      method: 'GET',
      url: '/api/account',
      headers: { origin: 'http://evil.example' },
    });
    expect(origin.statusCode).toBe(403);
    const encoded = await t.app.inject({ method: 'GET', url: '/%61pi/account', headers: { host: 'evil.example' } });
    expect(encoded.statusCode).toBe(403);
    await expect(t.app.injectWS('/%77s', { headers: { origin: 'http://evil.example' } })).rejects.toThrow(
      'Unexpected server response: 403',
    );
    seen.push(evil.body, origin.body, encoded.body);
  });
});

describe('REST', () => {
  it('deposit: 200 and the account total follows; "1,5" is 1.5; "abc" is a 400', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const dep = await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1000' });
    expect(dep.status).toBe(200);
    expect((await t.call('GET', '/api/account')).body.total).toBe('1000');
    expect((await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1,5' })).status).toBe(200);
    expect((await t.call('GET', '/api/account')).body.total).toBe('1001.5');
    const bad = await t.call('POST', '/api/deposit', { wallet: 'spot', amount: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/^Invalid amount "abc"/);
    expect((await t.call('POST', '/api/deposit', { wallet: 'moon', amount: '1' })).status).toBe(400);
    expect((await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1.005' })).body).toEqual({
      error: 'Deposit has at most 2 decimals',
    });
    expect((await t.call('POST', '/api/deposit', { wallet: 'spot', amount: 5 })).status).toBe(400);
  });

  it('market buy: 200 pending, fills after 300 ms, history has the fill, WS gets the notice', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { ws, msgs } = await t.connect();
    await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1000' });

    const res = await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1.2' });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ symbol: 'BTCUSDT', status: 'pending', qty: '1.2' });
    expect((await t.call('GET', '/api/orders?status=open')).body.orders).toHaveLength(1);

    t.clock.advance(300);
    const hist = await t.call('GET', '/api/history?types=fill');
    expect(hist.status).toBe(200);
    expect(hist.body.rows).toHaveLength(1);
    expect(hist.body.rows[0].payload.fill.price).toMatch(/^100\.05833+$/);
    const fills = await t.call('GET', '/api/fills?symbol=BTCUSDT&limit=10');
    expect(fills.body.fills).toEqual([expect.objectContaining({ side: 'buy', qty: '1.2', fee: '0.0012', feeAsset: 'BTC' })]);
    expect((await t.call('GET', '/api/orders?status=open')).body.orders).toEqual([]);
    expect((await t.call('GET', '/api/orders?status=recent')).body.orders[0]).toMatchObject({ status: 'filled' });

    const notice = await waitFor(() => msgs.find((m) => m.type === 'notice'));
    expect(notice).toEqual({
      type: 'notice',
      kind: 'fill',
      level: 'info',
      text: 'Bought 1.2 BTC @ 100.0583 · slippage $0.07 · fee 0.0012 BTC',
    });
    expect(notice.text.startsWith('Bought 1.2 BTC')).toBe(true);
    ws.terminate();
  });

  it('meta: coins, symbols, loaded rules and fees as strings, perps, tiers, test data, season - nothing from config', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { body } = await t.call('GET', '/api/meta');
    expect(Object.keys(body).sort()).toEqual(['coins', 'fees', 'perp', 'rules', 'season', 'symbols', 'testData', 'tiers']);
    expect(body.coins).toEqual(COINS);
    expect(body.symbols[0]).toBe('BTCUSDT');
    expect(Object.keys(body.rules)).toEqual(['BTCUSDT']); // the only symbol with loaded rules
    expect(body.rules.BTCUSDT).toMatchObject({ tickSize: '0.01', stepSize: '0.00001', minNotional: '5', maxNumAlgoOrders: 5 });
    expect(body.fees).toEqual({ spot: { maker: '0.001', taker: '0.001' }, perp: { maker: '0.0002', taker: '0.0005' } });
    // A new database holds no data recorded before catch-up existed.
    expect(body.testData).toBe(false);
    expect(body.season).toEqual({ id: 1, name: 'Season 1', startedAt: T0 });

    expect(body.tiers).toEqual({ source: 'bundled', fetchedAt: 1_760_000_000_000 });
    expect(Object.keys(body.perp)).toEqual(config.symbols); // every symbol, loaded or not
    const btc = body.perp.BTCUSDT;
    expect(Object.keys(btc).sort()).toEqual(['brackets', 'leverage', 'marginMode', 'maxLeverage', 'rules']);
    expect(btc.rules).toMatchObject({ symbol: 'BTCUSDT', tickSize: '0.1', stepSize: '0.001', minNotional: '50', liquidationFee: '0.0125' });
    expect(btc.maxLeverage).toBe(150);
    expect(btc.brackets[0]).toEqual({ floor: '0', cap: '300000', mmr: '0.004', cum: '0', maxLeverage: 150 });
    expect(btc.brackets).toHaveLength(12);
    expect([btc.leverage, btc.marginMode]).toEqual([20, 'isolated']);
    // Not loaded yet: rules and tiers null, the default leverage shown.
    expect(body.perp.ETHUSDT).toEqual({ rules: null, maxLeverage: null, brackets: null, leverage: 20, marginMode: 'isolated' });

    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 7 })).status).toBe(200);
    expect((await t.call('GET', '/api/meta')).body.perp.BTCUSDT.leverage).toBe(7);
    t.perpMarket.tierSource = null;
    expect((await t.call('GET', '/api/meta')).body.tiers).toBeNull();
  });

  it('meta: testData is true only for a database recorded before catch-up existed (meta.test_data kept)', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO meta (key, value) VALUES ('test_data', '1')").run();
    const t = await makeApp({ db });
    apps.push(t.app);
    await t.login();
    expect((await t.call('GET', '/api/meta')).body.testData).toBe(true);
  });

  it('order input errors are 400s; engine rejections are recorded and returned with 200', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const unknown = await t.call('POST', '/api/orders', { symbol: 'FOOUSDT', side: 'buy', type: 'market', qty: '1' });
    expect(unknown).toMatchObject({ status: 400, body: { error: 'Unknown symbol FOOUSDT' } });
    expect((await t.call('POST', '/api/orders', { side: 'buy', type: 'market', qty: '1' })).body).toEqual({
      error: 'Missing field symbol',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'up', type: 'market', qty: '1' })).body).toEqual({
      error: 'Invalid field side',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 })).body).toEqual({
      error: 'Invalid field qty',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'trailing', qty: '1' })).body).toEqual({
      error: 'Invalid field type',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1', size: '1' })).body).toEqual({
      error: 'Invalid field size',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '1', price: '99', attach: { stopLoss: '9', takeProfit: '200', trail: '1' } })).body).toEqual({
      error: 'Invalid field attach.trail',
    });
    expect((await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1', note: 'x' })).body).toEqual({ error: 'Invalid field note' });
    expect((await t.call('POST', '/api/deposit', { wallet: 'moon', amount: '1' })).body).toEqual({ error: 'Invalid field wallet' });
    expect((await t.call('POST', '/api/transfer', { from: 'spot', to: 'leverage', amount: 1 })).body).toEqual({ error: 'Invalid field amount' });
    expect((await t.call('POST', '/api/oco', { symbol: 'BTCUSDT', qty: '1', stopLoss: '9', takeProfit: '200', x: 1 })).body).toEqual({ error: 'Invalid field x' });
    expect((await t.call('POST', '/api/orders', { symbol: 'ETHUSDT', side: 'buy', type: 'market', qty: '1' })).body).toEqual({
      error: 'Trading rules not loaded for ETHUSDT',
    });

    const rejected = await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.order).toMatchObject({ market: 'spot', status: 'rejected', rejectReason: 'Insufficient USDT: need 100.05, available 0' });
    const hist = await t.call('GET', '/api/history?types=order_rejected');
    expect(hist.body.rows).toHaveLength(1);
    expect((await t.call('GET', '/api/history?limit=0')).status).toBe(400);
    expect((await t.call('GET', '/api/orders?status=closed')).status).toBe(400);
  });

  it('preview, cancel, transfer, OCO and candles', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1000' });

    const preview = await t.call('POST', '/api/orders/preview', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1.2' });
    expect(preview.body).toMatchObject({ estSlippageUsd: '0.07', fee: { asset: 'BTC', amount: '0.0012' }, rejectReason: null });

    const limit = await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '1', price: '99.50' });
    t.clock.advance(300);
    // The cancel is a request: accepted, it arrives after its delay; the order is still open meanwhile.
    const cancel = await t.call('DELETE', `/api/orders/${limit.body.order.id}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.order).toMatchObject({ market: 'spot', status: 'open', cancelArrivesAt: t.clock.now + 100 });
    const again = await t.call('DELETE', `/api/orders/${limit.body.order.id}`);
    expect([again.status, again.body]).toEqual([400, { error: 'Cancel already requested' }]);
    t.clock.advance(100);
    expect(t.runner.state.orders.has(limit.body.order.id)).toBe(false); // finished: saved, then out of memory
    expect(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(limit.body.order.id)).toEqual({ status: 'cancelled' });
    expect((await t.call('DELETE', `/api/orders/${limit.body.order.id}`)).body).toEqual({ error: 'Order is not open' });
    expect((await t.call('DELETE', '/api/orders/nope')).status).toBe(404);

    const tr = await t.call('POST', '/api/transfer', { from: 'spot', to: 'leverage', amount: '100' });
    expect(tr.status).toBe(200);
    expect(tr.body.account.leverageUsdt).toBe('100');
    expect((await t.call('POST', '/api/transfer', { from: 'spot', to: 'spot', amount: '1' })).body).toEqual({
      error: 'Choose two different wallets',
    });

    await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
    t.clock.advance(300);
    const oco = await t.call('POST', '/api/oco', { symbol: 'BTCUSDT', qty: '0.5', stopLoss: '95', takeProfit: '110' });
    expect(oco.status).toBe(200);
    expect(oco.body.orders.map((o: any) => [o.type, o.status])).toEqual([
      ['stop_loss', 'pending'],
      ['take_profit', 'pending'],
    ]);

    const candles = await t.call('GET', `/api/candles?symbol=BTCUSDT&interval=1h&endTime=${T0}`);
    expect(candles.body.candles).toEqual([{ time: T0, open: '1', high: '2', low: '0.5', close: 'BTCUSDT:1h', volume: '3' }]);
    expect((await t.call('GET', '/api/candles?symbol=BTCUSDT&interval=7m')).body).toEqual({ error: 'Unsupported interval 7m' });
    const perp = await t.call('GET', `/api/candles?market=perp&symbol=BTCUSDT&interval=1m&endTime=${T0}`);
    expect(perp.body.candles).toEqual([{ time: T0, open: '1', high: '2', low: '0.5', close: 'perp:BTCUSDT:1m', volume: '3' }]);
    expect((await t.call('GET', '/api/candles?market=spot&symbol=BTCUSDT&interval=1h')).body.candles[0].close).toBe('BTCUSDT:1h');
    expect((await t.call('GET', '/api/candles?market=margin&symbol=BTCUSDT&interval=1h')).body).toEqual({ error: 'Unknown market margin' });
  });
});

/** Logged in, 1000 USDT in the leverage wallet. */
async function perpApp() {
  const t = await makeApp();
  apps.push(t.app);
  await t.login();
  expect((await t.call('POST', '/api/deposit', { wallet: 'leverage', amount: '1000' })).status).toBe(200);
  return t;
}

type PerpApp = Awaited<ReturnType<typeof perpApp>>;

/** A long 0.01 BTCUSDT at 80000 (leverage 20: margin 40 less the 0.4 fee), filled after its 100 ms delay. */
async function openLong(t: PerpApp) {
  const res = await t.call('POST', '/api/perp/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' });
  expect(res.status).toBe(200);
  t.clock.advance(100);
  return res.body.order;
}

describe('perp REST', () => {
  it('POST /api/perp/orders: a market buy opens a position after its delay; malformed or unknown fields are 400s', async () => {
    const t = await perpApp();
    const res = await t.call('POST', '/api/perp/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01', reduceOnly: false });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ market: 'perp', symbol: 'BTCUSDT', side: 'buy', type: 'market', status: 'pending', qty: '0.01', leverage: 20 });
    t.clock.advance(100);
    expect((await t.call('GET', '/api/positions')).body.positions).toEqual([
      expect.objectContaining({ symbol: 'BTCUSDT', side: 'long', qty: '0.01', entryPrice: '80000', margin: '39.6' }),
    ]);

    const bad = async (body: object) => (await t.call('POST', '/api/perp/orders', body)).body;
    const base = { symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.01', price: '79000' };
    expect(await bad({ ...base, size: '1' })).toEqual({ error: 'Invalid field size' });
    expect(await bad({ ...base, qty: 0.01 })).toEqual({ error: 'Invalid field qty' });
    expect(await bad({ ...base, price: ['79000'] })).toEqual({ error: 'Invalid field price' });
    expect(await bad({ ...base, reduceOnly: 'yes' })).toEqual({ error: 'Invalid field reduceOnly' });
    expect(await bad({ ...base, side: 'long' })).toEqual({ error: 'Invalid field side' });
    // An unknown type is malformed input, not an order: nothing is recorded.
    expect(await bad({ ...base, type: 'stop_market' })).toEqual({ error: 'Invalid field type' });
    expect(await bad({ ...base, type: 'stop_loss' })).toEqual({ error: 'Invalid field type' });
    expect(await bad({ ...base, type: 7 })).toEqual({ error: 'Invalid field type' });
    expect(t.db.prepare("SELECT count(*) AS n FROM orders WHERE market = 'perp' AND status = 'rejected'").get()).toEqual({ n: 0 });
    expect(await bad({ ...base, attach: 'tight' })).toEqual({ error: 'Invalid field attach' });
    expect(await bad({ ...base, attach: { stopLoss: 70000 } })).toEqual({ error: 'Invalid field attach.stopLoss' });
    expect(await bad({ ...base, attach: { trailing: '1' } })).toEqual({ error: 'Invalid field attach.trailing' });
    expect(await bad({ ...base, symbol: undefined })).toEqual({ error: 'Missing field symbol' });
    expect(await bad({ ...base, symbol: 'FOOUSDT' })).toEqual({ error: 'Unknown symbol FOOUSDT' });
    expect((await t.call('POST', '/api/perp/orders', { ...base, symbol: 'ETHUSDT' })).body).toEqual({
      error: 'Trading rules not loaded for ETHUSDT perp',
    });
    expect(t.runner.openPerpOrders()).toEqual([]);

    // An engine rejection is recorded and returned with 200, as for spot.
    const rejected = await t.call('POST', '/api/perp/orders', { ...base, qty: '0.0001' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.order).toMatchObject({ status: 'rejected' });
    expect(rejected.body.order.rejectReason).toMatch(/^LOT_SIZE/);
  });

  it('POST /api/perp/orders/preview estimates without placing; an unknown symbol is a 400', async () => {
    const t = await perpApp();
    const res = await t.call('POST', '/api/perp/orders/preview', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estAvgPrice: '80000', notional: '800', fee: '0.4', leverage: 20, maxLeverage: 150, rejectReason: null });
    expect(t.runner.openPerpOrders()).toEqual([]);
    expect((await t.call('POST', '/api/perp/orders/preview', { symbol: 'NOPE', side: 'buy', type: 'market', qty: '1' })).body).toEqual({
      error: 'Unknown symbol NOPE',
    });
    expect((await t.call('POST', '/api/perp/orders/preview', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1', x: 1 })).body).toEqual({
      error: 'Invalid field x',
    });
  });

  it('GET /api/positions: live mark, unrealised P&L, margin balance, maintenance margin, margin ratio, liquidation price', async () => {
    const t = await perpApp();
    expect((await t.call('GET', '/api/positions')).body).toEqual({ positions: [] });
    await openLong(t);
    t.perpMarket.mark('BTCUSDT', '79000');
    const [p] = (await t.call('GET', '/api/positions')).body.positions;
    const liq = liquidationPrice(btcBrackets, 'long', D('0.01'), D('80000'), D('39.6'))!;
    expect(p).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'long',
      qty: '0.01',
      entryPrice: '80000',
      leverage: 20,
      margin: '39.6',
      marginMode: 'isolated',
      catchingUp: false,
      markPrice: '79000',
      markFresh: true,
      markAt: T0 + 100,
      unrealizedPnl: '-10',
      marginBalance: '29.6',
      maintenanceMargin: '3.16',
      marginRatio: D('3.16').div('29.6').toString(),
      liquidationPrice: liq.toString(),
    });
    // The most margin a removal may take now, as the engine judges it at the fresh mark.
    const removable = maxRemovableMargin({
      brackets: btcBrackets,
      side: 'long',
      qty: D('0.01'),
      entry: D('80000'),
      margin: D('39.6'),
      mark: D('79000'),
      leverage: 20,
    });
    expect(p.maxRemovableMargin).toBe(removable.toString());
    // A stale mark is still shown, flagged; never replaced by a guess. Nothing is removable on it.
    t.perpMarket.setMarkFresh('BTCUSDT', false);
    expect((await t.call('GET', '/api/positions')).body.positions[0]).toMatchObject({
      markPrice: '79000',
      markFresh: false,
      maxRemovableMargin: null,
    });
    // Refused without the session.
    expect((await t.call('GET', '/api/positions', undefined, false)).status).toBe(401);
  });

  it('DELETE /api/orders/:id cancels a perp order too; a second cancel is refused', async () => {
    const t = await perpApp();
    const limit = await t.call('POST', '/api/perp/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.01', price: '79000' });
    t.clock.advance(100);
    const id = limit.body.order.id;
    const cancel = await t.call('DELETE', `/api/orders/${id}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.order).toMatchObject({ id, market: 'perp', status: 'open', cancelArrivesAt: t.clock.now + 100 });
    expect((await t.call('DELETE', `/api/orders/${id}`)).body).toEqual({ error: 'Cancel already requested' });
    t.clock.advance(100);
    expect(t.db.prepare('SELECT status, market FROM orders WHERE id = ?').get(id)).toEqual({ status: 'cancelled', market: 'perp' });
    expect((await t.call('DELETE', `/api/orders/${id}`)).body).toEqual({ error: 'Order is not open' });
  });

  it('POST /api/perp/leverage sets a whole number up to the maximum; locked while a position is open', async () => {
    const t = await perpApp();
    const ok = await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 10 });
    expect(ok).toMatchObject({ status: 200, body: { symbol: 'BTCUSDT', leverage: 10, marginMode: 'isolated' } });
    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 151 })).body).toEqual({
      error: 'Leverage must be a whole number from 1 to 150',
    });
    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: '10' })).body).toEqual({ error: 'Invalid field leverage' });
    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 2.5 })).body).toEqual({ error: 'Invalid field leverage' });
    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT' })).body).toEqual({ error: 'Missing field leverage' });
    await openLong(t);
    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 5 })).body).toEqual({
      error: 'Leverage is locked while a position or an opening order is open on BTCUSDT',
    });
    expect((await t.call('GET', '/api/positions')).body.positions[0].leverage).toBe(10);
  });

  it('a leverage change reaches every open socket at once; a socket that connects later has it in its snapshot', async () => {
    const t = await perpApp();
    const a = await t.connect();
    const b = await t.connect();
    const snapshot = await waitFor(() => a.msgs.find((m) => m.type === 'perpSettings'));
    // Every symbol's setting, the default until one is set.
    expect(Object.keys(snapshot.settings).sort()).toEqual([...config.symbols].sort());
    expect(snapshot.settings.BTCUSDT).toEqual({ leverage: 20, marginMode: 'isolated' });
    const seen = [a.msgs.length, b.msgs.length];

    expect((await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 7 })).status).toBe(200);
    for (const [i, c] of [a, b].entries()) {
      const pushed = await waitFor(() => c.msgs.slice(seen[i]).find((m) => m.type === 'perpSettings'));
      expect(pushed.settings.BTCUSDT).toEqual({ leverage: 7, marginMode: 'isolated' });
      expect(pushed.settings.ETHUSDT).toEqual({ leverage: 20, marginMode: 'isolated' });
    }
    const late = await t.connect();
    expect((await waitFor(() => late.msgs.find((m) => m.type === 'perpSettings'))).settings.BTCUSDT.leverage).toBe(7);
    for (const c of [a, b, late]) c.ws.terminate();
  });

  it('engine refusals that are temporary (tiers not loaded, no fresh mark) are 503s, like missing rules', async () => {
    const t = await perpApp();
    await openLong(t);
    t.perpMarket.setMarkFresh('BTCUSDT', false);
    expect(await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'remove', amount: '1' })).toMatchObject({
      status: 503,
      body: { error: 'Mark price unavailable; try again when live data is back' },
    });
    t.perpMarket.setMarkFresh('BTCUSDT', true);
    t.perpMarket.clearBrackets('BTCUSDT');
    const tiers = { status: 503, body: { error: 'Leverage tiers not loaded yet; try again in a moment' } };
    expect(await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: '1' })).toMatchObject(tiers);
    expect(await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'remove', amount: '1' })).toMatchObject(tiers);
    expect(await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 5 })).toMatchObject(tiers);
    // The owner's own mistakes stay 400s.
    t.perpMarket.setBrackets('BTCUSDT', btcBrackets);
    expect((await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: '100000' })).status).toBe(400);
  });

  it('POST /api/perp/margin/preview: the margin and liquidation price a change would leave, or its refusal; nothing changes', async () => {
    const t = await perpApp();
    const preview = (body: object) => t.call('POST', '/api/perp/margin/preview', body);
    expect((await preview({ symbol: 'BTCUSDT', action: 'add', amount: '10' })).body).toEqual({
      marginAfter: null,
      liquidationPriceAfter: null,
      maxRemovable: null,
      rejectReason: 'No open position on BTCUSDT',
    });
    await openLong(t);
    const add = await preview({ symbol: 'BTCUSDT', action: 'add', amount: '10' });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({
      marginAfter: '49.6',
      liquidationPriceAfter: liquidationPrice(btcBrackets, 'long', D('0.01'), D('80000'), D('49.6'))!.toString(),
      rejectReason: null,
    });
    // At the mark 80000, a 20x long holds exactly its initial margin less the fee: nothing is removable.
    expect(add.body.maxRemovable).toBe(
      maxRemovableMargin({
        brackets: btcBrackets,
        side: 'long',
        qty: D('0.01'),
        entry: D('80000'),
        margin: D('39.6'),
        mark: D('80000'),
        leverage: 20,
      }).toString(),
    );
    expect(add.body.maxRemovable).toBe('0');
    // 10 USDT in profit at 81000: the profit is not removable.
    t.perpMarket.mark('BTCUSDT', '81000');
    expect((await preview({ symbol: 'BTCUSDT', action: 'remove', amount: '1' })).body).toEqual({
      marginAfter: null,
      liquidationPriceAfter: null,
      maxRemovable: '0',
      rejectReason: 'At most 0 USDT can be removed now',
    });
    // Margin added above the initial margin at the mark is: 49.6 - 0.01 x 81000 / 20.
    expect((await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: '10' })).status).toBe(200);
    expect((await preview({ symbol: 'BTCUSDT', action: 'remove', amount: '1' })).body).toEqual({
      marginAfter: '48.6',
      liquidationPriceAfter: liquidationPrice(btcBrackets, 'long', D('0.01'), D('80000'), D('48.6'))!.toString(),
      maxRemovable: '9.1',
      rejectReason: null,
    });
    t.perpMarket.mark('BTCUSDT', '80000');
    // Refused without the session.
    expect((await t.call('POST', '/api/perp/margin/preview', { symbol: 'BTCUSDT', action: 'add', amount: '1' }, false)).status).toBe(401);
    const tooMuch = await preview({ symbol: 'BTCUSDT', action: 'remove', amount: '40' });
    expect(tooMuch.body).toMatchObject({ marginAfter: null, liquidationPriceAfter: null });
    expect(tooMuch.body.rejectReason).toBe(`At most ${tooMuch.body.maxRemovable} USDT can be removed now`);
    // Nothing moved.
    expect((await t.call('GET', '/api/positions')).body.positions[0].margin).toBe('49.6');
    // Malformed requests are 400s, as for the action itself.
    expect((await preview({ symbol: 'BTCUSDT', action: 'take', amount: '1' })).body).toEqual({ error: 'Invalid field action' });
    expect((await preview({ symbol: 'BTCUSDT', action: 'add', amount: 1 })).body).toEqual({ error: 'Invalid field amount' });
    expect((await preview({ symbol: 'NOPE', action: 'add', amount: '1' })).body).toEqual({ error: 'Unknown symbol NOPE' });
  });

  it('POST /api/perp/margin-mode: isolated is accepted, cross is refused for now', async () => {
    const t = await perpApp();
    expect(await t.call('POST', '/api/perp/margin-mode', { symbol: 'BTCUSDT', mode: 'isolated' })).toMatchObject({
      status: 200,
      body: { symbol: 'BTCUSDT', leverage: 20, marginMode: 'isolated' },
    });
    expect(await t.call('POST', '/api/perp/margin-mode', { symbol: 'BTCUSDT', mode: 'cross' })).toMatchObject({
      status: 400,
      body: { error: 'Cross margin is not available yet; isolated only' },
    });
    expect((await t.call('POST', '/api/perp/margin-mode', { symbol: 'BTCUSDT', mode: 'portfolio' })).body).toEqual({ error: 'Invalid field mode' });
  });

  it('POST /api/perp/margin adds and removes isolated margin; more than is safe to remove is refused', async () => {
    const t = await perpApp();
    expect((await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: '10' })).body).toEqual({
      error: 'No open position on BTCUSDT',
    });
    await openLong(t);
    const add = await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: '10' });
    expect(add.status).toBe(200);
    expect(add.body.position).toMatchObject({ symbol: 'BTCUSDT', margin: '49.6' });
    const remove = await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'remove', amount: '5' });
    expect(remove.body.position).toMatchObject({ margin: '44.6' });
    const tooMuch = await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'remove', amount: '40' });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/^At most [\d.]+ USDT can be removed now$/);
    expect((await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'take', amount: '1' })).body).toEqual({ error: 'Invalid field action' });
    expect((await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: 1 })).body).toEqual({ error: 'Invalid field amount' });
    expect((await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: 'lots' })).body.error).toMatch(/^Invalid amount "lots"/);
  });

  it('POST /api/perp/tpsl sets close-position stops on the position; without one they are recorded as rejected', async () => {
    const t = await perpApp();
    const none = await t.call('POST', '/api/perp/tpsl', { symbol: 'BTCUSDT', stopLoss: '70000' });
    expect(none.status).toBe(200);
    expect(none.body.orders.map((o: any) => [o.type, o.status, o.rejectReason])).toEqual([
      ['stop_loss', 'rejected', 'No open position on BTCUSDT'],
    ]);
    expect((await t.call('POST', '/api/perp/tpsl', { symbol: 'BTCUSDT' })).body).toEqual({ error: 'Missing field stopLoss or takeProfit' });
    expect((await t.call('POST', '/api/perp/tpsl', { symbol: 'BTCUSDT', stopLoss: 70000 })).body).toEqual({ error: 'Invalid field stopLoss' });
    await openLong(t);
    const set = await t.call('POST', '/api/perp/tpsl', { symbol: 'BTCUSDT', stopLoss: '70000', takeProfit: '90000' });
    expect(set.status).toBe(200);
    expect(set.body.orders.map((o: any) => [o.market, o.type, o.status, o.closePosition, o.triggerPrice])).toEqual([
      ['perp', 'stop_loss', 'pending', true, '70000'],
      ['perp', 'take_profit', 'pending', true, '90000'],
    ]);
  });

  it('POST /api/perp/close: a reduce-only market order, the whole position without qty; nothing to close is a 400', async () => {
    const t = await perpApp();
    expect((await t.call('POST', '/api/perp/close', { symbol: 'BTCUSDT' })).body).toEqual({ error: 'No open position on BTCUSDT' });
    await openLong(t);
    const part = await t.call('POST', '/api/perp/close', { symbol: 'BTCUSDT', qty: '0.004' });
    expect(part.status).toBe(200);
    expect(part.body.order).toMatchObject({ market: 'perp', side: 'sell', type: 'market', qty: '0.004', reduceOnly: true, status: 'pending' });
    t.clock.advance(100);
    expect((await t.call('GET', '/api/positions')).body.positions[0].qty).toBe('0.006');
    const all = await t.call('POST', '/api/perp/close', { symbol: 'BTCUSDT' });
    expect(all.body.order).toMatchObject({ side: 'sell', qty: '0.006', reduceOnly: true });
    t.clock.advance(100);
    expect((await t.call('GET', '/api/positions')).body.positions).toEqual([]);
    expect((await t.call('POST', '/api/perp/close', { symbol: 'BTCUSDT', qty: 0.1 })).body).toEqual({ error: 'Invalid field qty' });
  });

  it('history filters market=perp and the perp event types; orders and fills filter by market and say which', async () => {
    const t = await perpApp();
    await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1000' });
    await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
    await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 10 });
    const open = await openLong(t);
    await t.call('POST', '/api/perp/close', { symbol: 'BTCUSDT' });
    t.clock.advance(100);
    const limit = await t.call('POST', '/api/perp/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.01', price: '79000' });
    t.clock.advance(100);

    const perp = await t.call('GET', '/api/history?market=perp&types=leverage_set,position_opened,position_closed,fill');
    expect(perp.body.rows.map((r: any) => [r.type, r.market])).toEqual([
      ['position_closed', 'perp'],
      ['fill', 'perp'],
      ['position_opened', 'perp'],
      ['fill', 'perp'],
      ['leverage_set', 'perp'],
    ]);
    const spot = await t.call('GET', '/api/history?market=spot&types=fill');
    expect(spot.body.rows.map((r: any) => r.market)).toEqual(['spot']);
    // market=leverage is the leverage side as a whole: perp events, its wallet's deposits, and transfers.
    await t.call('POST', '/api/transfer', { from: 'spot', to: 'leverage', amount: '5' });
    const types = 'fill,position_opened,deposit,transfer';
    const lev = (await t.call('GET', `/api/history?market=leverage&types=${types}`)).body.rows;
    expect(lev.map((r: any) => [r.type, r.market])).toEqual([
      ['transfer', null],
      ['fill', 'perp'],
      ['position_opened', 'perp'],
      ['fill', 'perp'],
      ['deposit', 'leverage'],
    ]);
    const perpOnly = (await t.call('GET', `/api/history?market=perp&types=${types}`)).body.rows;
    expect(perpOnly.map((r: any) => r.type)).toEqual(['transfer', 'fill', 'position_opened', 'fill']);
    const spotSide = (await t.call('GET', `/api/history?market=spot&types=${types}`)).body.rows;
    expect(spotSide.map((r: any) => [r.type, r.market])).toEqual([
      ['transfer', null],
      ['fill', 'spot'],
      ['deposit', 'spot'],
    ]);
    expect((await t.call('GET', '/api/history?market=margin')).body).toEqual({ error: 'market must be spot, leverage or perp' });

    const perpFills = (await t.call('GET', '/api/fills?market=perp')).body.fills;
    expect(perpFills).toHaveLength(2);
    const positionId = perp.body.rows.find((r: any) => r.type === 'position_opened').payload.position.id;
    expect(perpFills[1]).toMatchObject({ market: 'perp', orderId: open.id, positionId, uncovered: null, roundTripId: null, side: 'buy' });
    const spotFills = (await t.call('GET', '/api/fills')).body.fills;
    expect(spotFills.map((f: any) => [f.market, f.positionId, f.uncovered])).toEqual([['spot', null, null]]);
    expect((await t.call('GET', '/api/fills?market=spot&symbol=BTCUSDT')).body.fills).toHaveLength(1);
    expect((await t.call('GET', '/api/fills?market=both')).body).toEqual({ error: 'market must be spot or perp' });

    const openPerp = (await t.call('GET', '/api/orders?status=open&market=perp')).body.orders;
    expect(openPerp.map((o: any) => [o.id, o.market])).toEqual([[limit.body.order.id, 'perp']]);
    expect((await t.call('GET', '/api/orders?status=open')).body.orders).toEqual([]);
    const recentPerp = (await t.call('GET', '/api/orders?status=recent&market=perp')).body.orders;
    expect(recentPerp).toHaveLength(3);
    expect(recentPerp.every((o: any) => o.market === 'perp')).toBe(true);
    const recentSpot = (await t.call('GET', '/api/orders?status=recent')).body.orders;
    expect(recentSpot.map((o: any) => [o.market, o.status])).toEqual([['spot', 'filled']]);
  });

  it('a liquidation from catch-up with no socket open is delivered once on connect, then not again after the acknowledgement', async () => {
    const a = await perpApp();
    await openLong(a); // 0.01 at 80000, 20x: liquidated at a mark of 76345.4
    a.runner.stop(); // the last heartbeat at T0; no browser connected from here on
    const MIN = 60_000;
    const history = new FakeHistory();
    const at = Math.floor(T0 / MIN) * MIN + 3 * MIN;
    history.markList.BTCUSDT = [{ openTime: at, open: D('80000'), high: D('80000'), low: D('76000'), close: D('76000') }];
    const t = await makeApp({ db: a.db, clock: new FakeClock(T0 + 10 * MIN), history });
    apps.push(t.app);
    await t.login();
    await settle();
    expect(t.runner.gate('perp:BTCUSDT')).toBe('live');
    expect(t.runner.positions()).toEqual([]);
    const liquidations = (msgs: any[]) => msgs.filter((m) => m.type === 'notice' && m.kind === 'liquidation');

    const first = await t.connect();
    await waitFor(() => first.msgs.find((m) => m.type === 'positions'));
    await waitFor(() => liquidations(first.msgs)[0]);
    const [alert] = liquidations(first.msgs);
    expect(alert.level).toBe('error');
    expect(alert.text).toMatch(/^LIQUIDATED: BTCUSDT long 0\.01 at mark 76,345\.4/);
    expect(alert.liquidation).toEqual({
      eventId: expect.any(Number),
      symbol: 'BTCUSDT',
      side: 'long',
      qty: '0.01',
      markPrice: expect.any(String),
      marginLost: '39.6',
      liquidationFee: expect.any(String),
    });
    const second = await t.connect(); // not acknowledged yet: a second tab gets it too
    await waitFor(() => liquidations(second.msgs)[0]);
    expect(liquidations(first.msgs)).toHaveLength(1);
    second.ws.terminate();

    // Acknowledged: by an existing liquidation's id only.
    const ack = (eventId: unknown) => t.call('POST', '/api/liquidations/ack', { eventId });
    expect(await ack('1')).toMatchObject({ status: 400 });
    expect(await ack(alert.liquidation.eventId + 1000)).toMatchObject({ status: 400, body: { error: 'Unknown liquidation' } });
    expect((await t.call('POST', '/api/liquidations/ack', { eventId: alert.liquidation.eventId, extra: 1 })).status).toBe(400);
    expect(await t.call('POST', '/api/liquidations/ack', { eventId: alert.liquidation.eventId }, false)).toMatchObject({ status: 401 });
    expect(await ack(alert.liquidation.eventId)).toMatchObject({ status: 200 });
    first.ws.terminate();

    const third = await t.connect();
    await waitFor(() => third.msgs.find((m) => m.type === 'positions'));
    await new Promise((r) => setTimeout(r, 20));
    expect(liquidations(third.msgs)).toEqual([]);
    third.ws.terminate();
  });

  it('a liquidation while a "restored" notice collects reaches the socket at once, ahead of it', async () => {
    const t = await perpApp();
    await openLong(t);
    const { ws, msgs } = await t.connect();
    await waitFor(() => msgs.find((m) => m.type === 'positions'));
    t.market.setFresh('BTCUSDT', false);
    t.clock.advance(2000 + FEED_NOTICE_WINDOW_MS); // interrupted, and its notice sent
    await waitFor(() => msgs.find((m) => m.type === 'notice' && m.kind === 'feed_gap'));
    t.market.setFresh('BTCUSDT', true);
    const seen = msgs.length;
    t.clock.advance(1000); // spot BTC restored: its notice collects for the window
    t.perpMarket.mark('BTCUSDT', '76000');
    await waitFor(() => msgs.slice(seen).find((m) => m.type === 'notice' && m.kind === 'liquidation'));
    const kinds = () => msgs.slice(seen).filter((m) => m.type === 'notice').map((m) => m.kind);
    expect(kinds()).toEqual(['liquidation']);
    t.clock.advance(FEED_NOTICE_WINDOW_MS);
    await waitFor(() => (kinds().length === 2 ? true : undefined));
    expect(kinds()).toEqual(['liquidation', 'feed_restored']);
    ws.terminate();
  });

  it('a live liquidation notice carries its event id, the same one a later connect would replay', async () => {
    const t = await perpApp();
    await openLong(t);
    const { ws, msgs } = await t.connect();
    await waitFor(() => msgs.find((m) => m.type === 'positions'));
    t.perpMarket.mark('BTCUSDT', '76000');
    const live = await waitFor(() => msgs.find((m) => m.type === 'notice' && m.kind === 'liquidation'));
    const other = await t.connect();
    const replayed = await waitFor(() => other.msgs.find((m) => m.type === 'notice' && m.kind === 'liquidation'));
    expect(replayed.liquidation).toEqual(live.liquidation);
    expect(replayed.text).toBe(live.text);
    expect(typeof live.liquidation.eventId).toBe('number');
    ws.terminate();
    other.ws.terminate();
  });

  it('while the perp data is stale, margin changes and leverage transfers are refused with a 409 and the reason', async () => {
    const t = await perpApp();
    await openLong(t);
    t.perpMarket.setFresh('BTCUSDT', false);
    t.clock.advance(1000); // the poll opens the gap
    expect(t.runner.gate('perp:BTCUSDT')).toBe('stale');
    for (const action of ['add', 'remove']) {
      expect(await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action, amount: '1' })).toMatchObject({
        status: 409,
        body: { error: MARGIN_STALE_REFUSAL },
      });
      expect((await t.call('POST', '/api/perp/margin/preview', { symbol: 'BTCUSDT', action, amount: '1' })).body).toEqual({
        marginAfter: null,
        liquidationPriceAfter: null,
        maxRemovable: null,
        rejectReason: MARGIN_STALE_REFUSAL,
      });
    }
    expect((await t.call('GET', '/api/positions')).body.positions[0]).toMatchObject({ maxRemovableMargin: null });
    expect(await t.call('POST', '/api/transfer', { from: 'leverage', to: 'spot', amount: '1' })).toMatchObject({
      status: 409,
      body: { error: LEVERAGE_TRANSFER_STALE_REFUSAL },
    });
  });

  it('while a perp catches up after a gap, its actions and leverage transfers are refused with a 409 and the reason', async () => {
    const a = await perpApp();
    await openLong(a);
    a.runner.stop(); // the last heartbeat at T0
    const history = new FakeHistory();
    const release = history.hold();
    const t = await makeApp({ db: a.db, clock: new FakeClock(T0 + 10 * 60_000), history });
    apps.push(t.app);
    await t.login();
    expect(t.runner.gate('perp:BTCUSDT')).toBe('catching_up');
    const refused = { status: 409, body: { error: CATCHING_UP_REFUSAL } };
    expect(await t.call('POST', '/api/perp/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' })).toMatchObject(refused);
    expect(await t.call('POST', '/api/perp/leverage', { symbol: 'BTCUSDT', leverage: 5 })).toMatchObject(refused);
    expect(await t.call('POST', '/api/perp/margin-mode', { symbol: 'BTCUSDT', mode: 'isolated' })).toMatchObject(refused);
    expect(await t.call('POST', '/api/perp/margin', { symbol: 'BTCUSDT', action: 'add', amount: '1' })).toMatchObject(refused);
    expect(await t.call('POST', '/api/perp/tpsl', { symbol: 'BTCUSDT', stopLoss: '70000' })).toMatchObject(refused);
    expect(await t.call('POST', '/api/perp/close', { symbol: 'BTCUSDT' })).toMatchObject(refused);
    // The margin preview answers with the action's own refusal, and nothing is shown as removable.
    expect((await t.call('POST', '/api/perp/margin/preview', { symbol: 'BTCUSDT', action: 'remove', amount: '1' })).body).toEqual({
      marginAfter: null,
      liquidationPriceAfter: null,
      maxRemovable: null,
      rejectReason: CATCHING_UP_REFUSAL,
    });
    expect((await t.call('GET', '/api/positions')).body.positions[0]).toMatchObject({ markFresh: true, maxRemovableMargin: null });
    expect(await t.call('POST', '/api/transfer', { from: 'leverage', to: 'spot', amount: '1' })).toMatchObject({
      status: 409,
      body: { error: LEVERAGE_TRANSFER_REFUSAL },
    });
    // The health message says so per market and symbol.
    const { ws, msgs } = await t.connect();
    const health = await waitFor(() => msgs.find((m) => m.type === 'health'));
    expect(health.markets['perp:BTCUSDT']).toMatchObject({ catchingUp: true });
    expect(health.markets['spot:BTCUSDT']).toMatchObject({ catchingUp: false });
    expect(health.catchingUp).toEqual(['perp:BTCUSDT']);
    // Its position is shown, flagged as catching up: the figures may still change.
    expect((await t.call('GET', '/api/positions')).body.positions).toEqual([
      expect.objectContaining({ symbol: 'BTCUSDT', qty: '0.01', catchingUp: true }),
    ]);
    ws.terminate();
    release();
  });

  it('data back but its gap not yet applied: an order is refused with a 409 and the reason, like the other gate refusals', async () => {
    const t = await perpApp();
    vi.spyOn(t.runner, 'submitPerp').mockImplementation(() => {
      throw new RefusedError(GAP_NOT_APPLIED_REFUSAL);
    });
    expect(await t.call('POST', '/api/perp/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' })).toMatchObject({
      status: 409,
      body: { error: GAP_NOT_APPLIED_REFUSAL },
    });
  });
});

/** A small deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('order fuzz', () => {
  it('valid bodies with random fields changed, dropped or added, on every spot and perp write route, never get a 5xx', async () => {
    const t = await perpApp();
    await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '100000' });
    await openLong(t);
    const rnd = prng(20261024);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const values: readonly unknown[] = [
      '0.01', '0.001', '1', '0', '-1', '1e3', '1e-9', '0.000000001', '1,5', '٣', 'NaN', 'Infinity', '', ' ',
      'abc', '99999999999999999999', '80000', '79000', '70000', '90000', '100', '99.5', '0x10', '1.2.3', 'buy',
      'sell', 'market', 'limit', 'post_only', 'stop_loss', 'take_profit', 'stop_market', 'isolated', 'cross', 'add',
      'remove', 'spot', 'leverage', 'BTCUSDT', 'FOO', 0, 1, -1, 2.5, 1e308, 10, 150, 151, true, false, null, [], ['1'],
      {}, { stopLoss: '70000' }, { stopLoss: 1 }, { takeProfit: '90000', stopLoss: '70000' }, { x: '1' }, 'constructor',
    ];
    const S = 'BTCUSDT';
    // A valid request per route (several for orders); each case changes some of its fields.
    const templates: [string, Record<string, unknown>][] = [
      ['/api/orders', { symbol: S, side: 'buy', type: 'limit', qty: '0.01', price: '99' }],
      ['/api/orders', { symbol: S, side: 'sell', type: 'market', qty: '0.001' }],
      ['/api/orders', { symbol: S, side: 'buy', type: 'limit', qty: '0.01', price: '99', attach: { stopLoss: '90', takeProfit: '110' } }],
      ['/api/orders', { symbol: S, side: 'sell', type: 'stop_loss', qty: '0.001', triggerPrice: '95', price: '94' }],
      ['/api/orders/preview', { symbol: S, side: 'buy', type: 'market', quoteQty: '10' }],
      ['/api/oco', { symbol: S, qty: '0.001', stopLoss: '90', takeProfit: '110' }],
      ['/api/deposit', { wallet: 'leverage', amount: '10' }],
      ['/api/transfer', { from: 'spot', to: 'leverage', amount: '1' }],
      ['/api/perp/orders', { symbol: S, side: 'buy', type: 'market', qty: '0.001' }],
      ['/api/perp/orders', { symbol: S, side: 'sell', type: 'market', quoteQty: '100', reduceOnly: true }],
      ['/api/perp/orders', { symbol: S, side: 'buy', type: 'limit', qty: '0.002', price: '79500', attach: { stopLoss: '75000', takeProfit: '85000' } }],
      ['/api/perp/orders', { symbol: S, side: 'sell', type: 'post_only', qty: '0.001', price: '80500' }],
      ['/api/perp/orders/preview', { symbol: S, side: 'sell', type: 'limit', qty: '0.001', price: '80100', reduceOnly: false }],
      ['/api/perp/leverage', { symbol: S, leverage: 10 }],
      ['/api/perp/margin-mode', { symbol: S, mode: 'isolated' }],
      ['/api/perp/margin', { symbol: S, action: 'add', amount: '1' }],
      ['/api/perp/margin', { symbol: S, action: 'remove', amount: '0.5' }],
      ['/api/perp/tpsl', { symbol: S, stopLoss: '70000', takeProfit: '90000' }],
      ['/api/perp/close', { symbol: S, qty: '0.001' }],
      ['/api/perp/close', { symbol: S }],
    ];
    const extraKeys = ['extra', 'market', 'leverage', 'reduceOnly', 'attach', 'qty', 'price', 'symbol', 'side', 'type'];
    const statuses = new Map<number, number>();
    const headers = { cookie: t.cookie(), 'content-type': 'application/json' };
    let tradeId = 1000;
    for (let i = 0; i < 2000; i++) {
      const [url, template] = pick(templates);
      const body: Record<string, unknown> = { ...template };
      const changes = rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 3);
      for (let c = 0; c < changes; c++) {
        const keys = Object.keys(body);
        const r = rnd();
        if (r < 0.15 && keys.length > 0) delete body[pick(keys)];
        else if (r < 0.25) body[pick(extraKeys)] = pick(values);
        else if (keys.length > 0) body[pick(keys)] = pick(values);
      }
      const payload = rnd() < 0.02 ? pick<unknown>([[1, 2], 'text', 42, null]) : body;
      const res = await t.app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers });
      seen.push(res.body, JSON.stringify(res.headers));
      statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
      if (res.statusCode >= 500) throw new Error(`${res.statusCode} for POST ${url} ${JSON.stringify(payload)}: ${res.body}`);

      // The market moves: futures and spot trades, marks, and time for arrivals and cancels.
      const r = rnd();
      if (r < 0.2) t.perpMarket.trade(S, { id: ++tradeId, price: D(pick(['79400', '79990', '80000', '80600'])), qty: D('0.01'), sellerInitiated: rnd() < 0.5, time: t.clock.now });
      else if (r < 0.3) t.perpMarket.mark(S, pick(['70000', '76000', '79000', '80000', '81000']));
      else if (r < 0.35) t.market.trade(S, { id: ++tradeId, price: D(pick(['89', '99', '100', '111'])), qty: D('0.5'), sellerInitiated: rnd() < 0.5, time: t.clock.now });
      if (rnd() < 0.3) t.clock.advance(pick([50, 100, 250]));
      if (rnd() < 0.05) {
        const open = [...t.runner.openOrders(), ...t.runner.openPerpOrders()];
        const id = open.length > 0 && rnd() < 0.7 ? pick(open).id : String(pick(values));
        const del = await t.app.inject({ method: 'DELETE', url: `/api/orders/${encodeURIComponent(id)}`, headers: { cookie: t.cookie() } });
        seen.push(del.body);
        expect(del.statusCode).toBeLessThan(500);
      }
    }
    t.clock.advance(1000);
    // Accepted and refused requests were both exercised, and the engine still takes orders.
    expect(statuses.get(200)).toBeGreaterThan(400);
    expect(statuses.get(400)).toBeGreaterThan(400);
    expect((await t.call('POST', '/api/perp/orders/preview', { symbol: S, side: 'sell', type: 'market', qty: '0.001' })).status).toBe(200);
    expect((await t.call('POST', '/api/deposit', { wallet: 'spot', amount: '1' })).status).toBe(200);
    // It went past placing orders: perp positions were opened and closed along the way.
    const count = (type: string) => (t.db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n;
    expect(count('position_opened')).toBeGreaterThan(1);
    expect(count('position_closed')).toBeGreaterThan(1);
  });
});

describe('WS /ws', () => {
  it('sends a snapshot on connect; subscribe switches book, trades and kline for the client', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { ws, msgs } = await t.connect();
    await waitFor(() => (msgs.length >= 6 ? true : undefined));
    expect(msgs.slice(0, 6).map((m) => m.type)).toEqual(['tickers', 'health', 'account', 'orders', 'marks', 'positions']);
    expect(msgs[1].health.BTCUSDT).toEqual({ fresh: true, reason: null });
    // Every market and symbol, spot and perp, with whether it is catching up.
    expect(Object.keys(msgs[1].markets)).toEqual([...config.symbols.map((s) => `spot:${s}`), ...config.symbols.map((s) => `perp:${s}`)]);
    expect(msgs[1].markets['perp:BTCUSDT']).toEqual({ fresh: true, reason: null, catchingUp: false });
    expect(msgs[1].markets['perp:ETHUSDT']).toEqual({ fresh: false, reason: 'Disconnected', catchingUp: false });
    expect(msgs[1].catchingUp).toEqual([]);

    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'BTCUSDT', interval: '1m' }));
    const book = await waitFor(() => msgs.find((m) => m.type === 'book'));
    expect(book.symbol).toBe('BTCUSDT');
    expect(book.bids[0]).toEqual({ price: '99.9', qty: '0.4' });
    expect(t.candles.subs.map((s) => [s.symbol, s.interval, s.active])).toEqual([['BTCUSDT', '1m', true]]);

    t.market.trade('BTCUSDT', { id: 1, price: D('100'), qty: D('0.1'), sellerInitiated: false, time: T0 });
    const trades = await waitFor(() => msgs.find((m) => m.type === 'trades' && m.trades.length > 0));
    expect(trades.trades[0]).toMatchObject({ price: '100', qty: '0.1' });

    t.candles.subs[0]!.cb({ time: T0, open: '1', high: '1', low: '1', close: '1', volume: '0' });
    const kline = await waitFor(() => msgs.find((m) => m.type === 'kline'));
    expect(kline).toMatchObject({ symbol: 'BTCUSDT', interval: '1m', candle: { time: T0 } });

    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'ETHUSDT', interval: '5m' }));
    await waitFor(() => (t.candles.subs.length === 2 ? true : undefined));
    expect(t.candles.subs.map((s) => [s.symbol, s.interval, s.active])).toEqual([
      ['BTCUSDT', '1m', false],
      ['ETHUSDT', '5m', true],
    ]);
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'NOPE', interval: '5m' }));
    const err = await waitFor(() => msgs.find((m) => m.type === 'error'));
    expect(err.error).toBe('Unknown symbol NOPE');
    ws.terminate();
  });

  it('a perp subscribe gets the perp book, trades and klines only - never spot data - and switching releases it', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { ws, msgs } = await t.connect();
    await waitFor(() => (msgs.length >= 6 ? true : undefined));
    t.perpMarket.trade('BTCUSDT', { id: 7, price: D('80001'), qty: D('0.002'), sellerInitiated: true, time: T0 });
    ws.send(JSON.stringify({ type: 'subscribe', market: 'perp', symbol: 'BTCUSDT', interval: '1m' }));
    await waitFor(() => (t.perpCandles.subs.length === 1 ? true : undefined));
    expect(t.candles.subs).toEqual([]);

    // The subscription's starting snapshot: the futures book and recent futures trades.
    const book = await waitFor(() => msgs.find((m) => m.type === 'book'));
    expect(book).toEqual({
      type: 'book',
      market: 'perp',
      symbol: 'BTCUSDT',
      bids: [{ price: '79990', qty: '0.2' }, { price: '79980', qty: '1' }],
      asks: [{ price: '80000', qty: '0.2' }, { price: '80010', qty: '1' }],
    });
    const first = await waitFor(() => msgs.find((m) => m.type === 'trades'));
    expect(first).toMatchObject({ market: 'perp', symbol: 'BTCUSDT', trades: [{ id: 7, price: '80001' }] });

    t.perpCandles.subs[0]!.cb({ time: T0, open: '1', high: '1', low: '1', close: '1', volume: '0' });
    const kline = await waitFor(() => msgs.find((m) => m.type === 'kline'));
    expect(kline).toMatchObject({ market: 'perp', symbol: 'BTCUSDT', interval: '1m', candle: { time: T0 } });

    // Live: futures trades and book updates reach it; spot ones never do.
    t.market.trade('BTCUSDT', { id: 1, price: D('100'), qty: D('0.1'), sellerInitiated: false, time: T0 });
    t.perpMarket.trade('BTCUSDT', { id: 8, price: D('80002'), qty: D('0.003'), sellerInitiated: false, time: T0 });
    await waitFor(() => msgs.find((m) => m.type === 'trades' && m.trades[0]?.id === 8));
    t.clock.advance(250);
    t.perpMarket.bookUpdate('BTCUSDT');
    await waitFor(() => (msgs.filter((m) => m.type === 'book').length === 2 ? true : undefined));
    const bookAndTrades = msgs.filter((m) => m.type === 'book' || m.type === 'trades');
    expect(bookAndTrades.every((m) => m.market === 'perp')).toBe(true);
    expect(bookAndTrades.flatMap((m) => m.trades ?? []).map((tr: any) => tr.price)).toEqual(['80001', '80002']);

    // Switching to spot (market omitted) releases the perp subscription: only spot data from then on.
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'BTCUSDT', interval: '1m' }));
    await waitFor(() => (t.candles.subs.length === 1 ? true : undefined));
    expect(t.perpCandles.subs[0]!.active).toBe(false);
    await waitFor(() => msgs.find((m) => m.type === 'trades' && m.market === 'spot')); // the snapshot, after its book
    const mark = msgs.length;
    t.clock.advance(250);
    t.perpMarket.bookUpdate('BTCUSDT');
    t.perpMarket.trade('BTCUSDT', { id: 9, price: D('80003'), qty: D('0.001'), sellerInitiated: false, time: T0 });
    t.market.trade('BTCUSDT', { id: 2, price: D('101'), qty: D('0.1'), sellerInitiated: false, time: T0 });
    await waitFor(() => msgs.slice(mark).find((m) => m.type === 'trades'));
    await new Promise((r) => setTimeout(r, 30));
    const after = msgs.slice(mark).filter((m) => m.type === 'book' || m.type === 'trades');
    expect(after.map((m) => [m.type, m.market])).toEqual([['trades', 'spot']]);

    ws.send(JSON.stringify({ type: 'subscribe', market: 'margin', symbol: 'BTCUSDT', interval: '1m' }));
    const err = await waitFor(() => msgs.find((m) => m.type === 'error'));
    expect(err.error).toBe('Unknown market margin');
    ws.terminate();
  });
});

describe('sessions over /ws', () => {
  it('an open /ws whose session has been idle 24 h is closed at the next heartbeat, telling the client why', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { msgs, closed } = await t.connect();
    await waitFor(() => (msgs.length >= 6 ? true : undefined));
    jump(t.clock, 24 * 3_600_000);
    t.clock.advance(30_000); // the heartbeat
    await waitFor(() => closed[0]);
    expect(closed[0]).toEqual({ code: 4001, reason: 'Session expired; log in again' });
    expect(await t.call('GET', '/api/account')).toMatchObject({ status: 401, body: { error: 'Session expired; log in again' } });
  });

  it('messages on /ws renew the session idle timer, as requests do', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { ws, msgs, closed } = await t.connect();
    await waitFor(() => (msgs.length >= 6 ? true : undefined));
    jump(t.clock, 23 * 3_600_000);
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'BTCUSDT', interval: '1m' }));
    await waitFor(() => msgs.find((m) => m.type === 'book'));
    jump(t.clock, 23 * 3_600_000); // 46 h after login, 23 h after the message
    expect((await t.call('GET', '/api/account')).status).toBe(200);
    expect(closed).toEqual([]);
    ws.terminate();
  });

  it('every login sweeps the failures of addresses whose failures are all over 15 minutes old', async () => {
    const clock = new FakeClock(T0);
    const app = Fastify();
    apps.push(app);
    const logger = createLogger([], () => {});
    const auth = registerAuth(app, { appPassword: 'right', logger, now: () => clock.now });
    const login = (ip: string, password: string) =>
      app.inject({ method: 'POST', url: '/api/login', payload: { password }, remoteAddress: ip });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.2']) expect((await login(ip, 'wrong')).statusCode).toBe(401);
    expect(auth.loginFailureAddresses()).toBe(2);
    jump(clock, 15 * 60_000);
    expect((await login('10.0.0.3', 'wrong')).statusCode).toBe(401);
    expect(auth.loginFailureAddresses()).toBe(1); // 10.0.0.3 only: the others never came back
    jump(clock, 15 * 60_000);
    expect((await login('10.0.0.4', 'right')).statusCode).toBe(200);
    expect(auth.loginFailureAddresses()).toBe(0);
  });
});

describe('secrets', () => {
  it('no response body, header, WS message or log line in this file contains a configured secret', () => {
    expect(seen.length).toBeGreaterThan(50);
    expect(SECRET_VALUES).toContain(config.appPassword);
    expect(JSON.stringify(config)).not.toContain(SECRET_ENV.APP_PASSWORD);
    for (const text of [...seen, ...logs]) {
      for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
    }
  });
});
