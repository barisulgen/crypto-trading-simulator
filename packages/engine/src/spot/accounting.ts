import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type {
  Basis,
  EngineCtx,
  EngineEvent,
  Fill,
  PriceLevel,
  RoundTrip,
  Side,
  SpotOrder,
  SpotRules,
} from '../types.ts';
import { unrealizedPnl } from '../perp/math.ts';
import type { PositionSide } from '../perp/types.ts';
import type { SimEngine } from '../sim.ts';
import { LIVE_STATUSES } from './state.ts';
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
 * remains is worth less than the minimum order value at the sell price (dust, 0 included) and no
 * sell order of the coin is still live (`sellLive`: one still covers coins, so the trip waits for
 * it); the dust keeps its cost and carries into the next trip. A sell with no open trip closes
 * nothing.
 */
export function applySellToBasis(
  b: Basis,
  qty: Decimal,
  netProceeds: Decimal,
  remainingValueAtPrice: Decimal,
  minNotional: Decimal,
  now: number,
  symbol: string,
  sellLive = false,
): { basis: Basis; realized: Decimal; closed: RoundTrip | null } {
  // Coins only arrive through buys, so the basis always covers the holding being sold.
  if (qty.gt(b.qty)) throw new Error(`${symbol}: cannot sell ${qty} against a cost basis of ${b.qty}`);
  // Selling everything takes all of the cost, with no division remainder left behind.
  const costOut = qty.eq(b.qty) ? b.cost : b.cost.mul(qty).div(b.qty);
  const realized = netProceeds.minus(costOut);
  const left = { qty: b.qty.minus(qty), cost: b.cost.minus(costOut) };

  if (b.roundTripId === null) return { basis: { ...b, ...left }, realized, closed: null };
  const after: Basis = { ...b, ...left, tripRealized: b.tripRealized.plus(realized) };
  if (sellLive || remainingValueAtPrice.gte(minNotional)) return { basis: after, realized, closed: null };
  return { ...closeTrip(after, symbol, now), realized };
}

/** Close the basis's open round trip with the P&L realised so far; the holding and its cost stay. */
function closeTrip(b: Basis, symbol: string, now: number): { basis: Basis; closed: RoundTrip } {
  const closed: RoundTrip = { id: b.roundTripId!, symbol, openedAt: b.openedAt!, closedAt: now, pnl: b.tripRealized };
  return { basis: { ...b, roundTripId: null, openedAt: null, tripRealized: D(0) }, closed };
}

/**
 * Whether a live sell order of `symbol` (in flight, resting, armed or executing) still covers
 * coins. `current` is the order being filled, as it is after the fill; the state may still hold
 * it as it was before.
 */
function liveSellCovers(s: SpotState, symbol: string, current: SpotOrder | null): boolean {
  if (current && current.side === 'sell' && LIVE_STATUSES.has(current.status)) return true;
  for (const o of s.orders.values()) {
    if (o.id === current?.id) continue;
    if (o.symbol === symbol && o.side === 'sell' && LIVE_STATUSES.has(o.status)) return true;
  }
  return false;
}

/**
 * Round trips that a sell order's end lets close: for each coin whose sell order these events
 * cancelled or rejected, the open trip closes when no sell of the coin is live any more and what
 * is held is dust at the best bid (else the last trade price). The events come back with each
 * `round_trip_closed` after them. Without exchange rules or any price a trip stays open.
 */
export function closeTripsAfterSellEnds(s: SpotState, events: EngineEvent[], ctx: EngineCtx): EngineEvent[] {
  const symbols = new Set<string>();
  for (const e of events) {
    if ((e.type === 'order_cancelled' || e.type === 'order_rejected') && e.order.side === 'sell') {
      symbols.add(e.order.symbol);
    }
  }
  const out = [...events];
  for (const symbol of symbols) {
    const closed = closeIfDust(s, symbol, ctx);
    if (closed) out.push({ type: 'round_trip_closed', time: ctx.now, roundTrip: closed });
  }
  return out;
}

