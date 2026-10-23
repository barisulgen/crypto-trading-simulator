import { D } from '../src/decimal.ts';
import type { Decimal } from '../src/decimal.ts';
import type { Bracket, PerpCtx, PerpMarketView, PerpRules } from '../src/perp/types.ts';
import type { BookSnapshot, Side } from '../src/types.ts';
import { FakeMarket, testCtx } from './fixtures.ts';

export type BracketRow = [floor: string, cap: string, mmr: string, cum: string, maxLeverage: number];

/** Brackets from [floor, cap, mmr, cum, maxLeverage] rows. */
export function brackets(rows: BracketRow[]): Bracket[] {
  return rows.map(([floor, cap, mmr, cum, maxLeverage]) => ({
    floor: D(floor),
    cap: D(cap),
    mmr: D(mmr),
    cum: D(cum),
    maxLeverage,
  }));
}

/** Binance's BTCUSDT leverage tiers as published on 2026-10-23. */
export const btcBrackets: Bracket[] = brackets([
  ['0', '300000', '0.004', '0', 150],
  ['300000', '800000', '0.005', '300', 100],
  ['800000', '3000000', '0.0065', '1500', 75],
  ['3000000', '12000000', '0.01', '12000', 50],
  ['12000000', '70000000', '0.02', '132000', 25],
  ['70000000', '100000000', '0.025', '482000', 20],
  ['100000000', '230000000', '0.05', '2982000', 10],
  ['230000000', '480000000', '0.1', '14482000', 5],
  ['480000000', '600000000', '0.125', '26482000', 4],
  ['600000000', '800000000', '0.15', '41482000', 3],
  ['800000000', '1200000000', '0.25', '121482000', 2],
  ['1200000000', '1800000000', '0.5', '421482000', 1],
]);

export const solBrackets: Bracket[] = brackets([
  ['0', '50000', '0.005', '0', 100],
  ['50000', '400000', '0.0065', '75', 75],
]);

export const btcPerpRules: PerpRules = {
  symbol: 'BTCUSDT',
  base: 'BTC',
  quote: 'USDT',
  status: 'TRADING',
  tickSize: D('0.1'),
  minPrice: D('556.8'),
  maxPrice: D('4529764'),
  stepSize: D('0.001'),
  minQty: D('0.001'),
  maxQty: D('1000'),
  marketStepSize: D('0.001'),
  marketMinQty: D('0.001'),
  marketMaxQty: D('120'),
  minNotional: D('50'),
  maxNumOrders: 200,
  multiplierUp: D('1.05'),
  multiplierDown: D('0.95'),
  liquidationFee: D('0.0125'),
  marketTakeBound: D('0.05'),
};

export const perpBook: BookSnapshot = {
  asks: [
    { price: D('80000.0'), qty: D('0.2') },
    { price: D('80010.0'), qty: D('1.0') },
  ],
  bids: [
    { price: D('79990.0'), qty: D('0.2') },
    { price: D('79980.0'), qty: D('1.0') },
  ],
};

/**
 * In-memory PerpMarketView. BTCUSDT starts fresh with a fresh mark on perpBook, mark 80000, last
 * 80000, with btcPerpRules and btcBrackets. `bookCalls` counts book() calls (copies of the whole book).
 */
export class FakePerpMarket implements PerpMarketView {
  bookCalls = 0;
  private books = new Map<string, BookSnapshot>([['BTCUSDT', perpBook]]);
  private freshness = new Map<string, boolean>([['BTCUSDT', true]]);
  private markFreshness = new Map<string, boolean>([['BTCUSDT', true]]);
  private markPrices = new Map<string, Decimal | null>([['BTCUSDT', D('80000')]]);
  private lastPrices = new Map<string, Decimal | null>([['BTCUSDT', D('80000')]]);
  private ruleSet = new Map<string, PerpRules>([['BTCUSDT', btcPerpRules]]);
  private tiers = new Map<string, Bracket[]>([['BTCUSDT', btcBrackets]]);

  setBook(symbol: string, book: BookSnapshot): void {
    this.books.set(symbol, book);
  }
  setFresh(symbol: string, fresh: boolean): void {
    this.freshness.set(symbol, fresh);
  }
  setMarkFresh(symbol: string, fresh: boolean): void {
    this.markFreshness.set(symbol, fresh);
  }
  setMarkPrice(symbol: string, price: Decimal | null): void {
    this.markPrices.set(symbol, price);
  }
  setLastPrice(symbol: string, price: Decimal | null): void {
    this.lastPrices.set(symbol, price);
  }
  setRules(symbol: string, rules: PerpRules): void {
    this.ruleSet.set(symbol, rules);
  }
  /** As before exchangeInfo has loaded: rules() throws for the symbol. */
  clearRules(symbol: string): void {
    this.ruleSet.delete(symbol);
  }
  setBrackets(symbol: string, brackets: Bracket[]): void {
    this.tiers.set(symbol, brackets);
  }

  isFresh(symbol: string): boolean {
    return this.freshness.get(symbol) ?? false;
  }
  isMarkFresh(symbol: string): boolean {
    return this.markFreshness.get(symbol) ?? false;
  }
  book(symbol: string): BookSnapshot {
    this.bookCalls += 1;
    return this.books.get(symbol) ?? { bids: [], asks: [] };
  }
  best(symbol: string, side: Side): Decimal | null {
    const book = this.books.get(symbol);
    return (side === 'buy' ? book?.asks : book?.bids)?.[0]?.price ?? null;
  }
  lastPrice(symbol: string): Decimal | null {
    return this.lastPrices.get(symbol) ?? null;
  }
  markPrice(symbol: string): Decimal | null {
    return this.markPrices.get(symbol) ?? null;
  }
  rules(symbol: string): PerpRules {
    const r = this.ruleSet.get(symbol);
    if (!r) throw new Error(`No rules for ${symbol}`);
    return r;
  }
  brackets(symbol: string): Bracket[] {
    const b = this.tiers.get(symbol);
    if (!b) throw new Error(`No leverage brackets for ${symbol}`);
    return b;
  }
}

/** testCtx over a perp market: the same deterministic time, rng and ids; fees 0.02 % maker, 0.05 % taker. */
export function perpCtx(market: PerpMarketView, opts: { now?: number; rngValues?: number[] } = {}): PerpCtx {
  const { now, rng, newId } = testCtx(new FakeMarket(), opts);
  return { now, rng, newId, market, fees: { maker: D('0.0002'), taker: D('0.0005') } };
}
