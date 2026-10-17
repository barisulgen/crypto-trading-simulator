import { readFileSync } from 'node:fs';
import { D } from '@sim/engine';
import type { FeeSchedule } from '@sim/engine';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  coins: string[];
  symbols: string[];
  fees: { spot: FeeSchedule; perp: FeeSchedule };
  health: { silentMs: number; lagMs: number; noUpdateMs: number };
  /** Non-enumerable: never serialised or iterated. */
  readonly appPassword: string | null;
  /** Non-enumerable: never serialised or iterated. */
  readonly secrets: string[];
}

export const COINS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val.endsWith(val[0]!)) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read env file (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

export function loadConfig(
  envFile = '.env.local',
  env: Record<string, string | undefined> = process.env,
): Config {
  const merged: Record<string, string | undefined> = { ...readEnvFile(envFile), ...env };
  const host = merged.HOST || '127.0.0.1';
  const appPassword = merged.APP_PASSWORD || null;
  if (host !== '127.0.0.1' && !appPassword) {
    throw new Error('APP_PASSWORD is required when HOST is not 127.0.0.1');
  }
  const secrets = [merged.BINANCE_KEY, merged.BINANCE_SECRET, merged.APP_PASSWORD].filter(
    (s): s is string => !!s,
  );
  const config = {
    host,
    port: merged.PORT ? Number(merged.PORT) : 8787,
    dbPath: merged.DB_PATH || 'data/sim.sqlite',
    coins: [...COINS],
    symbols: COINS.map((c) => `${c}USDT`),
    fees: {
      spot: { maker: D('0.001'), taker: D('0.001') },
      perp: { maker: D('0.0002'), taker: D('0.0005') },
    },
    health: { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 },
  } as Config;
  Object.defineProperty(config, 'secrets', { value: secrets, enumerable: false });
  Object.defineProperty(config, 'appPassword', { value: appPassword, enumerable: false });
  return config;
}
