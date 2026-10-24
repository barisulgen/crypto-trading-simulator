// The perp order form's pure parts: what it sends, which field is still blank, when reduce-only is
// forced, why leverage is locked, the largest position a leverage allows, and the tiers note.
import type { PerpOrderRequest, PositionSide, Side, TierSource } from '@sim/engine';
import type { PerpMark, WirePerpOrder, WirePosition } from './api.ts';
import { fmtNum, tickDecimals } from './format.ts';
import { cmpDec, floorDivToStep, subDec } from './market.ts';
import { CATCHING_UP_REASON, hasPrice } from './orderForm.ts';
import { validPrice } from './quickAmount.ts';
import type { QuickState } from './quickAmount.ts';

export type PerpOrderType = PerpOrderRequest['type'];

export interface PerpFormFields {
  symbol: string;
  side: Side;
  type: PerpOrderType;
  /** The amount is a coin quantity ('coin', sent as qty) or a USDT notional ('usd', sent as quoteQty). */
  amountIn: 'coin' | 'usd';
  amount: string;
  /** Limit price (limit, post-only). */
  price: string;
  /** Reduce-only as it applies (forced on against an open position, see reduceOnlyState). */
  reduceOnly: boolean;
  /** Attach a stop-loss and/or take-profit (opening orders only). */
  attach: boolean;
  stopLoss: string;
  takeProfit: string;
  /**
   * Set by the 100 % button of a reduce-only order in dollars: the coins to send as qty in place
   * of the dollars, so the order reduces the whole position whatever the price does meanwhile.
   */
  reduceAll?: string;
}

export const PERP_ORDER_TYPES: { value: PerpOrderType; label: string }[] = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'post_only', label: 'Post-only' },
];

/** The side of the position an order of `side` opens or adds to. */
export function positionSideOf(side: Side): PositionSide {
  return side === 'buy' ? 'long' : 'short';
}

/**
 * Reduce-only as the form shows it. An order against the open position can only reduce it (one-way
 * mode), so it is forced on and says which position it reduces; otherwise it is the owner's choice.
 */
export function reduceOnlyState(
  side: Side,
  position: Pick<WirePosition, 'side'> | null | undefined,
  checked: boolean,
): { on: boolean; forced: boolean; label: string } {
  if (position && position.side !== positionSideOf(side)) {
    return { on: true, forced: true, label: `Reduces your ${position.side}` };
  }
  return { on: checked, forced: false, label: 'Reduce-only' };
}

const blank = (v: string) => v.trim() === '';

/**
 * The request for POST /api/perp/orders and its preview. Every value goes out exactly as the owner
 * typed it (the server parses '1,5'); only the fields the order uses are sent, and the attached
 * legs only on an opening order and only those filled in.
 */
export function buildPerpRequest(f: PerpFormFields): PerpOrderRequest {
  const req: PerpOrderRequest = { symbol: f.symbol, side: f.side, type: f.type };
  if (f.amountIn === 'coin') req.qty = f.amount;
  else if (f.reduceOnly && f.reduceAll !== undefined) req.qty = f.reduceAll;
  else req.quoteQty = f.amount;
  if (hasPrice(f.type)) req.price = f.price;
  req.reduceOnly = f.reduceOnly;
  if (f.attach && !f.reduceOnly) {
    req.attach = {
      ...(blank(f.stopLoss) ? {} : { stopLoss: f.stopLoss }),
      ...(blank(f.takeProfit) ? {} : { takeProfit: f.takeProfit }),
    };
  }
  return req;
}

/** What the owner still has to type, or null when the order has everything it needs. */
export function perpMissingInput(f: PerpFormFields): string | null {
  if (blank(f.amount)) return 'Enter an amount';
  if (hasPrice(f.type) && blank(f.price)) return 'Enter a limit price';
  if (f.attach && !f.reduceOnly && blank(f.stopLoss) && blank(f.takeProfit)) {
    return 'Enter a stop-loss or a take-profit price';
  }
  return null;
}

/**
 * Whether a preview request (JSON from buildPerpRequest) is for this form's symbol, side, type and
 * reduce-only setting: an answer for any other is never shown (its figures mean something else).
 */
export function perpPreviewMatches(key: string | null, f: PerpFormFields): boolean {
  if (key === null) return false;
  try {
    const r = JSON.parse(key) as Partial<PerpOrderRequest>;
    return r.symbol === f.symbol && r.side === f.side && r.type === f.type && (r.reduceOnly ?? false) === f.reduceOnly;
  } catch {
    return false;
  }
}

