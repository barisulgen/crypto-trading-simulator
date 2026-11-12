// History: every recorded event, newest first, with filters (coin, spot or leverage, event
// type, date range) kept in the hash query, e.g. '#/history?symbol=BTCUSDT&types=fill', so a
// filtered view survives a reload, can be bookmarked, and Back/Forward step through filter changes.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BackwardsNote, FilterFields } from '../components/FilterFields.tsx';
import { Button, CONTROL, RefreshIcon } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { HistoryRow } from '../lib/api.ts';
import { EXPORT_PAGE_SIZE, fetchAllHistory, historyCsv } from '../lib/csv.ts';
import type { CsvFormat } from '../lib/csv.ts';
import { loadCsvFormat, saveCsvFormat } from '../lib/csvFormat.ts';
import {
  EMPTY_FILTERS,
  EVENT_TYPES,
  MARKET_FILTERS,
  describeEvent,
  filterParams,
  hasFilters,
  historyQuery,
  localDate,
  parseFilters,
  sortTypes,
} from '../lib/history.ts';
import type { EventType, EventView, HistoryFilters, Tone } from '../lib/history.ts';
import { useLive } from '../lib/live.ts';
import { fmtClock, fmtDate, fmtDateTime } from '../lib/market.ts';
import { navigate } from '../lib/route.ts';

const go = (f: HistoryFilters) => navigate('/history', filterParams(f));

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

// ---- export ----

