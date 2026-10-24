// The order forms' quick-amount buttons (25/50/75/100 % of the free balance, or of a perp
// position) and the spot form's "Available" line. Pure decimal-string arithmetic: amounts are
// floored, never rounded up, so a form never offers more than the free balance covers.
import type { OrderType, PerpOrderRequest, Side } from '@sim/engine';
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

// ---- perpetuals ----

export interface PerpQuickInput {
  /** The unit the amount field is in: coins or dollars (USDT notional). */
  unit: 'coin' | 'usd';
  pct: Pct;
  /** Free leverage-wallet USDT. */
  free: string;
  /** The symbol's leverage setting. */
  leverage: number;
  /** Taker fee rate ('0.0005'). */
  taker: string;
  side: Side;
  type: PerpOrderRequest['type'];
  /** The limit price field as typed (limit, post-only). */
  price: string;
  /** The perp book: bids best (highest) first, asks best (lowest) first. */
  bids: WireLevel[];
  asks: WireLevel[];
  /** The live mark price; null while it is stale or not received. */
  mark: string | null;
  /** The last trade price; null before the first. */
  last: string | null;
  /** The quantity step for this order type (see amountStep). */
  step: string;
  /** Reduce-only: the position the percentages are shares of; null for an opening order. */
  reduce: { qty: string } | null;
}

/**
 * Mirrors the engine's last-price buffer: every perp order except a limit buy reserves its margin
 * at no less than the last price × 1.0015.
 */
export const PERP_LAST_PRICE_BUFFER = '1.0015';
/** Three 8-decimal round-ups (initial margin, open loss, fee): at most this much above the exact cost. */
const ROUND_UPS = '0.00000003';

const maxDec = (...vs: string[]) => vs.reduce((a, b) => (cmpDec(a, b) >= 0 ? a : b));

/**
 * The engine's prices for an opening order's cost: imPrice, at which the initial margin and the
 * fee are reserved, and olPrice, the fill price whose loss against the mark is charged up front.
 * `fill` is the price the order is assumed to fill at (a market order's walk average, a limit's
 * price). A limit buy reserves at its price; every other order at no less than the buffered last
 * price, and a sell at no less than the mark either.
 */
function costPrices(side: Side, type: PerpOrderRequest['type'], fill: string, mark: string, last: string) {
  const buffered = mulDec(last, PERP_LAST_PRICE_BUFFER);
  let imPrice: string;
  if (type !== 'market' && side === 'buy') imPrice = fill;
  else imPrice = side === 'buy' ? maxDec(fill, buffered) : maxDec(fill, mark, buffered);
  return { imPrice, olPrice: fill };
}

/**
 * What one coin of the order costs × leverage, the cost being initial margin (imPrice ÷ L) plus
 * open loss (the fill's loss against the mark, never negative) plus the taker fee (imPrice × taker):
 * imPrice + L × (openLoss + imPrice × taker). Exact.
 */
function unitCostTimesLeverage(side: Side, im: string, ol: string, mark: string, lev: string, taker: string): string {
  const diff = side === 'buy' ? subDec(ol, mark) : subDec(mark, ol);
  const openLoss = cmpDec(diff, '0') > 0 ? diff : '0';
  return addDec(im, mulDec(lev, addDec(openLoss, mulDec(im, taker))));
}

/**
 * The deepest price a quantity reaches on the book side it takes, beyond the visible levels the
 * last one: no better than the walk's average, so a cost at it is never below the engine's.
 * Null on an empty side.
 */
function worstFill(levels: WireLevel[], qty: string): string | null {
  const last = levels.at(-1);
  if (!last) return null;
  let left = qty;
  for (const level of levels) {
    if (cmpDec(left, level.qty) <= 0) return level.price;
    left = subDec(left, level.qty);
  }
  return last.price;
}

/**
 * The amount a perp quick-amount button fills in, or null when there is nothing to price it with.
 * Minimums and the maximum position are not checked: the server's preview gives the reason.
 *
 * - Opening order: the largest quantity whose cost as the engine reckons it (initial margin and
 *   fee at imPrice, open loss at olPrice, each rounded up to 8 decimals) is at most the share of
 *   the free leverage USDT, floored to the step. A market order is priced at the deepest book
 *   level the quantity reaches (worked out twice: once from the best price, then again from the
 *   level that quantity reaches); a limit at its price, else the best price on its side. Needs the
 *   live mark and the last price, as the engine does. In dollars: that quantity before the step
 *   floor, at the price the server converts dollars at (the mark for a market order, the limit
 *   price for a limit), floored to the cent, so the coins the server makes of it never exceed it.
 * - Reduce-only: the share of the position's size floored to the step; in dollars that quantity
 *   at the limit price (else the mark), floored to the cent. At 100 % the order sends the coins
 *   themselves (sellAll), so it reduces the whole position whatever the price does meanwhile.
 */
export function perpQuickAmount(i: PerpQuickInput): QuickResult | null {
  const share = mulDec(i.free, FRACTION[i.pct]);
  if (i.reduce) {
    const qty = floorToStep(mulDec(i.reduce.qty, FRACTION[i.pct]), i.step);
    if (i.unit === 'coin') return { amount: qty, belowStep: isZero(qty), belowCent: false };
    if (isZero(qty)) return { amount: '0', belowStep: true, belowCent: false };
    const at = (i.type === 'market' ? null : validPrice(i.price)) ?? i.mark;
    if (at === null) return null;
    const c = cents(mulDec(qty, at));
    return { amount: c.amount, belowStep: false, belowCent: c.zero, ...(i.pct === 100 ? { sellAll: qty } : {}) };
  }

  const { mark, last } = i;
  if (mark === null || last === null) return null;
  const levels = i.side === 'buy' ? i.asks : i.bids;
  const best = levels[0]?.price;
  // Kept below the share by the most the round-ups can add, so the rounded cost never exceeds it.
  const budget = cmpDec(share, ROUND_UPS) > 0 ? subDec(share, ROUND_UPS) : '0';
  const lev = String(i.leverage);
  const budgetTimesLeverage = mulDec(budget, lev);
  const sized = (im: string, ol: string) => {
    const denom = unitCostTimesLeverage(i.side, im, ol, mark, lev, i.taker);
    return { qty: floorDivToStep(budgetTimesLeverage, denom, i.step), denom };
  };

  let fit: { qty: string; denom: string };
  if (i.type === 'market') {
    if (best === undefined) return null;
    const first = costPrices(i.side, 'market', best, mark, last);
    const reach = sized(first.imPrice, first.olPrice).qty;
    const worst = worstFill(levels, reach) ?? best;
    // A smaller quantity fills no worse than `worst`: a buy's imPrice and open loss are highest
    // there, a sell's open loss; a sell's imPrice is highest at the best bid.
    const im = i.side === 'buy' ? costPrices('buy', 'market', worst, mark, last).imPrice : first.imPrice;
    fit = sized(im, worst);
  } else {
    const fill = validPrice(i.price) ?? best;
    if (fill === undefined) return null;
    const p = costPrices(i.side, i.type, fill, mark, last);
    fit = sized(p.imPrice, p.olPrice);
  }

  if (i.unit === 'coin') return { amount: fit.qty, belowStep: isZero(fit.qty), belowCent: false };
  const convert = i.type === 'market' ? mark : (validPrice(i.price) ?? best!);
  const dollars = floorDivToStep(mulDec(budgetTimesLeverage, convert), fit.denom, CENT);
  const c = cents(dollars);
  return { amount: c.amount, belowStep: false, belowCent: c.zero };
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
