// Holdings and order figures for the bottom tabs, computed exactly on decimal strings (display only).
import type { AccountSnapshot } from './api.ts';
import { cmpDec, divDec, fmtClock, pctOf, subDec } from './market.ts';

export interface HoldingRow {
  asset: string;
  symbol: string;
  /** Spot holding, free + locked. */
  qty: string;
  free: string;
  locked: string;
  /** Best bid; while stale, the last real one received ('0' when there has been none). */
  bid: string;
  /** qty x best bid, as the server values it. */
  value: string;
  /** False when the bid is stale or missing. */
  fresh: boolean;
  /** False when the coin has had no bid since the server started (its value is a placeholder 0). */
  priced: boolean;
  /** When the bid was received (ms), null when unknown. */
  bidAt: number | null;
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
      priced: hasBid,
      bidAt: c.bidAt,
      cost,
      avgCost: hasBasis ? divDec(basis.cost, basis.qty, priceDp(symbol)) : null,
      pnl,
      pnlPct: pnl !== null && cost !== null && cmpDec(cost, '0') !== 0 ? pctOf(pnl, cost) : null,
    };
  });
}

/** Tooltip for a holding's value: none while live, else where the number comes from. */
export function valueTitle(h: HoldingRow): string | undefined {
  if (h.fresh) return undefined;
  if (!h.priced) return 'No price yet';
  return h.bidAt === null
    ? 'Last real bid — live data interrupted'
    : `Last real bid at ${fmtClock(h.bidAt)} — live data interrupted`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * 'Prices paused (1 coin, 2 positions)' while any held coin is valued without a live bid or any
 * open position without a live mark, else null.
 */
export function pricesPausedLabel(account: AccountSnapshot): string | null {
  const coins = account.pricesPaused.length;
  const positions = account.marksPaused?.length ?? 0;
  if (coins === 0 && positions === 0) return null;
  const parts = [coins > 0 && count(coins, 'coin', 'coins'), positions > 0 && count(positions, 'position', 'positions')];
  return `Prices paused (${parts.filter(Boolean).join(', ')})`;
}

/**
 * True while something counted in the total has never been priced since the server started: a
 * held coin with no bid (as for its holdings row, `priced` false: its value is a placeholder 0) or
 * an open position with no mark (it counts as its margin only), or the server says so. Total value
 * and net P&L would then show a figure that is not real. (A coin or position priced earlier that is
 * now stale is a different case: 'Prices paused'.)
 */
export function pricesLoading(account: AccountSnapshot): boolean {
  if (account.pricesLoading) return true;
  if (account.coins.some((c) => cmpDec(c.qty, '0') > 0 && cmpDec(c.bid, '0') <= 0)) return true;
  return (account.leverage?.positions ?? []).some((p) => p.markPrice === null);
}

/** Average fill price of an order (filled quote / filled qty) with `dp` decimals; null before any fill. */
export function avgFill(filledQuote: string, filledQty: string, dp: number): string | null {
  return cmpDec(filledQty, '0') > 0 ? divDec(filledQuote, filledQty, dp) : null;
}