/** Saves the text as a file through a temporary download link. */
function saveCsv(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const FORMAT_TITLES: Record<CsvFormat, string> = {
  standard: 'Commas between fields, dot decimals',
  'excel-eu': 'Semicolons between fields, comma decimals: opens directly in Excel with Turkish or European settings',
};

/** The browser's local storage, or null where even looking it up is refused. */
function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Every event the filters match as a CSV file; nothing is saved if any page fails. */
function ExportButton({ filters, onError }: { filters: HistoryFilters; onError(message: string): void }) {
  const [rows, setRows] = useState<number | null>(null);
  const running = rows !== null;
  const [format, setFormat] = useState<CsvFormat>(() => loadCsvFormat(browserStorage()));

  function choose(f: CsvFormat) {
    setFormat(f);
    saveCsvFormat(browserStorage(), f);
  }

  async function run() {
    onError('');
    setRows(0);
    try {
      const all = await fetchAllHistory(
        (before) => api.history({ ...historyQuery(filters, before), limit: EXPORT_PAGE_SIZE }),
        setRows,
      );
      saveCsv(historyCsv(all, Intl.DateTimeFormat().resolvedOptions().timeZone, format), `history-${localDate(Date.now())}.csv`);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setRows(null);
    }
  }

  return (
    <>
      {running && (
        <span role="status" className="text-xs whitespace-nowrap text-muted">
          Exporting... {rows} rows
        </span>
      )}
      <select
        aria-label="CSV format"
        value={format}
        disabled={running}
        onChange={(e) => choose(e.target.value === 'excel-eu' ? 'excel-eu' : 'standard')}
        title={FORMAT_TITLES[format]}
        className={`${CONTROL} h-9 w-auto flex-none field-sizing-content desk:h-6 desk:px-1`}
      >
        <option value="standard" title={FORMAT_TITLES.standard}>
          Standard
        </option>
        <option value="excel-eu" title={FORMAT_TITLES['excel-eu']}>
          Excel (Turkish/European)
        </option>
      </select>
      <Button tone="quiet" size="sm" disabled={running} title="Save every event these filters match as a CSV file" onClick={run}>
        Export CSV
      </Button>
    </>
  );
}

// ---- filters ----

function activeCount(f: HistoryFilters): number {
  return [f.symbol !== null, f.market !== null, f.types.length > 0, f.from !== null || f.to !== null].filter(Boolean).length;
}

function TypeChips({ types, onChange }: { types: EventType[]; onChange(t: EventType[]): void }) {
  const chip = (on: boolean) =>
    `h-7 rounded-ctl border px-2 text-xs whitespace-nowrap ${
      on
        ? 'border-faint bg-raised font-semibold text-fg shadow-[inset_0_-2px_0_var(--color-accent)]'
        : 'border-line text-muted hover:text-fg'
    }`;
  return (
    <div role="group" aria-label="Event types" className="flex flex-wrap gap-1">
      <button type="button" aria-pressed={types.length === 0} onClick={() => onChange([])} className={chip(types.length === 0)}>
        All types
      </button>
      {EVENT_TYPES.map((t) => {
        const on = types.includes(t.type);
        return (
          <button
            key={t.type}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(sortTypes(on ? types.filter((x) => x !== t.type) : [...types, t.type]))}
            className={chip(on)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterBar({ filters, onRefresh }: { filters: HistoryFilters; onRefresh(): void }) {
  // Phones: the filters fold behind a button so the list keeps the screen; desktop shows them all.
  const [open, setOpen] = useState(false);
  const [exportError, setExportError] = useState('');
  const count = activeCount(filters);
  const set = (patch: Partial<HistoryFilters>) => go({ ...filters, ...patch });
  return (
    <section aria-label="Filters" className="flex-none border-b border-line bg-panel desk:rounded-panel desk:border">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 desk:min-h-9">
        <h1 className="text-xs font-semibold text-muted">History</h1>
        <Button
          size="sm"
          className="desk:hidden"
          aria-expanded={open}
          aria-controls="history-filters"
          onClick={() => setOpen(!open)}
        >
          Filters
          {count > 0 && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-on-accent">{count}</span>}
        </Button>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          <ExportButton filters={filters} onError={setExportError} />
          {hasFilters(filters) && (
            <Button tone="quiet" size="sm" onClick={() => go(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          )}
          <Button tone="quiet" size="sm" aria-label="Refresh" title="Load the newest events again" onClick={onRefresh}>
            <RefreshIcon />
            <span className="hidden desk:inline">Refresh</span>
          </Button>
        </div>
      </div>
      {exportError !== '' && (
        <p role="alert" className="border-t border-line px-3 py-1.5 text-xs break-words text-down">
          Export failed: {exportError}
        </p>
      )}
      <div
        id="history-filters"
        className={`${open ? 'flex' : 'hidden'} flex-col gap-3 border-t border-line px-3 pt-2.5 pb-3 desk:flex desk:border-t-0 desk:pt-0`}
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 desk:flex desk:flex-wrap desk:items-end desk:gap-x-4">
          <FilterFields value={filters} onChange={set} markets={MARKET_FILTERS} allTitle="Both markets and every account event" />
        </div>
        <TypeChips types={filters.types} onChange={(types) => set({ types })} />
      </div>
      <BackwardsNote value={filters} what="no event can match" />
    </section>
  );
}

// ---- rows ----

const BADGE: Record<EventView['tone'], string> = {
  plain: 'border-line bg-raised text-fg',
  muted: 'border-line text-muted',
  down: 'border-down/50 bg-down-soft text-fg',
  accent: 'border-accent/70 bg-accent-soft text-fg',
};

const TONE: Record<Tone, string> = { up: 'text-up', down: 'text-down', muted: 'text-muted' };

/** Desktop: time | event | coin | details on one dense line. Phones: a card with the details two to a line. */
const GRID = 'desk:grid desk:grid-cols-[9.75rem_10rem_4.5rem_minmax(0,1fr)] desk:gap-x-3';

/**
 * The badge of an event a catch-up produced: 'estimated', with what it was estimated from as its
 * tooltip; a tap (phones have no hover) shows the same text under the row.
 */
function EstimatedBadge({ text, open, onToggle }: { text: string; open: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      title={text}
      aria-expanded={open}
      aria-label={`Estimated: ${text}`}
      onClick={onToggle}
      className="inline-flex rounded-ctl border border-dashed border-accent px-1.5 text-2xs leading-[1.125rem] font-semibold whitespace-nowrap text-fg hover:bg-accent-soft"
    >
      estimated
    </button>
  );
}

function EventLine({ row }: { row: HistoryRow }) {
  const v = describeEvent(row);
  const [why, setWhy] = useState(false);
  const estimated = v.estimated ? `${v.estimated.why} ${v.estimated.gap}.` : null;
  return (
    <li className={`flex flex-col gap-2 border-b border-line/60 px-3 py-2.5 text-xs desk:py-1.5 ${GRID}`}>
      <div className="flex flex-wrap items-center gap-2 desk:contents">
        <time
          dateTime={Number.isFinite(row.time) ? new Date(row.time).toISOString() : undefined}
          title={fmtDateTime(row.time)}
          className="order-last ml-auto text-2xs whitespace-nowrap text-muted desk:order-none desk:ml-0 desk:pt-px desk:text-xs"
        >
          <span>{fmtDate(row.time)}</span> <span className="text-fg">{fmtClock(row.time)}</span>
        </time>
        <span className="flex flex-wrap items-center gap-1 desk:items-start desk:pt-px">
          <span className={`inline-flex rounded-ctl border px-1.5 text-2xs leading-[1.125rem] font-semibold whitespace-nowrap ${BADGE[v.tone]}`}>
            {v.label}
          </span>
          {estimated !== null && <EstimatedBadge text={estimated} open={why} onToggle={() => setWhy(!why)} />}
        </span>
        {v.coin !== null ? (
          <span className="whitespace-nowrap desk:pt-px">
            <span className="font-semibold">{v.coin}</span>
            {v.market !== null && <span className="ml-1 text-2xs text-muted">{v.market}</span>}
          </span>
        ) : (
          <span className="hidden text-faint desk:inline desk:pt-px">-</span>
        )}
      </div>
      <div className="min-w-0 desk:pt-px">
        {v.fields.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 desk:flex desk:flex-wrap desk:gap-x-4 desk:gap-y-0.5">
            {v.fields.map((f) => (
              <div key={f.label} className="min-w-0 desk:whitespace-nowrap">
                <dt className="text-2xs text-faint desk:mr-1.5 desk:inline">{f.label}</dt>
                <dd className={`[overflow-wrap:anywhere] desk:inline ${f.tone ? TONE[f.tone] : ''}`}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {v.note && (
          <p className="mt-1.5 desk:mt-0.5">
            <span className="mr-1.5 text-2xs text-faint">{v.note.label}</span>
            <span className="[overflow-wrap:anywhere]">{v.note.text}</span>
          </p>
        )}
        {v.list && (
          <div className="mt-1.5 desk:mt-0.5">
            <span className="text-2xs text-faint">{v.list.label}</span>
            <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4">
              {v.list.items.map((item, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        {why && estimated !== null && (
          <p className="mt-1.5 rounded-ctl border border-dashed border-accent/70 px-2 py-1 desk:mt-0.5">
            <span className="mr-1.5 text-2xs text-faint">Estimated</span>
            <span className="[overflow-wrap:anywhere]">{estimated}</span>
          </p>
        )}
      </div>
    </li>
  );
}

// ---- list ----

interface ListState {
  rows: HistoryRow[];
  nextBefore: number | null;
  status: 'loading' | 'ready' | 'error';
  error: string;
  more: 'idle' | 'loading' | 'error';
  moreError: string;
}

const LOADING: ListState = { rows: [], nextBefore: null, status: 'loading', error: '', more: 'idle', moreError: '' };

function Message({ children }: { children: ReactNode }) {
  return <div className="m-auto flex max-w-[34ch] flex-col items-center gap-3 p-8 text-center text-xs text-faint">{children}</div>;
}

/**
 * History screen. The filters are the hash query; a filter change navigates, which reloads the
 * first page (50 events). 'Load more' pages back with the server's `nextBefore` cursor.
 */
export function HistoryPage({ params }: { params: URLSearchParams }) {
  // Rules (tick and step decimals) arrive with /api/meta; re-render when they do.
  useLive((s) => s.meta);
  const filters = parseFilters(params);
  const key = new URLSearchParams(filterParams(filters)).toString();
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<ListState>(LOADING);
  const shownKey = useRef(key);
  // Each first-page load is a generation; answers for an older one (filters changed since) are dropped.
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    const sameView = shownKey.current === key;
    shownKey.current = key;
    // A refresh keeps the rows on screen until the new page arrives; new filters start empty.
    setList((l) => (sameView ? { ...l, status: 'loading', more: 'idle' } : LOADING));
    api.history(historyQuery(parseFilters(new URLSearchParams(key)))).then(
      (page) => {
        if (g === gen.current) setList({ ...LOADING, rows: page.rows, nextBefore: page.nextBefore, status: 'ready' });
      },
      (e: unknown) => {
        if (g === gen.current) setList((l) => ({ ...l, status: 'error', error: errorText(e) }));
      },
    );
    // Leaving the page (or a newer load) drops every answer still on its way, 'Load more' included.
    return () => {
      gen.current++;
    };
  }, [key, refresh]);

  function loadMore() {
    if (list.nextBefore === null) return;
    const g = gen.current;
    setList((l) => ({ ...l, more: 'loading' }));
    api.history(historyQuery(filters, list.nextBefore)).then(
      (page) => {
        if (g !== gen.current) return;
        setList((l) => {
          const seen = new Set(l.rows.map((r) => r.id));
          return { ...l, rows: [...l.rows, ...page.rows.filter((r) => !seen.has(r.id))], nextBefore: page.nextBefore, more: 'idle' };
        });
      },
      (e: unknown) => {
        if (g === gen.current) setList((l) => ({ ...l, more: 'error', moreError: errorText(e) }));
      },
    );
  }

  const filtered = hasFilters(filters);
  let body: ReactNode;
  if (list.status === 'error' && list.rows.length === 0) {
    body = (
      <Message>
        <p role="alert" className="text-sm text-fg">
          Could not load the history: {list.error}
        </p>
        <Button onClick={() => setRefresh((n) => n + 1)}>Retry</Button>
      </Message>
    );
  } else if (list.status === 'loading' && list.rows.length === 0) {
    body = <Message>Loading history...</Message>;
  } else if (list.rows.length === 0) {
    body = filtered ? (
      <Message>
        <p className="text-sm text-muted">No events match these filters</p>
        <Button onClick={() => go(EMPTY_FILTERS)}>Clear filters</Button>
      </Message>
    ) : (
      <Message>
        <p className="text-sm text-muted">Nothing recorded yet</p>
        Deposits, orders, fills, positions, funding, liquidations and data gaps will be listed here as they happen.
      </Message>
    );
  } else {
    body = (
      <>
        {list.status === 'error' && (
          <p role="alert" className="flex items-center gap-2 border-b border-line bg-down-soft px-3 py-1.5 text-xs text-fg">
            Could not refresh: {list.error}
            <Button tone="quiet" size="sm" onClick={() => setRefresh((n) => n + 1)}>
              Retry
            </Button>
          </p>
        )}
        <div
          aria-hidden="true"
          className={`sticky top-0 z-[1] hidden border-b border-line bg-panel px-3 py-1 text-2xs text-faint ${GRID}`}
        >
          <span>Time</span>
          <span>Event</span>
          <span>Coin</span>
          <span>Details</span>
        </div>
        <ol aria-label="Events, newest first" className={list.status === 'loading' ? 'opacity-60' : ''}>
          {list.rows.map((r) => (
            <EventLine key={r.id} row={r} />
          ))}
        </ol>
        <div className="flex flex-col items-center gap-2 px-3 py-4 text-xs text-faint">
          {list.nextBefore !== null ? (
            <>
              {list.more === 'error' && (
                <p role="alert" className="text-down">
                  Could not load more: {list.moreError}
                </p>
              )}
              <Button disabled={list.more === 'loading'} onClick={loadMore}>
                {list.more === 'loading' ? 'Loading...' : list.more === 'error' ? 'Retry' : 'Load more'}
              </Button>
              <span>
                {list.rows.length} events shown
              </span>
            </>
          ) : (
            <span>
              {filtered ? 'End of the matching events' : 'Start of the history'} - {list.rows.length}{' '}
              {list.rows.length === 1 ? 'event' : 'events'}
            </span>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[100rem] flex-col desk:gap-1.5 desk:p-1.5">
      <FilterBar filters={filters} onRefresh={() => setRefresh((n) => n + 1)} />
      <section
        aria-label="Events"
        aria-busy={list.status === 'loading'}
        className="flex min-h-0 flex-1 flex-col overflow-auto bg-panel desk:rounded-panel desk:border desk:border-line"
      >
        {body}
      </section>
    </div>
  );
}
