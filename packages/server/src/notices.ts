import { D, Decimal } from '@sim/engine';
import type { Fill, MarginWarning, PerpEvent, PerpFill, PerpRules, PositionSide, SimEvent, SpotRules } from '@sim/engine';

export interface Notice {
  kind:
    | 'fill'
    | 'partial_fill'
    | 'rejected'
    | 'cancel_rejected'
    | 'triggered'
    | 'thin_book'
    | 'feed_gap'
    | 'feed_restored'
    | 'funding'
    | 'liquidation'
    | 'margin_warning'
    | 'catch_up';
  level: 'info' | 'warn' | 'error';
  text: string;
  /** A liquidation notice's figures as data (exact decimal strings), for an alert that shows them. */
  liquidation?: LiquidationDetail;
}

/**
 * What a liquidation took: the position (symbol, side, quantity), the mark it happened at, the
 * margin lost and the fee in it; with the id of its event, which acknowledges its alert.
 */
export interface LiquidationDetail {
  /** The liquidation event's id; absent only when it is not known. */
  eventId?: number;
  symbol: string;
  side: PositionSide;
  qty: string;
  markPrice: string;
  marginLost: string;
  liquidationFee: string;
}

/** What the notices read beyond the events: each market's rules (null before they load) and the positions after the call. */
export interface NoticeLookup {
  spotRules(symbol: string): SpotRules | null;
  perpRules(symbol: string): PerpRules | null;
  /** The liquidation price of the symbol's open position as it is now; null when none, or it can never be liquidated. */
  liquidationPrice(symbol: string): Decimal | null;
  /** The id the event was saved with, when known. */
  eventId?(e: SimEvent): number | undefined;
}

const isPerp = (e: SimEvent): e is PerpEvent => 'market' in e && e.market === 'perp';

/**
 * One notice per fill (spot or perp), partial fill, rejection (one per pair), late cancel,
 * trigger, thin-book cancel, funding payment or receipt, and liquidation. What a catch-up run
 * applied after a gap gets one notice, from its summary, listing every action (each estimated);
 * its own events give none, so nothing it estimated reads like a live fill, except a liquidation:
 * the position is gone whatever applied it, so it raises the owner's alert as a live one does.
 */
export function noticesFor(events: SimEvent[], lookup: NoticeLookup): Notice[] {
  const out: Notice[] = [];
  const rejectedPairs = new Set<string>();
  for (const e of events) {
    if (e.type === 'catch_up') {
      out.push(catchUpNotice(e));
      continue;
    }
    if ('catchUp' in e && e.catchUp !== undefined) {
      if (e.type === 'liquidation') out.push(liquidationNotice(e, tickOf(lookup.perpRules(e.symbol)), lookup.eventId?.(e)));
      continue;
    }
    const perp = isPerp(e);
    switch (e.type) {
      case 'fill': {
        const text = perp
          ? perpFillText(e.fill as PerpFill, events, lookup)
          : fillText(e.fill as Fill, lookup.spotRules(e.fill.symbol));
        if (e.order.status === 'partially_filled') {
          out.push({ kind: 'partial_fill', level: 'info', text: `Partial fill: ${text}` });
        } else {
          out.push({ kind: 'fill', level: 'info', text });
        }
        break;
      }
      case 'order_rejected':
        if (e.order.ocoGroupId !== null) {
          if (rejectedPairs.has(e.order.ocoGroupId)) break;
          rejectedPairs.add(e.order.ocoGroupId);
        }
        out.push({ kind: 'rejected', level: 'error', text: e.reason });
        break;
      case 'cancel_rejected':
        out.push({ kind: 'cancel_rejected', level: 'error', text: e.reason });
        break;
      case 'order_triggered': {
        const tick = tickOf(perp ? lookup.perpRules(e.order.symbol) : lookup.spotRules(e.order.symbol));
        const label = e.order.type === 'stop_loss' ? 'Stop' : 'Take-profit';
        out.push({ kind: 'triggered', level: 'warn', text: `${label} triggered at ${atTick(e.lastPrice, tick)}` });
        break;
      }
      case 'order_cancelled':
        if (e.reason === 'thin_book') {
          const rules = perp ? lookup.perpRules(e.order.symbol) : lookup.spotRules(e.order.symbol);
          out.push({
            kind: 'thin_book',
            level: 'warn',
            text: `Book too thin: ${e.cancelledQty} ${baseOf(e.order.symbol, rules)} not filled and cancelled`,
          });
        }
        break;
      case 'funding':
        out.push({ kind: 'funding', level: 'info', text: fundingText(e) });
        break;
      case 'liquidation':
        out.push(liquidationNotice(e, tickOf(lookup.perpRules(e.symbol)), lookup.eventId?.(e)));
        break;
      default:
        break;
    }
  }
  return out;
}

