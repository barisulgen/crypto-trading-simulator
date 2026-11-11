// Stats: the result of the current season, filtered by coin, market and date range (kept in the
// hash query, e.g. '#/stats?symbol=BTCUSDT&from=2026-11-01'). Hours and weekdays are read in the
// browser's time zone.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EquityChart } from '../components/EquityChart.tsx';
import { StatsFilters } from '../components/StatsFilters.tsx';
import { Button } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { WireStatsReport } from '../lib/api.ts';
import { isBackwards } from '../lib/history.ts';
import { parseStatsFilters, statsFilterParams, statsQuery, statsView, unrealisedAdded } from '../lib/stats.ts';
import type { BreakdownTable, StatRow, StatTone, StatsView } from '../lib/stats.ts';

const TONE: Record<StatTone, string> = { up: 'text-up', down: 'text-down', muted: 'text-muted', plain: 'text-fg' };

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** The browser's IANA time zone: hours and weekdays are bucketed in it. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function Section({
  title,
  aside,
  className = '',
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col rounded-panel border border-line bg-panel ${className}`}>
      <header className="flex min-h-9 flex-none flex-wrap items-center justify-between gap-x-2 border-b border-line px-3 py-1.5">
        <h2 className="text-xs font-semibold text-muted">{title}</h2>
        {aside !== undefined && <span className="text-2xs text-faint">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function EstimatedBadge() {
  return (
    <span
      title="Estimated by a catch-up after a data gap"
      className="ml-1.5 inline-flex rounded-ctl border border-dashed border-accent px-1.5 align-middle text-2xs leading-[1.125rem] font-semibold whitespace-nowrap text-fg"
    >
      estimated
    </span>
  );
}

/** Label and value on one line, any note (and a History link) under them. */
function Rows({ rows }: { rows: StatRow[] }) {
  return (
    <dl className="flex flex-col px-3 py-1">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-0.5 border-b border-line/60 py-1.5 last:border-b-0">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-xs text-muted">
              {r.label}
              {r.estimated && <EstimatedBadge />}
            </dt>
            <dd className={`text-right text-sm font-semibold ${TONE[r.tone]}`}>{r.value}</dd>
          </div>
          {(r.note !== undefined || r.href !== undefined) && (
            <p className="text-2xs text-faint">
              {r.note}
              {r.href !== undefined && (
                <>
                  {' '}
                  <a href={r.href} className="whitespace-nowrap text-muted underline hover:text-fg">
                    Show in History
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      ))}
    </dl>
  );
}

/** A value that is a figure (money, a percent, '–'), not words such as 'incomplete: ...'. */
const FIGURE = /^[-+$\d–]/;

/** The headline figures as tiles: Net P&L first, the BTC benchmark beside the result. */
function Headline({ view }: { view: StatsView }) {
  return (
    <Section title="Result" aside={view.scope} className="desk:col-span-2">
      {view.asOf !== null && (
        <p role="status" className="border-b border-line bg-accent-soft px-3 py-1.5 text-xs text-fg">
          {view.asOf}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-3 desk:grid-cols-3 xl:grid-cols-6">
        {view.headline.map((r, i) => (
          <div key={r.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-2xs text-faint">{r.label}</dt>
            <dd
              className={`${!FIGURE.test(r.value) ? 'text-sm' : `whitespace-nowrap ${i === 0 ? 'text-xl' : 'text-lg'}`} font-semibold ${TONE[r.tone]}`}
            >
              {r.value}
            </dd>
            {r.note !== undefined && <dd className="text-2xs text-faint">{r.note}</dd>}
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Breakdown({ table }: { table: BreakdownTable }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-xs whitespace-nowrap">
        <thead>
          <tr className="border-b border-line text-2xs text-faint">
            <th scope="col" className="py-1 pr-3 text-left font-semibold text-muted">
              {table.title}
            </th>
            <th scope="col" className="py-1 pl-3 text-right font-normal">
              P&amp;L
            </th>
            <th scope="col" className="py-1 pl-3 text-right font-normal">
              Trades
            </th>
            <th scope="col" className="py-1 pl-3 text-right font-normal">
              Win rate
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.label} className="border-b border-line/60 last:border-b-0">
              <th scope="row" className="py-1 pr-3 text-left font-normal">
                {r.label}
              </th>
              <td className={`py-1 pl-3 text-right ${TONE[r.tone]}`}>{r.pnl}</td>
              <td className="py-1 pl-3 text-right">{r.count}</td>
              <td className="py-1 pl-3 text-right">{r.winRate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Figures({ view, chart, tz }: { view: StatsView; chart: ReactNode; tz: string }) {
  const extra = [view.open, view.unattributed, view.uncovered].filter((l) => l !== null);
  return (
    <div className="grid grid-cols-1 gap-1.5 desk:grid-cols-2 desk:items-start">
      <Headline view={view} />
      <Section title="Equity" className="desk:col-span-2">
        {chart}
      </Section>
      <Section title="Trade quality" aside={view.quality.note ?? undefined}>
        <Rows rows={view.quality.rows} />
      </Section>
      <Section title="Risk" aside={view.riskNote ?? undefined}>
        <Rows rows={view.risk} />
      </Section>
      <Section title="Costs" aside={view.costs.note ?? undefined}>
        <Rows rows={view.costs.rows} />
      </Section>
      <Section title="Breakdowns" aside={view.breakdowns.note ?? undefined}>
        <div className="flex flex-col gap-3 p-3">
          {view.breakdowns.empty !== null ? (
            <p className="text-xs text-muted">{view.breakdowns.empty}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {view.breakdowns.tables.map((t) => (
                <Breakdown key={t.title} table={t} />
              ))}
            </div>
          )}
          <p className="text-2xs text-faint">Times in {tz}. Hour and day are when the trade was opened.</p>
        </div>
      </Section>
      <Section title="Outside the trade figures" className="desk:col-span-2">
        <ul className="flex flex-col gap-1 px-3 py-2 text-xs">
          {extra.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

interface LoadState {
  report: WireStatsReport | null;
  status: 'loading' | 'ready' | 'error';
  error: string;
}

function Message({ children }: { children: ReactNode }) {
  return <div className="m-auto flex max-w-[34ch] flex-col items-center gap-3 p-8 text-center text-xs text-faint">{children}</div>;
}

/** Stats screen. A filter change navigates, which computes the stats again; Refresh does so in place. */
export function StatsPage({ params }: { params: URLSearchParams }) {
  const filters = parseStatsFilters(params);
  const key = new URLSearchParams(statsFilterParams(filters)).toString();
  const [tz] = useState(timeZone);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LoadState>({ report: null, status: 'loading', error: '' });
  const shownKey = useRef(key);
  // Answers for an older request (the filters changed since) are dropped.
  const gen = useRef(0);

  const backwards = isBackwards(filters);

  useEffect(() => {
    const g = ++gen.current;
    const sameView = shownKey.current === key;
    shownKey.current = key;
    // A From date after the To date covers no moment: nothing is asked; the filters bar says why.
    if (isBackwards(parseStatsFilters(new URLSearchParams(key)))) {
      setState({ report: null, status: 'ready', error: '' });
      return;
    }
    // A refresh keeps the figures on screen until the new ones arrive; new filters start empty.
    setState((s) => (sameView ? { ...s, status: 'loading' } : { report: null, status: 'loading', error: '' }));
    api.stats(statsQuery(parseStatsFilters(new URLSearchParams(key)), tz)).then(
      (report) => {
        if (g === gen.current) setState({ report, status: 'ready', error: '' });
      },
      (e: unknown) => {
        if (g === gen.current) setState((s) => ({ ...s, status: 'error', error: errorText(e) }));
      },
    );
    return () => {
      gen.current++;
    };
  }, [key, tz, refresh]);

  const retry = () => setRefresh((n) => n + 1);
  let body: ReactNode;
  if (backwards) {
    body = null;
  } else if (state.report === null) {
    body =
      state.status === 'error' ? (
        <Message>
          <p role="alert" className="text-sm text-fg">
            Could not load the stats: {state.error}
          </p>
          <Button onClick={retry}>Retry</Button>
        </Message>
      ) : (
        <Message>Computing stats...</Message>
      );
  } else {
    const now = Date.now();
    const report = state.report;
    body = (
      <>
        {state.status === 'error' && (
          <p role="alert" className="mb-1.5 flex items-center gap-2 rounded-panel border border-line bg-down-soft px-3 py-1.5 text-xs text-fg">
            Could not refresh: {state.error}
            <Button tone="quiet" size="sm" onClick={retry}>
              Retry
            </Button>
          </p>
        )}
        <div className={state.status === 'loading' ? 'opacity-60' : ''}>
          <Figures
            view={statsView(report, filters, now)}
            chart={<EquityChart report={report} unrealisedAdded={unrealisedAdded(filters, report.headline.live, now)} />}
            tz={tz}
          />
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[100rem] flex-col desk:gap-1.5 desk:p-1.5">
      <StatsFilters filters={filters} live={backwards ? null : (state.report?.headline.live ?? null)} onRefresh={retry} />
      <div aria-busy={state.status === 'loading'} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-1.5 desk:p-0">
        {body}
      </div>
    </div>
  );
}
