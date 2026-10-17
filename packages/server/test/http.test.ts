import { afterAll, describe, expect, it } from 'vitest';
import { D, SpotEngine } from '@sim/engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/http.ts';
import { ClientHub } from '../src/api/ws.ts';
import { COINS, loadConfig } from '../src/config.ts';
import { currentSeasonId, openDb } from '../src/db/db.ts';
import { loadSpotState } from '../src/db/store.ts';
import { createLogger } from '../src/log.ts';
import type { Candle } from '../src/market/candles.ts';
import { EngineRunner } from '../src/runner.ts';
import { FakeClock, FakeHealth, TestMarket } from './helpers.ts';

const T0 = 1_700_000_000_000;
const SECRET_ENV = { BINANCE_KEY: 'kKEY-9f3a1e', BINANCE_SECRET: 'sSECRET-77b2c4', APP_PASSWORD: 'pw-LAN-4c1d0a' };
const config = loadConfig('test/fixtures/does-not-exist.env', SECRET_ENV);
const SECRET_VALUES = Object.values(SECRET_ENV);

/** Every response body, response header and WS message seen in this file, plus every log line. */
const seen: string[] = [];
const logs: string[] = [];

class FakeCandles {
  subs: { symbol: string; interval: string; active: boolean; cb: (c: Candle) => void }[] = [];
  async history(symbol: string, interval: string, endTime?: number): Promise<Candle[]> {
    return [{ time: endTime ?? T0, open: '1', high: '2', low: '0.5', close: `${symbol}:${interval}`, volume: '3' }];
  }
  subscribe(symbol: string, interval: string, cb: (c: Candle) => void): () => void {
    const s = { symbol, interval, active: true, cb };
    this.subs.push(s);
    return () => {
      s.active = false;
    };
  }
}

async function makeApp(opts: { password?: boolean } = {}) {
  const db = openDb(':memory:');
  const clock = new FakeClock(T0);
  const seasonId = currentSeasonId(db, () => clock.now);
  const market = new TestMarket(config.symbols);
  const logger = createLogger(config.secrets, (_s, line) => logs.push(line));
  const engine = new SpotEngine(loadSpotState(db, seasonId, ['USDT', ...COINS]));
  let hub: ClientHub | null = null;
  const runner = new EngineRunner({
    db,
    seasonId,
    engine,
    market,
    health: new FakeHealth(market, config.symbols),
    symbols: config.symbols,
    fees: config.fees.spot,
    now: () => clock.now,
    rng: () => 0,
    setTimer: clock.setTimer,
    onBroadcast: (m) => hub?.broadcast(m),
    onFatal: () => {},
    logger,
  });
  const candles = new FakeCandles();
  hub = new ClientHub({ market, candles, runner, symbols: config.symbols, setTimer: clock.setTimer, logger });
  runner.start();
  hub.start();
  const app = await buildApp({
    runner,
    market,
    hub,
    candles,
    db,
    seasonId,
    coins: config.coins,
    symbols: config.symbols,
    fees: config.fees,
    appPassword: opts.password === false ? null : config.appPassword,
    logger,
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
    // Listen from onInit: the server sends its snapshot as soon as the socket opens.
    const ws = await app.injectWS(
      '/ws',
      { headers: { cookie } },
      {
        onInit: (client) =>
          client.on('message', (data: Buffer) => {
            const text = data.toString();
            seen.push(text);
            msgs.push(JSON.parse(text));
          }),
      },
    );
    return { ws, msgs };
  };
  return { app, db, clock, market, runner, hub, candles, call, login, connect };
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
    seen.push(evil.body, origin.body);
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

  it('meta: coins, symbols, loaded rules and fees as strings, test data, season - nothing from config', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { body } = await t.call('GET', '/api/meta');
    expect(Object.keys(body).sort()).toEqual(['coins', 'fees', 'rules', 'season', 'symbols', 'testData']);
    expect(body.coins).toEqual(COINS);
    expect(body.symbols[0]).toBe('BTCUSDT');
    expect(Object.keys(body.rules)).toEqual(['BTCUSDT']); // the only symbol with loaded rules
    expect(body.rules.BTCUSDT).toMatchObject({ tickSize: '0.01', stepSize: '0.00001', minNotional: '5', maxNumAlgoOrders: 5 });
    expect(body.fees).toEqual({ spot: { maker: '0.001', taker: '0.001' }, perp: { maker: '0.0002', taker: '0.0005' } });
    expect(body.testData).toBe(true);
    expect(body.season).toEqual({ id: 1, name: 'Season 1', startedAt: T0 });
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
      error: 'side must be buy or sell',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 })).body).toEqual({
      error: 'qty must be a string',
    });
    expect((await t.call('POST', '/api/orders', { symbol: 'ETHUSDT', side: 'buy', type: 'market', qty: '1' })).body).toEqual({
      error: 'Trading rules not loaded for ETHUSDT',
    });

    const rejected = await t.call('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.order).toMatchObject({ status: 'rejected', rejectReason: 'Insufficient USDT: need 100.05, available 0' });
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
    const cancel = await t.call('DELETE', `/api/orders/${limit.body.order.id}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.order).toMatchObject({ status: 'cancelled' });
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
  });
});

describe('WS /ws', () => {
  it('sends a snapshot on connect; subscribe switches book, trades and kline for the client', async () => {
    const t = await makeApp();
    apps.push(t.app);
    await t.login();
    const { ws, msgs } = await t.connect();
    await waitFor(() => (msgs.length >= 4 ? true : undefined));
    expect(msgs.slice(0, 4).map((m) => m.type)).toEqual(['tickers', 'health', 'account', 'orders']);
    expect(msgs[1].health.BTCUSDT).toEqual({ fresh: true, reason: null });

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
