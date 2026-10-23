// The order form's quick-amount buttons (25/50/75/100 % of the free balance) and its
// "Available" line. Pure decimal-string arithmetic: amounts are floored, never rounded up, so
// the form never offers more than the free balance covers.
import type { OrderType, Side } from '@sim/engine';
import type { AccountSnapshot, WireLevel } from './api.ts';
import { fmtBalance, fmtFloor, fmtNum, fmtUsdFloor, tickDecimals } from './format.ts';
import { addDec, cmpDec, floorDivToStep, floorToStep, mulDec, subDec } from './market.ts';
import { hasPrice, hasTrigger } from './orderForm.ts';

export type Pct = 25 | 50 | 75 | 100;
export const PCTS: readonly Pct[] = [25, 50, 75, 100];
/** Each percentage as an exact decimal fraction. */
const FRACTION: Record<Pct, string> = { 25: '0.25', 50: '0.5', 75: '0.75', 100: '1' };

const CENT = '0.01';

export interface QuickInput {
  side: Side;
  /** The unit the amount field is in: coins or dollars (USDT). */
  unit: 'coin' | 'usd';
  pct: Pct;
  type: OrderType;
  /** Free (unlocked) balances only. */
  freeBase: string;
  freeQuote: string;
  /** The visible book: bids best (highest) first, asks best (lowest) first. */
  bids: WireLevel[];
  asks: WireLevel[];
  /** The limit and trigger fields as typed. */
  price: string;
  trigger: string;
  /** The quantity step for this order type (see amountStep). */
  step: string;
}

export interface QuickResult {
  /** What goes in the amount field: coins trimmed ('0.0003'), dollars with cents ('637.50'). */
  amount: string;
  /** The share of the balance is less than one quantity step (the amount is '0'). */
  belowStep: boolean;
  /** A buy in dollars: the share is less than one cent (the amount is '0'). */
  belowCent: boolean;
  /**
   * A 100 % sell in dollars: the coins the order sends instead of the dollars (every whole step of
   * the free coins). Dollars would be turned back into coins at the prices when the order arrives,
   * which can come to a step less, or a step more than is held, once the book has moved.
   */
  sellAll?: string;
}

const isZero = (v: string) => cmpDec(v, '0') === 0;

/** The quantity step the engine checks: the market step for market orders (when set), else the lot step. */
export function amountStep(rules: { stepSize: string; marketStepSize: string }, type: OrderType): string {
  return type === 'market' && !isZero(rules.marketStepSize) ? rules.marketStepSize : rules.stepSize;
}

/** The free (not locked in open orders) spot balance of an asset; '0' when there is none. */
export function spotFree(account: AccountSnapshot | null, asset: string): string {
  return account?.balances.spot[asset]?.free ?? '0';
}

/** A price as the server would parse it ('1,5' is 1.5), or null when it is blank, malformed or not positive. */
export function validPrice(input: string): string | null {
  const s = input.trim();
  if (!/^\d+([.,]\d+)?$/.test(s)) return null;
  const v = s.replace(',', '.');
  return cmpDec(v, '0') > 0 ? v : null;
}

/** The price a non-market order is sized at: the entered limit or trigger price, else the best level. */
function enteredOr(i: QuickInput, best: string | undefined): string | null {
  const entered = hasPrice(i.type) ? validPrice(i.price) : hasTrigger(i.type) ? validPrice(i.trigger) : null;
  return entered ?? best ?? null;
}

/**
 * Coins a budget buys walking the asks as the engine's dollar-sized market buy does: at each level
 * the smaller of its quantity and the whole steps the rest of the budget buys there. What the
 * visible book cannot cover is priced at the last visible ask. Null on an empty book.
 */
