import type { Decimal } from '../decimal.ts';
import type { OrderType, Side } from '../types.ts';

export type StopType = 'stop_loss' | 'take_profit';

export function isStopType(type: OrderType): type is StopType {
  return type === 'stop_loss' || type === 'take_profit';
}

/**
 * Has the last trade price reached the trigger? Sell stop-loss: last ≤ trigger;
 * buy stop-loss: last ≥ trigger; sell take-profit: last ≥ trigger; buy take-profit: last ≤ trigger.
 */
export function isTriggered(type: StopType, side: Side, trigger: Decimal, last: Decimal): boolean {
  const triggersUpward = (type === 'stop_loss') === (side === 'buy');
  return triggersUpward ? last.gte(trigger) : last.lte(trigger);
}
