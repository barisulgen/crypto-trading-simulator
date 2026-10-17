import { D } from '@sim/engine';
import type { BookSnapshot, Decimal, PriceLevel } from '@sim/engine';

type Raw = [string, string][];
type Side = PriceLevel[];

export type DiffResult = 'applied' | 'dropped' | 'gap';

/** Index of the first level not "before" `price` in the given order; `found` if equal. */
function search(side: Side, price: Decimal, desc: boolean): { i: number; found: boolean } {
  let lo = 0;
  let hi = side.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = side[mid]!.price.cmp(price);
    if (c === 0) return { i: mid, found: true };
    if (desc ? c > 0 : c < 0) lo = mid + 1;
    else hi = mid;
  }
  return { i: lo, found: false };
}

function applyLevels(side: Side, updates: Raw, desc: boolean): void {
  for (const [p, q] of updates) {
    const price = D(p);
    const qty = D(q);
    const { i, found } = search(side, price, desc);
    if (qty.isZero()) {
      if (found) side.splice(i, 1);
    } else if (found) {
      side[i] = { price: side[i]!.price, qty };
    } else {
      side.splice(i, 0, { price, qty });
    }
  }
}

/** Local depth book following Binance's snapshot + diff-stream procedure. */
export class LocalBook {
  private bids: Side = [];
  private asks: Side = [];
  private lastUpdateId = 0;
  private prevU = 0;
  private synced = false; // first bridging diff applied
  private hasSnapshot = false;
  private ok = false;

  get valid(): boolean {
    return this.ok;
  }

  applySnapshot(s: { lastUpdateId: number; bids: Raw; asks: Raw }): void {
    this.bids = [];
    this.asks = [];
    applyLevels(this.bids, s.bids, true);
    applyLevels(this.asks, s.asks, false);
    this.lastUpdateId = s.lastUpdateId;
    this.prevU = s.lastUpdateId;
    this.synced = false;
    this.hasSnapshot = true;
    this.ok = false;
  }

  applyDiff(e: { U: number; u: number; b: Raw; a: Raw }): DiffResult {
    if (!this.hasSnapshot) return 'gap';
    if (!this.synced) {
      if (e.u <= this.lastUpdateId) return 'dropped';
      if (e.U > this.lastUpdateId + 1) return this.fail();
      this.synced = true;
      this.ok = true;
    } else {
      if (!this.ok) return 'gap';
      if (e.U !== this.prevU + 1) return this.fail();
    }
    applyLevels(this.bids, e.b, true);
    applyLevels(this.asks, e.a, false);
    this.prevU = e.u;
    return 'applied';
  }

  private fail(): 'gap' {
    this.ok = false;
    this.hasSnapshot = false;
    return 'gap';
  }

  snapshot(levels?: number): BookSnapshot {
    const cut = (s: Side) => (levels === undefined ? s : s.slice(0, levels)).map((l) => ({ ...l }));
    return { bids: cut(this.bids), asks: cut(this.asks) };
  }

  bestBid(): PriceLevel | null {
    return this.bids[0] ? { ...this.bids[0] } : null;
  }

  bestAsk(): PriceLevel | null {
    return this.asks[0] ? { ...this.asks[0] } : null;
  }
}
