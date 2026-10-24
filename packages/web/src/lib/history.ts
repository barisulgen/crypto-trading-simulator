// History screen logic (pure): filters <-> the URL query, filters -> the API query, and one
// display row per recorded event. Decimals stay strings.
import type {
  CancelReason,
  CatchUpBasis,
  CatchUpEvent,
  EngineEvent,
  OrderType,
  PerpEvent,
  PositionCloseReason,
  Wallet,
} from '@sim/engine';
import type { HistoryQuery, HistoryRow, Wire, WireFill, WireOrder, WirePerpOrder } from './api.ts';
import {
  ORDER_TYPE_LABEL,
  driftSign,
  fmtAvgPrice,
  fmtCost,
  fmtDrift,
  fmtPrice,
  fmtQty,
  fmtUsd,
  perpTickSize,
  signOf,
} from './format.ts';
import { addDec, cmpDec, fmtDateTime, fmtFundingPct, liqPriceAtTick, subDec } from './market.ts';
import { fmtPnl } from './positions.ts';

export const PAGE_SIZE = 50;

export const HISTORY_COINS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];
const SYMBOLS = HISTORY_COINS.map((c) => `${c}USDT`);

/** Every event type the history records, in the order the type filter lists them. */
export const EVENT_TYPES = [
  { type: 'deposit', label: 'Deposits' },
  { type: 'transfer', label: 'Transfers' },
  { type: 'leverage_set', label: 'Leverage changes' },
  { type: 'margin_changed', label: 'Margin changes' },
  { type: 'order_placed', label: 'Orders placed' },
  { type: 'order_cancelled', label: 'Orders cancelled' },
  { type: 'cancel_rejected', label: 'Cancels failed' },
  { type: 'order_rejected', label: 'Orders rejected' },
  { type: 'order_triggered', label: 'Stops triggered' },
  { type: 'fill', label: 'Fills' },
  { type: 'position_opened', label: 'Positions opened' },
  { type: 'position_closed', label: 'Positions closed' },
  { type: 'round_trip_closed', label: 'Round trips' },
  { type: 'funding', label: 'Funding' },
  { type: 'liquidation', label: 'Liquidations' },
  { type: 'feed_gap', label: 'Feed gaps' },
  { type: 'catch_up', label: 'Catch-ups' },
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

/**
 * The market filter: spot, or the leverage side as a whole (the perpetuals and the leverage
 * wallet). Transfers move money between the two, so both show them.
 */
export const MARKET_FILTERS: { value: Wallet; label: string; title: string }[] = [
  { value: 'spot', label: 'Spot', title: 'Spot orders and fills, spot-wallet deposits, and transfers' },
  {
    value: 'leverage',
    label: 'Leverage',
    title: 'Perpetual orders, fills, positions, funding and liquidations, leverage-wallet deposits, and transfers',
  },
];

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
    // A perp link (hand-written, say) means the leverage side, where the perpetuals are.
    market: market === 'spot' || market === 'leverage' ? market : market === 'perp' ? 'leverage' : null,
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
  /** The coin's market: 'Spot' or 'Perp'; null for account events. */
  market: 'Spot' | 'Perp' | null;
  fields: Field[];
  /** Long text shown in full on its own line (a rejection or gap reason, verbatim). */
  note: { label: string; text: string } | null;
  /** Lines shown in full, one per item (what a catch-up applied, in its own words). */
  list: { label: string; items: string[] } | null;
  /**
   * Set on an event a catch-up run produced after a data gap: it was estimated, not seen live.
   * `why` says from what, in one sentence; `gap` is the gap it covered.
   */
  estimated: { why: string; gap: string } | null;
}

type Payload<K extends EngineEvent['type']> = Wire<Extract<EngineEvent, { type: K }>>;
type PerpPayload<K extends PerpEvent['type']> = Wire<Extract<PerpEvent, { type: K }>>;
type PerpPosition = PerpPayload<'position_opened'>['position'];
type PerpFillWire = PerpPayload<'fill'>['fill'];
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
  price_band: 'outside the market price band',
  reduce_only: 'more than the position (reduce-only)',
  position_closed: 'position closed',
  liquidation: 'liquidation',
  catch_up_unavailable: 'trade history unavailable',
};

