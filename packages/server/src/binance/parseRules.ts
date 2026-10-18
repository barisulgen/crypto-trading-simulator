import { D } from '@sim/engine';
import type { SpotRules } from '@sim/engine';

type Filter = Record<string, any>;

export function parseSpotRules(symbolInfo: unknown): SpotRules {
  const s = symbolInfo as { symbol?: string; baseAsset?: string; quoteAsset?: string; filters?: Filter[] };
  if (!s || typeof s.symbol !== 'string' || !Array.isArray(s.filters)) {
    throw new Error('parseSpotRules: not a Binance symbol info object');
  }
  const sym = s.symbol;
  const filters = s.filters;
  const need = (type: string): Filter => {
    const f = filters.find((x) => x.filterType === type);
    if (!f) throw new Error(`parseSpotRules: ${sym} is missing required filter ${type}`);
    return f;
  };
  const pf = need('PRICE_FILTER');
  const lot = need('LOT_SIZE');
  const mlot = need('MARKET_LOT_SIZE');
  const nt = need('NOTIONAL');
  const pp = need('PERCENT_PRICE_BY_SIDE');
  const mno = need('MAX_NUM_ORDERS');
  const mna = need('MAX_NUM_ALGO_ORDERS');
  const asset = (key: 'baseAsset' | 'quoteAsset'): string => {
    const v = s[key];
    if (typeof v !== 'string' || v === '') throw new Error(`parseSpotRules: ${sym} has no ${key}`);
    return v;
  };
  const count = (f: Filter, type: string, key: string): number => {
    const v = Number(f[key]);
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`parseSpotRules: ${sym} ${type}.${key} is not a positive integer (${f[key]})`);
    }
    return v;
  };
  return {
    symbol: sym,
    base: asset('baseAsset'),
    quote: asset('quoteAsset'),
    tickSize: D(pf.tickSize),
    minPrice: D(pf.minPrice),
    maxPrice: D(pf.maxPrice),
    stepSize: D(lot.stepSize),
    minQty: D(lot.minQty),
    maxQty: D(lot.maxQty),
    marketMinQty: D(mlot.minQty),
    marketMaxQty: D(mlot.maxQty),
    marketStepSize: D(mlot.stepSize),
    minNotional: D(nt.minNotional),
    maxNotional: D(nt.maxNotional),
    applyMinToMarket: Boolean(nt.applyMinToMarket),
    applyMaxToMarket: Boolean(nt.applyMaxToMarket),
    bidMultiplierUp: D(pp.bidMultiplierUp),
    bidMultiplierDown: D(pp.bidMultiplierDown),
    askMultiplierUp: D(pp.askMultiplierUp),
    askMultiplierDown: D(pp.askMultiplierDown),
    maxNumOrders: count(mno, 'MAX_NUM_ORDERS', 'maxNumOrders'),
    maxNumAlgoOrders: count(mna, 'MAX_NUM_ALGO_ORDERS', 'maxNumAlgoOrders'),
  };
}

/** The symbol's Binance trading status ('TRADING', 'BREAK', 'HALT', ...); throws when missing. */
export function parseSymbolStatus(symbolInfo: unknown): string {
  const s = symbolInfo as { symbol?: unknown; status?: unknown };
  if (typeof s?.status !== 'string' || s.status === '') {
    throw new Error(`parseSymbolStatus: ${String(s?.symbol)} has no status`);
  }
  return s.status;
}
