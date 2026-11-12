// Stats screen logic (pure): filters <-> the hash query (the same keys and local days as History),
// filters -> the API query, and the report -> labelled rows per section. Decimals stay strings.
import type { Wallet } from '@sim/engine';
import type { StatsQuery, WireStatsReport } from './api.ts';
import { fmtNum, fmtUsd, signOf } from './format.ts';
import { EMPTY_FILTERS, filterParams, localDate, localDayEnd, localDayStart, parseFilters } from './history.ts';
import { cmpDec, fmtDateTime, mulDec } from './market.ts';
import { href } from './route.ts';

/** What cannot be computed. */
const NONE = '–';

// ---- filters ----

export interface StatsFilter {
  /** 'BTCUSDT', or null for every coin. */
  symbol: string | null;
  /** 'spot' is the spot wallet and spot trades; 'leverage' the leverage wallet and perpetual trades. */
  market: Wallet | null;
  /** Local dates 'YYYY-MM-DD', both days included. */
  from: string | null;
  to: string | null;
}

export const EMPTY_STATS_FILTER: StatsFilter = { symbol: null, market: null, from: null, to: null };

export const STATS_MARKETS: { value: Wallet; label: string; title: string }[] = [
  { value: 'spot', label: 'Spot', title: 'The spot wallet and spot trades' },
  { value: 'leverage', label: 'Leverage', title: 'The leverage wallet and perpetual trades' },
];

/** Filters from the hash query, read as History reads them; History's event types do not apply. */
export function parseStatsFilters(params: URLSearchParams): StatsFilter {
  const { symbol, market, from, to } = parseFilters(params);
  return { symbol, market, from, to };
}

/** The hash query of a filter set; empty filters are left out. */
export function statsFilterParams(f: StatsFilter): Record<string, string> {
  return filterParams({ ...EMPTY_FILTERS, ...f });
}

export const hasStatsFilters = (f: StatsFilter): boolean =>
  f.symbol !== null || f.market !== null || f.from !== null || f.to !== null;

/** GET /api/stats parameters: whole local days, both ends included; hours and weekdays in `tz`. */
export function statsQuery(f: StatsFilter, tz: string): StatsQuery {
  const q: StatsQuery = { tz };
  if (f.symbol !== null) q.symbol = f.symbol;
  if (f.market !== null) q.market = f.market;
  const from = f.from === null ? null : localDayStart(f.from);
  const to = f.to === null ? null : localDayEnd(f.to);
  if (from !== null) q.from = from;
  if (to !== null) q.to = to;
  return q;
}

/**
 * Whether the filter's range reaches the present: no To date, or one whose local day has not
 * ended by `now`. Without `now` a To date is taken as past, so nothing is claimed as current.
 */
function endsNow(f: StatsFilter, now: number | undefined): boolean {
  const end = f.to === null ? null : localDayEnd(f.to);
  return end === null || (now !== undefined && end >= now);
}

/**
 * Whether a coin's figures include what it holds now: only while prices are live and the range
 * reaches the present. `live` null (not known yet) counts as not live.
 */
export const unrealisedAdded = (f: StatsFilter, live: boolean | null, now: number | undefined): boolean =>
  live === true && endsNow(f, now);

/**
 * What a filter does not narrow, said next to the filters. `live` is whether the last report's
 * figures were at live prices (null before one has loaded); it and `now` decide, as for the
 * headline, whether a coin's unrealised P&L is added.
 */
export function filterNotes(f: StatsFilter, live: boolean | null, now?: number): string[] {
  const notes: string[] = [];
  if (f.symbol !== null || f.market !== null) notes.push('The BTC benchmark always covers the whole account.');
  if (f.symbol !== null) {
    notes.push(
      unrealisedAdded(f, live, now)
        ? 'For one coin, the curve and drawdown follow its realised P&L; unrealised added now.'
        : 'For one coin, the curve and drawdown follow its realised P&L only.',
    );
  }
  return notes;
}

// ---- formatting ----

export type StatTone = 'up' | 'down' | 'muted' | 'plain';

/** Dollars to the cent; with `sign`, a gain carries '+'. */
function usd(v: string | null, sign = false): string {
  return v === null ? NONE : fmtUsd(v, { sign });
}

