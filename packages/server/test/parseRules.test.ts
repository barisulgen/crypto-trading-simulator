import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSpotRules } from '../src/binance/parseRules.ts';
import { BinanceRest } from '../src/binance/rest.ts';

const info = JSON.parse(readFileSync(new URL('./fixtures/btcusdt-exchangeinfo.json', import.meta.url), 'utf8'));

describe('parseSpotRules', () => {
  it('maps BTCUSDT filters', () => {
    const r = parseSpotRules(info.symbols[0]);
    expect(r.symbol).toBe('BTCUSDT');
    expect(r.base).toBe('BTC');
    expect(r.quote).toBe('USDT');
    expect(r.tickSize.toString()).toBe('0.01');
    expect(r.stepSize.toString()).toBe('0.00001');
    expect(r.minNotional.toString()).toBe('5');
    expect(r.applyMinToMarket).toBe(true);
    expect(r.bidMultiplierUp.toString()).toBe('1.2');
    expect(r.maxNumAlgoOrders).toBe(5);
    expect(r.maxNumOrders).toBe(200);
    expect(r.marketMinQty.isZero()).toBe(true);
    expect(r.marketStepSize.isZero()).toBe(true);
  });
  it('throws a clear error on a missing filter', () => {
    const bad = { ...info.symbols[0], filters: info.symbols[0].filters.filter((f: any) => f.filterType !== 'NOTIONAL') };
    expect(() => parseSpotRules(bad)).toThrow(/NOTIONAL/);
  });
});

describe('BinanceRest', () => {
  const make = () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(String(u));
      return new Response('{"ok":1}', { status: 200 });
    }) as unknown as typeof fetch;
    return { urls, rest: new BinanceRest(f) };
  };
  it('builds URLs', async () => {
    const { urls, rest } = make();
    await rest.exchangeInfo(['BTCUSDT', 'ETHUSDT']);
    await rest.depth('BTCUSDT');
    await rest.avgPrice('BTCUSDT');
    await rest.klines('BTCUSDT', '1m', 5, 99);
    await rest.klines('BTCUSDT', '1m', 5);
    await rest.serverTime();
    const b = 'https://api.binance.com';
    expect(urls).toEqual([
      `${b}/api/v3/exchangeInfo?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT"]')}`,
      `${b}/api/v3/depth?symbol=BTCUSDT&limit=1000`,
      `${b}/api/v3/avgPrice?symbol=BTCUSDT`,
      `${b}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5&endTime=99`,
      `${b}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5`,
      `${b}/api/v3/time`,
    ]);
  });
  it('throws on non-2xx with a body snippet', async () => {
    const f = (async () => new Response('x'.repeat(500), { status: 418 })) as unknown as typeof fetch;
    const err = await new BinanceRest(f).serverTime().catch((e) => e as Error);
    expect(err.message).toBe(`Binance /api/v3/time HTTP 418: ${'x'.repeat(200)}`);
  });
});
