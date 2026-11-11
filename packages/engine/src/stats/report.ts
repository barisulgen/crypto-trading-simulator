import { D, type Decimal } from '../decimal.ts';
import type { SimEvent } from '../sim.ts';
import type { AccountValue } from '../spot/accounting.ts';
import type { Wallet } from '../types.ts';
import { benchmarkBuy, benchmarkValue } from './benchmark.ts';
import { breakdowns } from './breakdowns.ts';
import { costs, risk } from './costs.ts';
import { capitalAt, drawdown, pnlSeries, rangePnl, type PnlPoint, type Scope } from './equity.ts';
import { tradeQuality } from './quality.ts';
import { buildTrades } from './trades.ts';
import type { StatsBenchmark, StatsEvent, StatsFilter, StatsInput, StatsMarker, StatsReport, Trade } from './types.ts';

const ACCOUNT: Scope = { kind: 'account' };

/** A coin filter gives the coin's scope (in the filtered market only); a market filter alone, the wallet's. */
function scopeOf(f: StatsFilter): Scope {
  if (f.symbol !== null) {
    return { kind: 'coin', symbol: f.symbol, market: f.market === null ? null : f.market === 'spot' ? 'spot' : 'perp' };
  }
  if (f.market !== null) return { kind: 'wallet', wallet: f.market };
  return ACCOUNT;
}

/** The symbol an event concerns, for the events the stats read; null for the others. */
function eventSymbol(e: SimEvent): string | null {
  switch (e.type) {
    case 'fill':
      return e.fill.symbol;
    case 'funding':
    case 'liquidation':
      return e.symbol;
    case 'position_opened':
    case 'position_closed':
      return e.position.symbol;
    case 'round_trip_closed':
      return e.roundTrip.symbol;
    default:
      return null;
  }
}

const isPerp = (e: SimEvent): boolean => 'market' in e && e.market === 'perp';

/** An event of the filtered coin and market. Deposits and transfers move money; they are never trading events. */
function eventMatches(e: SimEvent, f: StatsFilter): boolean {
  if (e.type === 'deposit' || e.type === 'transfer') return false;
  if (f.symbol !== null && eventSymbol(e) !== f.symbol) return false;
  if (f.market !== null && isPerp(e) !== (f.market === 'leverage')) return false;
  return true;
}

const within = (time: number, f: StatsFilter): boolean =>
  (f.from === null || time >= f.from) && (f.to === null || time <= f.to);

function marketMatches(market: 'spot' | 'perp', symbol: string, f: StatsFilter): boolean {
  if (f.symbol !== null && symbol !== f.symbol) return false;
  return f.market === null || (market === 'perp') === (f.market === 'leverage');
}

/** A trade of the filtered coin and market that closed in the range. */
const tradeMatches = (t: Trade, f: StatsFilter): boolean =>
  marketMatches(t.market, t.symbol, f) && within(t.closedAt, f);

function walletValue(a: AccountValue, wallet: Wallet): Decimal {
  return wallet === 'spot' ? a.total.minus(a.leverage.value) : a.leverage.value;
}

/** A held coin at its bid less its remaining cost; zero when not held, null when it has never been priced. */
function spotUnrealized(input: StatsInput, symbol: string): Decimal | null {
  const asset = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  const coin = input.account.coins.find((c) => c.asset === asset);
  if (!coin) return D(0);
  if (!coin.fresh && coin.bid.isZero()) return null;
  return coin.value.minus(input.basis[asset]?.cost ?? 0);
}

/** The open position's P&L at the mark; zero with no position, null when it has never been marked. */
function perpUnrealized(input: StatsInput, symbol: string): Decimal | null {
  const p = input.account.leverage.positions.find((x) => x.symbol === symbol);
  return p ? p.unrealizedPnl : D(0);
}

/**
 * The scope's point at `now`, from the current account value. A coin's is what it realised so far
 * plus what it holds now: the spot coins at the bid less their remaining cost and the open
 * position at the mark. An unpriced part counts as 0 and the point is then not fully priced.
 */
