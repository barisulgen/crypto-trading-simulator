import { D } from '../src/decimal.ts';
import type { Bracket, PerpRules } from '../src/perp/types.ts';
import type { BookSnapshot } from '../src/types.ts';

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
