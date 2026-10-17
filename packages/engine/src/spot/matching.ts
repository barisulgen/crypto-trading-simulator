import type { Decimal } from '../decimal.ts';
import type { AggTrade, SpotOrder } from '../types.ts';

/**
 * Share one real trade's volume among resting limit orders it trades through.
 *
 * - A seller-initiated trade strictly below a buy's price fills that buy; a buyer-initiated
 *   trade strictly above a sell's price fills that sell. A touch never fills.
 * - Priority: best price for the counterparty (higher buy, lower sell), then earlier createdAt,
 *   then the order the caller passed them in.
 * - Each order gets at most its remaining quantity; the total is at most trade.qty.
 *
 * The caller passes only orders that may match (same symbol, resting, arrived).
 */
export function allocateTradeThrough(orders: SpotOrder[], trade: AggTrade): { orderId: string; qty: Decimal }[] {
  const eligible = orders.filter((o) => {
    if (!o.price || !o.qty) return false;
    return trade.sellerInitiated
      ? o.side === 'buy' && trade.price.lt(o.price)
      : o.side === 'sell' && trade.price.gt(o.price);
  });
  // Only one side is eligible per trade, so comparing by that side's priority is enough.
  eligible.sort((a, b) => {
    const byPrice = a.side === 'buy' ? b.price!.cmp(a.price!) : a.price!.cmp(b.price!);
    return byPrice !== 0 ? byPrice : a.createdAt - b.createdAt;
  });

  const out: { orderId: string; qty: Decimal }[] = [];
  let left = trade.qty;
  for (const o of eligible) {
    if (left.lte(0)) break;
    const remaining = o.qty!.minus(o.filledQty);
    const take = remaining.lt(left) ? remaining : left;
    if (take.lte(0)) continue;
    out.push({ orderId: o.id, qty: take });
    left = left.minus(take);
  }
  return out;
}
