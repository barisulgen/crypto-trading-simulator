import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { ActionResult, Wallet } from '../types.ts';

export interface Balance {
  free: Decimal;
  locked: Decimal;
}

/** The account's wallets and the running total of money deposited, shared by every market engine. */
export interface Ledger {
  balances: Record<Wallet, Record<string, Balance>>;
  totalDeposited: Decimal;
}

/** Zero spot balances for every asset; the leverage wallet holds USDT only. */
export function emptyLedger(spotAssets: string[]): Ledger {
  const spot: Record<string, Balance> = {};
  for (const a of spotAssets) spot[a] = { free: D(0), locked: D(0) };
  return {
    balances: { spot, leverage: { USDT: { free: D(0), locked: D(0) } } },
    totalDeposited: D(0),
  };
}

/** The balance row for wallet/asset, created at zero if missing. */
export function balanceOf(l: Ledger, wallet: Wallet, asset: string): Balance {
  const rows = l.balances[wallet];
  let row = rows[asset];
  if (!row) {
    row = { free: D(0), locked: D(0) };
    rows[asset] = row;
  }
  return row;
}

/** Free balance of wallet/asset, read-only (never creates a row). */
export function freeOf(l: Ledger, wallet: Wallet, asset: string): Decimal {
  return l.balances[wallet][asset]?.free ?? D(0);
}

/** Move amount from free to locked. Caller has checked that free covers it. */
export function lockFunds(l: Ledger, wallet: Wallet, asset: string, amount: Decimal): void {
  const b = balanceOf(l, wallet, asset);
  b.free = b.free.minus(amount);
  b.locked = b.locked.plus(amount);
}

/** Move amount from locked back to free. */
export function releaseFunds(l: Ledger, wallet: Wallet, asset: string, amount: Decimal): void {
  const b = balanceOf(l, wallet, asset);
  b.locked = b.locked.minus(amount);
  b.free = b.free.plus(amount);
}

/**
 * Spend amount, taking it from the order's lock first and from free for any excess.
 * Returns the part of the lock left unspent (still locked; caller releases it).
 */
export function spendFunds(l: Ledger, wallet: Wallet, asset: string, amount: Decimal, lock: Decimal): Decimal {
  const b = balanceOf(l, wallet, asset);
  const fromLock = amount.lt(lock) ? amount : lock;
  b.locked = b.locked.minus(fromLock);
  b.free = b.free.minus(amount.minus(fromLock));
  return lock.minus(fromLock);
}

export function credit(l: Ledger, wallet: Wallet, asset: string, amount: Decimal): void {
  const b = balanceOf(l, wallet, asset);
  b.free = b.free.plus(amount);
}

export function deposit(l: Ledger, wallet: Wallet, amount: Decimal, ctx: { now: number }): ActionResult {
  if (!amount.isFinite() || !amount.gt(0)) return { ok: false, reason: 'Deposit must be greater than 0' };
  if (amount.decimalPlaces() > 2) return { ok: false, reason: 'Deposit has at most 2 decimals' };
  const b = balanceOf(l, wallet, 'USDT');
  b.free = b.free.plus(amount);
  l.totalDeposited = l.totalDeposited.plus(amount);
  return {
    ok: true,
    events: [{ type: 'deposit', time: ctx.now, wallet, amount, totalDeposited: l.totalDeposited }],
  };
}

/** Moves free USDT only; locked funds never move. Not a deposit. */
export function transfer(
  l: Ledger,
  from: Wallet,
  to: Wallet,
  amount: Decimal,
  ctx: { now: number },
): ActionResult {
  if (from === to) return { ok: false, reason: 'Choose two different wallets' };
  if (!amount.isFinite() || !amount.gt(0)) return { ok: false, reason: 'Transfer must be greater than 0' };
  const src = balanceOf(l, from, 'USDT');
  if (amount.gt(src.free)) {
    return {
      ok: false,
      reason: `Insufficient free USDT in ${from} wallet: need ${amount}, available ${src.free}`,
    };
  }
  const dst = balanceOf(l, to, 'USDT');
  src.free = src.free.minus(amount);
  dst.free = dst.free.plus(amount);
  return { ok: true, events: [{ type: 'transfer', time: ctx.now, from, to, amount }] };
}
