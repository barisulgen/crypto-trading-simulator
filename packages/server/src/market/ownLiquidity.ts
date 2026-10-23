import type { Decimal, PriceLevel } from '@sim/engine';

export type BookSide = 'bids' | 'asks';

/**
 * What the owner's own taker fills took from one symbol's book. The real book never shows them,
 * so without this a large order split into small ones would fill each piece at the same top of
 * book. A claim on a level lasts until a depth update touches that level (the exchange's new
 * quantity there replaces it); a resync or snapshot ends every claim.
 */
export class OwnLiquidity {
  private readonly sides: Record<BookSide, Map<string, Decimal>> = { bids: new Map(), asks: new Map() };

  /** Add what a fill took at each level to the claims on that side. */
  consume(side: BookSide, levels: PriceLevel[]): void {
    const claims = this.sides[side];
    for (const l of levels) {
      const key = l.price.toString();
      const prev = claims.get(key);
      claims.set(key, prev ? prev.plus(l.qty) : l.qty);
    }
  }

  /** A depth update for the level at `price` ends our claim on it. */
  onLevelUpdate(side: BookSide, price: Decimal): void {
    this.sides[side].delete(price.toString());
  }

  /** A resync or snapshot: every claim ends. */
  clear(): void {
    this.sides.bids.clear();
    this.sides.asks.clear();
  }

  /** How many levels of `side` carry a claim. */
  count(side: BookSide): number {
    return this.sides[side].size;
  }

  /**
   * The levels of `side` less the claims on them; a level whose claims reach its quantity is
   * dropped. Returns new levels and leaves `levels` unchanged.
   */
  apply(side: BookSide, levels: PriceLevel[]): PriceLevel[] {
    const claims = this.sides[side];
    if (claims.size === 0) return levels.map((l) => ({ ...l }));
    const out: PriceLevel[] = [];
    for (const l of levels) {
      const claim = claims.get(l.price.toString());
      if (!claim) {
        out.push({ ...l });
        continue;
      }
      const left = l.qty.minus(claim);
      if (left.gt(0)) out.push({ price: l.price, qty: left });
    }
    return out;
  }
}
