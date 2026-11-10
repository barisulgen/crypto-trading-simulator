import type { Market } from '@sim/engine';

/**
 * The base addresses of the Binance hosts the server talks to. Each is a scheme, host, optional
 * port and optional path prefix, with no trailing slash; the clients append Binance's own paths.
 */
export interface BinanceEndpoints {
  /** Spot REST (/api/v3/...). */
  spotRest: string;
  /** USDⓈ-M futures REST (/fapi/v1/...). */
  futuresRest: string;
  /** Binance's web API, for the public leverage brackets (/bapi/...). */
  web: string;
  /** Spot WebSocket streams (/stream?streams=... and /ws). */
  spotWs: string;
  /** USDⓈ-M futures WebSocket streams (/public/... for depth, /market/... for the rest). */
  futuresWs: string;
}

export const DEFAULT_ENDPOINTS: Readonly<BinanceEndpoints> = Object.freeze({
  spotRest: 'https://api.binance.com',
  futuresRest: 'https://fapi.binance.com',
  web: 'https://www.binance.com',
  spotWs: 'wss://stream.binance.com:9443',
  futuresWs: 'wss://fstream.binance.com',
});

/** The env setting of each endpoint. */
export const ENDPOINT_ENV: Readonly<Record<keyof BinanceEndpoints, string>> = Object.freeze({
  spotRest: 'BINANCE_SPOT_REST_URL',
  futuresRest: 'BINANCE_FUTURES_REST_URL',
  web: 'BINANCE_WEB_URL',
  spotWs: 'BINANCE_SPOT_WS_URL',
  futuresWs: 'BINANCE_FUTURES_WS_URL',
});

const WS_KEYS: ReadonlySet<keyof BinanceEndpoints> = new Set(['spotWs', 'futuresWs']);

/**
 * One endpoint setting as a base address: the default when unset or empty. Refused (with the
 * setting's name, never its value) unless it is an http(s) address for REST and the web API, or a
 * ws(s) address for the streams, with no query, fragment or credentials.
 */
function parseEndpoint(key: keyof BinanceEndpoints, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ENDPOINTS[key];
  const name = ENDPOINT_ENV[key];
  const ws = WS_KEYS.has(key);
  const protocols = ws ? ['ws:', 'wss:'] : ['http:', 'https:'];
  const kind = ws ? 'a ws:// or wss:// address' : 'an http:// or https:// address';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be ${kind}`);
  }
  if (!protocols.includes(url.protocol) || !url.host) throw new Error(`${name} must be ${kind}`);
  if (url.search || url.hash || url.username || url.password || raw.includes('?') || raw.includes('#')) {
    throw new Error(`${name} must be a base address with no query, fragment or credentials`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Every endpoint from the env settings (see ENDPOINT_ENV), each defaulting to live Binance. */
export function parseEndpoints(env: Record<string, string | undefined>): BinanceEndpoints {
  const out = {} as BinanceEndpoints;
  for (const key of Object.keys(DEFAULT_ENDPOINTS) as (keyof BinanceEndpoints)[]) {
    out[key] = parseEndpoint(key, env[ENDPOINT_ENV[key]]);
  }
  return out;
}

/** Whether a host name is this computer: localhost, 127.0.0.0/8 or ::1. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The signed leverage-bracket request carries the API key to the futures REST address: with a key
 * set, that address must be https, or plain http only on this computer. Refused by setting name,
 * never by value.
 */
export function assertKeyTransport(e: Pick<BinanceEndpoints, 'futuresRest'>, keySet: boolean): void {
  if (!keySet) return;
  const url = new URL(e.futuresRest);
  if (url.protocol === 'https:' || isLoopback(url.hostname)) return;
  throw new Error(`${ENDPOINT_ENV.futuresRest} must be an https:// address (or http:// on this computer) while BINANCE_KEY is set`);
}

/**
 * The endpoints that differ from live Binance, for the log: each setting's name with its scheme,
 * host and port only. A path may carry a relay's token, so it is never shown.
 */
export function overriddenEndpoints(e: BinanceEndpoints): string[] {
  return (Object.keys(DEFAULT_ENDPOINTS) as (keyof BinanceEndpoints)[])
    .filter((k) => e[k] !== DEFAULT_ENDPOINTS[k])
    .map((k) => `${ENDPOINT_ENV[k]} (${new URL(e[k]).origin})`);
}

/** The spot combined-stream socket, before its stream names. */
export const spotStreamUrl = (e: Pick<BinanceEndpoints, 'spotWs'>): string => `${e.spotWs}/stream?streams=`;

/** USDⓈ-M futures depth streams are served only on the public endpoint. */
export const perpDepthStreamUrl = (e: Pick<BinanceEndpoints, 'futuresWs'>): string => `${e.futuresWs}/public/stream?streams=`;

/** Trades, mark price and tickers are served only on the market endpoint. */
export const perpMarketStreamUrl = (e: Pick<BinanceEndpoints, 'futuresWs'>): string => `${e.futuresWs}/market/stream?streams=`;

/** The socket a market's klines are subscribed on (SUBSCRIBE / UNSUBSCRIBE). */
export const klineSocketUrl = (e: Pick<BinanceEndpoints, 'spotWs' | 'futuresWs'>, market: Market): string =>
  market === 'spot' ? `${e.spotWs}/ws` : `${e.futuresWs}/market/ws`;

/** Binance's public (unofficial, unsigned) leverage-bracket endpoint used by its web site. */
export const unofficialBracketsUrl = (e: Pick<BinanceEndpoints, 'web'>): string =>
  `${e.web}/bapi/futures/v1/friendly/future/common/brackets`;