/** A fraction as a percentage, written as fmtPct writes one: '0.25' -> '25.00%' (dp 2), '0.5' -> '50.0%' (dp 1). */
function pct(fraction: string | null, dp: number, sign = false): string {
  if (fraction === null) return NONE;
  const shown = fmtNum(mulDec(fraction, '100'), dp);
  return `${sign && signOf(shown) > 0 ? '+' : ''}${shown}%`;
}

/**
 * Up for a gain, down for a loss, muted for zero or nothing. Money is judged as shown, to the
 * cent (dp 2); a fraction, shown as a percent with 2 decimals, needs dp 4 (FRACTION).
 */
function toneOf(v: string | null, dp = 2): StatTone {
  if (v === null) return 'muted';
  const s = signOf(v, dp);
  return s > 0 ? 'up' : s < 0 ? 'down' : 'muted';
}
const FRACTION = 4;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const baseOf = (symbol: string) => symbol.replace(/USDT$/, '');

type Estimated = WireStatsReport['estimated'];

/**
 * "includes 2 estimated trades, 1 estimated fill and 1 estimated funding payment", for the counts
 * given; null when they are all zero.
 */
function estimatedNote(e: Partial<Estimated>): string | null {
  const parts = [
    plural(e.trades ?? 0, 'estimated trade', 'estimated trades'),
    plural(e.fills ?? 0, 'estimated fill', 'estimated fills'),
    plural(e.funding ?? 0, 'estimated funding payment', 'estimated funding payments'),
    plural(e.liquidations ?? 0, 'estimated liquidation', 'estimated liquidations'),
  ].filter((p) => !p.startsWith('0 '));
  if (parts.length === 0) return null;
  const last = parts.pop()!;
  return `includes ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`;
}

const joinNotes = (...notes: (string | null | undefined)[]): string | undefined => {
  const kept = notes.filter((n): n is string => !!n);
  return kept.length > 0 ? kept.join(' · ') : undefined;
};

// ---- the view ----

export interface StatRow {
  label: string;
  value: string;
  tone: StatTone;
  note?: string;
  /** A link to History, filtered to what the figure is about. */
  href?: string;
  /** The trade the figure shows was estimated by a catch-up after a data gap. */
  estimated?: boolean;
}

export interface BreakdownTable {
  title: string;
  rows: { label: string; pnl: string; tone: StatTone; count: string; winRate: string }[];
}

export interface StatsView {
  /** What the figures cover: 'Whole account', 'Spot wallet', 'BTC perp', 'SOL, spot and perp'. */
  scope: string;
  /** Set when prices are not live: the moment the headline stands at. */
  asOf: string | null;
  /** Net P&L, return, value and deposits, and the BTC benchmark beside them. */
  headline: StatRow[];
  quality: { rows: StatRow[]; note: string | null };
  risk: StatRow[];
  /** 'includes N estimated ...' when anything estimated is in scope; null otherwise. */
  riskNote: string | null;
  costs: { rows: StatRow[]; note: string | null };
  breakdowns: { tables: BreakdownTable[]; empty: string | null; note: string | null };
  /**
   * 'Open: 2, unrealised -$12.50': trades still open, which are in no trade figure. Under a range
   * that ended before now, 'Open now: 2', without the unrealised P&L, which is not as of its end.
   */
  open: string;
  /** Realised P&L that belongs to no trade; null when there is none. */
  unattributed: string | null;
  /** Losses neither the margin nor free USDT could pay, counted in full; null when zero. */
  uncovered: string | null;
}

type Scope = WireStatsReport['headline']['scope'];
type WireTrade = NonNullable<WireStatsReport['quality']['best']>;

function scopeName(scope: Scope): string {
  if (scope.kind === 'account') return 'Whole account';
  if (scope.kind === 'wallet') return scope.wallet === 'spot' ? 'Spot wallet' : 'Leverage wallet';
  const coin = baseOf(scope.symbol);
  return scope.market === null ? `${coin}, spot and perp` : `${coin} ${scope.market}`;
}

/** 'BTC perp long 10x · <opened> to <closed>' */
function tradeText(t: WireTrade): string {
  const what = [baseOf(t.symbol), t.market, t.side, t.leverage !== null ? `${t.leverage}x` : null].filter(Boolean).join(' ');
  return `${what} · ${fmtDateTime(t.openedAt)} to ${fmtDateTime(t.closedAt)}`;
}

