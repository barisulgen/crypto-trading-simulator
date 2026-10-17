import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { Basis, SpotOrder, Wallet } from '../types.ts';

export interface Balance {
  free: Decimal;
  locked: Decimal;
}

export interface SpotState {
  balances: Record<Wallet, Record<string, Balance>>;
  /** Every order seen this session, terminal ones included. */
  orders: Map<string, SpotOrder>;
  basis: Record<string, Basis>;
  totalDeposited: Decimal;
}

/** Zero spot balances for every asset; the leverage wallet holds USDT only. */
export function emptySpotState(assets: string[]): SpotState {
  const spot: Record<string, Balance> = {};
  for (const a of assets) spot[a] = { free: D(0), locked: D(0) };
  return {
    balances: { spot, leverage: { USDT: { free: D(0), locked: D(0) } } },
    orders: new Map(),
    basis: {},
    totalDeposited: D(0),
  };
}

/** The balance row for wallet/asset, created at zero if missing. */
export function balanceOf(state: SpotState, wallet: Wallet, asset: string): Balance {
  const rows = state.balances[wallet];
  let row = rows[asset];
  if (!row) {
    row = { free: D(0), locked: D(0) };
    rows[asset] = row;
  }
  return row;
}

/** Move amount from free to locked. Caller has checked that free covers it. */
export function lockFunds(state: SpotState, asset: string, amount: Decimal): void {
  const b = balanceOf(state, 'spot', asset);
  b.free = b.free.minus(amount);
  b.locked = b.locked.plus(amount);
}

/** Move amount from locked back to free. */
export function releaseFunds(state: SpotState, asset: string, amount: Decimal): void {
  const b = balanceOf(state, 'spot', asset);
  b.locked = b.locked.minus(amount);
  b.free = b.free.plus(amount);
}

/**
 * Spend amount, taking it from the order's lock first and from free for any excess.
 * Returns the part of the lock left unspent (still locked; caller releases it).
 */
export function spendFunds(state: SpotState, asset: string, amount: Decimal, lock: Decimal): Decimal {
  const b = balanceOf(state, 'spot', asset);
  const fromLock = amount.lt(lock) ? amount : lock;
  b.locked = b.locked.minus(fromLock);
  b.free = b.free.minus(amount.minus(fromLock));
  return lock.minus(fromLock);
}

export function credit(state: SpotState, asset: string, amount: Decimal): void {
  const b = balanceOf(state, 'spot', asset);
  b.free = b.free.plus(amount);
}