function livePoint(
  input: StatsInput,
  scope: Scope,
  walletCapital: Decimal | null,
): { point: PnlPoint; priced: boolean } {
  const { account: a, now } = input;
  if (scope.kind === 'account') {
    return { point: { time: now, pnl: a.total.minus(a.totalDeposited), value: a.total }, priced: true };
  }
  if (scope.kind === 'wallet') {
    const value = walletValue(a, scope.wallet);
    return { point: { time: now, pnl: value.minus(walletCapital ?? 0), value }, priced: true };
  }
  const realised = pnlSeries({ events: input.events, snapshots: [], live: null }, scope, null, null);
  let pnl = realised.at(-1)?.pnl ?? D(0);
  let priced = true;
  const parts: (Decimal | null)[] = [];
  if (scope.market !== 'perp') parts.push(spotUnrealized(input, scope.symbol));
  if (scope.market !== 'spot') parts.push(perpUnrealized(input, scope.symbol));
  for (const u of parts) {
    if (u === null) priced = false;
    else pnl = pnl.plus(u);
  }
  return { point: { time: now, pnl, value: a.totalDeposited.plus(pnl) }, priced };
}

/**
 * The deposits in the range, whatever the scope, and for a wallet scope also the transfers into
 * and out of that wallet, by time then row id.
 */
function markers(events: StatsEvent[], scope: Scope, f: StatsFilter): StatsMarker[] {
  const out: StatsMarker[] = [];
  const ordered = events.filter((r) => within(r.time, f)).sort((a, b) => a.time - b.time || a.id - b.id);
  for (const { time, event: e } of ordered) {
    if (e.type === 'deposit') {
      out.push({ time, kind: 'deposit', amount: e.amount, wallet: e.wallet });
    } else if (e.type === 'transfer' && scope.kind === 'wallet') {
      if (e.to === scope.wallet) out.push({ time, kind: 'transfer_in', amount: e.amount, wallet: scope.wallet });
      else if (e.from === scope.wallet) out.push({ time, kind: 'transfer_out', amount: e.amount, wallet: scope.wallet });
    }
  }
  return out;
}

interface Holding {
  btc: Decimal;
  cash: Decimal;
  deposited: Decimal;
}

/** What the benchmark holds at a time: walks forward, so each call must ask for a time no earlier than the last. */
function holdingCursor(buys: { time: number; amount: Decimal; btc: Decimal; cash: Decimal }[]): (t: number) => Holding {
  let i = 0;
  let h: Holding = { btc: D(0), cash: D(0), deposited: D(0) };
  return (t) => {
    while (i < buys.length && buys[i]!.time <= t) {
      const b = buys[i]!;
      h = { btc: h.btc.plus(b.btc), cash: h.cash.plus(b.cash), deposited: h.deposited.plus(b.amount) };
      i += 1;
    }
    return h;
  };
}

/** The holding at the bid; with no BTC held it is its cash, and BTC with no bid cannot be valued. */
function valueOf(h: Holding, bid: Decimal | null | undefined): Decimal | null {
  if (h.btc.isZero()) return h.cash;
  return bid ? benchmarkValue([h], bid) : null;
}

/**
 * Buying BTC with every deposit at its recorded ask and holding it, over the whole account. With
 * no range it is valued at the current bid. With a range it is measured at the moments of the
 * account series' first and last points, at the BTC bid recorded with those snapshots (the
 * current bid for the live point); the series' zero origin is a P&L of 0.
 */
function benchmark(
  input: StatsInput,
  filter: StatsFilter,
  series: PnlPoint[],
  live: PnlPoint | null,
  capitalMax: Decimal,
): StatsBenchmark {
  const prices = new Map(input.benchmarkBuys.map((b) => [b.depositEventId, b.price]));
  const buys: { time: number; amount: Decimal; btc: Decimal; cash: Decimal }[] = [];
  let missing = 0;
  const deposits = input.events.filter((r) => r.event.type === 'deposit').sort((a, b) => a.time - b.time || a.id - b.id);
  for (const row of deposits) {
    if (row.event.type !== 'deposit') continue;
    const price = prices.get(row.id);
    if (price === undefined || !price.gt(0)) {
      missing += 1;
      continue;
    }
    const amount = row.event.amount;
    buys.push({ time: row.time, amount, ...benchmarkBuy(amount, price, input.btcRules, input.spotTakerFee) });
  }
  if (missing > 0) return { scope: 'account', missing, value: null, pnl: null, returnPct: null, series: [] };

  const bids = new Map(input.snapshots.map((s) => [s.time, s.btcBid]));
  const bidAt = (p: PnlPoint) => (p === live ? input.btcBid : bids.get(p.time));

  const line: { time: number; value: Decimal }[] = [];
  const along = holdingCursor(buys);
  for (const p of series) {
    const bid = bidAt(p);
    if (bid === undefined || bid === null) continue;
    const value = valueOf(along(p.time), bid)!;
    if (line.at(-1)?.time === p.time) line[line.length - 1] = { time: p.time, value };
    else line.push({ time: p.time, value });
  }

  if (filter.from === null && filter.to === null) {
    const h = holdingCursor(buys)(Infinity);
    const value = valueOf(h, input.btcBid);
    const pnl = value === null ? null : value.minus(h.deposited);
    const returnPct = pnl !== null && h.deposited.gt(0) ? pnl.div(h.deposited) : null;
    return { scope: 'account', missing, value, pnl, returnPct, series: line };
  }

  const first = series[0];
  const last = series.at(-1);
  if (!first || !last) return { scope: 'account', missing, value: D(0), pnl: D(0), returnPct: null, series: line };
  const at = holdingCursor(buys);
  const pnlAt = (p: PnlPoint): Decimal | null => {
    const h = at(p.time);
    const v = valueOf(h, bidAt(p));
    return v === null ? null : v.minus(h.deposited);
  };
  const startPnl = filter.from === null ? D(0) : pnlAt(first);
  const endHolding = at(last.time);
  const value = valueOf(endHolding, bidAt(last));
  const endPnl = last === first ? startPnl : value === null ? null : value.minus(endHolding.deposited);
  const pnl = startPnl === null || endPnl === null ? null : endPnl.minus(startPnl);
  const returnPct = pnl !== null && capitalMax.gt(0) ? pnl.div(capitalMax) : null;
  return { scope: 'account', missing, value, pnl, returnPct, series: line };
}