function closeIfDust(s: SpotState, symbol: string, ctx: EngineCtx): RoundTrip | null {
  let rules: SpotRules;
  try {
    rules = ctx.market.rules(symbol);
  } catch {
    return null;
  }
  const b = s.basis[rules.base];
  if (!b || b.roundTripId === null || liveSellCovers(s, symbol, null)) return null;
  const price = ctx.market.best(symbol, 'sell') ?? ctx.market.lastPrice(symbol);
  if (price === null || b.qty.mul(price).gte(rules.minNotional)) return null;
  const r = closeTrip(b, symbol, ctx.now);
  s.basis[rules.base] = r.basis;
  return r.closed;
}

/**
 * Throws if selling `qty` would exceed the coin's cost basis, an invariant breach (coins only
 * arrive through buys). Fill paths call it before settling, so nothing has changed when it throws.
 */
export function assertBasisCovers(s: SpotState, rules: SpotRules, side: Side, qty: Decimal): void {
  if (side !== 'sell') return;
  const held = s.basis[rules.base]?.qty ?? D(0);
  if (qty.gt(held)) throw new Error(`${rules.symbol}: cannot sell ${qty} against a cost basis of ${held}`);
}

/**
 * The one accounting hook: every fill (market, limit, stop, pair leg; maker or taker) goes
 * through here to become its `fill` event. Updates the coin's basis, stamps the fill with its
 * realised P&L (sells; null for buys) and round-trip id (for a closing sell, the trip it closed),
 * and adds `round_trip_closed` after the fill when the sell left only dust and no sell of the
 * coin is live any more. A trip never closes while a sell order is live, so every fill of a sell
 * carries the trip that was open when the order was placed. `consumed` (taker fills) is what
 * the fill took from each book level; the event carries it.
 */
export function recordFill(
  s: SpotState,
  fill: Fill,
  order: SpotOrder,
  rules: SpotRules,
  ctx: EngineCtx,
  consumed?: PriceLevel[],
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
      liveSellCovers(s, fill.symbol, order),
    );
    s.basis[asset] = r.basis;
    accounted = { ...fill, realizedPnl: r.realized, roundTripId: b.roundTripId };
    closed = r.closed;
  }
  const events: EngineEvent[] = [
    { type: 'fill', time: ctx.now, fill: accounted, order, ...(consumed ? { consumed } : {}) },
  ];
  if (closed) events.push({ type: 'round_trip_closed', time: ctx.now, roundTrip: closed });
  return events;
}

// ---- account value ----

export interface CoinValue {
  asset: string;
  /** Spot holding, free + locked. */
  qty: Decimal;
  /** Best bid (while stale, the last real one received); 0 when there has been none (never invented). */
  bid: Decimal;
  value: Decimal;
  /** False when the bid is stale or missing. */
  fresh: boolean;
  /** When the bid was received (ms); null when there has been none or the source does not say. */
  bidAt: number | null;
}

/** An open perp position as valued: its margin plus its unrealised P&L at the mark price. */
export interface PositionValue {
  symbol: string;
  side: PositionSide;
  qty: Decimal;
  margin: Decimal;
  /** The mark price (while stale, the last one received); null when there has been none (never invented). */
  markPrice: Decimal | null;
  /** False when the mark is stale or missing. */
  markFresh: boolean;
  /** When the mark was received (ms); null when there has been none or the source does not say. */
  markAt: number | null;
  /** At markPrice; null when there has been no mark, and the position then counts as its margin only. */
  unrealizedPnl: Decimal | null;
}

export interface LeverageValue {
  /** Leverage wallet USDT. */
  free: Decimal;
  /** Leverage wallet USDT locked by open orders. */
  locked: Decimal;
  positions: PositionValue[];
  /** free + locked + Σ(margin + unrealised P&L at the mark). */
  value: Decimal;
}

