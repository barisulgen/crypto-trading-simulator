import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export function D(x: Decimal.Value): Decimal {
  return new Decimal(x);
}

/** Round x down to a multiple of step. A step of 0 means "no step". */
export function floorToStep(x: Decimal, step: Decimal): Decimal {
  if (step.isZero()) return x;
  return x.div(step).floor().mul(step);
}

/** True if x is an exact multiple of step. A step of 0 means "no step". */
export function isMultipleOf(x: Decimal, step: Decimal): boolean {
  if (step.isZero()) return true;
  return x.mod(step).isZero();
}

/** Round up (away from zero for positives) to 8 decimal places. */
export function roundUp8(x: Decimal): Decimal {
  return x.toDecimalPlaces(8, Decimal.ROUND_UP);
}
