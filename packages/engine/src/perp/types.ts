import type { Decimal } from '../decimal.ts';
import type { BookSnapshot, Side } from '../types.ts';

/** Binance USDⓈ-M perpetual trading rules for one symbol (fapi exchangeInfo). */
export interface PerpRules {
  symbol: string;
  base: string;
  quote: string;
  status: string;
  tickSize: Decimal;
  minPrice: Decimal;
  maxPrice: Decimal;
  stepSize: Decimal;
  minQty: Decimal;
  maxQty: Decimal;
  marketStepSize: Decimal;
  marketMinQty: Decimal;
  marketMaxQty: Decimal;
  minNotional: Decimal;
  maxNumOrders: number;
  multiplierUp: Decimal;
  multiplierDown: Decimal;
  liquidationFee: Decimal;
  marketTakeBound: Decimal;
}

/** One leverage tier: positions with notional in [floor, cap) use this maintenance rate and maximum leverage. */
export interface Bracket {
  floor: Decimal;
  cap: Decimal;
  /** Maintenance margin ratio. */
  mmr: Decimal;
  /** Maintenance amount: maintenance margin = notional × mmr − cum. */
  cum: Decimal;
  maxLeverage: number;
}

/** Where a tier table came from: the signed endpoint, the public web endpoint, or the copy shipped with the server. */
export type TierSource = 'official' | 'unofficial' | 'bundled';

export interface TierSet {
  source: TierSource;
  /** Epoch ms the tables were fetched (for the bundled copy, when that copy was taken). */
  fetchedAt: number;
  /** Per symbol, ascending by floor and contiguous from 0. */
  brackets: Record<string, Bracket[]>;
}

/** What the perp engine may know about the futures market. Never invents a price. */
export interface PerpMarketView {
  /** Book, trades and mark price all fresh, rules and leverage tiers loaded, and Binance TRADING the symbol. */
  isFresh(symbol: string): boolean;
  /** The mark price's connection is healthy and its last update is current and at most 10 000 ms old. */
  isMarkFresh(symbol: string): boolean;
  /** A copy of the whole book: costly, so read only when a walk needs the levels. */
  book(symbol: string): BookSnapshot;
  /** Best price a taker would hit (best ask for a buy, best bid for a sell), without copying the book. */
  best(symbol: string, side: Side): Decimal | null;
  /** The last trade price received, fresh or not; null before the first. */
  lastPrice(symbol: string): Decimal | null;
  /** The last mark price received, fresh or not (see isMarkFresh); null before the first. */
  markPrice(symbol: string): Decimal | null;
  rules(symbol: string): PerpRules;
  /** Leverage tiers, ascending by floor and contiguous from 0. */
  brackets(symbol: string): Bracket[];
}
