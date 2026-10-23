// History screen logic (pure): filters <-> the URL query, filters -> the API query, and one
// display row per recorded event. Decimals stay strings.
import type { CancelReason, EngineEvent, OrderType, Wallet } from '@sim/engine';
import type { HistoryQuery, HistoryRow, Wire, WireFill, WireOrder } from './api.ts';
import { ORDER_TYPE_LABEL, driftSign, fmtAvgPrice, fmtCost, fmtDrift, fmtPrice, fmtQty, fmtUsd, signOf } from './format.ts';
import { fmtDateTime } from './market.ts';

export const PAGE_SIZE = 50;

export const HISTORY_COINS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];
const SYMBOLS = HISTORY_COINS.map((c) => `${c}USDT`);

/** Every event type the history records, in the order the type filter lists them. */
export const EVENT_TYPES = [
  { type: 'deposit', label: 'Deposits' },
  { type: 'transfer', label: 'Transfers' },
  { type: 'order_placed', label: 'Orders placed' },
  { type: 'order_cancelled', label: 'Orders cancelled' },
  { type: 'cancel_rejected', label: 'Cancels failed' },
  { type: 'order_rejected', label: 'Orders rejected' },
  { type: 'order_triggered', label: 'Stops triggered' },
  { type: 'fill', label: 'Fills' },
  { type: 'round_trip_closed', label: 'Round trips' },
  { type: 'feed_gap', label: 'Feed gaps' },
] as const;
export type EventType = (typeof EVENT_TYPES)[number]['type'];
const TYPE_ORDER: string[] = EVENT_TYPES.map((t) => t.type);

export interface HistoryFilters {
  /** 'BTCUSDT', or null for every coin. */
  symbol: string | null;
  market: Wallet | null;
  /** Empty means every type. Always in EVENT_TYPES order, without repeats. */
  types: EventType[];
  /** Local dates 'YYYY-MM-DD', both days included. */
  from: string | null;
  to: string | null;
}

export const EMPTY_FILTERS: HistoryFilters = { symbol: null, market: null, types: [], from: null, to: null };

export function hasFilters(f: HistoryFilters): boolean {
  return f.symbol !== null || f.market !== null || f.types.length > 0 || f.from !== null || f.to !== null;
}

/** Event types in the filter's fixed order, unknown names and repeats dropped. */
export function sortTypes(types: readonly string[]): EventType[] {
  return TYPE_ORDER.filter((t) => types.includes(t)) as EventType[];
}

// ---- local dates ----

/** The local date 'YYYY-MM-DD' as [year, month 0-11, day], or null if it is not a real date. */
function ymd(date: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(y, mo, d);
  return check.getFullYear() === y && check.getMonth() === mo && check.getDate() === d ? [y, mo, d] : null;
}

/** Local midnight at the start of the day, in ms; null for a bad date. */
export function localDayStart(date: string): number | null {
  const p = ymd(date);
  return p ? new Date(p[0], p[1], p[2]).getTime() : null;
}

/** The last millisecond of the local day (a 23- or 25-hour day included), in ms; null for a bad date. */
export function localDayEnd(date: string): number | null {
  const p = ymd(date);
  return p ? new Date(p[0], p[1], p[2] + 1).getTime() - 1 : null;
}

const validDate = (v: string | null): string | null => (v !== null && ymd(v) ? v : null);

// ---- URL query <-> filters ----

/** Filters from the hash query ('#/history?symbol=BTCUSDT&types=fill'); unknown values are dropped. */
export function parseFilters(params: URLSearchParams): HistoryFilters {
  const symbol = params.get('symbol');
  const market = params.get('market');
  return {
    symbol: symbol !== null && SYMBOLS.includes(symbol) ? symbol : null,
    market: market === 'spot' || market === 'leverage' ? market : null,
    types: sortTypes((params.get('types') ?? '').split(',')),
    from: validDate(params.get('from')),
    to: validDate(params.get('to')),
  };
}

/** The hash query of a filter set; empty filters are left out. */
export function filterParams(f: HistoryFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.symbol !== null) p.symbol = f.symbol;
  if (f.market !== null) p.market = f.market;
  if (f.types.length > 0) p.types = sortTypes(f.types).join(',');
  if (f.from !== null) p.from = f.from;
  if (f.to !== null) p.to = f.to;
  return p;
}

/** GET /api/history parameters: whole local days, both ends included; `before` pages back. */
export function historyQuery(f: HistoryFilters, before?: number): HistoryQuery {
  const q: HistoryQuery = {};
  if (f.symbol !== null) q.symbol = f.symbol;
  if (f.market !== null) q.market = f.market;
  if (f.types.length > 0) q.types = [...f.types];
  const from = f.from === null ? null : localDayStart(f.from);
  const to = f.to === null ? null : localDayEnd(f.to);
  if (from !== null) q.from = from;
  if (to !== null) q.to = to;
  q.limit = PAGE_SIZE;
  if (before !== undefined) q.before = before;
  return q;
}

