import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

describe('loadConfig', () => {
  it('reads secrets from the env file and hides them from serialisation', () => {
    const c = loadConfig(fx('test.env'), {});
    expect(c.secrets).toEqual(['k123', 's456']);
    const json = JSON.stringify(c);
    expect(json).not.toContain('k123');
    expect(json).not.toContain('s456');
    expect(Object.keys(c)).not.toContain('secrets');
  });

  it('applies defaults', () => {
    const c = loadConfig(fx('missing.env'), {});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8787);
    expect(c.dbPath).toBe('data/sim.sqlite');
    expect(c.symbols).toHaveLength(10);
    expect(c.symbols[0]).toBe('BTCUSDT');
    expect(c.fees.spot.taker.toString()).toBe('0.001');
    expect(c.fees.perp.maker.toString()).toBe('0.0002');
    expect(c.health).toEqual({ silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 });
    expect(c.appPassword).toBeNull();
    expect(c.secrets).toEqual([]);
  });

  it('exposes the Binance key pair only when both are set, never enumerably', () => {
    const c = loadConfig(fx('test.env'), {});
    expect(c.binanceCredentials).toEqual({ key: 'k123', secret: 's456' });
    expect(Object.keys(c)).not.toContain('binanceCredentials');
    expect(JSON.stringify(c)).not.toContain('k123');
    expect(loadConfig(fx('test.env'), { BINANCE_SECRET: '' }).binanceCredentials).toBeNull();
    expect(loadConfig(fx('missing.env'), {}).binanceCredentials).toBeNull();
  });

  it('process env wins over the file', () => {
    const c = loadConfig(fx('test.env'), { BINANCE_KEY: 'zzz' });
    expect(c.secrets).toEqual(['zzz', 's456']);
  });

  it('requires APP_PASSWORD when HOST is not 127.0.0.1', () => {
    expect(() => loadConfig(fx('host.env'), {})).toThrow(
      'APP_PASSWORD is required when HOST is not 127.0.0.1',
    );
    const c = loadConfig(fx('host.env'), { APP_PASSWORD: 'pw' });
    expect(c.host).toBe('0.0.0.0');
    expect(c.secrets).toEqual(['pw']);
    expect(c.appPassword).toBe('pw');
    expect(Object.keys(c)).not.toContain('appPassword');
    expect(JSON.stringify(c)).not.toContain('pw');
  });

  it('accepts only a whole PORT from 1 to 65535', () => {
    const bad = 'PORT must be a whole number from 1 to 65535';
    for (const port of ['0', '70000', '12a', '65536', '-1', '80.5', '1e3', ' ']) {
      expect(() => loadConfig(fx('missing.env'), { PORT: port }), port).toThrow(bad);
    }
    expect(loadConfig(fx('missing.env'), { PORT: '8080' }).port).toBe(8080);
    expect(loadConfig(fx('missing.env'), { PORT: '65535' }).port).toBe(65535);
    expect(loadConfig(fx('missing.env'), { PORT: '1' }).port).toBe(1);
  });
});