/** History filtered to the trade's coin and the local days from its opening to its close. */
export function tradeHref(t: WireTrade): string {
  return href('/history', statsFilterParams({ ...EMPTY_STATS_FILTER, symbol: t.symbol, from: localDate(t.openedAt), to: localDate(t.closedAt) }));
}

function tradeRow(label: string, t: WireTrade | null): StatRow {
  if (t === null) return { label, value: NONE, tone: 'muted' };
  return { label, value: usd(t.result, true), tone: toneOf(t.result), note: tradeText(t), href: tradeHref(t), estimated: t.estimated };
}

function headlineRows(r: WireStatsReport, ranged: boolean, added: boolean): StatRow[] {
  const h = r.headline;
  const { scope } = h;
  const coinNote = scope.kind !== 'coin' ? null : added ? 'realised P&L; unrealised added now' : 'realised P&L only';
  const estimated = estimatedNote(r.estimated);
  const rows: StatRow[] = [
    { label: 'Net P&L', value: usd(h.netPnl, true), tone: toneOf(h.netPnl), note: joinNotes(coinNote, estimated) },
    {
      label: 'Return',
      value: pct(h.returnPct, 2, true),
      tone: toneOf(h.returnPct, FRACTION),
      note: joinNotes(`of the highest capital, ${usd(h.capitalMax)}`, estimated),
    },
  ];
  const stale = h.live ? undefined : 'at the last prices received';
  if (scope.kind === 'wallet') {
    rows.push({ label: 'Wallet value', value: usd(h.currentValue), tone: 'plain', note: stale });
    rows.push({ label: 'Wallet capital', value: usd(h.deposited), tone: 'plain', note: 'deposits and transfers in, less transfers out' });
  } else if (scope.kind === 'coin') {
    rows.push({ label: 'Account value', value: usd(h.currentValue), tone: 'plain', note: joinNotes('whole account', stale) });
    rows.push({ label: 'Deposited', value: usd(h.deposited), tone: 'plain', note: 'whole account' });
  } else {
    rows.push({ label: 'Current value', value: usd(h.currentValue), tone: 'plain', note: stale });
    rows.push({ label: 'Deposited', value: usd(h.deposited), tone: 'plain' });
  }

  const b = r.benchmark;
  const whole = scope.kind === 'account' ? '' : ' (whole account)';
  if (b.missing > 0) {
    rows.push({
      label: `BTC buy-and-hold${whole}`,
      value: `incomplete: ${plural(b.missing, 'deposit has', 'deposits have')} no BTC price`,
      tone: 'muted',
    });
    return rows;
  }
  // With no range the benchmark is valued at the current BTC bid, while a headline that is not live
  // stops at its last point: say so rather than compare two different moments silently.
  const bidNote = !h.live && !ranged ? 'at the current BTC bid, not as of the time above' : undefined;
  rows.push({ label: `BTC buy-and-hold P&L${whole}`, value: usd(b.pnl, true), tone: toneOf(b.pnl), note: bidNote });
  rows.push({ label: `BTC buy-and-hold return${whole}`, value: pct(b.returnPct, 2, true), tone: toneOf(b.returnPct, FRACTION) });
  return rows;
}

function qualityRows(r: WireStatsReport): StatRow[] {
  const q = r.quality;
  const est = estimatedNote({ trades: r.estimated.trades });
  const tally = [`${q.wins} won`, `${q.losses} lost`, q.breakEven > 0 ? `${q.breakEven} break-even` : null];
  const profitFactor = q.noLosses ? 'No losing trades' : q.profitFactor === null ? NONE : fmtNum(q.profitFactor, 2);
  return [
    { label: 'Closed trades', value: String(q.count), tone: 'plain', note: q.count > 0 ? joinNotes(...tally, est) : undefined },
    { label: 'Win rate', value: pct(q.winRate, 1), tone: q.winRate === null ? 'muted' : 'plain' },
    { label: 'Average win', value: usd(q.avgWin, true), tone: toneOf(q.avgWin) },
    { label: 'Average loss', value: usd(q.avgLoss, true), tone: toneOf(q.avgLoss) },
    { label: 'Profit factor', value: profitFactor, tone: profitFactor === NONE ? 'muted' : 'plain' },
    { label: 'Expected profit per trade', value: usd(q.expectancy, true), tone: toneOf(q.expectancy) },
    tradeRow('Best trade', q.best),
    tradeRow('Worst trade', q.worst),
    { label: 'Longest winning streak', value: String(q.longestWinStreak), tone: 'plain' },
    { label: 'Longest losing streak', value: String(q.longestLossStreak), tone: 'plain' },
  ];
}