// ---- durations ----

/** A duration by its two largest units: '42s', '2m 05s', '2h 05m', '3d 4h'. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---- one display row per event ----

export type Tone = 'up' | 'down' | 'muted';

export interface Field {
  label: string;
  value: string;
  tone?: Tone;
}

export interface EventView {
  /** The type badge: 'Fill', 'Order rejected', 'Triggered stop expired', ... */
  label: string;
  tone: 'plain' | 'muted' | 'down' | 'accent';
  /** 'BTC', or null for account events (deposits, transfers). */
  coin: string | null;
  fields: Field[];
  /** Long text shown in full on its own line (a rejection or gap reason, verbatim). */
  note: { label: string; text: string } | null;
}

type Payload<K extends EngineEvent['type']> = Wire<Extract<EngineEvent, { type: K }>>;
interface FeedGapPayload {
  startedAt: number;
  endedAt: number;
  reason: string;
}

export const CANCEL_WORDS: Record<CancelReason, string> = {
  user: 'by you',
  thin_book: 'book too thin',
  oco: 'other leg of the pair triggered',
  parent_cancelled: 'parent cancelled',
};

const WALLET: Record<Wallet, string> = { spot: 'Spot', leverage: 'Leverage' };

const baseOf = (symbol: string) => symbol.replace(/USDT$/, '');
const typeLabel = (t: OrderType) => ORDER_TYPE_LABEL[t] ?? t;
const signTone = (v: string | null): Tone => {
  const s = signOf(v, 2);
  return s > 0 ? 'up' : s < 0 ? 'down' : 'muted';
};

function sideField(side: 'buy' | 'sell'): Field {
  return side === 'buy' ? { label: 'Side', value: 'Buy', tone: 'up' } : { label: 'Side', value: 'Sell', tone: 'down' };
}

/** What the owner entered is shown as sent, never rounded onto the tick or step (see fmtPrice). */
const EXACT = { exact: true };

/** Side, type, price or trigger, amount (and an attached pair): what every order event shows. */
function orderFields(o: WireOrder): Field[] {
  const pair = o.ocoGroupId !== null ? ' (linked pair)' : '';
  const price: Field =
    o.type === 'market'
      ? { label: 'Price', value: 'Market' }
      : o.type === 'limit' || o.type === 'post_only'
        ? { label: 'Price', value: fmtPrice(o.symbol, o.price, EXACT) }
        : { label: 'Trigger', value: fmtPrice(o.symbol, o.triggerPrice, EXACT) };
  const amount =
    o.qty !== null
      ? `${fmtQty(o.symbol, o.qty, EXACT)} ${baseOf(o.symbol)}`
      : o.quoteQty !== null
        ? fmtUsd(o.quoteQty, EXACT)
        : '-';
  const fields: Field[] = [
    sideField(o.side),
    { label: 'Type', value: typeLabel(o.type) + pair },
    price,
    { label: 'Amount', value: amount },
  ];
  if (o.attach) {
    fields.push({
      label: 'Attached',
      value: `SL ${fmtPrice(o.symbol, o.attach.stopLoss, EXACT)} / TP ${fmtPrice(o.symbol, o.attach.takeProfit, EXACT)}`,
    });
  }
  return fields;
}

function fillFields(f: WireFill, o: WireOrder): Field[] {
  const fee = f.feeAsset === 'USDT' ? `${f.fee} USDT` : `${f.fee} ${f.feeAsset} ~${fmtCost(f.feeUsd)}`;
  const drift = driftSign(f.driftUsd);
  const fields: Field[] = [
    sideField(f.side),
    { label: 'Type', value: typeLabel(o.type) },
    { label: 'Qty', value: `${fmtQty(f.symbol, f.qty)} ${baseOf(f.symbol)}` },
    { label: 'Price', value: fmtAvgPrice(f.symbol, f.price) },
    { label: 'Best at the time', value: fmtPrice(f.symbol, f.bestAtArrival) },
    // An unsigned cost (always >= 0), as in the preview and the fill notices.
    { label: 'Slippage', value: fmtCost(f.slippageUsd), tone: signOf(f.slippageUsd) === 0 ? 'muted' : undefined },
    // The engine stores a drift that costs the owner as positive.
    { label: 'Delay drift', value: fmtDrift(f.driftUsd), tone: drift > 0 ? 'down' : drift < 0 ? 'up' : 'muted' },
    { label: 'Role', value: f.liquidity === 'maker' ? 'Maker' : 'Taker' },
    { label: 'Fee', value: fee },
  ];
  if (f.realizedPnl !== null) {
    fields.push({ label: 'Realised P&L', value: fmtUsd(f.realizedPnl, { sign: true }), tone: signTone(f.realizedPnl) });
  }
  if (f.triggerPrice !== null) fields.push({ label: 'Trigger', value: fmtPrice(f.symbol, f.triggerPrice, EXACT) });
  return fields;
}