/** What a liquidation notice reads of its event (as engine values, or revived from its saved row). */
interface LiquidationFigures {
  symbol: string;
  position: { side: PositionSide; qty: Decimal };
  markPrice: Decimal;
  marginLost: Decimal;
  liquidationFee: Decimal;
  catchUp?: unknown;
}

/**
 * `LIQUIDATED: BTCUSDT long 0.1 at mark 76340.0 — margin lost $396.00 (fee $30.00)`, with the same
 * figures as data (exact decimal strings) and the event's id. One a catch-up applied says so.
 */
function liquidationNotice(e: LiquidationFigures, tick: number | null, eventId: number | undefined): Notice {
  const p = e.position;
  const caught = e.catchUp !== undefined && e.catchUp !== null ? ' · applied by the catch-up after a data gap' : '';
  return {
    kind: 'liquidation',
    level: 'error',
    text:
      `LIQUIDATED: ${e.symbol} ${p.side} ${p.qty} at mark ${atTick(e.markPrice, tick)}` +
      ` — margin lost $${usdUp(e.marginLost)} (fee $${usdUp(e.liquidationFee)})${caught}`,
    liquidation: {
      ...(eventId !== undefined ? { eventId } : {}),
      symbol: e.symbol,
      side: p.side,
      qty: p.qty.toString(),
      markPrice: e.markPrice.toString(),
      marginLost: e.marginLost.toString(),
      liquidationFee: e.liquidationFee.toString(),
    },
  };
}

/**
 * The notice of a saved liquidation event (its row id and JSON payload), as it was sent live: for
 * an alert the owner has not acknowledged yet. `rules` are the symbol's perp rules (null before
 * they load: the mark is then shown unrounded).
 */
export function savedLiquidationNotice(id: number, payload: unknown, rules: PerpRules | null): Notice {
  const p = payload as {
    symbol: string;
    position: { side: PositionSide; qty: string };
    markPrice: string;
    marginLost: string;
    liquidationFee: string;
    catchUp?: unknown;
  };
  const figures: LiquidationFigures = {
    symbol: p.symbol,
    position: { side: p.position.side, qty: D(p.position.qty) },
    markPrice: D(p.markPrice),
    marginLost: D(p.marginLost),
    liquidationFee: D(p.liquidationFee),
    ...(p.catchUp !== undefined ? { catchUp: p.catchUp } : {}),
  };
  return liquidationNotice(figures, tickOf(rules), id);
}

/**
 * A margin warning: level 0.5 warns, 0.8 and 0.9 are errors. The ratio is shown rounded up and the
 * liquidation price rounded towards the mark (see liqText), so neither looks safer than it is.
 */
export function marginWarningNotice(w: MarginWarning, rules: PerpRules | null): Notice {
  const ratio = w.ratio.mul(100).toFixed(1, Decimal.ROUND_UP);
  const liq = w.liquidationPrice === null ? '' : ` — liquidation at ${liqText(w.liquidationPrice, w.side, tickOf(rules))}`;
  return {
    kind: 'margin_warning',
    level: w.level === 0.5 ? 'warn' : 'error',
    text: `Margin ratio ${ratio}% on ${w.symbol} ${w.side}${liq}`,
  };
}

/**
 * `Caught up BTCUSDT perp after the data gap 12:00–12:10 UTC: <action>; <action>`, or `...: nothing
 * to apply`. A warning when anything was applied.
 */
function catchUpNotice(e: Extract<SimEvent, { type: 'catch_up' }>): Notice {
  const name = e.market === 'spot' ? e.symbol : `${e.symbol} perp`;
  const at = (t: number) => new Date(t).toISOString().slice(11, 16);
  const head = `Caught up ${name} after the data gap ${at(e.from)}–${at(e.to)} UTC`;
  const text = e.actions.length > 0 ? `${head}: ${e.actions.join('; ')}` : `${head}: nothing to apply`;
  return { kind: 'catch_up', level: e.actions.length > 0 ? 'warn' : 'info', text };
}