function walkAsksWithBudget(asks: WireLevel[], budget: string, step: string): string | null {
  const last = asks.at(-1);
  if (!last) return null;
  let qty = '0';
  let remaining = budget;
  for (const level of asks) {
    const affordable = floorDivToStep(remaining, level.price, step);
    const take = cmpDec(level.qty, affordable) < 0 ? level.qty : affordable;
    if (isZero(take)) return qty;
    qty = addDec(qty, take);
    remaining = subDec(remaining, mulDec(take, level.price));
  }
  return addDec(qty, floorDivToStep(remaining, last.price, step));
}

/** Dollars selling `qty` coins raises walking the bids; coins beyond the visible bids go at the last bid. Null on an empty book. */
function walkBidsWithQty(bids: WireLevel[], qty: string): string | null {
  const last = bids.at(-1);
  if (!last) return null;
  let value = '0';
  let remaining = qty;
  for (const level of bids) {
    if (isZero(remaining)) return value;
    const take = cmpDec(level.qty, remaining) < 0 ? level.qty : remaining;
    value = addDec(value, mulDec(take, level.price));
    remaining = subDec(remaining, take);
  }
  return addDec(value, mulDec(remaining, last.price));
}

/** Dollars floored to the cent, with two decimals; '0' when nothing is left. */
function cents(value: string): { amount: string; zero: boolean } {
  const floored = floorToStep(value, CENT);
  if (isZero(floored)) return { amount: '0', zero: true };
  return { amount: fmtNum(floored, 2, { group: false }), zero: false };
}

/**
 * The amount a quick-amount button fills in, or null when there is no price to size it with (an
 * empty book and no entered price). Minimums are not checked: a result under the minimum notional
 * or quantity is still returned, and the server's preview gives the reason.
 *
 * - Buy in dollars: pct of free USDT, floored to the cent.
 * - Buy in coins: the budget (pct of free USDT) walked over the asks for a market order; divided by
 *   the limit price (limit, post-only) or the trigger (stops, which reserve at it), else by the
 *   best ask. Floored to the step.
 * - Sell in coins: pct of the free coins, floored to the step (a 100 % sell leaves the dust).
 * - Sell in dollars: those coins valued as they would sell: walked over the bids for a market
 *   order, times the limit or trigger price, else times the best bid, floored to the cent. At 100 %
 *   the order sends the coins themselves (sellAll), so it sells every whole step whatever the book
 *   does before it arrives.
 */
export function quickAmount(i: QuickInput): QuickResult | null {
  const share = (free: string) => mulDec(free, FRACTION[i.pct]);
  if (i.side === 'buy') {
    const budget = share(i.freeQuote);
    if (i.unit === 'usd') {
      const c = cents(budget);
      return { amount: c.amount, belowStep: false, belowCent: c.zero };
    }
    let qty: string | null;
    if (i.type === 'market') qty = walkAsksWithBudget(i.asks, budget, i.step);
    else {
      const price = enteredOr(i, i.asks[0]?.price);
      qty = price === null ? null : floorDivToStep(budget, price, i.step);
    }
    if (qty === null) return null;
    const floored = floorToStep(qty, i.step);
    return { amount: floored, belowStep: isZero(floored), belowCent: false };
  }

  const qty = floorToStep(share(i.freeBase), i.step);
  if (i.unit === 'coin') return { amount: qty, belowStep: isZero(qty), belowCent: false };
  if (isZero(qty)) return { amount: '0', belowStep: true, belowCent: false };
  let value: string | null;
  if (i.type === 'market') value = walkBidsWithQty(i.bids, qty);
  else {
    const price = enteredOr(i, i.bids[0]?.price);
    value = price === null ? null : mulDec(qty, price);
  }
  if (value === null) return null;
  const c = cents(value);
  return { amount: c.amount, belowStep: false, belowCent: c.zero, ...(i.pct === 100 ? { sellAll: qty } : {}) };
}

export interface AvailableInput {
  side: Side;
  symbol: string;
  base: string;
  quote: string;
  /** The lot step the buy estimate is floored to. */
  stepSize: string;
  /** Free balance of what the order spends (USDT on a buy, the coin on a sell); undefined before the account loads. */
  free: string | undefined;
  bestBid: string | undefined;
  bestAsk: string | undefined;
  /** False while the selected coin's live data is stale. */
  fresh: boolean;
}

