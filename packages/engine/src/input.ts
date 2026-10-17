import { D } from './decimal.ts';
import type { Decimal } from 'decimal.js';

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Parse a user-typed positive amount. Accepts one "." or "," as decimal separator. */
export function parseAmount(input: string): Decimal {
  const s = input.trim();
  if (s === '') throw new InputError('Enter an amount');
  if (!/^\d+([.,]\d+)?$/.test(s)) {
    throw new InputError(
      `Invalid amount "${s}": use digits with one "." or "," as decimal separator (no signs, exponents or thousands separators)`,
    );
  }
  const value = D(s.replace(',', '.'));
  if (!value.gt(0)) throw new InputError('Amount must be greater than 0');
  return value;
}
