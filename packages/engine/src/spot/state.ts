import type { Decimal } from '../decimal.ts';
import * as ledger from '../account/ledger.ts';
import type { Balance, Ledger } from '../account/ledger.ts';
import type { Basis, OrderStatus, SpotOrder, Wallet } from '../types.ts';

export type { Balance };

export interface SpotState {
  /** The account's wallets, shared with every other market engine. */
  ledger: Ledger;
  /**
   * Live orders, plus finished ones until they are saved (evictTerminal); a finished order whose
   * owner cancel is still in flight stays until that cancel is answered.
   */
  orders: Map<string, SpotOrder>;
  /** Ids of the orders changed since the last takeDirty: what the next save writes. */
  dirty: Set<string>;
  basis: Record<string, Basis>;
  /** Per symbol, the id of the last AggTrade processed; older or repeated trades are ignored. */
  lastTradeId: Record<string, number>;
}

/** Empty spot state over the given ledger. */
export function emptySpotState(l: Ledger): SpotState {
  return { ledger: l, orders: new Map(), dirty: new Set(), basis: {}, lastTradeId: {} };
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set(['filled', 'cancelled', 'rejected']);

/** Store the order and mark it changed. Every engine change to an order goes through here. */
export function putOrder(state: SpotState, order: SpotOrder): void {
  state.orders.set(order.id, order);
  state.dirty.add(order.id);
}

/** The ids of the orders changed since the last call; the set is cleared. */
export function takeDirty(state: SpotState): string[] {
  const ids = [...state.dirty];
  state.dirty.clear();
  return ids;
}

/**
 * Drop finished orders (filled, cancelled, rejected) from memory once they are saved. One whose
 * owner cancel is still in flight is kept: when that cancel arrives it is answered as too late
 * (cancel_rejected), which clears it, and the next call drops the order.
 */
export function evictTerminal(state: SpotState): void {
  for (const [id, o] of state.orders) {
    if (TERMINAL.has(o.status) && o.cancelArrivesAt === null) state.orders.delete(id);
  }
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
