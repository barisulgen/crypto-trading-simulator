// Holdings and order figures for the bottom tabs, computed exactly on decimal strings (display only).
import type { AccountSnapshot } from './api.ts';
import { cmpDec, divDec, pctOf, subDec } from './market.ts';

export interface HoldingRow {
  asset: string;
  symbol: string;
  /** Spot holding, free + locked. */
  qty: string;
  free: string;
  locked: string;
  /** Best bid ('0' when there is none). */
  bid: string;
  /** qty x best bid, as the server values it. */
  value: string;
  /** False when the bid is stale or missing. */
  fresh: boolean;
  /** USDT paid for the holding, fees included; null without a cost basis. */
  cost: string | null;
  /** cost / qty with the symbol's price decimals. */
  avgCost: string | null;
  /** Value at bid minus cost; null without a bid or a cost basis. */
  pnl: string | null;
  /** pnl as a percentage of cost, 2 decimals. */
  pnlPct: string | null;
}

/**
 * One row per coin held (the server's order), with average cost and unrealised P&L at the best
 * bid. `priceDp` gives a symbol's price decimals (its tick size).
 */
export function holdingRows(account: AccountSnapshot, priceDp: (symbol: string) => number): HoldingRow[] {
  return account.coins.map((c) => {
    const symbol = `${c.asset}USDT`;
    const wallet = account.balances.spot[c.asset];
    const basis = account.basis[c.asset];
    const hasBasis = basis !== undefined && cmpDec(basis.qty, '0') > 0;
    const hasBid = cmpDec(c.bid, '0') > 0;
    const cost = hasBasis ? basis.cost : null;
    const pnl = cost !== null && hasBid ? subDec(c.value, cost) : null;
    return {
      asset: c.asset,
      symbol,
      qty: c.qty,
      free: wallet?.free ?? '0',
      locked: wallet?.locked ?? '0',
      bid: c.bid,
      value: c.value,
      fresh: c.fresh,
      cost,
      avgCost: hasBasis ? divDec(basis.cost, basis.qty, priceDp(symbol)) : null,
      pnl,
      pnlPct: pnl !== null && cost !== null && cmpDec(cost, '0') !== 0 ? pctOf(pnl, cost) : null,
    };
  });
}

/** Average fill price of an order (filled quote / filled qty) with `dp` decimals; null before any fill. */
export function avgFill(filledQuote: string, filledQty: string, dp: number): string | null {
  return cmpDec(filledQty, '0') > 0 ? divDec(filledQuote, filledQty, dp) : null;
}
