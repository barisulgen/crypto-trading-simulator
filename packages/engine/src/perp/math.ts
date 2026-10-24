import { D, Decimal, roundDown8, roundUp8 } from '../decimal.ts';
import type { Side } from '../types.ts';
import { bracketFor } from './tiers.ts';
import type { Bracket, PositionSide } from './types.ts';

/** How far above the last price an order's cost is assumed to fill, whatever its side. */
const LAST_PRICE_BUFFER = D('1.0015');

function dir(side: PositionSide | Side): 1 | -1 {
  return side === 'long' || side === 'buy' ? 1 : -1;
}

/** dir × qty × (mark − entry). */
export function unrealizedPnl(side: PositionSide, qty: Decimal, entry: Decimal, mark: Decimal): Decimal {
  return mark.minus(entry).mul(qty).mul(dir(side));
}

/** notional × mmr − cum, with notional = qty × mark and the bracket taken at that notional. */
export function maintenanceMargin(brackets: Bracket[], qty: Decimal, mark: Decimal): Decimal {
  const notional = qty.mul(mark);
  const b = bracketFor(brackets, notional);
  return notional.mul(b.mmr).minus(b.cum);
}

/** The position's margin plus its unrealised P&L. */
export function marginBalance(margin: Decimal, side: PositionSide, qty: Decimal, entry: Decimal, mark: Decimal): Decimal {
  return margin.plus(unrealizedPnl(side, qty, entry, mark));
}

/** maintenance ÷ balance; infinite once the balance is gone. The position is liquidated at 1. */
export function marginRatio(maintenance: Decimal, balance: Decimal): Decimal {
  if (balance.lte(0)) return D(Infinity);
  return maintenance.div(balance);
}

function liquidationAt(b: Bracket, side: PositionSide, qty: Decimal, entry: Decimal, margin: Decimal): Decimal {
  const cost = qty.mul(entry);
  if (side === 'long') return cost.minus(margin).minus(b.cum).div(qty.mul(D(1).minus(b.mmr)));
  return cost.plus(margin).plus(b.cum).div(qty.mul(D(1).plus(b.mmr)));
}

/**
 * The mark price at which the position's margin balance falls to its maintenance margin.
 * The bracket is the one that holds qty × price at that price itself, so the first bracket whose
 * result lands in its own [floor, cap) wins. Null when a long cannot be liquidated (the result is
 * at or below 0, as for a 1x long) or the position is empty.
 */
export function liquidationPrice(
  brackets: Bracket[],
  side: PositionSide,
  qty: Decimal,
  entry: Decimal,
  margin: Decimal,
): Decimal | null {
  if (qty.lte(0)) return null;
  // Maintenance margin is continuous across bracket edges, so exactly one bracket is self-consistent.
  // Only rounding on an edge can miss it; the result then lies on that edge, nearest of all to its own bracket.
  let price: Decimal | null = null;
  let miss: Decimal | null = null;
  for (const b of brackets) {
    const p = liquidationAt(b, side, qty, entry, margin);
    const notional = qty.mul(p);
    const found = bracketFor(brackets, notional);
    if (found === b) {
      price = p;
      break;
    }
    const off = notional.lt(b.floor) ? b.floor.minus(notional) : notional.minus(b.cap);
    if (miss === null || off.lt(miss)) {
      miss = off;
      price = p;
    }
  }
  if (price === null) throw new Error('No leverage brackets');
  if (side === 'long' && price.lte(0)) return null;
  return price;
}

/**
 * The price at which closing the whole position loses exactly its isolated margin: E − M ÷ Q for a
 * long, E + M ÷ Q for a short. Unrounded.
 */
export function bankruptcyPrice(side: PositionSide, qty: Decimal, entry: Decimal, margin: Decimal): Decimal {
  return entry.minus(margin.div(qty).mul(dir(side)));
}

/**
 * The price an order's margin is reserved at. A limit buy uses its price; every other order reserves
 * margin at no less than the mark (sells) and the last price plus 0.15 %.
 */
