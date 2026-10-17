// Display formatting for decimal strings. Money never becomes a JS number here: every helper
// rounds and groups the decimal string itself (half away from zero), so nothing is lost to floats.

const NUMERIC = /^([+-])?(\d+)(?:\.(\d*))?$/;
const DASH = '-';

type Value = string | null | undefined;

interface Parsed {
  negative: boolean;
  int: string;
  frac: string;
}

function parse(value: string): Parsed | null {
  const m = NUMERIC.exec(value.trim());
  if (!m) return null;
  return { negative: m[1] === '-', int: m[2]!, frac: m[3] ?? '' };
}

/** Add 1 to a string of decimal digits. */
function increment(digits: string): string {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '9') {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
    out[i] = '0';
  }
  return '1' + out.join('');
}

/** Round to `dp` decimals, half away from zero. Returns the integer and fraction digit strings. */
function round(p: Parsed, dp: number): { int: string; frac: string } {
  const frac = p.frac.padEnd(dp + 1, '0');
  let digits = p.int + frac.slice(0, dp);
  if (frac.charCodeAt(dp) >= 53 /* '5' */) digits = increment(digits);
  const cut = digits.length - dp;
  const int = digits.slice(0, cut).replace(/^0+(?=\d)/, '');
  return { int: int === '' ? '0' : int, frac: digits.slice(cut) };
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Rounded parts plus the sign as displayed (a value that rounds to zero has no sign). */
function rounded(value: string, dp: number): { sign: -1 | 0 | 1; int: string; frac: string } | null {
  const p = parse(value);
  if (!p) return null;
  const r = round(p, dp);
  const zero = /^0*$/.test(r.int + r.frac);
  return { sign: zero ? 0 : p.negative ? -1 : 1, ...r };
}

/** Number of decimals a tick or step size allows: '0.01000000' -> 2, '1.00000000' -> 0. */
export function tickDecimals(size: string): number {
  const p = parse(size);
  if (!p) return 0;
  return p.frac.replace(/0+$/, '').length;
}

/** A decimal string rounded to `dp` decimals, with thousands separators unless `group: false`. */
export function fmtNum(value: string, dp: number, opts: { group?: boolean } = {}): string {
  const r = rounded(value, dp);
  if (!r) return value;
  const int = opts.group === false ? r.int : group(r.int);
  return `${r.sign < 0 ? '-' : ''}${int}${dp > 0 ? '.' + r.frac : ''}`;
}

/** -1, 0 or 1: the sign of the value as shown with `dp` decimals (all decimals if omitted). */
export function signOf(value: Value, dp?: number): -1 | 0 | 1 {
  if (value === null || value === undefined) return 0;
  const p = parse(value);
  if (!p) return 0;
  return rounded(value, dp ?? p.frac.length)?.sign ?? 0;
}

// ---- per-symbol rules (set from GET /api/meta) ----

export interface SizeRules {
  tickSize: string;
  stepSize: string;
}

let rulesBySymbol: Record<string, SizeRules> = {};

export function setRules(rules: Record<string, SizeRules>): void {
  rulesBySymbol = rules;
}

/** Decimals of a value as given, trailing zeros trimmed (fallback before the rules load). */
function ownDecimals(value: string): number {
  const p = parse(value);
  return p ? Math.min(p.frac.replace(/0+$/, '').length, 8) : 0;
}

/** A price with the symbol's tick-size decimals. */
export function fmtPrice(symbol: string, value: Value): string {
  if (value === null || value === undefined) return DASH;
  const tick = rulesBySymbol[symbol]?.tickSize;
  return fmtNum(value, tick !== undefined ? tickDecimals(tick) : ownDecimals(value));
}

/** A coin quantity with the symbol's step-size decimals. */
export function fmtQty(symbol: string, value: Value): string {
  if (value === null || value === undefined) return DASH;
  const step = rulesBySymbol[symbol]?.stepSize;
  return fmtNum(value, step !== undefined ? tickDecimals(step) : ownDecimals(value));
}

/** US dollars: '$1,234.56', '-$12.35'; with `sign: true` gains get a '+'. */
export function fmtUsd(value: Value, opts: { sign?: boolean } = {}): string {
  if (value === null || value === undefined) return DASH;
  const r = rounded(value, 2);
  if (!r) return value;
  const prefix = r.sign < 0 ? '-' : r.sign > 0 && opts.sign ? '+' : '';
  return `${prefix}$${group(r.int)}.${r.frac}`;
}

/** A signed percentage with 2 decimals: '+2.35%', '-0.50%', '0.00%'. */
export function fmtPct(value: Value): string {
  if (value === null || value === undefined) return DASH;
  const r = rounded(value, 2);
  if (!r) return value;
  return `${r.sign < 0 ? '-' : r.sign > 0 ? '+' : ''}${group(r.int)}.${r.frac}%`;
}
