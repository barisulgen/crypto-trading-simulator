import { describe, it, expect } from 'vitest';
import { checkTiers, fetchUnofficialBrackets, parseSnapshot, TierLoader } from '../src/binance/tiers.ts';
import type { TierLoaderDeps } from '../src/binance/tiers.ts';
import { PauseController } from '../src/binance/restCore.ts';
import bundled from '../src/binance/tiers-snapshot.json' with { type: 'json' };
import bapi from './fixtures/bapi-brackets.json' with { type: 'json' };
import official from './fixtures/leverage-bracket.json' with { type: 'json' };

const NOW = 1_800_000_000_000;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'].map((c) => `${c}USDT`);
const clone = <T>(x: T): T => structuredClone(x);

function loader(over: Partial<TierLoaderDeps> = {}) {
  const warnings: string[] = [];
  const calls = { official: 0, unofficial: 0 };
  const deps: TierLoaderDeps = {
    symbols: SYMBOLS,
    rest: {
      leverageBracket: async () => {
        calls.official++;
        return official;
      },
    },
    credentials: { key: 'k3y', secret: 's3cret' },
    unofficial: async () => {
      calls.unofficial++;
      return bapi;
    },
    logger: { info() {}, error: (m) => warnings.push(m), warn: (m) => warnings.push(m) },
    ...over,
  };
  return { loader: new TierLoader(deps), warnings, calls };
}

const plain = (b: { floor: any; cap: any; mmr: any; cum: any; maxLeverage: number }) => ({
  floor: b.floor.toString(),
  cap: b.cap.toString(),
  mmr: b.mmr.toString(),
  cum: b.cum.toString(),
  maxLeverage: b.maxLeverage,
});

describe('TierLoader', () => {
  it('uses the signed leverageBracket when it covers all ten symbols', async () => {
    const t = loader();
    const set = await t.loader.load(NOW);
    expect(set.source).toBe('official');
    expect(set.fetchedAt).toBe(NOW);
    expect(Object.keys(set.brackets).sort()).toEqual([...SYMBOLS].sort());
    expect(plain(set.brackets.BTCUSDT![1]!)).toEqual({ floor: '300000', cap: '800000', mmr: '0.005', cum: '300', maxLeverage: 100 });
    expect(plain(set.brackets.BTCUSDT![0]!)).toEqual({ floor: '0', cap: '300000', mmr: '0.004', cum: '0', maxLeverage: 150 });
    expect(set.brackets.HYPEUSDT).toHaveLength(9);
    expect(t.calls).toEqual({ official: 1, unofficial: 0 });
    expect(t.warnings).toEqual([]);
  });

  it('falls back to the public endpoint when the signed call fails (HTTP 401), with a warning', async () => {
    const t = loader({
      rest: {
        leverageBracket: async () => {
          throw new Error('Binance /fapi/v1/leverageBracket HTTP 401: {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}');
        },
      },
    });
    const set = await t.loader.load(NOW);
    expect(set.source).toBe('unofficial');
    expect(set.fetchedAt).toBe(NOW);
    expect(plain(set.brackets.BTCUSDT![1]!)).toEqual({ floor: '300000', cap: '800000', mmr: '0.005', cum: '300', maxLeverage: 100 });
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('HTTP 401');
  });

  it('skips the signed call when no key is configured', async () => {
    const t = loader({ credentials: null });
    const set = await t.loader.load(NOW);
    expect(set.source).toBe('unofficial');
    expect(t.calls).toEqual({ official: 0, unofficial: 1 });
    expect(t.warnings).toEqual([]);
  });

  it('uses the bundled snapshot, with a warning, when the public endpoint lacks a symbol', async () => {
    const noHype = clone(bapi);
    noHype.data.brackets = noHype.data.brackets.filter((b) => b.symbol !== 'HYPEUSDT');
    const t = loader({ credentials: null, unofficial: async () => noHype });
    const set = await t.loader.load(NOW);
    expect(set.source).toBe('bundled');
    expect(set.fetchedAt).toBe(bundled.fetchedAt);
    expect(Object.keys(set.brackets).sort()).toEqual([...SYMBOLS].sort());
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('HYPEUSDT');
    expect(t.warnings[0]).toContain('bundled');
  });

  it('rejects a source whose brackets are not contiguous', async () => {
    const gap = clone(official);
    gap.find((s) => s.symbol === 'BTCUSDT')!.brackets[2]!.notionalFloor = 900000; // tier 2 ends at 800000
    const t = loader({ rest: { leverageBracket: async () => gap } });
    const set = await t.loader.load(NOW);
    expect(set.source).toBe('unofficial');
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('BTCUSDT');
    expect(t.warnings[0]).toContain('contiguous');
  });

  it('rejects a source whose first bracket does not start at 0, or whose envelope is not ok', async () => {
    const offset = clone(official);
    offset.find((s) => s.symbol === 'ETHUSDT')!.brackets[0]!.notionalFloor = 5;
    const failed = { ...clone(bapi), code: '100001' };
    const t = loader({ rest: { leverageBracket: async () => offset }, unofficial: async () => failed });
    const set = await t.loader.load(NOW);
    expect(set.source).toBe('bundled');
    expect(t.warnings).toHaveLength(2);
    expect(t.warnings[0]).toContain('ETHUSDT');
    expect(t.warnings[1]).toContain('100001');
  });

  it('sorts brackets by floor before checking them', async () => {
    const shuffled = clone(official);
    shuffled.forEach((s) => s.brackets.reverse());
    const set = await loader({ rest: { leverageBracket: async () => shuffled } }).loader.load(NOW);
    expect(set.source).toBe('official');
    expect(set.brackets.BTCUSDT![0]!.floor.isZero()).toBe(true);
  });

  it('throws when no source, not even the bundled one, is usable', async () => {
    const t = loader({
      credentials: null,
      unofficial: async () => {
        throw new Error('offline');
      },
      snapshot: { ...clone(bundled), brackets: { BTCUSDT: bundled.brackets.BTCUSDT } },
    });
    await expect(t.loader.load(NOW)).rejects.toThrow(/No usable leverage tier source/);
  });
});

