// The Stats filters bar: coin, market and date range, kept in the hash query like History's, with
// a note on what a filter does not narrow (the benchmark; a coin's curve).
import { useState } from 'react';
import { navigate } from '../lib/route.ts';
import { EMPTY_STATS_FILTER, STATS_MARKETS, filterNotes, hasStatsFilters, statsFilterParams } from '../lib/stats.ts';
import type { StatsFilter } from '../lib/stats.ts';
import { BackwardsNote, FilterFields } from './FilterFields.tsx';
import { Button, RefreshIcon } from './ui.tsx';

const go = (f: StatsFilter) => navigate('/stats', statsFilterParams(f));

export function StatsFilters({ filters, onRefresh }: { filters: StatsFilter; onRefresh(): void }) {
  // Phones: the filters fold behind a button so the figures keep the screen; desktop shows them all.
  const [open, setOpen] = useState(false);
  const notes = filterNotes(filters);
  const count = [filters.symbol !== null, filters.market !== null, filters.from !== null || filters.to !== null].filter(Boolean).length;
  return (
    <section aria-label="Filters" className="flex-none border-b border-line bg-panel desk:rounded-panel desk:border">
      <div className="flex h-11 items-center gap-2 px-3 desk:h-9">
        <h1 className="text-xs font-semibold text-muted">Stats</h1>
        <Button size="sm" className="desk:hidden" aria-expanded={open} aria-controls="stats-filters" onClick={() => setOpen(!open)}>
          Filters
          {count > 0 && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-on-accent">{count}</span>}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {hasStatsFilters(filters) && (
            <Button tone="quiet" size="sm" onClick={() => go(EMPTY_STATS_FILTER)}>
              Clear filters
            </Button>
          )}
          <Button tone="quiet" size="sm" aria-label="Refresh" title="Compute the stats again" onClick={onRefresh}>
            <RefreshIcon />
            <span className="hidden desk:inline">Refresh</span>
          </Button>
        </div>
      </div>
      <div
        id="stats-filters"
        className={`${open ? 'flex' : 'hidden'} flex-col gap-2 border-t border-line px-3 pt-2.5 pb-3 desk:flex desk:border-t-0 desk:pt-0`}
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 desk:flex desk:flex-wrap desk:items-end desk:gap-x-4">
          <FilterFields
            value={filters}
            onChange={(patch) => go({ ...filters, ...patch })}
            markets={STATS_MARKETS}
            allTitle="The whole account: both wallets and every trade"
          />
        </div>
        <BackwardsNote value={filters} what="there is nothing to compute" />
        {notes.length > 0 && (
          <ul aria-label="What the filters do not narrow" className="flex flex-col gap-0.5 text-2xs text-muted">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
