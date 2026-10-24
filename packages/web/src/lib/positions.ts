// Open perp positions as the positions tab, the warning banner and the account bar show them:
// figures from the wire position, rounded so that none looks safer than it is, and never shown
// as live when the mark behind them is not.
import type { AccountSnapshot, WirePerpOrder, WirePosition } from './api.ts';
import { fmtNum, tickDecimals } from './format.ts';
import { addDec, cmpDec, floorToStep, liqPriceAtTick, mulDec, pctOfDir, subDec } from './market.ts';
import { validPrice } from './quickAmount.ts';
import type { Pct } from './quickAmount.ts';

const DASH = '-';
/** The server writes an infinite margin ratio (the margin balance is gone) as this. */
const INFINITE = 'Infinity';

// ---- figures ----

/** How close a position is to liquidation, by its margin ratio: from 0.5, 0.8 and 0.9 (liquidated at 1). */
export type RiskLevel = 'none' | 'amber' | 'red' | 'pulse';

const LEVEL_RANK: Record<RiskLevel, number> = { none: 0, amber: 1, red: 2, pulse: 3 };

/** A margin ratio in percent, rounded up to 0.1: the figure every ratio display and level uses. */
const ratioUp = (ratio: string) => pctOfDir(ratio, '1', 1, 'ceil');

/**
 * The risk level of a margin ratio, judged on the figure shown (rounded up to 0.1 %), so a ratio
 * shown as 50.0 % is amber even when it is a hair under 0.5; 'none' when the ratio is unknown.
 */
export function riskLevel(ratio: string | null): RiskLevel {
  if (ratio === null) return 'none';
  if (ratio === INFINITE) return 'pulse';
  const pct = ratioUp(ratio);
  if (cmpDec(pct, '90') >= 0) return 'pulse';
  if (cmpDec(pct, '80') >= 0) return 'red';
  if (cmpDec(pct, '50') >= 0) return 'amber';
  return 'none';
}

/** A margin ratio as a percentage rounded up to 0.1 (as the margin warnings show it): '82.4%'; '∞' once the balance is gone. */
export function ratioPct(ratio: string): string {
  if (ratio === INFINITE) return '∞';
  return `${fmtNum(ratioUp(ratio), 1)}%`;
}

/** Unrealised P&L as a percentage of the margin, 2 decimals, rounded down (a loss away from zero); null without margin. */
export function pnlPctOfMargin(pnl: string, margin: string): string | null {
  if (cmpDec(margin, '0') === 0) return null;
  return pctOfDir(pnl, margin, 2, 'floor');
}

/** |mark − liquidation price| as a percentage of the mark, 2 decimals, rounded down (nearer to danger). */
export function liqDistancePct(mark: string, liq: string): string {
  const gap = subDec(mark, liq).replace(/^-/, '');
  return pctOfDir(gap, mark, 2, 'floor');
}

export interface PositionFigures {
  /** Unrealised P&L at the mark; null without a mark. */
  pnl: string | null;
  /** pnl as a percentage of the margin. */
  pnlPct: string | null;
  /** The margin ratio as shown ('10.7%'); null without a mark or the tiers. */
  ratioPct: string | null;
  level: RiskLevel;
  /** The liquidation price at the tick, rounded towards the mark; null without one or before the tick is known. */
  liq: string | null;
  /** How far the mark is from that price, percent of the mark; null without both. */
  liqDistancePct: string | null;
}

/**
 * A row's figures from the wire position. The liquidation price is rounded to the tick towards the
 * mark (as every liquidation figure is) and the distance is measured to that price; without the
 * tick neither is shown, never the price rounded to nearest.
 */
export function positionFigures(p: WirePosition, tick: string | undefined): PositionFigures {
  const liq = p.liquidationPrice === null ? null : liqPriceAtTick(p.liquidationPrice, p.side, tick);
  return {
    pnl: p.unrealizedPnl,
    pnlPct: p.unrealizedPnl === null ? null : pnlPctOfMargin(p.unrealizedPnl, p.margin),
    ratioPct: p.marginRatio === null ? null : ratioPct(p.marginRatio),
    level: riskLevel(p.marginRatio),
    liq,
    liqDistancePct: liq !== null && p.markPrice !== null && cmpDec(p.markPrice, '0') > 0 ? liqDistancePct(p.markPrice, liq) : null,
  };
}

