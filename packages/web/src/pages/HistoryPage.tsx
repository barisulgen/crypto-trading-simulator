// History (T16): every recorded event, newest first, with filters (coin, spot or leverage, event
// type, date range) kept in the hash query, e.g. '#/history?symbol=BTCUSDT&types=fill', so a
// filtered view survives a reload, can be bookmarked, and Back/Forward step through filter changes.
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Segmented } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { HistoryRow } from '../lib/api.ts';
import {
  EMPTY_FILTERS,
  EVENT_TYPES,
  HISTORY_COINS,
  describeEvent,
  filterParams,
  hasFilters,
  historyQuery,
  parseFilters,
  sortTypes,
} from '../lib/history.ts';
import type { EventType, EventView, HistoryFilters, Tone } from '../lib/history.ts';
import { useLive } from '../lib/live.ts';
import { fmtClock, fmtDate, fmtDateTime } from '../lib/market.ts';
import { navigate } from '../lib/route.ts';

const go = (f: HistoryFilters) => navigate('/history', filterParams(f));

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

// ---- filters ----

const CONTROL =
  'h-8 min-w-0 rounded-ctl border border-line bg-canvas px-2 text-xs text-fg focus:border-focus disabled:opacity-50';

function Labelled({ label, children, className = '' }: { label: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-2xs text-faint">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

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

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.5H10" />
    </svg>
  );
}

function FilterBar({ filters, onRefresh }: { filters: HistoryFilters; onRefresh(): void }) {
  // Phones: the filters fold behind a button so the list keeps the screen; desktop shows them all.
  const [open, setOpen] = useState(false);
  const count = activeCount(filters);
  const set = (patch: Partial<HistoryFilters>) => go({ ...filters, ...patch });
  const backwards = filters.from !== null && filters.to !== null && filters.from > filters.to;
  return (
    <section aria-label="Filters" className="flex-none border-b border-line bg-panel desk:rounded-panel desk:border">
      <div className="flex h-11 items-center gap-2 px-3 desk:h-9">
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
        <div className="ml-auto flex items-center gap-1">
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
      <div
        id="history-filters"
        className={`${open ? 'flex' : 'hidden'} flex-col gap-3 border-t border-line px-3 pt-2.5 pb-3 desk:flex desk:border-t-0 desk:pt-0`}
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 desk:flex desk:flex-wrap desk:items-end desk:gap-x-4">
          <Labelled label="Coin">
            {(id) => (
              <select
                id={id}
                value={filters.symbol ?? ''}
                onChange={(e) => set({ symbol: e.target.value || null })}
                className={`${CONTROL} desk:w-32`}
              >
                <option value="">All coins</option>
                {HISTORY_COINS.map((c) => (
                  <option key={c} value={`${c}USDT`}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Labelled>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-2xs text-faint" aria-hidden="true">
              Market
            </span>
            <Segmented
              label="Market"
              value={filters.market ?? 'all'}
              options={[
                { value: 'all', label: 'All' },
                { value: 'spot', label: 'Spot' },
                { value: 'leverage', label: 'Leverage', title: 'Leverage trading arrives in Phase 2; deposits and transfers show here' },
              ]}
              onChange={(v) => set({ market: v === 'all' ? null : v })}
            />
          </div>
          <Labelled label="From">
            {(id) => (
              <input
                id={id}
                type="date"
                value={filters.from ?? ''}
                max={filters.to ?? undefined}
                onChange={(e) => set({ from: e.target.value || null })}
                className={CONTROL}
              />
            )}
          </Labelled>
          <Labelled label="To (inclusive)">
            {(id) => (
              <input
                id={id}
                type="date"
                value={filters.to ?? ''}
                min={filters.from ?? undefined}
                onChange={(e) => set({ to: e.target.value || null })}
                className={CONTROL}
              />
            )}
          </Labelled>
        </div>
        {backwards && (
          <p role="status" className="text-xs text-down">
            The From date is after the To date, so no event can match.
          </p>
        )}
        <TypeChips types={filters.types} onChange={(types) => set({ types })} />
      </div>
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
const GRID = 'desk:grid desk:grid-cols-[9.75rem_10rem_3.25rem_minmax(0,1fr)] desk:gap-x-3';

function EventLine({ row }: { row: HistoryRow }) {
  const v = describeEvent(row);
  return (
    <li className={`flex flex-col gap-2 border-b border-line/60 px-3 py-2.5 text-xs desk:py-1.5 ${GRID}`}>
      <div className="flex items-center gap-2 desk:contents">
        <time
          dateTime={new Date(row.time).toISOString()}
          title={fmtDateTime(row.time)}
          className="order-last ml-auto text-2xs whitespace-nowrap text-muted desk:order-none desk:ml-0 desk:pt-px desk:text-xs"
        >
          <span>{fmtDate(row.time)}</span> <span className="text-fg">{fmtClock(row.time)}</span>
        </time>
        <span className="desk:pt-px">
          <span className={`inline-flex rounded-ctl border px-1.5 text-2xs leading-[1.125rem] font-semibold whitespace-nowrap ${BADGE[v.tone]}`}>
            {v.label}
          </span>
        </span>
        {v.coin !== null ? (
          <span className="font-semibold desk:pt-px">{v.coin}</span>
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
        Deposits, orders, fills and feed gaps will be listed here as they happen.
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
