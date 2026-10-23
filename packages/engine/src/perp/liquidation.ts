import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import { bracketsOrNull } from './market.ts';
import { liquidationPrice, liquidationSplit, maintenanceMargin, marginBalance, marginRatio } from './math.ts';
import { cancelOrder, liveOrders, remainingQty } from './orders.ts';
import { positionClosed } from './position.ts';
import type { PerpState } from './state.ts';
import type { Bracket, MarginWarning, PerpCtx, PerpEvent, PerpRules, Position, WarnLevel } from './types.ts';

/** Liquidation and margin-ratio warnings, judged on the mark price only. */

/**
 * How a margin model judges a symbol's position at a mark price: its margin ratio and whether it is
 * liquidated. Null when the symbol has no position.
 */
export interface LiquidationModel {
  evaluate(
    state: PerpState,
    symbol: string,
    mark: Decimal,
    brackets: Bracket[],
  ): { liquidate: boolean; ratio: Decimal } | null;
}

/**
 * Isolated margin: the position's own margin balance (margin plus unrealised P&L at the mark)
 * against its maintenance margin. A balance at or below the maintenance margin liquidates.
 */
export const isolatedModel: LiquidationModel = {
  evaluate(state, symbol, mark, brackets) {
    const p = state.positions[symbol];
    if (!p) return null;
    const maintenance = maintenanceMargin(brackets, p.qty, mark);
    const balance = marginBalance(p.margin, p.side, p.qty, p.entryPrice, mark);
    return { liquidate: balance.lte(maintenance), ratio: marginRatio(maintenance, balance) };
  },
};

const LEVELS: readonly WarnLevel[] = [0.5, 0.8, 0.9];
/** How far below a level the ratio must fall before that level can warn again. */
const REARM = D('0.05');

/**
 * The warning a margin ratio gives a position whose warnLevel is `current`, and the warnLevel after
 * it. Each level already given stays given until the ratio falls REARM below it; the ratio then
 * warns once at the highest level it reaches above what is still given.
 */
export function nextWarning(current: Position['warnLevel'], ratio: Decimal): {
  warnLevel: Position['warnLevel'];
  level: WarnLevel | null;
} {
  let given: Position['warnLevel'] = 0;
  let reached: WarnLevel | null = null;
  for (const l of LEVELS) {
    if (l <= current && ratio.gte(D(l).minus(REARM))) given = l;
    if (ratio.gte(l)) reached = l;
  }
  if (reached !== null && reached > given) return { warnLevel: reached, level: reached };
  return { warnLevel: given, level: null };
}

function rulesOrNull(symbol: string, ctx: PerpCtx): PerpRules | null {
  try {
    return ctx.market.rules(symbol);
  } catch {
    return null;
  }
}

/**
 * Liquidate the symbol's position at `price`: cancel every live order on the symbol (reason
 * liquidation, releasing its lock), remove the position and report the loss. The whole isolated
 * margin is lost, split into the trading loss at `price`, the liquidation fee at `feeRate` and the
 * remainder; the leverage wallet is not touched. A no-op without a position.
 */
export function liquidate(s: PerpState, symbol: string, price: Decimal, feeRate: Decimal, ctx: PerpCtx): PerpEvent[] {
  const held = s.positions[symbol];
  if (!held) return [];
  const events: PerpEvent[] = [];
  const cancelledOrderIds: string[] = [];
  for (const o of liveOrders(s, symbol)) {
    events.push(...cancelOrder(s, o, 'liquidation', remainingQty(o), ctx));
    cancelledOrderIds.push(o.id);
  }
  delete s.positions[symbol];

  const split = liquidationSplit({
    margin: held.margin,
    side: held.side,
    qty: held.qty,
    entry: held.entryPrice,
    mark: price,
    feeRate,
  });
  events.push({
    type: 'liquidation',
    market: 'perp',
    time: ctx.now,
    symbol,
    position: held,
    markPrice: price,
    marginLost: held.margin,
    ...split,
    cancelledOrderIds,
  });
  // The remainder is lost with the trading loss, so realised P&L − fees + funding is still what
  // the position cost the owner.
  const closed: Position = {
    ...held,
    qty: D(0),
    margin: D(0),
    realizedPnl: held.realizedPnl.minus(split.tradingLoss).minus(split.remainder),
    fees: held.fees.plus(split.liquidationFee),
  };
  events.push(...positionClosed(s, closed, price, 'liquidated', ctx));
  return events;
}

/**
 * A mark price for the symbol: liquidate the position if the model says so, otherwise update its
 * warning level and return the warning it gives, if any. Needs the leverage tiers (and, to
 * liquidate, the liquidation fee rate from the rules); without them nothing changes until a later
 * mark. The caller has checked that the mark is fresh.
 */
export function checkMark(
  s: PerpState,
  symbol: string,
  mark: Decimal,
  model: LiquidationModel,
  ctx: PerpCtx,
): { events: PerpEvent[]; warnings: MarginWarning[] } {
  const none = { events: [], warnings: [] };
  const held = s.positions[symbol];
  const brackets = bracketsOrNull(symbol, ctx);
  if (!held || !brackets || mark.lte(0)) return none;
  const verdict = model.evaluate(s, symbol, mark, brackets);
  if (!verdict) return none;

  if (verdict.liquidate) {
    const rules = rulesOrNull(symbol, ctx);
    if (!rules) return none;
    return { events: liquidate(s, symbol, mark, rules.liquidationFee, ctx), warnings: [] };
  }

  const next = nextWarning(held.warnLevel, verdict.ratio);
  if (next.warnLevel !== held.warnLevel) s.positions[symbol] = { ...held, warnLevel: next.warnLevel };
  if (next.level === null) return none;
  const warning: MarginWarning = {
    symbol,
    positionId: held.id,
    level: next.level,
    ratio: verdict.ratio,
    markPrice: mark,
    liquidationPrice: liquidationPrice(brackets, held.side, held.qty, held.entryPrice, held.margin),
  };
  return { events: [], warnings: [warning] };
}