export interface AccountValue {
  spotUsdtFree: Decimal;
  spotUsdtLocked: Decimal;
  /** Leverage wallet USDT, free + locked; positions are in `leverage`. */
  leverageUsdt: Decimal;
  coins: CoinValue[];
  leverage: LeverageValue;
  /** Spot value plus leverage value. */
  total: Decimal;
  totalDeposited: Decimal;
  netPnl: Decimal;
  /** Percent of the deposits (−0.03 means −0.03 %); null when nothing has been deposited. */
  netPnlPct: Decimal | null;
  /** Held coins whose bid is stale or missing: total value and net P&L are not live while non-empty. */
  pricesPaused: string[];
  /**
   * A held coin or an open position has never been priced: it counts as 0 (a coin) or as its margin
   * only (a position), so total value and net P&L would show a loss that is not real.
   */
  pricesLoading: boolean;
}

type Quote = { price: Decimal; fresh: boolean; at?: number } | null;

/**
 * Account value: spot USDT (free + locked), plus each coin held at its best bid, the price it could
 * actually be sold at, plus the leverage wallet (free + locked) and each open position at its
 * margin plus its unrealised P&L at the mark price. A stale bid or mark is used as the last one
 * received and flagged; one never received is never invented. Coins and positions follow the order
 * of `symbols` (`<COIN>USDT`); one missing from it is still valued, after the listed ones.
 */
export function valueAccount(
  sim: SimEngine,
  bestBid: (symbol: string) => Quote,
  perp: { mark(symbol: string): Quote },
  symbols: string[],
): AccountValue {
  const { spot: spotWallet, leverage: leverageWallet } = sim.ledger.balances;
  const usdt = spotWallet.USDT ?? { free: D(0), locked: D(0) };
  const lev = leverageWallet.USDT ?? { free: D(0), locked: D(0) };
  const leverageUsdt = lev.free.plus(lev.locked);

  const rankSymbol = (symbol: string) => {
    const i = symbols.indexOf(symbol);
    return i === -1 ? symbols.length : i;
  };
  let neverPriced = false;
  const coins = Object.entries(spotWallet)
    .filter(([asset, b]) => asset !== 'USDT' && b.free.plus(b.locked).gt(0))
    .sort(([a], [b]) => rankSymbol(`${a}USDT`) - rankSymbol(`${b}USDT`))
    .map(([asset, b]): CoinValue => {
      const qty = b.free.plus(b.locked);
      const bid = bestBid(`${asset}USDT`);
      if (!bid) {
        neverPriced = true;
        return { asset, qty, bid: D(0), value: D(0), fresh: false, bidAt: null };
      }
      return { asset, qty, bid: bid.price, value: qty.mul(bid.price), fresh: bid.fresh, bidAt: bid.at ?? null };
    });

  const positions = Object.values(sim.perp.state.positions)
    .sort((a, b) => rankSymbol(a.symbol) - rankSymbol(b.symbol))
    .map((p): PositionValue => {
      const base = { symbol: p.symbol, side: p.side, qty: p.qty, margin: p.margin };
      const mark = perp.mark(p.symbol);
      if (!mark) {
        neverPriced = true;
        return { ...base, markPrice: null, markFresh: false, markAt: null, unrealizedPnl: null };
      }
      const pnl = unrealizedPnl(p.side, p.qty, p.entryPrice, mark.price);
      return { ...base, markPrice: mark.price, markFresh: mark.fresh, markAt: mark.at ?? null, unrealizedPnl: pnl };
    });
  const leverageValue = positions.reduce((sum, p) => sum.plus(p.margin).plus(p.unrealizedPnl ?? 0), leverageUsdt);

  const spotValue = coins.reduce((sum, c) => sum.plus(c.value), usdt.free.plus(usdt.locked));
  const total = spotValue.plus(leverageValue);
  const totalDeposited = sim.ledger.totalDeposited;
  const netPnl = total.minus(totalDeposited);
  return {
    spotUsdtFree: usdt.free,
    spotUsdtLocked: usdt.locked,
    leverageUsdt,
    coins,
    leverage: { free: lev.free, locked: lev.locked, positions, value: leverageValue },
    total,
    totalDeposited,
    netPnl,
    netPnlPct: totalDeposited.isZero() ? null : netPnl.div(totalDeposited).mul(100),
    pricesPaused: coins.filter((c) => !c.fresh).map((c) => c.asset),
    pricesLoading: neverPriced,
  };
}
