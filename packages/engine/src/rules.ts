import type { Decimal } from './decimal.ts';
import { isMultipleOf } from './decimal.ts';
import type { NormalizedRequest, SpotRules } from './types.ts';

export interface RuleContext {
  avgPrice: Decimal | null;
  openOrders: number;
  openAlgoOrders: number;
}

function priceFilter(label: string, p: Decimal, r: SpotRules): string | null {
  if (p.lt(r.minPrice)) return `PRICE_FILTER: ${label} ${p} is below the minimum price ${r.minPrice}`;
  if (p.gt(r.maxPrice)) return `PRICE_FILTER: ${label} ${p} is above the maximum price ${r.maxPrice}`;
  if (!isMultipleOf(p.sub(r.minPrice), r.tickSize)) {
    return `PRICE_FILTER: ${label} ${p} is not a multiple of tick size ${r.tickSize}`;
  }
  return null;
}

function lotSize(req: NormalizedRequest, qty: Decimal, r: SpotRules): string | null {
  if (req.type === 'market') {
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
  if (qty.lt(r.minQty)) return `LOT_SIZE: quantity ${qty} is below the minimum ${r.minQty}`;
  if (qty.gt(r.maxQty)) return `LOT_SIZE: quantity ${qty} is above the maximum ${r.maxQty}`;
  if (!isMultipleOf(qty.sub(r.minQty), r.stepSize)) {
    return `LOT_SIZE: quantity ${qty} is not a multiple of step size ${r.stepSize}`;
  }
  return null;
}

function notional(req: NormalizedRequest, avg: Decimal, r: SpotRules): string | null {
  const isMarket = req.type === 'market';
  let value: Decimal;
  if (isMarket) {
    if (req.qty) value = avg.mul(req.qty);
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

function percentPrice(req: NormalizedRequest, avg: Decimal, r: SpotRules): string | null {
  if ((req.type !== 'limit' && req.type !== 'post_only') || !req.price) return null;
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

/** Returns a rejection reason, or null if the order passes every Binance spot filter. */
export function validateSpotOrder(
  req: NormalizedRequest,
  rules: SpotRules,
  ctx: RuleContext,
): string | null {
  if (!ctx.avgPrice) return 'Average price unavailable; order rejected (never guessed)';
  const avg = ctx.avgPrice;

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