export function assumedPrice(p: {
  type: 'market' | 'limit';
  side: Side;
  price?: Decimal;
  walkAvg?: Decimal;
  mark: Decimal;
  last: Decimal;
}): Decimal {
  const base = p.type === 'limit' ? p.price : p.walkAvg;
  if (!base) throw new Error(p.type === 'limit' ? 'A limit order needs a price' : 'A market order needs a walk average');
  if (p.type === 'limit' && p.side === 'buy') return base;
  const buffered = p.last.mul(LAST_PRICE_BUFFER);
  return p.side === 'buy' ? Decimal.max(base, buffered) : Decimal.max(base, p.mark, buffered);
}

/** roundUp8(notional × rate). */
export function perpFee(notional: Decimal, rate: Decimal): Decimal {
  return roundUp8(notional.mul(rate));
}

/**
 * What opening an order costs: initial margin at imPrice, the loss already standing against the mark
 * at olPrice, and the taker fee at imPrice, each rounded up to 8 decimals.
 */
export function orderCost(p: {
  side: Side;
  qty: Decimal;
  imPrice: Decimal;
  olPrice: Decimal;
  mark: Decimal;
  leverage: number;
  takerRate: Decimal;
}): { initialMargin: Decimal; openLoss: Decimal; fee: Decimal; total: Decimal } {
  const notional = p.qty.mul(p.imPrice);
  const initialMargin = roundUp8(notional.div(p.leverage));
  const openLoss = roundUp8(p.qty.mul(Decimal.max(0, p.olPrice.minus(p.mark).mul(dir(p.side)))));
  const fee = perpFee(notional, p.takerRate);
  return { initialMargin, openLoss, fee, total: initialMargin.plus(openLoss).plus(fee) };
}

/**
 * How a liquidated position's margin is spent: first the trading loss at the mark, then the
 * liquidation fee from what is left. The remainder is lost too: the whole margin always goes.
 */
export function liquidationSplit(p: {
  margin: Decimal;
  side: PositionSide;
  qty: Decimal;
  entry: Decimal;
  mark: Decimal;
  feeRate: Decimal;
}): { tradingLoss: Decimal; liquidationFee: Decimal; remainder: Decimal } {
  const loss = Decimal.max(0, unrealizedPnl(p.side, p.qty, p.entry, p.mark).neg());
  const tradingLoss = Decimal.min(p.margin, roundUp8(loss));
  const liquidationFee = Decimal.min(p.margin.minus(tradingLoss), roundUp8(p.feeRate.mul(p.qty).mul(p.mark)));
  return { tradingLoss, liquidationFee, remainder: p.margin.minus(tradingLoss).minus(liquidationFee) };
}

/** |qty × mark × rate|, rounded up when the owner pays it and down when the owner receives it. */
export function fundingAmount(qty: Decimal, markPrice: Decimal, rate: Decimal, paying: boolean): Decimal {
  const amount = qty.mul(markPrice).mul(rate).abs();
  return paying ? roundUp8(amount) : roundDown8(amount);
}

/**
 * The margin that may be taken out of an isolated position, rounded down:
 * max(0, min(margin − maintenance, margin + min(unrealised P&L, 0) − mark × qty ÷ leverage)).
 * An unrealised loss reduces it; an unrealised profit does not add to it, since it is not yet
 * realised and could vanish before the position closes.
 */
export function maxRemovableMargin(p: {
  brackets: Bracket[];
  side: PositionSide;
  qty: Decimal;
  entry: Decimal;
  margin: Decimal;
  mark: Decimal;
  leverage: number;
}): Decimal {
  const aboveMaintenance = p.margin.minus(maintenanceMargin(p.brackets, p.qty, p.mark));
  const loss = Decimal.min(0, unrealizedPnl(p.side, p.qty, p.entry, p.mark));
  const aboveInitial = p.margin.plus(loss).minus(p.mark.mul(p.qty).div(p.leverage));
  return roundDown8(Decimal.max(0, Decimal.min(aboveMaintenance, aboveInitial)));
}