/** At most 200 characters of a payload's raw JSON, for rows that cannot be described. */
function rawJson(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload) ?? String(payload);
  } catch {
    text = String(payload);
  }
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/**
 * The badge, coin, labelled details and note shown for one history row. A row that cannot be
 * read (a malformed or unexpected payload) becomes 'Unreadable event (<type>)' with its raw data,
 * so one bad record never blanks the screen.
 */
export function describeEvent(row: HistoryRow): EventView {
  try {
    return describeKnown(row);
  } catch {
    return {
      label: `Unreadable event (${row.type})`,
      tone: 'down',
      coin: row.symbol === null ? null : baseOf(row.symbol),
      fields: [],
      note: { label: 'Data', text: rawJson(row.payload) },
    };
  }
}

function describeKnown(row: HistoryRow): EventView {
  const coin = row.symbol === null ? null : baseOf(row.symbol);
  const view = (label: string, tone: EventView['tone'], fields: Field[], note: EventView['note'] = null): EventView => ({
    label,
    tone,
    coin,
    fields,
    note,
  });
  switch (row.type) {
    case 'deposit': {
      const p = row.payload as Payload<'deposit'>;
      return view('Deposit', 'plain', [
        { label: 'Amount', value: fmtUsd(p.amount) },
        { label: 'Wallet', value: WALLET[p.wallet] ?? p.wallet },
        { label: 'Total deposited', value: fmtUsd(p.totalDeposited) },
      ]);
    }
    case 'transfer': {
      const p = row.payload as Payload<'transfer'>;
      return view('Transfer', 'plain', [
        { label: 'Amount', value: fmtUsd(p.amount) },
        { label: 'From', value: WALLET[p.from] ?? p.from },
        { label: 'To', value: WALLET[p.to] ?? p.to },
      ]);
    }
    case 'order_placed': {
      const p = row.payload as Payload<'order_placed'>;
      return view('Order placed', 'plain', orderFields(p.order));
    }
    case 'order_cancelled': {
      const p = row.payload as Payload<'order_cancelled'>;
      return view('Order cancelled', 'muted', [
        ...orderFields(p.order),
        { label: 'Cancelled', value: CANCEL_WORDS[p.reason] ?? p.reason },
        { label: 'Cancelled qty', value: `${fmtQty(p.order.symbol, p.cancelledQty)} ${baseOf(p.order.symbol)}` },
      ]);
    }
    case 'cancel_rejected': {
      // The owner's cancel arrived after the order had filled, triggered, been rejected or been cancelled.
      const p = row.payload as Payload<'cancel_rejected'>;
      return view('Cancel failed', 'down', orderFields(p.order), { label: 'Reason', text: p.reason });
    }
    case 'order_rejected': {
      const p = row.payload as Payload<'order_rejected'>;
      // A triggered stop or take-profit that could not execute (the engine's own wording).
      const expired = p.order.type === 'take_profit' ? 'Triggered take-profit expired' : 'Triggered stop expired';
      return view(p.afterTrigger ? expired : 'Order rejected', 'down', orderFields(p.order), { label: 'Reason', text: p.reason });
    }
    case 'order_triggered': {
      const p = row.payload as Payload<'order_triggered'>;
      return view(p.order.type === 'take_profit' ? 'Take-profit triggered' : 'Stop triggered', 'accent', [
        ...orderFields(p.order),
        { label: 'Last trade', value: fmtPrice(p.order.symbol, p.lastPrice) },
      ]);
    }
    case 'fill': {
      const p = row.payload as Payload<'fill'>;
      return view(p.order.status === 'partially_filled' ? 'Partial fill' : 'Fill', 'plain', fillFields(p.fill, p.order));
    }
    case 'round_trip_closed': {
      const t = (row.payload as Payload<'round_trip_closed'>).roundTrip;
      return view('Round trip closed', 'plain', [
        { label: 'Opened', value: fmtDateTime(t.openedAt) },
        { label: 'Closed', value: fmtDateTime(t.closedAt) },
        { label: 'Hold time', value: fmtDuration(t.closedAt - t.openedAt) },
        { label: 'P&L', value: fmtUsd(t.pnl, { sign: true }), tone: signTone(t.pnl) },
      ]);
    }
    case 'feed_gap': {
      const g = row.payload as FeedGapPayload;
      return view(
        'Feed gap',
        'accent',
        [
          { label: 'Start', value: fmtDateTime(g.startedAt) },
          { label: 'End', value: fmtDateTime(g.endedAt) },
          { label: 'Duration', value: fmtDuration(g.endedAt - g.startedAt) },
        ],
        { label: 'Reason', text: g.reason },
      );
    }
    default:
      return view(row.type, 'muted', [], { label: 'Data', text: rawJson(row.payload) });
  }
}
