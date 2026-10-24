import type { Decimal } from '../decimal.ts';
import * as ledger from '../account/ledger.ts';
import type { Ledger } from '../account/ledger.ts';
import type { OrderStatus } from '../types.ts';
import { maxLeverage } from './tiers.ts';
import type { Bracket, PerpOrder, Position } from './types.ts';

/** Leverage used on a symbol until the owner sets one, capped at the symbol's maximum. */
export const DEFAULT_LEVERAGE = 20;

/** Sizes held on one side during a funding window. */
export interface FundingSide {
  /** The largest size held at any moment of the window: what a payer pays on. */
  max: Decimal;
  /** The smallest size held at any moment of the window: what a receiver receives on. */
  min: Decimal;
  /** The last position held on this side during the window; null if none was. */
  positionId: string | null;
}

/** The sizes held around one funding time, from 15 s before it to 15 s after. */
export interface FundingWindow {
  symbol: string;
  fundingTime: number;
  long: FundingSide;
  short: FundingSide;
}

export interface FundingState {
  /** Open windows, per symbol. */
  windows: Record<string, FundingWindow>;
  /** Closed windows waiting for their settled rate. */
  pending: FundingWindow[];
  /** Per symbol, the funding times already applied. */
  applied: Record<string, number[]>;
}

export interface PerpSettings {
  leverage: number;
  marginMode: 'isolated';
}

export interface PerpState {
  /** The account's wallets, shared with every other market engine; perps use the leverage wallet's USDT. */
  ledger: Ledger;
  /**
   * Live orders, plus finished ones until they are saved (evictTerminal); a finished order whose
   * owner cancel is still in flight stays until that cancel is answered.
   */
  orders: Map<string, PerpOrder>;
  /** Open positions, one per symbol at most. */
  positions: Record<string, Position>;
  settings: Record<string, PerpSettings>;
  /** Per symbol, the id of the last futures AggTrade processed. */
  lastTradeId: Record<string, number>;
  /** Ids of the orders changed since the last takeDirty: what the next save writes. */
  dirty: Set<string>;
  funding: FundingState;
}

/** Empty perp state over the given ledger. */
export function emptyPerpState(l: Ledger): PerpState {
  return {
    ledger: l,
    orders: new Map(),
    positions: {},
    settings: {},
    lastTradeId: {},
    dirty: new Set(),
    funding: { windows: {}, pending: [], applied: {} },
  };
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set(['filled', 'cancelled', 'rejected']);

/** Store the order and mark it changed. Every engine change to an order goes through here. */
export function putOrder(state: PerpState, order: PerpOrder): void {
  state.orders.set(order.id, order);
  state.dirty.add(order.id);
}

/** The ids of the orders changed since the last call; the set is cleared. */
export function takeDirty(state: PerpState): string[] {
  const ids = [...state.dirty];
  state.dirty.clear();
  return ids;
}

/**
 * Drop finished orders (filled, cancelled, rejected) from memory once they are saved. One whose
 * owner cancel is still in flight is kept until that cancel is answered.
 */
export function evictTerminal(state: PerpState): void {
  for (const [id, o] of state.orders) {
    if (TERMINAL.has(o.status) && o.cancelArrivesAt === null) state.orders.delete(id);
  }
}

/**
 * The symbol's leverage setting, or the default capped at the symbol's maximum. Before the leverage
 * tiers have loaded (brackets null) the maximum is unknown and the default is returned as it is.
 */
export function leverageFor(state: PerpState, symbol: string, brackets: Bracket[] | null): number {
  const setting = state.settings[symbol]?.leverage;
  if (setting !== undefined) return setting;
  return brackets ? Math.min(DEFAULT_LEVERAGE, maxLeverage(brackets)) : DEFAULT_LEVERAGE;
}

// ---- leverage wallet (USDT) ----

const WALLET = 'leverage';
const USDT = 'USDT';

export function freeUsdt(state: PerpState): Decimal {
  return ledger.freeOf(state.ledger, WALLET, USDT);
}

/** Move amount from free to locked. Caller has checked that free covers it. */
export function lockUsdt(state: PerpState, amount: Decimal): void {
  ledger.lockFunds(state.ledger, WALLET, USDT, amount);
}

/** Move amount from locked back to free. */
export function releaseUsdt(state: PerpState, amount: Decimal): void {
  ledger.releaseFunds(state.ledger, WALLET, USDT, amount);
}

/**
 * Spend amount, taking it from the order's lock first and from free for any excess.
 * Returns the part of the lock left unspent (still locked; caller releases it).
 */
export function spendUsdt(state: PerpState, amount: Decimal, lock: Decimal): Decimal {
  return ledger.spendFunds(state.ledger, WALLET, USDT, amount, lock);
}

export function creditUsdt(state: PerpState, amount: Decimal): void {
  ledger.credit(state.ledger, WALLET, USDT, amount);
}

/** Take amount out of free USDT. Caller has checked that free covers it. */
export function debitUsdt(state: PerpState, amount: Decimal): void {
  ledger.credit(state.ledger, WALLET, USDT, amount.neg());
}