/** What a catch-up event was estimated from, one plain sentence per basis (the badge's tooltip). */
export const BASIS_WHY: Record<CatchUpBasis, string> = {
  candle_worst_price:
    'Estimated from 1-minute price candles: the order is taken at the worst price of the minute in which the price reached it.',
  trigger_minute_worst_price:
    'Estimated from 1-minute price candles: the stop had already triggered, so it is filled at the worst price of its trigger minute.',
  mark_candle: 'Estimated from 1-minute mark-price candles: the mark reached the liquidation price within that minute.',
  funding_history: 'Settled at the funding rate and mark price Binance published for a funding time inside the gap.',
  aggtrade_replay: "Replayed from Binance's recorded trades of the gap, filling only where real trades went through the price.",
  history_unavailable:
    "Binance no longer had the gap's trades, so the resting order was cancelled at the start of the gap rather than guessed.",
  cancel_arrival: 'Your cancel reached the exchange during the gap and took effect at its own arrival time.',
};

const CLOSE_REASON: Record<PositionCloseReason, string> = {
  closed: 'Closed by an order',
  stop_loss: 'Stop-loss',
  take_profit: 'Take-profit',
  liquidated: 'Liquidated',
};

const WALLET: Record<Wallet, string> = { spot: 'Spot', leverage: 'Leverage' };

const baseOf = (symbol: string) => symbol.replace(/USDT$/, '');
const typeLabel = (t: OrderType) => ORDER_TYPE_LABEL[t] ?? t;
const signTone = (v: string | null): Tone => {
  const s = signOf(v, 2);
  return s > 0 ? 'up' : s < 0 ? 'down' : 'muted';
};
/** A signed amount's tone as fmtPnl shows it (rounded against the owner). */
const pnlTone = (v: string): Tone => {
  const shown = fmtPnl(v);
  return shown.startsWith('+') ? 'up' : shown.startsWith('-') ? 'down' : 'muted';
};

function sideField(side: 'buy' | 'sell'): Field {
  return side === 'buy' ? { label: 'Side', value: 'Buy', tone: 'up' } : { label: 'Side', value: 'Sell', tone: 'down' };
}

const SIDE_WORD = { long: 'Long', short: 'Short' } as const;

function positionSideField(side: 'long' | 'short'): Field {
  return { label: 'Side', value: SIDE_WORD[side], tone: side === 'long' ? 'up' : 'down' };
}

/** What the owner entered is shown as sent, never rounded onto the tick or step (see fmtPrice). */
const EXACT = { exact: true };
const PERP = { market: 'perp' } as const;
const PERP_EXACT = { market: 'perp', exact: true } as const;

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

/**
 * A perp order's side, type (reduce-only, or closing the whole position), price or trigger at the
 * perpetual's decimals, amount, leverage and the stops attached to it.
 */
