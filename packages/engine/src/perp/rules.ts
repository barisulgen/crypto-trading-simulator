import type { Decimal } from '../decimal.ts';
import { limitLotSize, marketLotSize, priceFilter } from '../rules.ts';
import type { Side } from '../types.ts';
import type { PerpOrderType, PerpRules } from './types.ts';

/** A perp order with its amounts parsed, as the futures filters see it. */
export interface NormalizedPerpRequest {
  symbol: string;
  side: Side;
  type: PerpOrderType;
  /** Absent for a close-position stop, which closes whatever the position holds. */
  qty?: Decimal;
  price?: Decimal;
  triggerPrice?: Decimal;
  reduceOnly: boolean;
}

export const MARK_UNAVAILABLE = 'Mark price unavailable; order rejected (never guessed)';
export const TIERS_NOT_LOADED = 'Leverage tiers not loaded yet; try again in a moment';

/**
 * Returns a rejection reason, or null if the order passes every Binance futures filter. The mark
 * price is needed by every order (MIN_NOTIONAL of market orders, PERCENT_PRICE of limits), so
 * without a positive mark the order is rejected; it is never guessed.
 */
export function validatePerpOrder(
  req: NormalizedPerpRequest,
  rules: PerpRules,
  ctx: { mark: Decimal | null; openOrders: number },
): string | null {
  const mark = ctx.mark && ctx.mark.gt(0) ? ctx.mark : null;
  if (!mark) return MARK_UNAVAILABLE;

  if (ctx.openOrders >= rules.maxNumOrders) {
    return `MAX_NUM_ORDERS: already ${ctx.openOrders} open orders on ${rules.symbol} (maximum ${rules.maxNumOrders})`;
  }

  if (req.price) {
    const e = priceFilter('price', req.price, rules);
    if (e) return e;
  }
  if (req.triggerPrice) {
    const e = priceFilter('trigger price', req.triggerPrice, rules);
    if (e) return e;
  }

  if (req.qty) {
    const e = req.type === 'market' ? marketLotSize(req.qty, rules) : limitLotSize(req.qty, rules);
    if (e) return e;
  }

  return minNotional(req, mark, rules) ?? percentPrice(req, mark, rules);
}

/** Market orders are valued at the mark, others at their price (or trigger). Reduce-only orders are exempt. */
function minNotional(req: NormalizedPerpRequest, mark: Decimal, r: PerpRules): string | null {
  if (req.reduceOnly || !req.qty) return null;
  const p = req.type === 'market' ? mark : (req.price ?? req.triggerPrice);
  if (!p) return null;
  const value = p.mul(req.qty);
  if (value.lt(r.minNotional)) return `MIN_NOTIONAL: order value ${value} is below the minimum ${r.minNotional}`;
  return null;
}

/** Limit and post-only only: a buy at most multiplierUp × mark, a sell at least multiplierDown × mark. */
function percentPrice(req: NormalizedPerpRequest, mark: Decimal, r: PerpRules): string | null {
  if ((req.type !== 'limit' && req.type !== 'post_only') || !req.price) return null;
  if (req.side === 'buy') {
    const max = mark.mul(r.multiplierUp);
    if (req.price.gt(max)) {
      return `PERCENT_PRICE: buy price ${req.price} is above the allowed maximum ${max} (${r.multiplierUp} × mark price ${mark})`;
    }
    return null;
  }
  const min = mark.mul(r.multiplierDown);
  if (req.price.lt(min)) {
    return `PERCENT_PRICE: sell price ${req.price} is below the allowed minimum ${min} (${r.multiplierDown} × mark price ${mark})`;
  }
  return null;
}
