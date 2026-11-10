import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { E2E_KEY, E2E_SECRET, FakeBinance } from './fakeBinance.ts';
import { waitFor } from './harness.ts';

/** The fake itself behaves as the parts of Binance the scenarios rely on. */
describe('the fake Binance', () => {
  const fake = new FakeBinance();
  let base = '';
  beforeAll(async () => {
    await fake.start();
    base = `http://127.0.0.1:${fake.port}`;
  });
  afterAll(async () => {
    await fake.stop();
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: (await res.json()) as any };
  };

  const listen = (path: string) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${fake.port}${path}`);
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    return { ws, messages, open: new Promise((r) => ws.once('open', r)) };
  };

  it('answers klines with startTime only from candles opening at or after it', async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const { body } = await get(`/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=10&startTime=${minute + 1}`);
    expect(body.every((r: any[]) => r[0] >= minute + 1)).toBe(true);
    const { body: same } = await get(`/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=10&startTime=${minute}`);
    expect(same[0][0]).toBe(minute);
  });

  it('serves futures depth only on /public and everything else only on /market, as Binance splits them', async () => {
    const pub = listen('/futures-ws/public/stream?streams=btcusdt@depth@100ms/btcusdt@aggTrade/btcusdt@markPrice@1s');
    const mkt = listen('/futures-ws/market/stream?streams=btcusdt@depth@100ms/btcusdt@aggTrade/btcusdt@markPrice@1s');
    await Promise.all([pub.open, mkt.open]);
    fake.trade('perp', 'BTCUSDT', '80000', '0.1');
    // Two marks on /market take two seconds: depth heartbeats (every 500 ms) would have come meanwhile.
    await waitFor('two marks on /market', () => mkt.messages.filter((m) => m.stream.includes('markPrice')).length >= 2, 5000);
    fake.trade('perp', 'BTCUSDT', '80000', '0.1');
    await waitFor('the second trade on /market', () => mkt.messages.filter((m) => m.stream.includes('aggTrade')).length >= 2, 5000);
    const kinds = (list: any[]) => new Set(list.map((m) => m.stream.split('@')[1]));
    expect([...kinds(pub.messages)]).toEqual(['depth']);
    expect(kinds(mkt.messages).has('depth')).toBe(false);
    expect(kinds(mkt.messages).has('aggTrade')).toBe(true);
    pub.ws.close();
    mkt.ws.close();
  });

  it('checks a signed request: the key, the HMAC of the query with the secret, and the timestamp within recvWindow', async () => {
    const signed = (timestamp: number, secret = E2E_SECRET) => {
      const q = `timestamp=${timestamp}&recvWindow=5000`;
      return `/fapi/v1/leverageBracket?${q}&signature=${createHmac('sha256', secret).update(q).digest('hex')}`;
    };
    const before = fake.signedAccepted;
    const ok = await get(signed(Date.now()), { 'X-MBX-APIKEY': E2E_KEY });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(fake.signedAccepted).toBe(before + 1);
    expect((await get(signed(Date.now(), 'wrong-secret'), { 'X-MBX-APIKEY': E2E_KEY })).body.code).toBe(-1022);
    expect((await get(signed(Date.now() - 6000), { 'X-MBX-APIKEY': E2E_KEY })).body.code).toBe(-1021);
    expect((await get(signed(Date.now()), { 'X-MBX-APIKEY': 'another-key' })).status).toBe(401);
    expect((await get(signed(Date.now()))).body.code).toBe(-2014);
  });

  it('sends a mark stamped in the past when asked, and announces a default funding time far ahead', async () => {
    const mkt = listen('/futures-ws/market/stream?streams=ethusdt@markPrice@1s');
    await mkt.open;
    fake.pauseMarks('ETHUSDT');
    const before = Date.now();
    fake.sendMarkUpdate('ETHUSDT', '2900', { eventLagMs: 6000 });
    const late = await waitFor('the late mark', () => mkt.messages.find((m) => m.data.p === '2900'), 3000);
    expect(late.data.E).toBeLessThanOrEqual(before - 6000 + 50);
    expect(late.data.T).toBeGreaterThan(Date.now() + 29 * 24 * 3_600_000);
    fake.pauseMarks('ETHUSDT', false);
    mkt.ws.close();
  });

  it('publishes a settlement for each 00/08/16 UTC funding time that passes', async () => {
    const boundary = Date.now() - 1000;
    (fake as any).nextBoundary = boundary;
    const rows = await waitFor('the settlement', async () => {
      const { body } = await get(`/fapi/v1/fundingRate?symbol=SOLUSDT&startTime=${boundary - 1}&endTime=${boundary + 1}&limit=10`);
      return body.length > 0 ? body : undefined;
    }, 5000, 200);
    expect(rows[0]).toEqual({ symbol: 'SOLUSDT', fundingTime: boundary, fundingRate: '0.00010000', markPrice: '150' });
  });
});
