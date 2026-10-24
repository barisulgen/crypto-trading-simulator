// Typed wrappers for the server's REST API. Every decimal arrives (and is sent) as a string.
import type {
  AccountValue,
  AggTrade,
  Balance,
  Bracket,
  Decimal,
  FeeSchedule,
  Fill,
  Market,
  OrderPreview,
  PerpOrder,
  PerpOrderRequest,
  PerpPreview,
  PerpRules,
  Position,
  PriceLevel,
  SpotOrder,
  SpotOrderRequest,
  SpotRules,
  TierSource,
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

export type { Market, Wallet };
export type WireRules = Wire<SpotRules>;
export type WirePerpRules = Wire<PerpRules>;
export type WireOrder = Wire<SpotOrder>;
export type WirePerpOrder = Wire<PerpOrder>;
export type WireFill = Wire<Fill>;
/** A row of GET /api/fills: a spot fill has a round trip, a perp fill the position it opened or reduced. */
export type WireFillRow = WireFill & {
  market: Market;
  positionId: string | null;
  /** Perp fills only: the loss neither the margin nor free leverage USDT could cover; null when none. */
  uncovered: string | null;
};
export type WireAggTrade = Wire<AggTrade>;
export type WireLevel = Wire<PriceLevel>;
export type WirePreview = Wire<OrderPreview>;
export type WirePerpPreview = Wire<PerpPreview>;

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

export interface Ticker {
  last: string;
  open24h: string;
  change24hPct: string;
}

export type HealthMap = Record<string, { fresh: boolean; reason: string | null }>;

/** A market and symbol, as the server keys them: 'spot:BTCUSDT', 'perp:BTCUSDT'. */
export type MarketKey = `${Market}:${string}`;

/** Feed health of every market and symbol, with whether its data is catching up after a gap. */
export type MarketHealth = Record<string, { fresh: boolean; reason: string | null; catchingUp: boolean }>;

/** A perpetual's mark price, index price and funding, as last received; `fresh` false once the mark is stale. */
export interface PerpMark {
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  /** When the next funding is settled, ms. */
  nextFundingTime: number;
  fresh: boolean;
}

/**
 * An open isolated position at the last mark received: figures from a stale mark are flagged
 * (markFresh false) and with no mark at all they are null.
 */
export type WirePosition = Wire<Position> & {
  marginMode: 'isolated';
  /** The symbol's perp data is catching up after a gap: the figures may still change. */
  catchingUp: boolean;
  markPrice: string | null;
  markFresh: boolean;
  markAt: number | null;
  unrealizedPnl: string | null;
  marginBalance: string | null;
  maintenanceMargin: string | null;
  marginRatio: string | null;
  /** Null when the position can no longer be liquidated by a price move. */
  liquidationPrice: string | null;
  /** The most margin a removal may take now (the engine's figure at the fresh mark); null without a fresh mark. */
  maxRemovableMargin: string | null;
};

/** What adding or removing margin would do now, as the server judges it (POST /api/perp/margin/preview). */
export interface WireMarginPreview {
  marginAfter: string | null;
  /** Unrounded; null when refused, or when the position could no longer be liquidated by a price move. */
  liquidationPriceAfter: string | null;
  maxRemovable: string | null;
  rejectReason: string | null;
}

/** A liquidation's figures as data (exact decimal strings): the position, the mark, the margin lost and the fee in it. */
export interface LiquidationDetail {
  symbol: string;
  side: 'long' | 'short';
  qty: string;
  markPrice: string;
  marginLost: string;
  liquidationFee: string;
}

/** Account value plus the raw wallet balances and each held coin's cost basis. */
export type AccountSnapshot = Wire<AccountValue> & {
  balances: Record<Wallet, Record<string, Wire<Balance>>>;
  /** Per coin held: quantity and USDT cost (fees included). */
  basis: Record<string, { qty: string; cost: string }>;
};

export interface NoticeMessage {
  kind:
    | 'fill'
    | 'partial_fill'
    | 'rejected'
    | 'cancel_rejected'
    | 'triggered'
    | 'thin_book'
    | 'feed_gap'
    | 'feed_restored'
    | 'funding'
    | 'liquidation'
    | 'margin_warning'
    | 'catch_up';
  level: 'info' | 'warn' | 'error';
  text: string;
  /** On a liquidation notice: its figures as data. */
  liquidation?: LiquidationDetail;
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
  /** Per symbol: perp rules and tiers (null until loaded), the leverage setting and margin mode. */
  perp?: Record<string, PerpMeta>;
  /** Where the leverage tiers came from and when they were fetched; null before the first load. */
  tiers?: { source: TierSource; fetchedAt: number } | null;
  fees: { spot: Wire<FeeSchedule>; perp: Wire<FeeSchedule> };
  testData: boolean;
  season: { id: number; name: string; startedAt: number };
}

export interface PerpMeta {
  rules: WirePerpRules | null;
  maxLeverage: number | null;
  brackets: Wire<Bracket>[] | null;
  leverage: number;
  marginMode: 'isolated';
}

/** Messages the server sends on /ws. */
export type ServerMessage =
  | { type: 'tickers'; tickers: Record<string, Ticker>; perpTickers?: Record<string, Ticker> }
  | { type: 'health'; health: HealthMap; markets?: MarketHealth; catchingUp?: string[] }
  | { type: 'account'; account: AccountSnapshot }
  | { type: 'orders'; orders: WireOrder[]; perpOrders?: WirePerpOrder[] }
  | { type: 'marks'; marks: Record<string, PerpMark> }
  | { type: 'positions'; positions: WirePosition[] }
  | ({ type: 'notice' } & NoticeMessage)
  // Book, trades and klines carry their market (absent means spot).
  | { type: 'book'; market?: Market; symbol: string; bids: WireLevel[]; asks: WireLevel[] }
  | { type: 'trades'; market?: Market; symbol: string; trades: WireAggTrade[] }
  | { type: 'kline'; market?: Market; symbol: string; interval: Interval; candle: Candle }
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
  market?: 'spot' | 'leverage' | 'perp';
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

let unauthorized: (message: string) => void = () => {};

/** Called on every 401 (LAN password mode without a session). */
export function onUnauthorized(cb: (message: string) => void): void {
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
    const error = (json as { error?: unknown } | null)?.error;
    if (res.status === 401 && path !== '/api/login') unauthorized(typeof error === 'string' ? error : '');
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
  /** One market's fills (spot unless `market` says perp), newest first. */
  fills: (p: { symbol?: string; limit?: number; market?: Market } = {}) =>
    request<{ fills: WireFillRow[] }>('GET', `/api/fills${qs(p)}`).then((r) => r.fills),
  history: (p: HistoryQuery = {}) =>
    request<HistoryPage>('GET', `/api/history${qs({ ...p, types: p.types?.join(',') })}`),
  candles: (symbol: string, interval: Interval, endTime?: number, market: Market = 'spot') =>
    request<{ candles: Candle[] }>('GET', `/api/candles${qs({ symbol, interval, endTime, market })}`).then(
      (r) => r.candles,
    ),
  /** `amount` is sent exactly as typed; the server parses it ('1,5' is accepted). */
  deposit: (wallet: Wallet, amount: string) =>
    request<{ account: AccountSnapshot }>('POST', '/api/deposit', { wallet, amount }).then((r) => r.account),
  transfer: (from: Wallet, to: Wallet, amount: string) =>
    request<{ account: AccountSnapshot }>('POST', '/api/transfer', { from, to, amount }).then((r) => r.account),
  preview: (req: SpotOrderRequest) => request<WirePreview>('POST', '/api/orders/preview', req),
  placeOrder: (req: SpotOrderRequest) =>
    request<{ order: WireOrder }>('POST', '/api/orders', req).then((r) => r.order),
  /**
   * Requests the cancel: the order comes back still live with its cancelArrivesAt. It is cancelled
   * when the request arrives, unless it filled, triggered, was rejected or was cancelled first (a
   * notice says so).
   */
  cancelOrder: (id: string) =>
    request<{ order: WireOrder }>('DELETE', `/api/orders/${encodeURIComponent(id)}`).then((r) => r.order),
  attachOco: (p: { symbol: string; qty: string; stopLoss: string; takeProfit: string }) =>
    request<{ orders: WireOrder[] }>('POST', '/api/oco', p).then((r) => r.orders),
  /** As for spot, every amount and price is sent exactly as typed. */
  perpPreview: (req: PerpOrderRequest) => request<WirePerpPreview>('POST', '/api/perp/orders/preview', req),
  placePerpOrder: (req: PerpOrderRequest) =>
    request<{ order: WirePerpOrder }>('POST', '/api/perp/orders', req).then((r) => r.order),
  /** The symbol's settings after the change; a refusal (locked, out of range) is an ApiError with the reason. */
  setLeverage: (symbol: string, leverage: number) =>
    request<{ symbol: string; leverage: number; marginMode: 'isolated' }>('POST', '/api/perp/leverage', {
      symbol,
      leverage,
    }),
  /** Margin in or out of the symbol's position: the position after it; a refusal is an ApiError with the reason. */
  changeMargin: (symbol: string, action: 'add' | 'remove', amount: string) =>
    request<{ position: WirePosition | null }>('POST', '/api/perp/margin', { symbol, action, amount }).then((r) => r.position),
  /** Read-only: what the same change would do now; a refusal comes back as its rejectReason. */
  marginPreview: (req: { symbol: string; action: 'add' | 'remove'; amount: string }) =>
    request<WireMarginPreview>('POST', '/api/perp/margin/preview', req),
  /** Close-position stops on the position; refused legs come back rejected, with the reason. */
  setPositionTpSl: (symbol: string, legs: { stopLoss?: string; takeProfit?: string }) =>
    request<{ orders: WirePerpOrder[] }>('POST', '/api/perp/tpsl', { symbol, ...legs }).then((r) => r.orders),
  /** A reduce-only market order against the position: `qty` of it, or all of it without. */
  closePosition: (symbol: string, qty?: string) =>
    request<{ order: WirePerpOrder }>('POST', '/api/perp/close', qty === undefined ? { symbol } : { symbol, qty }).then(
      (r) => r.order,
    ),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
};
