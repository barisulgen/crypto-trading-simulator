import { D, Decimal } from '../decimal.ts';
import { trackFundingWindow } from './funding.ts';
import { bracketsOrNull } from './market.ts';
import { liquidationPrice, liquidationSplit, maintenanceMargin, marginBalance, marginRatio } from './math.ts';
import { cancelOrder, liveOrders, remainingQty } from './orders.ts';
import { positionClosed } from './position.ts';
import type { PerpState } from './state.ts';
import type { Bracket, MarginWarning, PerpCtx, PerpEvent, PerpRules, Position, WarnLevel } from './types.ts';

/** Liquidation and margin-ratio warnings, judged on the mark price only. */

/**
 * How a margin model judges a symbol's position at a mark price: its margin ratio and whether it is
 * liquidated. `brackets` is null before the leverage tiers have loaded. Null when the symbol has no
 * position, or when the position cannot be judged without the tiers.
 */
export interface LiquidationModel {
  evaluate(
    state: PerpState,
    symbol: string,
    mark: Decimal,
    brackets: Bracket[] | null,
  ): { liquidate: boolean; ratio: Decimal } | null;
}

/**
 * Isolated margin: the position's own margin balance (margin plus unrealised P&L at the mark)
 * against its maintenance margin. A balance at or below the maintenance margin liquidates. Without
 * the tiers the maintenance margin is unknown but never negative, so a balance at or below 0 still
 * liquidates (its ratio is infinite); a positive one cannot be judged.
 */
export const isolatedModel: LiquidationModel = {
  evaluate(state, symbol, mark, brackets) {
    const p = state.positions[symbol];
    if (!p) return null;
    const balance = marginBalance(p.margin, p.side, p.qty, p.entryPrice, mark);
    if (!brackets) return balance.lte(0) ? { liquidate: true, ratio: D(Infinity) } : null;
    const maintenance = maintenanceMargin(brackets, p.qty, mark);
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
 * remainder; the leverage wallet is not touched. With the fee rate unknown (null), everything left
 * after the trading loss is booked as the fee. A no-op without a position.
 */
export function liquidate(
  s: PerpState,
  symbol: string,
  price: Decimal,
  feeRate: Decimal | null,
  ctx: PerpCtx,
): PerpEvent[] {
  const held = s.positions[symbol];
  if (!held) return [];
  const events: PerpEvent[] = [];
  const cancelledOrderIds: string[] = [];
  for (const o of liveOrders(s, symbol)) {
    events.push(...cancelOrder(s, o, 'liquidation', remainingQty(o), ctx));
    cancelledOrderIds.push(o.id);
  }
  delete s.positions[symbol];
  trackFundingWindow(s, symbol);

  const known = liquidationSplit({
    margin: held.margin,
    side: held.side,
    qty: held.qty,
    entry: held.entryPrice,
    mark: price,
    feeRate: feeRate ?? D(0),
  });
  const split = feeRate !== null ? known : { ...known, liquidationFee: known.remainder, remainder: D(0) };
  events.push({
    type: 'liquidation',
    market: 'perp',
    time: ctx.now,
    symbol,
    position: held,
    markPrice: price,
    marginLost: held.margin,
    ...split,
    feeRateKnown: feeRate !== null,
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
 * Liquidate the symbol's position at `liquidationPrice`, its own, for when the mark is known only
 * to have reached that price within a span (a 1-minute mark candle), not where it was at any
 * moment: the price is used as the mark, rounded to 8 decimals against the owner (down for a long,
 * up for a short). A no-op without a position.
 */
export function liquidateAtLiquidationPrice(
  s: PerpState,
  symbol: string,
  liquidationPrice: Decimal,
  ctx: PerpCtx,
): PerpEvent[] {
  const held = s.positions[symbol];
  if (!held) return [];
  const mark = liquidationPrice.toDecimalPlaces(8, held.side === 'long' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP);
  return liquidate(s, symbol, mark, rulesOrNull(symbol, ctx)?.liquidationFee ?? null, ctx);
}

/**
 * Liquidate the symbol's position if a span's mark prices reached its liquidation price: a long's
 * lowest mark at or below it, a short's highest at or above it. Only the range is known, not where
 * the mark was at any moment, so the liquidation price is used as the mark
 * (liquidateAtLiquidationPrice). [] without a position, or for one that can never be liquidated.
 */
export function liquidateOnMarkRange(
  s: PerpState,
  symbol: string,
  low: Decimal,
  high: Decimal,
  brackets: Bracket[],
  ctx: PerpCtx,
): PerpEvent[] {
  const p = s.positions[symbol];
  if (!p) return [];
  const lp = liquidationPrice(brackets, p.side, p.qty, p.entryPrice, p.margin);
  if (lp === null) return [];
  if (p.side === 'long' ? low.gt(lp) : high.lt(lp)) return [];
  return liquidateAtLiquidationPrice(s, symbol, lp, ctx);
}

/**
 * A mark price for the symbol: liquidate the position if the model says so, otherwise update its
 * warning level and return the warning it gives, if any. A due liquidation never waits for the
 * rules: without them the fee rate is unknown, which changes only how the lost margin is split.
 * Without the tiers, only a position the model can judge without them is liquidated, and no
 * warning is given. The caller has checked that the mark is fresh.
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
  if (!held || mark.lte(0)) return none;
  const brackets = bracketsOrNull(symbol, ctx);
  const verdict = model.evaluate(s, symbol, mark, brackets);
  if (!verdict) return none;

  if (verdict.liquidate) {
    const feeRate = rulesOrNull(symbol, ctx)?.liquidationFee ?? null;
    return { events: liquidate(s, symbol, mark, feeRate, ctx), warnings: [] };
  }
  if (!brackets) return none;

  const next = nextWarning(held.warnLevel, verdict.ratio);
  if (next.warnLevel !== held.warnLevel) s.positions[symbol] = { ...held, warnLevel: next.warnLevel };
  if (next.level === null) return none;
  const warning: MarginWarning = {
    symbol,
    positionId: held.id,
    side: held.side,
    level: next.level,
    ratio: verdict.ratio,
    markPrice: mark,
    liquidationPrice: liquidationPrice(brackets, held.side, held.qty, held.entryPrice, held.margin),
  };
  return { events: [], warnings: [warning] };
}
