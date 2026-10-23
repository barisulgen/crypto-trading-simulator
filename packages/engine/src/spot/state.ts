import type { Decimal } from '../decimal.ts';
import * as ledger from '../account/ledger.ts';
import type { Balance, Ledger } from '../account/ledger.ts';
import type { Basis, SpotOrder, Wallet } from '../types.ts';

export type { Balance };

export interface SpotState {
  /** The account's wallets, shared with every other market engine. */
  ledger: Ledger;
  /** Every order seen this session, terminal ones included. */
  orders: Map<string, SpotOrder>;
  basis: Record<string, Basis>;
  /** Per symbol, the id of the last AggTrade processed; older or repeated trades are ignored. */
  lastTradeId: Record<string, number>;
}

/** Empty spot state over the given ledger. */
export function emptySpotState(l: Ledger): SpotState {
  return { ledger: l, orders: new Map(), basis: {}, lastTradeId: {} };
}

/** The balance row for wallet/asset, created at zero if missing. */
export function balanceOf(state: SpotState, wallet: Wallet, asset: string): Balance {
  return ledger.balanceOf(state.ledger, wallet, asset);
}

/** Free balance of wallet/asset, read-only (never creates a row). */
export function freeOf(state: SpotState, wallet: Wallet, asset: string): Decimal {
  return ledger.freeOf(state.ledger, wallet, asset);
}

/** Move amount from free to locked. Caller has checked that free covers it. */
export function lockFunds(state: SpotState, asset: string, amount: Decimal): void {
  ledger.lockFunds(state.ledger, 'spot', asset, amount);
}

/** Move amount from locked back to free. */
export function releaseFunds(state: SpotState, asset: string, amount: Decimal): void {
  ledger.releaseFunds(state.ledger, 'spot', asset, amount);
}

/**
 * Spend amount, taking it from the order's lock first and from free for any excess.
 * Returns the part of the lock left unspent (still locked; caller releases it).
 */
export function spendFunds(state: SpotState, asset: string, amount: Decimal, lock: Decimal): Decimal {
  return ledger.spendFunds(state.ledger, 'spot', asset, amount, lock);
}

export function credit(state: SpotState, asset: string, amount: Decimal): void {
  ledger.credit(state.ledger, 'spot', asset, amount);
}
