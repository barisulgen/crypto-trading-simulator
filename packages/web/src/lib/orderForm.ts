// The order form's pure parts: what it sends for each order type, which field is still blank,
// and a guard so only the latest preview request's answer is shown.
import type { OrderType, Side, SpotOrderRequest } from '@sim/engine';
import type { WirePreview } from './api.ts';
import { addDec } from './market.ts';

export interface OrderFormFields {
  symbol: string;
  side: Side;
  type: OrderType;
  /** The amount is a coin quantity ('coin', sent as qty) or dollars ('usd', sent as quoteQty). */
  amountIn: 'coin' | 'usd';
  amount: string;
  /** Limit price (limit, post-only). */
  price: string;
  /** Trigger price (stop-loss, take-profit). */
  trigger: string;
  /** Attach a stop-loss / take-profit pair (buys only, not to stops). */
  attach: boolean;
  stopLoss: string;
  takeProfit: string;
}

export const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'post_only', label: 'Post-only' },
  { value: 'stop_loss', label: 'Stop-loss' },
  { value: 'take_profit', label: 'Take-profit' },
];

export function hasPrice(type: OrderType): boolean {
  return type === 'limit' || type === 'post_only';
}

export function hasTrigger(type: OrderType): boolean {
  return type === 'stop_loss' || type === 'take_profit';
}

/** A stop-loss / take-profit pair can be attached to market, limit and post-only buys. */
export function canAttach(f: Pick<OrderFormFields, 'side' | 'type'>): boolean {
  return f.side === 'buy' && !hasTrigger(f.type);
}

/**
 * The request for POST /api/orders and /api/orders/preview. Every value goes out exactly as the
 * owner typed it (the server parses '1,5'); only the fields the order type uses are sent.
 */
export function buildOrderRequest(f: OrderFormFields): SpotOrderRequest {
  const req: SpotOrderRequest = { symbol: f.symbol, side: f.side, type: f.type };
  if (f.amountIn === 'coin') req.qty = f.amount;
  else req.quoteQty = f.amount;
  if (hasPrice(f.type)) req.price = f.price;
  if (hasTrigger(f.type)) req.triggerPrice = f.trigger;
  if (f.attach && canAttach(f)) req.attach = { stopLoss: f.stopLoss, takeProfit: f.takeProfit };
  return req;
}

/** Whether a preview request (JSON from buildOrderRequest) is for this form's symbol, side and type. */
export function previewMatches(key: string | null, f: OrderFormFields): boolean {
  if (key === null) return false;
  try {
    const r = JSON.parse(key) as Partial<SpotOrderRequest>;
    return r.symbol === f.symbol && r.side === f.side && r.type === f.type;
  } catch {
    return false;
  }
}

const blank = (v: string) => v.trim() === '';

/** What the owner still has to type, or null when every field the order needs is filled in. */
export function missingInput(f: OrderFormFields): string | null {
  if (blank(f.amount)) return 'Enter an amount';
  if (hasPrice(f.type) && blank(f.price)) return 'Enter a limit price';
  if (hasTrigger(f.type) && blank(f.trigger)) return 'Enter a trigger price';
  if (f.attach && canAttach(f)) {
    if (blank(f.stopLoss)) return 'Enter a stop-loss price';
    if (blank(f.takeProfit)) return 'Enter a take-profit price';
  }
  return null;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Latest-request guard: `run` resolves with the outcome only if no later `run` (or `cancel`)
 * happened meanwhile, otherwise with null, so a slow old answer never replaces a newer one.
 */
export function createLatest() {
  let seq = 0;
  return {
    async run<T>(p: Promise<T>): Promise<Outcome<T> | null> {
      const id = ++seq;
      let outcome: Outcome<T>;
      try {
        outcome = { ok: true, value: await p };
      } catch (error) {
        outcome = { ok: false, error };
      }
      return id === seq ? outcome : null;
    },
    cancel(): void {
      seq++;
    },
  };
}

/**
 * What an exhausted preview can still fill: a buy, the coins it receives plus the fee (paid in
 * the coin); a sell, the dollars it raises before the fee. Null when nothing is fillable.
 */
export function fillable(p: WirePreview, side: Side): { amount: string; unit: 'coin' | 'usd' } | null {
  const fee = p.fee.amount ?? '0';
  if (side === 'buy') return p.receive === null ? null : { amount: addDec(p.receive, fee), unit: 'coin' };
  return p.total === null ? null : { amount: addDec(p.total, fee), unit: 'usd' };
}