/**
 * The stats of the filtered part of the record. Trades count in the range they closed in; costs
 * count the fills, funding and liquidations dated in the range; the P&L series follows the scope
 * the filter names (a coin, a wallet, or the account) and ends at the current value while prices
 * are live. The benchmark always covers the whole account.
 */
export function computeStats(input: StatsInput, filter: StatsFilter): StatsReport {
  const { events, snapshots, now } = input;
  const { from, to } = filter;
  const scope = scopeOf(filter);

  const walletCapital = scope.kind === 'wallet' ? capitalAt(events, scope, now) : null;
  const live = input.live ? livePoint(input, scope, walletCapital) : null;
  const series = pnlSeries({ events, snapshots, live: live?.point ?? null }, scope, from, to);
  const range = rangePnl(series, events, scope, from, to);
  const headline = {
    scope,
    netPnl: range.pnl,
    returnPct: range.returnPct,
    capitalMax: range.capitalMax,
    currentValue: scope.kind === 'wallet' ? walletValue(input.account, scope.wallet) : input.account.total,
    deposited: walletCapital ?? input.account.totalDeposited,
    live: live !== null && live.priced,
  };

  const built = buildTrades(events);
  const trades = built.trades.filter((t) => tradeMatches(t, filter));
  const scoped = events.filter((r) => eventMatches(r.event, filter));
  const dated = scoped.filter((r) => within(r.time, filter));
  const cost = costs(dated, range.pnl);
  const positions = input.positions.filter((p) => marketMatches('perp', p.symbol, filter));

  const open = built.open.filter((o) => marketMatches(o.market, o.symbol, filter));
  let unrealized: Decimal | null = D(0);
  for (const o of open) {
    const u = o.market === 'spot' ? spotUnrealized(input, o.symbol) : perpUnrealized(input, o.symbol);
    unrealized = u === null || unrealized === null ? null : unrealized.plus(u);
  }

  let dustRealized = D(0);
  let dustCount = 0;
  for (const r of built.unattributed) {
    if (r.event.type !== 'fill' || !eventMatches(r.event, filter) || !within(r.time, filter)) continue;
    dustCount += 1;
    dustRealized = dustRealized.plus(r.event.fill.realizedPnl ?? 0);
  }

  const accountLive =
    scope.kind === 'account' ? (live?.point ?? null) : input.live ? livePoint(input, ACCOUNT, null).point : null;
  const accountSeries =
    scope.kind === 'account' ? series : pnlSeries({ events, snapshots, live: accountLive }, ACCOUNT, from, to);
  const accountCapitalMax =
    scope.kind === 'account' ? range.capitalMax : rangePnl(accountSeries, events, ACCOUNT, from, to).capitalMax;

  return {
    headline,
    series,
    markers: markers(events, scope, filter),
    drawdown: drawdown(series),
    quality: tradeQuality(trades),
    risk: risk(scoped, positions, { from, to }),
    costs: cost,
    breakdowns: breakdowns(trades, input.tz),
    benchmark: benchmark(input, filter, accountSeries, accountLive, accountCapitalMax),
    open: { count: open.length, unrealized },
    unattributed: { count: dustCount, realized: dustRealized },
    estimated: { trades: trades.filter((t) => t.estimated).length, fills: cost.estimatedFills },
  };
}