/**
 * Signed dollars rounded against the owner: a gain down to the cent ('+$0.01' for 0.0199), a loss
 * up ('-$0.02' for -0.0123), so neither flatters.
 */
export function fmtPnl(value: string | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  const negative = value.trim().startsWith('-');
  const magnitude = value.trim().replace(/^[+-]/, '');
  // Cents of the magnitude: a loss is rounded up, a gain cut.
  const [int = '0', frac = ''] = magnitude.split('.');
  let cents = BigInt(int + frac.padEnd(2, '0').slice(0, 2));
  if (negative && /[1-9]/.test(frac.slice(2))) cents += 1n;
  if (cents === 0n) return '$0.00';
  const digits = cents.toString().padStart(3, '0');
  return `${negative ? '-' : '+'}$${fmtNum(`${digits.slice(0, -2)}.${digits.slice(-2)}`, 2)}`;
}

// ---- live or not ----

export interface PositionState {
  /** The figures come from a fresh mark over an open connection, and no catch-up is pending. */
  live: boolean;
  /** Why they are not live; null when they are. */
  staleReason: string | null;
  catchingUp: boolean;
}

/** Whether a position's figures are live (`down`: our connection to the simulator is lost). */
export function positionState(p: WirePosition, down: boolean): PositionState {
  const staleReason = p.catchingUp
    ? 'Catching up after a data gap: the figures may still change'
    : down
      ? 'Connection to the simulator lost'
      : p.markPrice === null
        ? 'No mark price yet'
        : !p.markFresh
          ? 'No mark price update for over 10 s'
          : null;
  return { live: staleReason === null, staleReason, catchingUp: p.catchingUp };
}

// ---- warning banner ----

export interface BannerEntry {
  symbol: string;
  side: 'long' | 'short';
  level: Exclude<RiskLevel, 'none'>;
  ratioPct: string;
  /** Distance to liquidation, percent of the mark; null when it is not known. */
  liqDistancePct: string | null;
  /** The figures are from the last live mark: the mark behind them now is not live. */
  stale: boolean;
}

/** '83.0%' -> '83.0' and '∞' above everything, for ordering. */
const ratioKey = (pct: string) => (pct === '∞' ? '1000000000' : pct.replace(/[%,]/g, ''));

/**
 * The banner after new positions (null: not received yet). A position on a live mark at a ratio of
 * 0.5 or more gets an entry at its level; a live mark under 0.5 clears it. A mark that is not live
 * (stale, our connection down, catching up, or no ratio) neither raises nor clears a level: the
 * last live entry stays, marked stale, and a position first seen that way gets none. A closed
 * position leaves the banner. Worst first.
 */
export function bannerEntries(
  prev: BannerEntry[],
  positions: WirePosition[] | null,
  opts: { down: boolean; tick(symbol: string): string | undefined },
): BannerEntry[] {
  if (positions === null) return prev.map((e) => ({ ...e, stale: true }));
  const out: BannerEntry[] = [];
  for (const p of positions) {
    const live = positionState(p, opts.down).live && p.marginRatio !== null;
    if (!live) {
      const last = prev.find((e) => e.symbol === p.symbol && e.side === p.side);
      if (last) out.push({ ...last, stale: true });
      continue;
    }
    const f = positionFigures(p, opts.tick(p.symbol));
    if (f.level === 'none' || f.ratioPct === null) continue;
    out.push({ symbol: p.symbol, side: p.side, level: f.level, ratioPct: f.ratioPct, liqDistancePct: f.liqDistancePct, stale: false });
  }
  return out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || cmpDec(ratioKey(b.ratioPct), ratioKey(a.ratioPct)));
}

// ---- close part ----

/** `pct` of the position's quantity, floored to the step (the amount never rounds up). */
export function closePartQty(qty: string, pct: Pct, step: string): string {
  return floorToStep(mulDec(qty, String(pct / 100)), step);
}

/**
 * A typed amount to close, floored to the step ('0,02' is accepted, as the server parses it), or
 * why it cannot be sent: blank or not a number, under one step, or more than the position.
 */
export function closeAmount(input: string, qty: string, step: string): { qty: string } | { error: string } {
  const amount = validPrice(input);
  if (amount === null) return { error: 'Enter an amount' };
  const floored = floorToStep(amount, step);
  if (cmpDec(floored, '0') <= 0) return { error: `Less than one step (${fmtNum(step, tickDecimals(step))})` };
  if (cmpDec(floored, qty) > 0) return { error: `More than the position (${qty})` };
  return { qty: floored };
}

