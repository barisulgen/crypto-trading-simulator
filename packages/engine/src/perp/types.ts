import type { Decimal } from '../decimal.ts';

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