/** `Bought 1.2 BTC @ 100.0583 · slippage $0.07 · fee 0.0012 BTC` (price at tick decimals + 2, half up; slippage rounded up). */
function fillText(f: Fill, rules: SpotRules | null): string {
  const verb = f.side === 'buy' ? 'Bought' : 'Sold';
  const price = rules ? f.price.toFixed(rules.tickSize.decimalPlaces() + 2, Decimal.ROUND_HALF_UP) : f.price.toString();
  const slippage = f.slippageUsd.toFixed(2, Decimal.ROUND_UP);
  return `${verb} ${f.qty} ${baseOf(f.symbol, rules)} @ ${price} · slippage $${slippage} · fee ${f.fee} ${f.feeAsset}`;
}

/**
 * `Opened long 0.1 BTC @ 80000.0 · fee $4.00 · liq 76345.4`: an opening fill opens or increases the
 * position; a reducing fill reduces or closes it and shows its realised P&L. Prices at tick
 * decimals; the fee rounded up, the P&L rounded against the owner; the liquidation price of the
 * position as it is after the call (none once it is closed).
 */
function perpFillText(f: PerpFill, events: SimEvent[], lookup: NoticeLookup): string {
  const rules = lookup.perpRules(f.symbol);
  const tick = tickOf(rules);
  const opening = f.marginIn !== null;
  const side: PositionSide = (f.side === 'buy') === opening ? 'long' : 'short';
  const named = (type: 'position_opened' | 'position_closed') =>
    events.some((e) => isPerp(e) && e.type === type && e.position.id === f.positionId);
  const verb = opening ? (named('position_opened') ? 'Opened' : 'Increased') : named('position_closed') ? 'Closed' : 'Reduced';
  const parts = [`${verb} ${side} ${f.qty} ${baseOf(f.symbol, rules)} @ ${atTick(f.price, tick)}`, `fee $${usdUp(f.fee)}`];
  if (!opening && f.realizedPnl !== null) parts.push(`P&L ${signedUsd(f.realizedPnl)}`);
  const liq = lookup.liquidationPrice(f.symbol);
  if (liq !== null && verb !== 'Closed') parts.push(`liq ${liqText(liq, side, tick)}`);
  return parts.join(' · ');
}

/** `Funding paid $0.80 on BTCUSDT long (rate 0.0100%)`: a payment rounded up, a receipt down; the rate half up, as the web shows it. */
function fundingText(e: Extract<PerpEvent, { type: 'funding' }>): string {
  const paid = e.amount.isNegative();
  const amount = e.amount.abs().toFixed(2, paid ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  const rate = e.rate.mul(100).toFixed(4, Decimal.ROUND_HALF_UP);
  const uncollected = e.uncollected === null ? '' : ` · $${usdUp(e.uncollected)} of it could not be collected`;
  return `Funding ${paid ? 'paid' : 'received'} $${amount} on ${e.symbol} ${e.side} (rate ${rate}%)${uncollected}`;
}

function tickOf(rules: { tickSize: Decimal } | null): number | null {
  return rules ? rules.tickSize.decimalPlaces() : null;
}

/**
 * A price at tick decimals, rounded half up (away from zero), as the web app rounds every price it
 * shows: the engine's own rounding mode is half-even, which would make a notice and the history
 * disagree on a price ending in 5.
 */
function atTick(price: Decimal, tick: number | null): string {
  return tick === null ? price.toString() : price.toFixed(tick, Decimal.ROUND_HALF_UP);
}

/** A liquidation price at tick decimals, rounded towards the mark: up for a long, down for a short. */
function liqText(price: Decimal, side: PositionSide, tick: number | null): string {
  if (tick === null) return price.toString();
  return price.toFixed(tick, side === 'long' ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
}

function usdUp(amount: Decimal): string {
  return amount.toFixed(2, Decimal.ROUND_UP);
}

/** `+$1.23` / `-$0.50`, rounded against the owner: a loss away from zero, a gain towards it. */
function signedUsd(amount: Decimal): string {
  const negative = amount.isNegative();
  const abs = amount.abs().toFixed(2, negative ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  return `${negative ? '-' : '+'}$${abs}`;
}

function baseOf(symbol: string, rules: { base: string } | null): string {
  return rules?.base ?? symbol.replace(/USDT$/, '');
}
