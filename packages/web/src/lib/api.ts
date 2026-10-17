// Typed wrappers for the server's REST API. Every decimal arrives (and is sent) as a string.
import type {
  AccountValue,
  AggTrade,
  Balance,
  Decimal,
  FeeSchedule,
  Fill,
  OrderPreview,
  PriceLevel,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
  Wallet,
} from '@sim/engine';

/** An engine type as it crosses JSON: every Decimal becomes its decimal string. */
export type Wire<T> = T extends Decimal
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export type { Wallet };
export type WireRules = Wire<SpotRules>;
export type WireOrder = Wire<SpotOrder>;
export type WireFill = Wire<Fill>;
export type WireAggTrade = Wire<AggTrade>;
export type WireLevel = Wire<PriceLevel>;
export type WirePreview = Wire<OrderPreview>;

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

export interface Ticker {
  last: string;
  open24h: string;
  change24hPct: string;
}

export type HealthMap = Record<string, { fresh: boolean; reason: string | null }>;

/** Account value plus the raw wallet balances and each held coin's cost basis. */
export type AccountSnapshot = Wire<AccountValue> & {
  balances: Record<Wallet, Record<string, Wire<Balance>>>;
  /** Per coin held: quantity and USDT cost (fees included). */
  basis: Record<string, { qty: string; cost: string }>;
};

export interface NoticeMessage {
  kind: 'fill' | 'partial_fill' | 'rejected' | 'triggered' | 'thin_book' | 'feed_gap' | 'feed_restored';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface Candle {
  /** Open time, ms. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface Meta {
  coins: string[];
  symbols: string[];
  /** Symbols whose exchange rules are not loaded yet are missing. */
  rules: Record<string, WireRules>;
  fees: { spot: Wire<FeeSchedule>; perp: Wire<FeeSchedule> };
  testData: boolean;
  season: { id: number; name: string; startedAt: number };
}

/** Messages the server sends on /ws. */
export type ServerMessage =
  | { type: 'tickers'; tickers: Record<string, Ticker> }
  | { type: 'health'; health: HealthMap }
  | { type: 'account'; account: AccountSnapshot }
  | { type: 'orders'; orders: WireOrder[] }
  | ({ type: 'notice' } & NoticeMessage)
  | { type: 'book'; symbol: string; bids: WireLevel[]; asks: WireLevel[] }
  | { type: 'trades'; symbol: string; trades: WireAggTrade[] }
  | { type: 'kline'; symbol: string; interval: Interval; candle: Candle }
  | { type: 'error'; error: string };

/** One event of GET /api/history; `payload` is the stored event (decimals as strings). */
export interface HistoryRow {
  id: number;
  time: number;
  type: string;
  symbol: string | null;
  market: string | null;
  payload: unknown;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: number | null;
}

export interface HistoryQuery {
  symbol?: string;
  market?: 'spot' | 'leverage';
  types?: string[];
  from?: number;
  to?: number;
  before?: number;
  limit?: number;
}

/** A non-2xx response; `message` is the server's error text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorized: () => void = () => {};

/** Called on every 401 (LAN password mode without a session). */
export function onUnauthorized(cb: () => void): void {
  unauthorized = cb;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: handled below
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') unauthorized();
    const error = (json as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof error === 'string' ? error : `Request failed (${res.status})`);
  }
  return json as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  meta: () => request<Meta>('GET', '/api/meta'),
  account: () => request<AccountSnapshot>('GET', '/api/account'),
  orders: (status: 'open' | 'recent' = 'open') =>
    request<{ orders: WireOrder[] }>('GET', `/api/orders${qs({ status })}`).then((r) => r.orders),
  fills: (p: { symbol?: string; limit?: number } = {}) =>
    request<{ fills: WireFill[] }>('GET', `/api/fills${qs(p)}`).then((r) => r.fills),
  history: (p: HistoryQuery = {}) =>
    request<HistoryPage>('GET', `/api/history${qs({ ...p, types: p.types?.join(',') })}`),
  candles: (symbol: string, interval: Interval, endTime?: number) =>
    request<{ candles: Candle[] }>('GET', `/api/candles${qs({ symbol, interval, endTime })}`).then((r) => r.candles),
  /** `amount` is sent exactly as typed; the server parses it ('1,5' is accepted). */
  deposit: (wallet: Wallet, amount: string) =>
    request<{ account: AccountSnapshot }>('POST', '/api/deposit', { wallet, amount }).then((r) => r.account),
  transfer: (from: Wallet, to: Wallet, amount: string) =>
    request<{ account: AccountSnapshot }>('POST', '/api/transfer', { from, to, amount }).then((r) => r.account),
  preview: (req: SpotOrderRequest) => request<WirePreview>('POST', '/api/orders/preview', req),
  placeOrder: (req: SpotOrderRequest) =>
    request<{ order: WireOrder }>('POST', '/api/orders', req).then((r) => r.order),
  cancelOrder: (id: string) =>
    request<{ order: WireOrder }>('DELETE', `/api/orders/${encodeURIComponent(id)}`).then((r) => r.order),
  attachOco: (p: { symbol: string; qty: string; stopLoss: string; takeProfit: string }) =>
    request<{ orders: WireOrder[] }>('POST', '/api/oco', p).then((r) => r.orders),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
};
