import { Decimal, floorToStep, roundUp8 } from '../decimal.ts';
import type { SpotRules } from '../types.ts';

/**
 * A buy-and-hold deposit: a dollar-sized taker market buy at one ask price. The quantity is
 * floored to the step size and the fee is a share of it in BTC, rounded up to 8 dp. Money not
 * spent stays as cash, and an amount that cannot meet the minimum notional stays all cash.
 */
export function benchmarkBuy(
  amount: Decimal,
  ask: Decimal,
  rules: Pick<SpotRules, 'stepSize' | 'minNotional'>,
  takerFee: Decimal,
): { btc: Decimal; cash: Decimal; fee: Decimal } {
  const gross = floorToStep(amount.div(ask), rules.stepSize);
  if (gross.isZero() || gross.mul(ask).lt(rules.minNotional)) {
    return { btc: new Decimal(0), cash: amount, fee: new Decimal(0) };
  }
  const fee = roundUp8(gross.mul(takerFee));
  return { btc: gross.minus(fee), cash: amount.minus(gross.mul(ask)), fee };
}

/** The held BTC at the bid plus the cash. */
export function benchmarkValue(buys: { btc: Decimal; cash: Decimal }[], btcBid: Decimal): Decimal {
  return buys.reduce((sum, b) => sum.plus(b.btc.mul(btcBid)).plus(b.cash), new Decimal(0));
}
