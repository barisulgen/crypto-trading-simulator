import { D, floorToStep } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import type { BookSnapshot, Side } from './types.ts';

export interface WalkResult {
  qty: Decimal;
  quote: Decimal;
  avgPrice: Decimal | null;
  bestPrice: Decimal | null;
  slippageUsd: Decimal;
  levelsUsed: number;
  exhausted: boolean;
}

/**
 * Walk the book (buys take asks, sells hit bids) until the target is met or
 * the book / limit price runs out. Full precision; no rounding.
 */
export function walkBook(
  book: BookSnapshot,
  side: Side,
  target: { qty: Decimal } | { quote: Decimal },
  stepSize: Decimal,
  limitPrice?: Decimal,
): WalkResult {
  const levels = side === 'buy' ? book.asks : book.bids;
  const bestPrice = levels.length > 0 ? levels[0]!.price : null;
  const byQty = 'qty' in target;

  let qty = D(0);
  let quote = D(0);
  let levelsUsed = 0;
  let remaining = byQty ? target.qty : target.quote;
  // Price of the level that would be taken next if we ran out of book/limit.
  let blockedPrice: Decimal | null = null;
  let stoppedByTarget = false;

  for (const level of levels) {
    if (limitPrice !== undefined) {
      const beyond = side === 'buy' ? level.price.gt(limitPrice) : level.price.lt(limitPrice);
      if (beyond) {
        blockedPrice = level.price;
        break;
      }
    }
    const take = byQty
      ? minD(level.qty, remaining)
      : minD(level.qty, floorToStep(remaining.div(level.price), stepSize));
    if (take.lte(0)) {
      stoppedByTarget = true;
      break;
    }
    const cost = take.mul(level.price);
    qty = qty.plus(take);
    quote = quote.plus(cost);
    remaining = byQty ? remaining.minus(take) : remaining.minus(cost);
    levelsUsed += 1;
    if (byQty && remaining.lte(0)) {
      stoppedByTarget = true;
      break;
    }
  }

  let exhausted: boolean;
  if (byQty) {
    exhausted = qty.lt(target.qty);
  } else if (stoppedByTarget) {
    exhausted = false;
  } else {
    // Book or limit ran out: exhausted only if leftover could still buy a step.
    const refPrice = blockedPrice ?? (levels.length > 0 ? levels[levels.length - 1]!.price : null);
    exhausted = refPrice === null ? true : remaining.div(refPrice).gte(stepSize) && remaining.gt(0);
  }

  const avgPrice = qty.isZero() ? null : quote.div(qty);
  const slippageUsd =
    bestPrice === null
      ? D(0)
      : side === 'buy'
        ? quote.minus(bestPrice.mul(qty))
        : bestPrice.mul(qty).minus(quote);

  return { qty, quote, avgPrice, bestPrice, slippageUsd, levelsUsed, exhausted };
}

function minD(a: Decimal, b: Decimal): Decimal {
  return a.lt(b) ? a : b;
}