/**
 * How much of a reduce-only market order lies beyond the position it reduces, or null when none
 * does (or it cannot be told). The order fills at most the position; the rest is cancelled. A
 * dollar amount is converted at the mark to the step as the server converts it, and only with a
 * live mark. Limits get null: the server rejects a reduce-only limit larger than the position.
 */
export function reduceExcess(
  f: PerpFormFields,
  position: Pick<WirePosition, 'qty'> | null | undefined,
  mark: string | null,
  step: string,
): string | null {
  if (!f.reduceOnly || f.type !== 'market' || !position) return null;
  let qty: string | null;
  if (f.amountIn === 'coin') qty = validPrice(f.amount);
  else if (f.reduceAll !== undefined) qty = f.reduceAll;
  else {
    const quote = validPrice(f.amount);
    qty = quote === null || mark === null ? null : floorDivToStep(quote, mark, step);
  }
  if (qty === null || cmpDec(qty, position.qty) <= 0) return null;
  return subDec(qty, position.qty);
}

/** The quick-amount hint of the perp form: when the share came to nothing, or what a 100 % reduce sends. */
export function perpQuickHint(state: QuickState, step: string, base: string): string | null {
  if (state.pct === null) return null;
  if (state.belowCent) return 'Less than $0.01 available';
  if (state.belowStep) return `Less than one step (${fmtNum(step, tickDecimals(step))} ${base})`;
  if (state.sellAll !== undefined) return `Reduces all ${state.sellAll} ${base} (the whole position)`;
  return null;
}

// ---- live data ----

/**
 * What the form may treat as live. `staleReason` (null when everything is live) dims the estimate
 * and hides its liquidation price: the perp feed or the mark stale, our socket down, or no mark
 * yet. `blocked` disables submit only for the server's own state (feed or mark stale); with our
 * socket down the order still goes over HTTP and the server decides. `liveMark` is the mark only
 * while it is fresh and our socket is open.
 */
export function perpLiveState(p: {
  feed: { fresh: boolean; reason: string | null } | undefined;
  mark: PerpMark | undefined;
  down: boolean;
  /** The symbol's perp data is catching up after a feed gap: the server refuses orders until it is done. */
  catchingUp?: boolean;
}): { staleReason: string | null; blocked: boolean; liveMark: string | null } {
  const feedStale = p.feed !== undefined && !p.feed.fresh;
  const markStale = p.mark !== undefined && !p.mark.fresh;
  const catchingUp = p.catchingUp === true;
  const staleReason = feedStale
    ? (p.feed?.reason ?? 'No fresh data from Binance')
    : catchingUp
      ? CATCHING_UP_REASON
      : markStale
        ? 'No mark price update for over 10 s'
        : p.down
          ? 'Connection to the simulator lost'
          : p.mark === undefined
            ? 'No mark price yet'
            : null;
  const liveMark = p.mark?.fresh && !p.down ? p.mark.markPrice : null;
  return { staleReason, blocked: feedStale || markStale || catchingUp, liveMark };
}

// ---- leverage ----

/**
 * Why the symbol's leverage cannot be changed now, or null when it can. As the server rules: it is
 * locked while the symbol has a position or a live order that can open one (reduce-only orders and
 * close-position stops cannot). Until the positions have arrived the answer is not guessed.
 */
export function leverageLock(symbol: string, positions: WirePosition[] | null, orders: WirePerpOrder[]): string | null {
  const base = symbol.replace(/USDT$/, '');
  if (positions === null) return 'Waiting for your positions';
  const held = positions.find((p) => p.symbol === symbol);
  if (held) return `Locked while your ${base} ${held.side} is open`;
  if (orders.some((o) => o.symbol === symbol && !o.reduceOnly)) {
    return `Locked while an order that opens a position is open on ${base}`;
  }
  return null;
}

/** The largest position notional open at a leverage: the cap of the last tier that allows it, '0' if none does. */
export function maxPositionAt(brackets: { cap: string; maxLeverage: number }[], leverage: number): string {
  let cap = '0';
  for (const b of brackets) if (b.maxLeverage >= leverage) cap = b.cap;
  return cap;
}

// ---- tiers note ----

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date and time as 2026-10-23 08:00. */
function isoMinute(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Where the leverage tiers came from and when they were fetched (the bundled copy: when it was taken). */
export function tiersText(tiers: { source: TierSource; fetchedAt: number } | null | undefined): string {
  if (!tiers) return 'Margin tiers: not loaded yet';
  if (tiers.source === 'bundled') return `Margin tiers: bundled snapshot from ${isoMinute(tiers.fetchedAt)}`;
  return `Margin tiers: ${tiers.source} · fetched ${isoMinute(tiers.fetchedAt)}`;
}