describe('tier checks', () => {
  it('rejects bad numbers and a cap not above its floor', () => {
    const set = parseSnapshot(bundled, SYMBOLS);
    expect(checkTiers(set.brackets, SYMBOLS)).toBeNull();
    const bad = parseSnapshot(bundled, SYMBOLS);
    bad.brackets.SOLUSDT![0]!.maxLeverage = 0;
    expect(checkTiers(bad.brackets, SYMBOLS)).toMatch(/SOLUSDT/);
    const flat = parseSnapshot(bundled, SYMBOLS);
    flat.brackets.XRPUSDT![0]!.cap = flat.brackets.XRPUSDT![0]!.floor;
    expect(checkTiers(flat.brackets, SYMBOLS)).toMatch(/XRPUSDT/);
  });
});

describe('bundled snapshot', () => {
  it('covers all ten symbols with checked brackets and records its source and date', () => {
    expect(bundled.source).toBe('unofficial');
    expect(bundled.fetchedAt).toBeGreaterThan(Date.UTC(2026, 9, 1));
    const set = parseSnapshot(bundled, SYMBOLS);
    expect(set.source).toBe('bundled');
    expect(checkTiers(set.brackets, SYMBOLS)).toBeNull();
  });
});

describe('fetchUnofficialBrackets', () => {
  it('GETs the public brackets endpoint without any key, and a 429 there pauses the REST clients', async () => {
    let now = NOW;
    const urls: string[] = [];
    const headers: unknown[] = [];
    let status = 200;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      headers.push(init?.headers);
      return {
        ok: status === 200,
        status,
        headers: new Headers(status === 429 ? { 'retry-after': '30' } : {}),
        text: async () => '',
        json: async () => bapi,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const pause = new PauseController(() => now, { info() {}, warn() {}, error() {} });
    expect(await fetchUnofficialBrackets(fetchImpl, pause)).toEqual(bapi);
    expect(urls).toEqual(['https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets']);
    expect(headers[0]).toBeUndefined();
    status = 429;
    await expect(fetchUnofficialBrackets(fetchImpl, pause)).rejects.toThrow('HTTP 429');
    expect(pause.pausedUntil).toBe(NOW + 30_000);
    await expect(fetchUnofficialBrackets(fetchImpl, pause)).rejects.toThrow('paused');
    expect(urls).toHaveLength(2);
    now += 30_000;
    status = 200;
    await fetchUnofficialBrackets(fetchImpl, pause);
    expect(urls).toHaveLength(3);
  });
});
