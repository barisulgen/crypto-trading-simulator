import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import type { BookSnapshot, EngineCtx, MarketView, SpotRules } from '../src/types.ts';

export const btcRules: SpotRules = {
  symbol: 'BTCUSDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: D('0.01'),
  minPrice: D('0.01'),
  maxPrice: D('1000000'),
  stepSize: D('0.00001'),
  minQty: D('0.00001'),
  maxQty: D('9000'),
  marketMinQty: D('0'),
  marketMaxQty: D('114.06718587'),
  marketStepSize: D('0'),
  minNotional: D('5'),
  maxNotional: D('9000000'),
  applyMinToMarket: true,
  applyMaxToMarket: false,
  bidMultiplierUp: D('1.2'),
  bidMultiplierDown: D('0.5'),
  askMultiplierUp: D('2'),
  askMultiplierDown: D('0.8'),
  maxNumOrders: 200,
  maxNumAlgoOrders: 5,
};

export const sampleBook: BookSnapshot = {
  asks: [
    { price: D('100.00'), qty: D('0.5') },
    { price: D('100.10'), qty: D('1.0') },
    { price: D('100.50'), qty: D('2.0') },
  ],
  bids: [
    { price: D('99.90'), qty: D('0.4') },
    { price: D('99.80'), qty: D('1.0') },
    { price: D('99.00'), qty: D('3.0') },
  ],
};

/** In-memory MarketView. BTCUSDT starts fresh on sampleBook, avg price 100, last price 99.95. */
export class FakeMarket implements MarketView {
  private books = new Map<string, BookSnapshot>([['BTCUSDT', sampleBook]]);
  private freshness = new Map<string, boolean>([['BTCUSDT', true]]);
  private avgPrices = new Map<string, Decimal | null>([['BTCUSDT', D('100')]]);
  private lastPrices = new Map<string, Decimal | null>([['BTCUSDT', D('99.95')]]);
  private ruleSet = new Map<string, SpotRules>([['BTCUSDT', btcRules]]);

  setBook(symbol: string, book: BookSnapshot): void {
    this.books.set(symbol, book);
  }
  setFresh(symbol: string, fresh: boolean): void {
    this.freshness.set(symbol, fresh);
  }
  setAvgPrice(symbol: string, price: Decimal | null): void {
    this.avgPrices.set(symbol, price);
  }
  setLastPrice(symbol: string, price: Decimal | null): void {
    this.lastPrices.set(symbol, price);
  }
  setRules(symbol: string, rules: SpotRules): void {
    this.ruleSet.set(symbol, rules);
  }

  isFresh(symbol: string): boolean {
    return this.freshness.get(symbol) ?? false;
  }
  book(symbol: string): BookSnapshot {
    return this.books.get(symbol) ?? { bids: [], asks: [] };
  }
  avgPrice(symbol: string): Decimal | null {
    return this.avgPrices.get(symbol) ?? null;
  }
  lastPrice(symbol: string): Decimal | null {
    return this.lastPrices.get(symbol) ?? null;
  }
  rules(symbol: string): SpotRules {
    const r = this.ruleSet.get(symbol);
    if (!r) throw new Error(`No rules for ${symbol}`);
    return r;
  }
}

/**
 * Deterministic ctx: ids are o1, o2, ... / f1, ... per prefix; rng returns rngValues
 * in order and then repeats the last one (default 0). Fees are 0.10 % maker and taker.
 */
export function testCtx(
  market: MarketView,
  opts: { now?: number; rngValues?: number[] } = {},
): EngineCtx {
  const counters = new Map<string, number>();
  const values = opts.rngValues ?? [0];
  let i = 0;
  return {
    now: opts.now ?? 1_000_000,
    rng: () => values[Math.min(i++, values.length - 1)] ?? 0,
    newId: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}${n}`;
    },
    market,
    fees: { maker: D('0.001'), taker: D('0.001') },
  };
}
