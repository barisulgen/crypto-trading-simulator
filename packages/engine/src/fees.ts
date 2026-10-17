import { roundUp8 } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import type { Side } from './types.ts';

/** Buys pay the fee in base, sells in quote. `usd` is the unrounded quote x rate. */
export function spotFee(
  side: Side,
  qty: Decimal,
  quote: Decimal,
  rate: Decimal,
  base: string,
  quoteAsset: string,
): { asset: string; amount: Decimal; usd: Decimal } {
  const usd = quote.mul(rate);
  if (side === 'buy') return { asset: base, amount: roundUp8(qty.mul(rate)), usd };
  return { asset: quoteAsset, amount: roundUp8(quote.mul(rate)), usd };
}
