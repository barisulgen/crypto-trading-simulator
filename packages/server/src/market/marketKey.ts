import type { Market } from '@sim/engine';

/** A market and symbol as one key: perpetuals reuse the spot symbol names (spot:BTCUSDT, perp:BTCUSDT). */
export type MarketKey = `${Market}:${string}`;

export function marketKey(market: Market, symbol: string): MarketKey {
  return `${market}:${symbol}`;
}

/** The market and symbol of a key. */
export function splitKey(key: MarketKey): { market: Market; symbol: string } {
  const i = key.indexOf(':');
  return { market: key.slice(0, i) as Market, symbol: key.slice(i + 1) };
}