function riskRows(r: WireStatsReport): StatRow[] {
  const { drawdown: d, risk } = r;
  const coin = r.headline.scope.kind === 'coin';
  return [
    {
      label: 'Max drawdown',
      value: usd(d.maxUsd),
      tone: signOf(d.maxUsd, 2) > 0 ? 'down' : 'muted',
      note: coin ? "on the coin's realised P&L: a dip inside a trade that recovered before closing is not seen" : undefined,
    },
    { label: 'Max drawdown %', value: pct(d.maxPct, 2), tone: d.maxPct === null ? 'muted' : 'plain', note: 'of the value at the peak' },
    { label: 'Liquidations', value: String(risk.liquidations), tone: risk.liquidations > 0 ? 'down' : 'plain' },
    {
      label: 'Lost to liquidations',
      value: usd(risk.lostToLiquidations),
      tone: signOf(risk.lostToLiquidations, 2) > 0 ? 'down' : 'muted',
      note: `liquidation fees ${usd(risk.liquidationFees)} of it`,
    },
    {
      label: 'Average leverage',
      value: risk.avgLeverage === null ? NONE : `${fmtNum(risk.avgLeverage, 2)}x`,
      tone: risk.avgLeverage === null ? 'muted' : 'plain',
      note: 'positions open in the range, still-open ones included',
    },
    {
      label: 'Highest leverage',
      value: risk.maxLeverage === null ? NONE : `${risk.maxLeverage}x`,
      tone: risk.maxLeverage === null ? 'muted' : 'plain',
    },
  ];
}

function costRows(r: WireStatsReport): StatRow[] {
  const c = r.costs;
  const cost = (label: string, v: string, note?: string): StatRow => ({
    label,
    value: usd(v),
    tone: signOf(v, 2) === 0 ? 'muted' : 'plain',
    ...(note ? { note } : {}),
  });
  const gap = signOf(c.catchUpGapCost, 2) > 0 ? `includes ${usd(c.catchUpGapCost)} gap cost of estimated stop and take-profit fills` : undefined;
  let share: StatRow;
  if (c.share === null) {
    share = { label: 'Share of profit eaten by costs', value: `No profit before costs (${usd(c.preCost)})`, tone: 'muted' };
  } else if (cmpDec(c.preCost, '1') < 0 && cmpDec(c.total, c.preCost) > 0) {
    // Against a profit under $1 the percent is huge and says nothing: put the two amounts in words.
    const size = cmpDec(c.total, mulDec(c.preCost, '10')) >= 0 ? 'far larger' : 'larger';
    share = {
      label: 'Share of profit eaten by costs',
      value: `Costs (${usd(c.total)}) were ${size} than the profit before costs (${usd(c.preCost)})`,
      tone: 'down',
    };
  } else {
    const turned = cmpDec(c.share, '1') > 0 ? ': the costs turned a profit into a loss' : '';
    share = {
      label: 'Share of profit eaten by costs',
      value: pct(c.share, 2),
      tone: turned ? 'down' : 'plain',
      note: `of the ${usd(c.preCost)} made before costs${turned}`,
    };
  }
  const drift = signOf(c.drift, 2);
  return [
    cost('Taker fees', c.takerFees),
    cost('Maker fees', c.makerFees),
    cost('Liquidation fees', c.liquidationFees),
    cost('Funding paid', c.fundingPaid),
    { label: 'Funding received', value: usd(c.fundingReceived), tone: signOf(c.fundingReceived, 2) > 0 ? 'up' : 'muted' },
    // Received less paid: positive when funding paid the account on balance.
    { label: 'Funding net', value: usd(c.fundingNet, true), tone: toneOf(c.fundingNet) },
    cost('Slippage', c.slippage, gap),
    cost('Total costs', c.total, 'fees, liquidation fees, slippage and net funding paid'),
    share,
    {
      label: 'Delay drift',
      value: drift === 0 ? usd('0') : `${drift > 0 ? 'cost' : 'gain'} ${usd(c.drift.replace(/^-/, ''))}`,
      tone: drift > 0 ? 'down' : drift < 0 ? 'up' : 'muted',
      note: 'not in the total: it can be a gain',
    },
  ];
}

