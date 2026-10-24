import { Decimal } from '@sim/engine';
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
    | 'margin_warning';
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** What the notices read beyond the events: each market's rules (null before they load) and the positions after the call. */
export interface NoticeLookup {
  spotRules(symbol: string): SpotRules | null;
  perpRules(symbol: string): PerpRules | null;
  /** The liquidation price of the symbol's open position as it is now; null when none, or it can never be liquidated. */
  liquidationPrice(symbol: string): Decimal | null;
}

const isPerp = (e: SimEvent): e is PerpEvent => 'market' in e && e.market === 'perp';

/**
 * One notice per fill (spot or perp), partial fill, rejection (one per pair), late cancel,
 * trigger, thin-book cancel, funding payment or receipt, and liquidation.
 */
export function noticesFor(events: SimEvent[], lookup: NoticeLookup): Notice[] {
  const out: Notice[] = [];
  const rejectedPairs = new Set<string>();
  for (const e of events) {
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
      case 'liquidation': {
        const tick = tickOf(lookup.perpRules(e.symbol));
        const p = e.position;
        out.push({
          kind: 'liquidation',
          level: 'error',
          text:
            `LIQUIDATED: ${e.symbol} ${p.side} ${p.qty} at mark ${atTick(e.markPrice, tick)}` +
            ` — margin lost $${usdUp(e.marginLost)} (fee $${usdUp(e.liquidationFee)})`,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * A margin warning: level 0.5 warns, 0.8 and 0.9 are errors. The ratio is shown rounded up and the
 * liquidation price rounded towards the mark (see liqText), so neither looks safer than it is.
 */
export function marginWarningNotice(w: MarginWarning, side: PositionSide, rules: PerpRules | null): Notice {
  const ratio = w.ratio.mul(100).toFixed(1, Decimal.ROUND_UP);
  const liq = w.liquidationPrice === null ? '' : ` — liquidation at ${liqText(w.liquidationPrice, side, tickOf(rules))}`;
  return {
    kind: 'margin_warning',
    level: w.level === 0.5 ? 'warn' : 'error',
    text: `Margin ratio ${ratio}% on ${w.symbol} ${side}${liq}`,
  };
}

/** `Bought 1.2 BTC @ 100.0583 · slippage $0.07 · fee 0.0012 BTC` (price at tick decimals + 2; slippage rounded up). */
function fillText(f: Fill, rules: SpotRules | null): string {
  const verb = f.side === 'buy' ? 'Bought' : 'Sold';
  const price = rules ? f.price.toFixed(rules.tickSize.decimalPlaces() + 2) : f.price.toString();
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

/** `Funding paid $0.80 on BTCUSDT long (rate 0.0100%)`: a payment rounded up, a receipt down. */
function fundingText(e: Extract<PerpEvent, { type: 'funding' }>): string {
  const paid = e.amount.isNegative();
  const amount = e.amount.abs().toFixed(2, paid ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  const rate = e.rate.mul(100).toFixed(4);
  const uncollected = e.uncollected === null ? '' : ` · $${usdUp(e.uncollected)} of it could not be collected`;
  return `Funding ${paid ? 'paid' : 'received'} $${amount} on ${e.symbol} ${e.side} (rate ${rate}%)${uncollected}`;
}

function tickOf(rules: { tickSize: Decimal } | null): number | null {
  return rules ? rules.tickSize.decimalPlaces() : null;
}

function atTick(price: Decimal, tick: number | null): string {
  return tick === null ? price.toString() : price.toFixed(tick);
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
