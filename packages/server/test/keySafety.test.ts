import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const missing = fileURLToPath(new URL('./fixtures/missing.env', import.meta.url));

describe('the API key and the futures REST address', () => {
  it('refuses to start with a key set and the futures REST address on plain http to a host that is not loopback', () => {
    const bad = 'BINANCE_FUTURES_REST_URL must be an https:// address (or http:// on this computer) while BINANCE_KEY is set';
    for (const url of ['http://relay.example', 'http://192.168.1.10:9000', 'http://127.example.com', 'http://10.0.0.1/fapi']) {
      expect(() => loadConfig(missing, { BINANCE_KEY: 'k', BINANCE_SECRET: 's', BINANCE_FUTURES_REST_URL: url }), url).toThrow(bad);
      try {
        loadConfig(missing, { BINANCE_KEY: 'k', BINANCE_FUTURES_REST_URL: url });
      } catch (e) {
        expect((e as Error).message).not.toContain(url.replace(/^http:\/\//, ''));
      }
    }
  });

  it('allows https anywhere, plain http on loopback, and anything without a key', () => {
    const key = { BINANCE_KEY: 'k', BINANCE_SECRET: 's' };
    for (const url of ['https://relay.example', 'http://127.0.0.1:9000', 'http://127.1.2.3', 'http://localhost:8080', 'http://[::1]:9000']) {
      expect(loadConfig(missing, { ...key, BINANCE_FUTURES_REST_URL: url }).binance.futuresRest, url).toBe(url.replace(/\/$/, ''));
    }
    expect(loadConfig(missing, { BINANCE_FUTURES_REST_URL: 'http://relay.example' }).binance.futuresRest).toBe('http://relay.example');
    // The other hosts never see the key.
    expect(loadConfig(missing, { ...key, BINANCE_SPOT_REST_URL: 'http://relay.example' }).binance.spotRest).toBe('http://relay.example');
  });
});