const LEVERAGE: Record<string, string> = { '1-2': '1–2x', '3-5': '3–5x', '6-10': '6–10x', '>10': '>10x', spot: 'Spot' };
const HOLD: Record<string, string> = { '<5m': '< 5 min', '5m-1h': '5 min – 1 h', '1h-1d': '1 h – 1 day', '>=1d': '≥ 1 day' };
const SIDE: Record<string, string> = { long: 'Long', short: 'Short' };
const MARKET: Record<string, string> = { spot: 'Spot', perp: 'Perp' };

const DIMENSIONS: { key: keyof WireStatsReport['breakdowns']; title: string; label(key: string): string }[] = [
  { key: 'coin', title: 'Coin', label: (k) => k },
  { key: 'side', title: 'Long or short', label: (k) => SIDE[k] ?? k },
  { key: 'market', title: 'Market', label: (k) => MARKET[k] ?? k },
  { key: 'leverage', title: 'Leverage', label: (k) => LEVERAGE[k] ?? k },
  { key: 'hold', title: 'Hold time', label: (k) => HOLD[k] ?? k },
  { key: 'hour', title: 'Hour opened', label: (k) => `${k}:00` },
  { key: 'weekday', title: 'Day opened', label: (k) => k },
];

/**
 * The stats screen's figures from a report. `filter` and `now` say whether the range reaches the
 * present (only then does a coin's figure include what it holds now) and whether there is a range
 * at all (without one, the benchmark is valued at the current BTC bid).
 */
export function statsView(r: WireStatsReport, filter: StatsFilter = EMPTY_STATS_FILTER, now?: number): StatsView {
  const ranged = filter.from !== null || filter.to !== null;
  const last = r.series.at(-1);
  // An account or wallet curve ends at its last snapshot. A coin's ends at its last realising
  // event, which is not a moment the figures stand at, so it is not dated.
  const asOf = r.headline.live
    ? null
    : r.headline.scope.kind === 'coin'
      ? 'Prices are not live; realised P&L as recorded, unrealised left out'
      : `${last ? `As of ${fmtDateTime(last.time)}` : 'No value recorded yet'}: prices are not live`;
  const trades = estimatedNote({ trades: r.estimated.trades });
  const tables: BreakdownTable[] =
    r.quality.count === 0
      ? []
      : DIMENSIONS.map((d) => ({
          title: d.title,
          rows: r.breakdowns[d.key].map((b) => ({
            label: d.label(b.key),
            pnl: usd(b.pnl, true),
            tone: toneOf(b.pnl),
            count: String(b.count),
            winRate: pct(b.winRate, 1),
          })),
        })).filter((t) => t.rows.length > 0);
  return {
    scope: scopeName(r.headline.scope),
    asOf,
    headline: headlineRows(r, ranged, unrealisedAdded(filter, r.headline.live, now)),
    quality: { rows: qualityRows(r), note: trades },
    risk: riskRows(r),
    riskNote: estimatedNote(r.estimated),
    costs: {
      rows: costRows(r),
      note: estimatedNote({
        fills: r.costs.estimatedFills,
        funding: r.costs.estimatedFunding,
        liquidations: r.costs.estimatedLiquidations,
      }),
    },
    breakdowns: {
      tables,
      empty: tables.length === 0 ? 'No closed trades in this range' : null,
      note: tables.length > 0 ? trades : null,
    },
    open: r.open.pastRange
      ? `Open now: ${r.open.count}`
      : `Open: ${r.open.count}${r.open.count > 0 ? `, unrealised ${usd(r.open.unrealized, true)}` : ''}`,
    unattributed: r.unattributed.count > 0 ? `Realised outside any trade: ${usd(r.unattributed.realized, true)}` : null,
    uncovered: cmpDec(r.costs.uncovered, '0') !== 0 ? `Losses the wallet could not cover: ${usd(r.costs.uncovered)} (counted)` : null,
  };
}
