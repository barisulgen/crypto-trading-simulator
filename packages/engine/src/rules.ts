import type { Decimal } from './decimal.ts';
import { isMultipleOf } from './decimal.ts';
import type { NormalizedRequest, SpotRules } from './types.ts';

export interface RuleContext {
  avgPrice: Decimal | null;
  openOrders: number;
  openAlgoOrders: number;
}

/** A minPrice, maxPrice or tickSize of 0 disables that check, as on the exchange. */
export function priceFilter(label: string, p: Decimal, r: SpotRules): string | null {
  if (!r.minPrice.isZero() && p.lt(r.minPrice)) {
    return `PRICE_FILTER: ${label} ${p} is below the minimum price ${r.minPrice}`;
  }
  if (!r.maxPrice.isZero() && p.gt(r.maxPrice)) {
    return `PRICE_FILTER: ${label} ${p} is above the maximum price ${r.maxPrice}`;
  }
  if (!isMultipleOf(p.sub(r.minPrice), r.tickSize)) {
    return `PRICE_FILTER: ${label} ${p} is not a multiple of tick size ${r.tickSize}`;
  }
  return null;
}

/** MARKET_LOT_SIZE: applies to the quantity a market order buys or sells, whether sized in coins or dollars. */
export function marketLotSize(qty: Decimal, r: SpotRules): string | null {
  const step = r.marketStepSize.isZero() ? r.stepSize : r.marketStepSize;
  const min = r.marketMinQty.isZero() ? r.minQty : r.marketMinQty;
  if (qty.lt(min)) return `MARKET_LOT_SIZE: quantity ${qty} is below the market minimum ${min}`;
  if (qty.gt(r.marketMaxQty)) {
    return `MARKET_LOT_SIZE: quantity ${qty} is above the market maximum ${r.marketMaxQty}`;
  }
  if (!isMultipleOf(qty.sub(min), step)) {
    return `MARKET_LOT_SIZE: quantity ${qty} is not a multiple of step size ${step}`;
  }
  return null;
}

function lotSize(req: NormalizedRequest, qty: Decimal, r: SpotRules): string | null {
  if (req.type === 'market') return marketLotSize(qty, r);
  if (qty.lt(r.minQty)) return `LOT_SIZE: quantity ${qty} is below the minimum ${r.minQty}`;
  if (qty.gt(r.maxQty)) return `LOT_SIZE: quantity ${qty} is above the maximum ${r.maxQty}`;
  if (!isMultipleOf(qty.sub(r.minQty), r.stepSize)) {
    return `LOT_SIZE: quantity ${qty} is not a multiple of step size ${r.stepSize}`;
  }
  return null;
}

/** `avg` is non-null for market orders (checked by validateSpotOrder); other types never read it. */
function notional(req: NormalizedRequest, avg: Decimal | null, r: SpotRules): string | null {
  const isMarket = req.type === 'market';
  let value: Decimal;
  if (isMarket) {
    if (req.qty) value = avg!.mul(req.qty);
    else if (req.quoteQty) value = req.quoteQty;
    else return null;
  } else {
    const p = req.price ?? req.triggerPrice;
    if (!p || !req.qty) return null;
    value = p.mul(req.qty);
  }
  if ((!isMarket || r.applyMinToMarket) && value.lt(r.minNotional)) {
    return `NOTIONAL: order value ${value} is below the minimum ${r.minNotional}`;
  }
  if ((!isMarket || r.applyMaxToMarket) && value.gt(r.maxNotional)) {
    return `NOTIONAL: order value ${value} is above the maximum ${r.maxNotional}`;
  }
  return null;
}

/** Limit and post-only only; `avg` is non-null for them (checked by validateSpotOrder). */
function percentPrice(req: NormalizedRequest, avg: Decimal | null, r: SpotRules): string | null {
  if ((req.type !== 'limit' && req.type !== 'post_only') || !req.price || !avg) return null;
  const buy = req.side === 'buy';
  const up = buy ? r.bidMultiplierUp : r.askMultiplierUp;
  const down = buy ? r.bidMultiplierDown : r.askMultiplierDown;
  const max = avg.mul(up);
  const min = avg.mul(down);
  if (req.price.gt(max)) {
    return `PERCENT_PRICE_BY_SIDE: ${req.side} price ${req.price} is above the allowed maximum ${max} (${up} × average price ${avg})`;
  }
  if (req.price.lt(min)) {
    return `PERCENT_PRICE_BY_SIDE: ${req.side} price ${req.price} is below the allowed minimum ${min} (${down} × average price ${avg})`;
  }
  return null;
}

/** Order types whose filters use the average price: NOTIONAL for market, PERCENT_PRICE_BY_SIDE for limits. */
function usesAvgPrice(type: NormalizedRequest['type']): boolean {
  return type === 'market' || type === 'limit' || type === 'post_only';
}

/**
 * Returns a rejection reason, or null if the order passes every Binance spot filter.
 * Orders whose filters use the average price are rejected when it is unavailable; stops and
 * take-profits (NOTIONAL on the trigger price, no PERCENT_PRICE_BY_SIDE) do not need it.
 */
export function validateSpotOrder(
  req: NormalizedRequest,
  rules: SpotRules,
  ctx: RuleContext,
): string | null {
  const avg = ctx.avgPrice && ctx.avgPrice.gt(0) ? ctx.avgPrice : null;
  if (!avg && usesAvgPrice(req.type)) return 'Average price unavailable; order rejected (never guessed)';

  if (ctx.openOrders >= rules.maxNumOrders) {
    return `MAX_NUM_ORDERS: already ${ctx.openOrders} open orders on ${rules.symbol} (maximum ${rules.maxNumOrders})`;
  }
  if (
    (req.type === 'stop_loss' || req.type === 'take_profit') &&
    ctx.openAlgoOrders >= rules.maxNumAlgoOrders
  ) {
    return `MAX_NUM_ALGO_ORDERS: already ${ctx.openAlgoOrders} open stop/take-profit orders on ${rules.symbol} (maximum ${rules.maxNumAlgoOrders})`;
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
    const e = lotSize(req, req.qty, rules);
    if (e) return e;
  }

  return notional(req, avg, rules) ?? percentPrice(req, avg, rules);
}
