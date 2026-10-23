import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { Bracket } from './types.ts';

/**
 * The bracket whose [floor, cap) holds the notional. Above the last cap the last bracket applies;
 * below the first floor, the first. Relies on the brackets being ascending and contiguous from 0.
 */
export function bracketFor(brackets: Bracket[], notional: Decimal): Bracket {
  const first = brackets[0];
  if (!first) throw new Error('No leverage brackets');
  for (const b of brackets) {
    if (notional.lt(b.cap)) return b;
  }
  return brackets[brackets.length - 1] ?? first;
}

/** The highest leverage the symbol allows, which is the first bracket's. */
export function maxLeverage(brackets: Bracket[]): number {
  const first = brackets[0];
  if (!first) throw new Error('No leverage brackets');
  return first.maxLeverage;
}

/** The largest position notional open at this leverage: the cap of the last bracket that allows it, or 0 if none does. */
export function maxNotionalAt(brackets: Bracket[], leverage: number): Decimal {
  let cap = D(0);
  for (const b of brackets) {
    if (b.maxLeverage >= leverage) cap = b.cap;
  }
  return cap;
}
