import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import {
  DEFAULT_ENDPOINTS,
  klineSocketUrl,
  perpDepthStreamUrl,
  perpMarketStreamUrl,
  spotStreamUrl,
  unofficialBracketsUrl,
} from '../src/binance/endpoints.ts';
import { FuturesRest } from '../src/binance/futuresRest.ts';
import { BinanceRest } from '../src/binance/rest.ts';
import { PauseController } from '../src/binance/restCore.ts';
import { fetchUnofficialBrackets, UNOFFICIAL_BRACKETS_URL } from '../src/binance/tiers.ts';
import { CandleService } from '../src/market/candles.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { PerpFeed, perpHealth, PERP_DEPTH_URL, PERP_MARKET_URL } from '../src/market/perpFeed.ts';
import { SpotFeed, SPOT_STREAM_URL } from '../src/market/spotFeed.ts';
import { FakeWs } from './helpers.ts';

const missing = fileURLToPath(new URL('./fixtures/missing.env', import.meta.url));
const silent = { info() {}, warn() {}, error() {} };
const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };

const NAMES = {
  spotRest: 'BINANCE_SPOT_REST_URL',
  futuresRest: 'BINANCE_FUTURES_REST_URL',
  web: 'BINANCE_WEB_URL',
  spotWs: 'BINANCE_SPOT_WS_URL',
  futuresWs: 'BINANCE_FUTURES_WS_URL',
} as const;

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Binance endpoints in the config', () => {
  it('default to the live Binance hosts', () => {
    const c = loadConfig(missing, {});
    expect(c.binance).toEqual({
      spotRest: 'https://api.binance.com',
      futuresRest: 'https://fapi.binance.com',
      web: 'https://www.binance.com',
      spotWs: 'wss://stream.binance.com:9443',
      futuresWs: 'wss://fstream.binance.com',
    });
    expect(c.binance).toEqual(DEFAULT_ENDPOINTS);
    // Empty values (as left in a copied .env.example) are the defaults too.
    const empty = loadConfig(missing, Object.fromEntries(Object.values(NAMES).map((n) => [n, ''])));
    expect(empty.binance).toEqual(DEFAULT_ENDPOINTS);
  });

  it('derive exactly the addresses the clients used before they were configurable', () => {
    expect(spotStreamUrl(DEFAULT_ENDPOINTS)).toBe('wss://stream.binance.com:9443/stream?streams=');
    expect(perpDepthStreamUrl(DEFAULT_ENDPOINTS)).toBe('wss://fstream.binance.com/public/stream?streams=');
    expect(perpMarketStreamUrl(DEFAULT_ENDPOINTS)).toBe('wss://fstream.binance.com/market/stream?streams=');
    expect(klineSocketUrl(DEFAULT_ENDPOINTS, 'spot')).toBe('wss://stream.binance.com:9443/ws');
    expect(klineSocketUrl(DEFAULT_ENDPOINTS, 'perp')).toBe('wss://fstream.binance.com/market/ws');
    expect(unofficialBracketsUrl(DEFAULT_ENDPOINTS)).toBe(
      'https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets',
    );
    expect(SPOT_STREAM_URL).toBe(spotStreamUrl(DEFAULT_ENDPOINTS));
    expect(PERP_DEPTH_URL).toBe(perpDepthStreamUrl(DEFAULT_ENDPOINTS));
    expect(PERP_MARKET_URL).toBe(perpMarketStreamUrl(DEFAULT_ENDPOINTS));
    expect(UNOFFICIAL_BRACKETS_URL).toBe(unofficialBracketsUrl(DEFAULT_ENDPOINTS));
  });

  it('are overridden by the env, keeping a path prefix and dropping a trailing slash', () => {
    const c = loadConfig(missing, {
      BINANCE_SPOT_REST_URL: 'http://127.0.0.1:9001',
      BINANCE_FUTURES_REST_URL: 'https://relay.example:8443/fapi-relay/',
      BINANCE_WEB_URL: 'http://localhost:9002/',
      BINANCE_SPOT_WS_URL: 'ws://127.0.0.1:9003/spot',
      BINANCE_FUTURES_WS_URL: 'wss://relay.example/futures//',
    });
    expect(c.binance).toEqual({
      spotRest: 'http://127.0.0.1:9001',
      futuresRest: 'https://relay.example:8443/fapi-relay',
      web: 'http://localhost:9002',
      spotWs: 'ws://127.0.0.1:9003/spot',
      futuresWs: 'wss://relay.example/futures',
    });
    expect(spotStreamUrl(c.binance)).toBe('ws://127.0.0.1:9003/spot/stream?streams=');
    expect(perpDepthStreamUrl(c.binance)).toBe('wss://relay.example/futures/public/stream?streams=');
    expect(perpMarketStreamUrl(c.binance)).toBe('wss://relay.example/futures/market/stream?streams=');
    expect(klineSocketUrl(c.binance, 'spot')).toBe('ws://127.0.0.1:9003/spot/ws');
    expect(klineSocketUrl(c.binance, 'perp')).toBe('wss://relay.example/futures/market/ws');
    expect(unofficialBracketsUrl(c.binance)).toBe('http://localhost:9002/bapi/futures/v1/friendly/future/common/brackets');
  });

  it('are read from the env file as well, the process env winning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-endpoints-'));
    try {
      const file = join(dir, 'settings');
      writeFileSync(file, 'BINANCE_SPOT_REST_URL=http://127.0.0.1:1\nBINANCE_SPOT_WS_URL="ws://127.0.0.1:2"\n');
      const c = loadConfig(file, {});
      expect(c.binance.spotRest).toBe('http://127.0.0.1:1');
      expect(c.binance.spotWs).toBe('ws://127.0.0.1:2');
      expect(c.binance.futuresRest).toBe(DEFAULT_ENDPOINTS.futuresRest);
      expect(loadConfig(file, { BINANCE_SPOT_REST_URL: 'http://127.0.0.1:3' }).binance.spotRest).toBe('http://127.0.0.1:3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuse a REST or web address that is not http or https', () => {
    for (const name of [NAMES.spotRest, NAMES.futuresRest, NAMES.web]) {
      for (const bad of ['ws://127.0.0.1:1', 'wss://x.example', 'ftp://x.example', 'file:///etc/passwd', 'not a url', '127.0.0.1:9000']) {
        expect(() => loadConfig(missing, { [name]: bad }), `${name}=${bad}`).toThrow(
          `${name} must be an http:// or https:// address`,
        );
      }
    }
  });

  it('refuse a WebSocket address that is not ws or wss', () => {
    for (const name of [NAMES.spotWs, NAMES.futuresWs]) {
      for (const bad of ['http://127.0.0.1:1', 'https://x.example', 'javascript:alert(1)', 'nope']) {
        expect(() => loadConfig(missing, { [name]: bad }), `${name}=${bad}`).toThrow(
          `${name} must be a ws:// or wss:// address`,
        );
      }
    }
  });

  it('refuse a query, a fragment or credentials in any address', () => {
    const cases: [string, string][] = [
      [NAMES.spotRest, 'https://x.example/?a=1'],
      [NAMES.futuresRest, 'https://x.example/#frag'],
      [NAMES.web, 'https://user:pw@x.example'],
      [NAMES.spotWs, 'wss://x.example/?streams=a'],
      [NAMES.futuresWs, 'wss://user@x.example'],
    ];
    for (const [name, bad] of cases) {
      expect(() => loadConfig(missing, { [name]: bad }), bad).toThrow(`${name} must be a base address with no query, fragment or credentials`);
    }
  });

  it('never echo the refused value', () => {
    const e = (() => {
      try {
        loadConfig(missing, { BINANCE_SPOT_REST_URL: 'https://user:hunter2@x.example' });
      } catch (err) {
        return err as Error;
      }
      return null;
    })();
    expect(e).not.toBeNull();
    expect(e!.message).not.toContain('hunter2');
  });
});