export interface AvailableLine {
  /** '0.00120879 BTC' or '850.00 USDT'; '-' before the account loads. */
  free: string;
  /** '≈ $97.70' or '≈ 0.01045 BTC'; '≈ —' while stale or without a best price; null before the account loads. */
  approx: string | null;
  text: string;
}

/**
 * The free balance in both units. A sell: the coins (as fmtBalance shows them) and their value at
 * the best bid, floored to the cent. A buy: the USDT floored to the cent and the coins it buys at
 * the best ask, floored to the step.
 */
export function availableLine(a: AvailableInput): AvailableLine {
  if (a.free === undefined) return { free: '-', approx: null, text: 'Available -' };
  const sell = a.side === 'sell';
  const free = sell ? `${fmtBalance(a.symbol, a.free)} ${a.base}` : `${fmtFloor(a.free, 2)} ${a.quote}`;
  const best = sell ? a.bestBid : a.bestAsk;
  let approx = '≈ —';
  if (a.fresh && best !== undefined && cmpDec(best, '0') > 0) {
    approx = sell
      ? `≈ ${fmtUsdFloor(mulDec(a.free, best))}`
      : `≈ ${fmtNum(floorDivToStep(a.free, best, a.stepSize), tickDecimals(a.stepSize))} ${a.base}`;
  }
  return { free, approx, text: `Available ${free} ${approx}` };
}

// ---- which button is highlighted ----

export interface QuickState {
  /** The highlighted percentage; null when the amount was typed (or cleared). */
  pct: Pct | null;
  /** The last fill was less than one step / one cent (shown as a hint under the amount). */
  belowStep: boolean;
  belowCent: boolean;
  /** The coins a 100 % sell in dollars sends (see QuickResult.sellAll). */
  sellAll?: string;
}

export const NO_QUICK: QuickState = { pct: null, belowStep: false, belowCent: false };

export type QuickEvent =
  /** A percentage button was pressed. */
  | { type: 'pick'; pct: Pct }
  /** The unit, order type, limit price or trigger changed: an active percentage is filled in again. */
  | { type: 'reprice' }
  /** The amount was typed by hand, or the order was placed. */
  | { type: 'edit' }
  /** The side or the coin changed. */
  | { type: 'reset' };

/**
 * The next highlight state and the amount the field should now show (undefined: leave it; '' empties it).
 * `compute` sizes a percentage against the form as it is now (null: nothing to price it with).
 * Book updates are not an event: the field never changes under the owner.
 */
export function quickStep(
  state: QuickState,
  event: QuickEvent,
  compute: (pct: Pct) => QuickResult | null,
): { state: QuickState; amount?: string } {
  if (event.type === 'edit' || event.type === 'reset') return { state: NO_QUICK };
  const pct = event.type === 'pick' ? event.pct : state.pct;
  if (pct === null) return { state };
  const r = compute(pct);
  // A pick that cannot be priced changes nothing. A reprice that cannot be priced clears the
  // field too: the old amount would now read in the wrong unit or for the wrong price.
  if (r === null) return event.type === 'pick' ? { state } : { state: NO_QUICK, amount: '' };
  const next: QuickState = { pct, belowStep: r.belowStep, belowCent: r.belowCent };
  if (r.sellAll !== undefined) next.sellAll = r.sellAll;
  return { state: next, amount: r.amount };
}

/**
 * The hint under the amount: when the active percentage came to nothing, or the coins a 100 % sell
 * in dollars sends; null otherwise.
 */
export function quickHint(state: QuickState, step: string, base: string): string | null {
  if (state.pct === null) return null;
  if (state.belowCent) return 'Less than $0.01 available';
  if (state.belowStep) return `Less than one step (${fmtNum(step, tickDecimals(step))} ${base}) available`;
  if (state.sellAll !== undefined) return `Sells all ${state.sellAll} ${base} (every whole step of the free balance)`;
  return null;
}