// ---- stops ----

/** The position's close-position stop-loss and take-profit (live, on the closing side); null where none is set. */
export function positionStops(
  orders: WirePerpOrder[],
  p: Pick<WirePosition, 'symbol' | 'side'>,
): { stopLoss: WirePerpOrder | null; takeProfit: WirePerpOrder | null } {
  const closing = p.side === 'long' ? 'sell' : 'buy';
  const mine = orders.filter((o) => o.symbol === p.symbol && o.closePosition && o.side === closing);
  return {
    stopLoss: mine.find((o) => o.type === 'stop_loss') ?? null,
    takeProfit: mine.find((o) => o.type === 'take_profit') ?? null,
  };
}

// ---- account bar ----

export interface LeverageWalletLine {
  free: string;
  /** USDT locked by open orders. */
  inOrders: string;
  /** Σ (margin + unrealised P&L at the mark); null while a position has had no mark yet. */
  inPositions: string | null;
  /** Some position is valued at a mark that is not live. */
  stale: boolean;
  /** Some position has had no mark yet (its value would be its margin only). */
  loading: boolean;
}

/** The leverage wallet as free · in orders · in positions, positions valued at the mark. */
export function leverageWalletLine(account: AccountSnapshot): LeverageWalletLine {
  const lev = account.leverage;
  const loading = lev.positions.some((p) => p.unrealizedPnl === null);
  const inPositions = loading ? null : lev.positions.reduce((sum, p) => addDec(addDec(sum, p.margin), p.unrealizedPnl!), '0');
  return { free: lev.free, inOrders: lev.locked, inPositions, stale: (account.marksPaused?.length ?? 0) > 0, loading };
}

// ---- margin dialog ----

/**
 * Whether the margin dialog may send its change: an amount typed, nothing blocking the action (a
 * catch-up, no live mark for a removal) and no refusal in the server's preview of this very amount
 * (`current`: the answer shown is for what is typed now).
 */
export function marginSubmitReady(p: {
  hasAmount: boolean;
  blocked: string | null;
  noRemove: string | null;
  current: boolean;
  rejectReason: string | null;
}): boolean {
  return p.hasAmount && p.blocked === null && p.noRemove === null && !(p.current && p.rejectReason !== null);
}

// ---- actions ----

const CATCHING_UP_BLOCK = 'Catching up after a data gap: closing, margin and stops resume when it is done';

/**
 * Why each action on a position is off, or null when it is on. While the symbol catches up the
 * server refuses them all (409). Without live data (the mark stale or missing, or the perp feed
 * stale) a market close and new stops would be rejected, and a margin change is refused (409): a
 * change made inside a gap would decide what its catch-up finds.
 */
export function actionBlocks(
  p: Pick<WirePosition, 'catchingUp' | 'markFresh' | 'markPrice'>,
  feed: { fresh: boolean; reason: string | null } | undefined,
): { close: string | null; margin: string | null; tpsl: string | null } {
  if (p.catchingUp) return { close: CATCHING_UP_BLOCK, margin: CATCHING_UP_BLOCK, tpsl: CATCHING_UP_BLOCK };
  const stale =
    feed !== undefined && !feed.fresh
      ? `Live data interrupted (${feed.reason ?? 'no fresh data from Binance'}): the server would reject it now`
      : p.markPrice === null || !p.markFresh
        ? 'No live mark price: the server would reject it now'
        : null;
  return { close: stale, margin: stale, tpsl: stale };
}

// ---- chart ----

/**
 * The prices of a position's chart lines: the entry, and the liquidation price at the tick rounded
 * towards the mark, none before the tick is known (never the price rounded to nearest). `dimmed`
 * while our connection is down or the position's mark is not live.
 */
export function chartLines(
  p: Pick<WirePosition, 'entryPrice' | 'liquidationPrice' | 'side' | 'markFresh'> | undefined,
  tick: string | undefined,
  down: boolean,
): { entry: string | null; liq: string | null; dimmed: boolean } {
  if (!p) return { entry: null, liq: null, dimmed: false };
  const liq = p.liquidationPrice === null ? null : liqPriceAtTick(p.liquidationPrice, p.side, tick);
  return { entry: p.entryPrice, liq, dimmed: down || !p.markFresh };
}