describe('Binance clients on configured endpoints', () => {
  it('spot REST sends every request to its base', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return okResponse({ serverTime: 1 });
    }) as unknown as typeof fetch;
    await new BinanceRest(fetchImpl, Date.now, { base: 'http://127.0.0.1:9001' }).serverTime();
    await new BinanceRest(fetchImpl).serverTime();
    expect(urls).toEqual(['http://127.0.0.1:9001/api/v3/time', 'https://api.binance.com/api/v3/time']);
  });

  it('futures REST sends every request, the signed one included, to its base', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return okResponse(url.includes('/time') ? { serverTime: Date.now() } : []);
    }) as unknown as typeof fetch;
    const pause = new PauseController(Date.now);
    const rest = new FuturesRest(fetchImpl, Date.now, { pause, base: 'http://127.0.0.1:9004/relay' });
    await rest.premiumIndex();
    await rest.leverageBracket('k', 's');
    expect(urls[0]).toBe('http://127.0.0.1:9004/relay/fapi/v1/premiumIndex');
    expect(urls[1]).toBe('http://127.0.0.1:9004/relay/fapi/v1/time');
    expect(urls[2]).toMatch(/^http:\/\/127\.0\.0\.1:9004\/relay\/fapi\/v1\/leverageBracket\?timestamp=\d+&recvWindow=5000&signature=[0-9a-f]{64}$/);
    urls.length = 0;
    await new FuturesRest(fetchImpl, Date.now, { pause }).premiumIndex();
    expect(urls).toEqual(['https://fapi.binance.com/fapi/v1/premiumIndex']);
  });

  it('the public brackets endpoint is fetched from the given address', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return okResponse({ code: '000000' });
    }) as unknown as typeof fetch;
    const pause = new PauseController(Date.now);
    await fetchUnofficialBrackets(fetchImpl, pause, 'http://127.0.0.1:9002/bapi/futures/v1/friendly/future/common/brackets');
    await fetchUnofficialBrackets(fetchImpl, pause);
    expect(urls).toEqual([
      'http://127.0.0.1:9002/bapi/futures/v1/friendly/future/common/brackets',
      UNOFFICIAL_BRACKETS_URL,
    ]);
  });

  it('the spot and perp feeds open their sockets under the given WebSocket bases', () => {
    const urls: string[] = [];
    const wsFactory = (url: string) => {
      urls.push(url);
      return new FakeWs(url) as any;
    };
    const symbols = ['BTCUSDT'];
    const spot = new SpotFeed({
      symbols,
      rest: { depth: async () => ({}) },
      health: new FeedHealth(symbols, cfg),
      books: new Map([['BTCUSDT', new LocalBook()]]),
      logger: silent,
      wsFactory,
      streamUrl: 'ws://127.0.0.1:9003/spot/stream?streams=',
    });
    const perp = new PerpFeed({
      symbols,
      rest: { depth: async () => ({}) },
      health: perpHealth(symbols, cfg),
      books: new Map([['BTCUSDT', new LocalBook({ mode: 'futures' })]]),
      logger: silent,
      wsFactory,
      depthUrl: 'ws://127.0.0.1:9005/f/public/stream?streams=',
      marketUrl: 'ws://127.0.0.1:9005/f/market/stream?streams=',
    });
    spot.start();
    perp.start();
    spot.close();
    perp.close();
    expect(urls).toEqual([
      'ws://127.0.0.1:9003/spot/stream?streams=btcusdt@depth@100ms/btcusdt@aggTrade/btcusdt@miniTicker',
      'ws://127.0.0.1:9005/f/public/stream?streams=btcusdt@depth@100ms',
      'ws://127.0.0.1:9005/f/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s/btcusdt@miniTicker',
    ]);
  });

  it('the kline sockets open at the given address, or at Binance by default', () => {
    const urls: string[] = [];
    const wsFactory = (url: string) => {
      urls.push(url);
      return new FakeWs(url) as any;
    };
    const rest = { klines: async () => [] } as any;
    const services = [
      new CandleService({ rest, logger: silent, wsFactory, url: 'ws://127.0.0.1:9003/spot/ws' }),
      new CandleService({ market: 'perp', rest, logger: silent, wsFactory, url: 'ws://127.0.0.1:9005/f/market/ws' }),
      new CandleService({ rest, logger: silent, wsFactory }),
      new CandleService({ market: 'perp', rest, logger: silent, wsFactory }),
    ];
    for (const s of services) s.subscribe('BTCUSDT', '1m', () => {});
    for (const s of services) s.close();
    expect(urls).toEqual([
      'ws://127.0.0.1:9003/spot/ws',
      'ws://127.0.0.1:9005/f/market/ws',
      'wss://stream.binance.com:9443/ws',
      'wss://fstream.binance.com/market/ws',
    ]);
  });
});
