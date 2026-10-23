import { D } from '@sim/engine';
import type { Decimal, PerpRules } from '@sim/engine';

type Filter = Record<string, any>;

const DECIMAL = /^\d+(\.\d+)?$/;

/** Trading rules of one USDⓈ-M perpetual from its fapi exchangeInfo entry; throws on anything missing. */
export function parsePerpRules(symbolInfo: unknown): PerpRules {
  const s = symbolInfo as Record<string, unknown> & { symbol?: string; filters?: Filter[] };
  if (!s || typeof s.symbol !== 'string' || !Array.isArray(s.filters)) {
    throw new Error('parsePerpRules: not a Binance symbol info object');
  }
  const sym = s.symbol;
  const filters = s.filters;
  const need = (type: string): Filter => {
    const f = filters.find((x) => x?.filterType === type);
    if (!f) throw new Error(`Missing filter ${type} for ${sym}`);
    return f;
  };
  const pf = need('PRICE_FILTER');
  const lot = need('LOT_SIZE');
  const mlot = need('MARKET_LOT_SIZE');
  const mn = need('MIN_NOTIONAL');
  const mno = need('MAX_NUM_ORDERS');
  const pp = need('PERCENT_PRICE');
  const text = (key: string): string => {
    const v = s[key];
    if (typeof v !== 'string' || v === '') throw new Error(`parsePerpRules: ${sym} has no ${key}`);
    return v;
  };
  const top = (key: string): Decimal => {
    const v = text(key);
    if (!DECIMAL.test(v)) throw new Error(`parsePerpRules: ${sym} ${key} is not a number (${v})`);
    return D(v);
  };
  const dec = (f: Filter, type: string, key: string): Decimal => {
    const v = f[key];
    if (typeof v !== 'string' || !DECIMAL.test(v)) {
      throw new Error(`parsePerpRules: ${sym} ${type}.${key} is not a number (${v})`);
    }
    return D(v);
  };
  const count = (f: Filter, type: string, key: string): number => {
    const v = Number(f[key]);
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`parsePerpRules: ${sym} ${type}.${key} is not a positive integer (${f[key]})`);
    }
    return v;
  };
  return {
    symbol: sym,
    base: text('baseAsset'),
    quote: text('quoteAsset'),
    status: text('status'),
    tickSize: dec(pf, 'PRICE_FILTER', 'tickSize'),
    minPrice: dec(pf, 'PRICE_FILTER', 'minPrice'),
    maxPrice: dec(pf, 'PRICE_FILTER', 'maxPrice'),
    stepSize: dec(lot, 'LOT_SIZE', 'stepSize'),
    minQty: dec(lot, 'LOT_SIZE', 'minQty'),
    maxQty: dec(lot, 'LOT_SIZE', 'maxQty'),
    marketStepSize: dec(mlot, 'MARKET_LOT_SIZE', 'stepSize'),
    marketMinQty: dec(mlot, 'MARKET_LOT_SIZE', 'minQty'),
    marketMaxQty: dec(mlot, 'MARKET_LOT_SIZE', 'maxQty'),
    minNotional: dec(mn, 'MIN_NOTIONAL', 'notional'),
    maxNumOrders: count(mno, 'MAX_NUM_ORDERS', 'limit'),
    multiplierUp: dec(pp, 'PERCENT_PRICE', 'multiplierUp'),
    multiplierDown: dec(pp, 'PERCENT_PRICE', 'multiplierDown'),
    liquidationFee: top('liquidationFee'),
    marketTakeBound: top('marketTakeBound'),
  };
}
