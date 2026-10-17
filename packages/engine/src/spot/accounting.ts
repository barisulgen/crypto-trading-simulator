import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { Basis, EngineCtx, EngineEvent, Fill, RoundTrip, SpotOrder, SpotRules } from '../types.ts';
import type { SpotState } from './state.ts';

/**
 * Spot accounting. Realised P&L on every sell at
 * average cost, so net P&L is always right; flat-to-flat round trips only for trade count and
 * win rate. Full precision throughout; rounding is for display only.
 */

export function emptyBasis(): Basis {
  return { qty: D(0), cost: D(0), roundTripId: null, openedAt: null, tripRealized: D(0) };
}

/**
 * A buy adds the net coins received to the quantity and the USDT spent to the cost, so the buy
 * fee is part of the average cost. It opens a round trip if none is open (flat or dust only).
 */
export function applyBuyToBasis(
  b: Basis,
  netQty: Decimal,
  quoteSpent: Decimal,
  now: number,
  newId: () => string,
): Basis {
  const opening = b.roundTripId === null;
  return {
    qty: b.qty.plus(netQty),
    cost: b.cost.plus(quoteSpent),
    roundTripId: opening ? newId() : b.roundTripId,
    openedAt: opening ? now : b.openedAt,
    tripRealized: opening ? D(0) : b.tripRealized,
  };
}

/**
 * A sell realises net proceeds − average cost × qty sold. The open round trip closes when what
 * remains is worth less than the minimum order value at the sell price (dust, 0 included); the
 * dust keeps its cost and carries into the next trip. A sell with no open trip closes nothing.
 */
export function applySellToBasis(
  b: Basis,
  qty: Decimal,
  netProceeds: Decimal,
  remainingValueAtPrice: Decimal,
  minNotional: Decimal,
  now: number,
  symbol: string,
): { basis: Basis; realized: Decimal; closed: RoundTrip | null } {
  // Coins only arrive through buys, so the basis always covers the holding being sold.
  if (qty.gt(b.qty)) throw new Error(`${symbol}: cannot sell ${qty} against a cost basis of ${b.qty}`);
  // Selling everything takes all of the cost, with no division remainder left behind.
  const costOut = qty.eq(b.qty) ? b.cost : b.cost.mul(qty).div(b.qty);
  const realized = netProceeds.minus(costOut);
  const left = { qty: b.qty.minus(qty), cost: b.cost.minus(costOut) };

  if (b.roundTripId === null) return { basis: { ...b, ...left }, realized, closed: null };
  const tripRealized = b.tripRealized.plus(realized);
  if (remainingValueAtPrice.gte(minNotional)) {
    return { basis: { ...b, ...left, tripRealized }, realized, closed: null };
  }
  const closed: RoundTrip = { id: b.roundTripId, symbol, openedAt: b.openedAt!, closedAt: now, pnl: tripRealized };
  return {
    basis: { ...left, roundTripId: null, openedAt: null, tripRealized: D(0) },
    realized,
    closed,
  };
}

/**
 * The one accounting hook: every fill (market, limit, stop, pair leg; maker or taker) goes
 * through here to become its `fill` event. Updates the coin's basis, stamps the fill with its
 * realised P&L (sells; null for buys) and round-trip id (for a closing sell, the trip it closed),
 * and adds `round_trip_closed` after the fill when the sell left only dust.
 */
export function recordFill(
  s: SpotState,
  fill: Fill,
  order: SpotOrder,
  rules: SpotRules,
  ctx: EngineCtx,
): EngineEvent[] {
  const asset = rules.base;
  const b = s.basis[asset] ?? emptyBasis();
  let accounted: Fill;
  let closed: RoundTrip | null = null;
  if (fill.side === 'buy') {
    // Buys pay the fee in the coin.
    const basis = applyBuyToBasis(b, fill.qty.minus(fill.fee), fill.quote, ctx.now, () => ctx.newId('rt'));
    s.basis[asset] = basis;
    accounted = { ...fill, roundTripId: basis.roundTripId };
  } else {
    // Sells pay the fee in USDT.
    const remainingValue = b.qty.minus(fill.qty).mul(fill.price);
    const r = applySellToBasis(
      b,
      fill.qty,
      fill.quote.minus(fill.fee),
      remainingValue,
      rules.minNotional,
      ctx.now,
      fill.symbol,
    );
    s.basis[asset] = r.basis;
    accounted = { ...fill, realizedPnl: r.realized, roundTripId: b.roundTripId };
    closed = r.closed;
  }
  const events: EngineEvent[] = [{ type: 'fill', time: ctx.now, fill: accounted, order }];
  if (closed) events.push({ type: 'round_trip_closed', time: ctx.now, roundTrip: closed });
  return events;
}

// ---- account value ----

export interface CoinValue {
  asset: string;
  /** Spot holding, free + locked. */
  qty: Decimal;
  /** Best bid; 0 when there is none (never invented). */
  bid: Decimal;
  value: Decimal;
  /** False when the bid is stale or missing. */
  fresh: boolean;
}

export interface AccountValue {
  spotUsdtFree: Decimal;
  spotUsdtLocked: Decimal;
  /** Leverage wallet USDT, free + locked (Phase 2 adds margin and unrealised P&L). */
  leverageUsdt: Decimal;
  coins: CoinValue[];
  total: Decimal;
  totalDeposited: Decimal;
  netPnl: Decimal;
  /** Percent of the deposits (−0.03 means −0.03 %); null when nothing has been deposited. */
  netPnlPct: Decimal | null;
}

/**
 * Account value: spot USDT (free + locked), plus each coin held at its best bid,
 * the price it could actually be sold at, plus the leverage wallet. Coins follow the order of
 * `symbols` (`<COIN>USDT`); a held coin missing from it is still valued, after the listed ones.
 */
export function valueAccount(
  state: SpotState,
  bestBid: (symbol: string) => { price: Decimal; fresh: boolean } | null,
  symbols: string[],
): AccountValue {
  const spot = state.balances.spot;
  const usdt = spot.USDT ?? { free: D(0), locked: D(0) };
  const lev = state.balances.leverage.USDT ?? { free: D(0), locked: D(0) };
  const leverageUsdt = lev.free.plus(lev.locked);

  const rank = (asset: string) => {
    const i = symbols.indexOf(`${asset}USDT`);
    return i === -1 ? symbols.length : i;
  };
  const coins = Object.entries(spot)
    .filter(([asset, b]) => asset !== 'USDT' && b.free.plus(b.locked).gt(0))
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([asset, b]): CoinValue => {
      const qty = b.free.plus(b.locked);
      const bid = bestBid(`${asset}USDT`);
      if (!bid) return { asset, qty, bid: D(0), value: D(0), fresh: false };
      return { asset, qty, bid: bid.price, value: qty.mul(bid.price), fresh: bid.fresh };
    });

  const total = coins.reduce((sum, c) => sum.plus(c.value), usdt.free.plus(usdt.locked).plus(leverageUsdt));
  const netPnl = total.minus(state.totalDeposited);
  return {
    spotUsdtFree: usdt.free,
    spotUsdtLocked: usdt.locked,
    leverageUsdt,
    coins,
    total,
    totalDeposited: state.totalDeposited,
    netPnl,
    netPnlPct: state.totalDeposited.isZero() ? null : netPnl.div(state.totalDeposited).mul(100),
  };
}
