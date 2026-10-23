import { D } from './decimal.ts';
import type { Decimal } from 'decimal.js';

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Bounds that keep every later product and sum far inside the decimal precision (40 digits). */
const MAX_INT_DIGITS = 15;
const MAX_DECIMALS = 18;

/** Parse a user-typed positive amount. Accepts one "." or "," as decimal separator. */
export function parseAmount(input: string): Decimal {
  const s = input.trim();
  if (s === '') throw new InputError('Enter an amount');
  if (!/^\d+([.,]\d+)?$/.test(s)) {
    throw new InputError(
      `Invalid amount "${s}": use digits with one "." or "," as decimal separator (no signs, exponents or thousands separators)`,
    );
  }
  const [int = '', frac = ''] = s.replace(',', '.').split('.');
  if (int.replace(/^0+/, '').length > MAX_INT_DIGITS) {
    throw new InputError(`Amount too large: at most ${MAX_INT_DIGITS} digits before the decimal point`);
  }
  if (frac.length > MAX_DECIMALS) throw new InputError(`Too many decimals: at most ${MAX_DECIMALS}`);
  const value = D(s.replace(',', '.'));
  if (!value.gt(0)) throw new InputError('Amount must be greater than 0');
  return value;
}