function perpOrderFields(o: WirePerpOrder): Field[] {
  const flags = [o.ocoGroupId !== null ? 'linked pair' : null, o.closePosition ? 'closes the position' : o.reduceOnly ? 'reduce-only' : null];
  const type = [typeLabel(o.type), ...flags.filter((f) => f !== null)].join(', ');
  const price: Field =
    o.type === 'market'
      ? { label: 'Price', value: 'Market' }
      : o.type === 'limit' || o.type === 'post_only'
        ? { label: 'Price', value: fmtPrice(o.symbol, o.price, PERP_EXACT) }
        : { label: 'Trigger', value: fmtPrice(o.symbol, o.triggerPrice, PERP_EXACT) };
  const amount =
    o.qty !== null
      ? `${fmtQty(o.symbol, o.qty, PERP_EXACT)} ${baseOf(o.symbol)}`
      : o.quoteQty !== null
        ? fmtUsd(o.quoteQty, EXACT)
        : o.closePosition
          ? 'Whole position'
          : '-';
  const fields: Field[] = [
    sideField(o.side),
    { label: 'Type', value: type },
    price,
    { label: 'Amount', value: amount },
    { label: 'Leverage', value: `${o.leverage}x` },
  ];
  const legs = [
    o.attach?.stopLoss != null ? `SL ${fmtPrice(o.symbol, o.attach.stopLoss, PERP_EXACT)}` : null,
    o.attach?.takeProfit != null ? `TP ${fmtPrice(o.symbol, o.attach.takeProfit, PERP_EXACT)}` : null,
  ].filter((l) => l !== null);
  if (legs.length > 0) fields.push({ label: 'Attached', value: legs.join(' / ') });
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

/**
 * A perp fill: as a spot fill at the perpetual's decimals, the fee in USDT, plus the margin an
 * opening fill moved in, or the trading P&L (before fees) a reducing fill realised and any loss
 * nothing could cover. P&L is rounded against the owner, a loss up and a gain down.
 */
function perpFillFields(f: PerpFillWire, o: WirePerpOrder): Field[] {
  const drift = driftSign(f.driftUsd);
  const fields: Field[] = [
    sideField(f.side),
    { label: 'Type', value: typeLabel(o.type) },
    { label: 'Qty', value: `${fmtQty(f.symbol, f.qty, PERP)} ${baseOf(f.symbol)}` },
    { label: 'Price', value: fmtAvgPrice(f.symbol, f.price, PERP) },
    { label: 'Best at the time', value: fmtPrice(f.symbol, f.bestAtArrival, PERP) },
    { label: 'Slippage', value: fmtCost(f.slippageUsd), tone: signOf(f.slippageUsd) === 0 ? 'muted' : undefined },
    { label: 'Delay drift', value: fmtDrift(f.driftUsd), tone: drift > 0 ? 'down' : drift < 0 ? 'up' : 'muted' },
    { label: 'Role', value: f.liquidity === 'maker' ? 'Maker' : 'Taker' },
    { label: 'Fee', value: `${f.fee} ${f.feeAsset}` },
  ];
  if (f.marginIn !== null) fields.push({ label: 'Margin in', value: fmtUsd(f.marginIn) });
  if (f.realizedPnl !== null) fields.push({ label: 'Trading P&L', value: fmtPnl(f.realizedPnl), tone: pnlTone(f.realizedPnl) });
  if (f.uncovered !== null) fields.push({ label: 'Uncovered loss', value: fmtCost(f.uncovered), tone: 'down' });
  if (f.triggerPrice !== null) fields.push({ label: 'Trigger', value: fmtPrice(f.symbol, f.triggerPrice, PERP_EXACT) });
  return fields;
}

/**
 * The note on a close estimated from history that was held to the position's margin: the price
 * capped at the bankruptcy price (with the price it would have had without the cap), or, at an
 * unchanged price, the fee cut to what the margin had left. Null for any other close.
 */
function cappedNote(
  verb: 'filled' | 'closed',
  symbol: string,
  price: string,
  c: { bankruptcyCapped?: true; uncappedPrice?: string },
): EventView['note'] {
  if (!c.bankruptcyCapped) return null;
  if (c.uncappedPrice === undefined || cmpDec(c.uncappedPrice, price) === 0) {
    return { label: 'Capped', text: 'Held to the position margin: the fee was cut to what the margin had left' };
  }
  const at = (p: string) => fmtAvgPrice(symbol, p, PERP);
  return {
    label: 'Capped',
    text: `Held to the position margin: ${verb} at the bankruptcy price, ${at(price)}, instead of ${at(c.uncappedPrice)}, the price without the cap`,
  };
}

/** 'Long 0.100 BTC': a position's side and size. */
const positionText = (p: { symbol: string; side: 'long' | 'short'; qty: string }) =>
  `${SIDE_WORD[p.side]} ${fmtQty(p.symbol, p.qty, PERP)} ${baseOf(p.symbol)}`;

const entryField = (p: PerpPosition): Field => ({ label: 'Entry price', value: fmtAvgPrice(p.symbol, p.entryPrice, PERP) });

/** The estimated badge of an event a catch-up run produced; null for one seen live. */
function estimatedOf(payload: unknown): EventView['estimated'] {
  const tag = (payload as { catchUp?: { from: number; to: number; basis: string } }).catchUp;
  if (!tag) return null;
  return {
    why: BASIS_WHY[tag.basis as CatchUpBasis] ?? 'Estimated by the catch-up after a data gap.',
    gap: `Data gap ${fmtDateTime(tag.from)} to ${fmtDateTime(tag.to)}`,
  };
}

/** The market of a coin's event: perp when the row or its payload says so, spot otherwise. */
function marketOf(row: HistoryRow): EventView['market'] {
  if (row.symbol === null) return null;
  const perp = row.market === 'perp' || (row.payload as { market?: unknown } | null)?.market === 'perp';
  return perp ? 'Perp' : 'Spot';
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
 * The badge, coin, market, labelled details and note shown for one history row, with the
 * estimated badge on an event a catch-up produced. A row that cannot be read (a malformed or
 * unexpected payload) becomes 'Unreadable event (<type>)' with its raw data, so one bad record
 * never blanks the screen.
 */
export function describeEvent(row: HistoryRow): EventView {
  try {
    return describeKnown(row);
  } catch {
    return {
      label: `Unreadable event (${row.type})`,
      tone: 'down',
      coin: row.symbol === null ? null : baseOf(row.symbol),
      market: null,
      fields: [],
      note: { label: 'Data', text: rawJson(row.payload) },
      list: null,
      estimated: null,
    };
  }
}

function describeKnown(row: HistoryRow): EventView {
  const coin = row.symbol === null ? null : baseOf(row.symbol);
  const market = marketOf(row);
  const perp = market === 'Perp';
  const estimated = row.payload !== null && typeof row.payload === 'object' ? estimatedOf(row.payload) : null;
  const view = (
    label: string,
    tone: EventView['tone'],
    fields: Field[],
    note: EventView['note'] = null,
    list: EventView['list'] = null,
  ): EventView => ({ label, tone, coin, market, fields, note, list, estimated });
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
      if (perp) return view('Order placed', 'plain', perpOrderFields((row.payload as PerpPayload<'order_placed'>).order));
      const p = row.payload as Payload<'order_placed'>;
      return view('Order placed', 'plain', orderFields(p.order));
    }
    case 'order_cancelled': {
      const p = row.payload as Payload<'order_cancelled'> | PerpPayload<'order_cancelled'>;
      const o = p.order;
      const fields: Field[] = [
        ...(perp ? perpOrderFields(o as WirePerpOrder) : orderFields(o as WireOrder)),
        { label: 'Cancelled', value: CANCEL_WORDS[p.reason] ?? p.reason },
      ];
      // A close-position order has no quantity of its own: its amount already reads 'Whole position'.
      if (!(perp && (o as WirePerpOrder).closePosition)) {
        fields.push({ label: 'Cancelled qty', value: `${fmtQty(o.symbol, p.cancelledQty, perp ? PERP : {})} ${baseOf(o.symbol)}` });
      }
      return view('Order cancelled', 'muted', fields);
    }
    case 'cancel_rejected': {
      // The owner's cancel arrived after the order had filled, triggered, been rejected or been cancelled.
      const p = row.payload as Payload<'cancel_rejected'> | PerpPayload<'cancel_rejected'>;
      const fields = perp ? perpOrderFields(p.order as WirePerpOrder) : orderFields(p.order as WireOrder);
      return view('Cancel failed', 'down', fields, { label: 'Reason', text: p.reason });
    }
    case 'order_rejected': {
      const p = row.payload as Payload<'order_rejected'> | PerpPayload<'order_rejected'>;
      const fields = perp ? perpOrderFields(p.order as WirePerpOrder) : orderFields(p.order as WireOrder);
      // A triggered stop or take-profit that could not execute (the engine's own wording).
      const expired = p.order.type === 'take_profit' ? 'Triggered take-profit expired' : 'Triggered stop expired';
      return view(p.afterTrigger ? expired : 'Order rejected', 'down', fields, { label: 'Reason', text: p.reason });
    }
    case 'order_triggered': {
      const p = row.payload as Payload<'order_triggered'> | PerpPayload<'order_triggered'>;
      const fields = perp ? perpOrderFields(p.order as WirePerpOrder) : orderFields(p.order as WireOrder);
      return view(p.order.type === 'take_profit' ? 'Take-profit triggered' : 'Stop triggered', 'accent', [
        ...fields,
        { label: 'Last trade', value: fmtPrice(p.order.symbol, p.lastPrice, perp ? PERP : {}) },
      ]);
    }
    case 'fill': {
      if (perp) {
        const p = row.payload as PerpPayload<'fill'>;
        const label = p.order.status === 'partially_filled' ? 'Partial fill' : 'Fill';
        return view(label, 'plain', perpFillFields(p.fill, p.order), cappedNote('filled', p.fill.symbol, p.fill.price, p.fill));
      }
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
    case 'leverage_set': {
      const p = row.payload as PerpPayload<'leverage_set'>;
      return view('Leverage set', 'plain', [{ label: 'Leverage', value: `${p.leverage}x` }]);
    }
    case 'margin_changed': {
      const p = row.payload as PerpPayload<'margin_changed'>;
      // At the tick, rounded towards the mark as every liquidation price is; unrounded when the
      // side or the tick is not known, never rounded the wrong way.
      const after = p.liquidationPriceAfter;
      const atTick = after !== null && p.side ? liqPriceAtTick(after, p.side, perpTickSize(p.symbol)) : null;
      const liq = after === null ? 'None' : fmtPrice(p.symbol, atTick ?? after, PERP_EXACT);
      return view(p.action === 'add' ? 'Margin added' : 'Margin removed', 'plain', [
        { label: 'Amount', value: fmtUsd(p.amount, EXACT) },
        { label: 'Margin after', value: fmtUsd(p.marginAfter) },
        { label: 'Liquidation price after', value: liq },
      ]);
    }
    case 'position_opened': {
      const p = (row.payload as PerpPayload<'position_opened'>).position;
      return view('Position opened', 'plain', [
        positionSideField(p.side),
        { label: 'Size', value: `${fmtQty(p.symbol, p.qty, PERP)} ${baseOf(p.symbol)}` },
        { label: 'Leverage', value: `${p.leverage}x` },
        { label: 'Margin mode', value: 'Isolated' },
        entryField(p),
        { label: 'Margin', value: fmtUsd(p.margin) },
      ]);
    }
    case 'position_closed': {
      const p = row.payload as PerpPayload<'position_closed'>;
      const pos = p.position;
      // What the position made or lost in all: trading P&L, less every fee, plus net funding.
      const net = addDec(subDec(p.realizedPnl, p.fees), p.funding);
      return view(
        'Position closed',
        p.reason === 'liquidated' ? 'down' : 'plain',
        [
          positionSideField(pos.side),
          { label: 'Leverage', value: `${pos.leverage}x` },
          { label: 'Margin mode', value: 'Isolated' },
          entryField(pos),
          { label: 'Exit price', value: fmtAvgPrice(pos.symbol, p.exitPrice, PERP) },
          { label: 'Trading P&L', value: fmtPnl(p.realizedPnl), tone: pnlTone(p.realizedPnl) },
          { label: 'Fees', value: fmtCost(p.fees) },
          { label: 'Funding', value: fmtPnl(p.funding), tone: pnlTone(p.funding) },
          { label: 'Net P&L', value: fmtPnl(net), tone: pnlTone(net) },
          { label: 'Hold time', value: fmtDuration(p.holdMs) },
          { label: 'Reason', value: CLOSE_REASON[p.reason] ?? p.reason },
        ],
        cappedNote('closed', pos.symbol, p.exitPrice, p),
      );
    }
    case 'funding': {
      const p = row.payload as PerpPayload<'funding'>;
      const paid = cmpDec(p.amount, '0') < 0;
      const fields: Field[] = [
        { label: 'Position', value: positionText(p) },
        { label: 'Rate', value: fmtFundingPct(p.rate) },
        { label: 'Mark price', value: fmtPrice(p.symbol, p.markPrice, PERP) },
        { label: 'Funding time', value: fmtDateTime(p.fundingTime) },
        // A payment rounded up, a receipt down, as the funding notice rounds them.
        { label: 'Amount', value: fmtPnl(p.amount), tone: pnlTone(p.amount) },
        paid
          ? { label: 'Taken from', value: p.target === 'margin' ? 'Position margin' : 'Leverage wallet' }
          : { label: 'Paid into', value: 'Leverage wallet' },
      ];
      if (p.uncollected !== null) fields.push({ label: 'Not collected', value: fmtCost(p.uncollected), tone: 'down' });
      return view(paid ? 'Funding paid' : 'Funding received', 'plain', fields);
    }
    case 'liquidation': {
      // Money lost is rounded up and the mark shown at the tick, as the liquidation alert shows them.
      const p = row.payload as PerpPayload<'liquidation'>;
      const fields: Field[] = [
        { label: 'Position', value: positionText(p.position) },
        { label: 'Leverage', value: `${p.position.leverage}x` },
        entryField(p.position),
        { label: 'Mark price', value: fmtPrice(p.symbol, p.markPrice, PERP) },
        { label: 'Margin lost', value: fmtCost(p.marginLost), tone: 'down' },
        { label: 'Trading loss', value: fmtCost(p.tradingLoss) },
        { label: 'Liquidation fee', value: fmtCost(p.liquidationFee) },
        { label: 'Remainder', value: fmtCost(p.remainder) },
      ];
      if (p.cancelledOrderIds.length > 0) fields.push({ label: 'Orders cancelled', value: String(p.cancelledOrderIds.length) });
      const note = p.feeRateKnown
        ? null
        : {
            label: 'Fee',
            text: 'The liquidation fee rate was not loaded: everything the trading loss left of the margin is shown as the fee',
          };
      return view('Liquidation', 'down', fields, note);
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
    case 'catch_up': {
      // The summary of a catch-up run: the gap, and each action it applied in its own words.
      const c = row.payload as Wire<CatchUpEvent>;
      const fields: Field[] = [
        { label: 'Gap start', value: fmtDateTime(c.from) },
        { label: 'Gap end', value: fmtDateTime(c.to) },
        { label: 'Gap length', value: fmtDuration(c.to - c.from) },
      ];
      if (c.actions.length === 0) return view('Caught up', 'accent', fields, { label: 'Applied', text: 'Nothing to apply' });
      return view('Caught up', 'accent', fields, null, { label: 'Applied', items: [...c.actions] });
    }
    default:
      return view(row.type, 'muted', [], { label: 'Data', text: rawJson(row.payload) });
  }
}
