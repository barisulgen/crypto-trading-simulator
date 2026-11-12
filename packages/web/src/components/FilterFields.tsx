// The coin, market and date-range fields History and Stats both filter by, kept in the hash query.
import type { Wallet } from '@sim/engine';
import { HISTORY_COINS, isBackwards } from '../lib/history.ts';
import { CONTROL, Labelled, Segmented } from './ui.tsx';
import type { SegmentOption } from './ui.tsx';

export interface RangeFilter {
  symbol: string | null;
  market: Wallet | null;
  /** Local dates 'YYYY-MM-DD', both days included. */
  from: string | null;
  to: string | null;
}

/**
 * Coin select, market segmented control (All plus `markets`) and from/to dates. Laid out by the
 * caller's grid or flex container; a From date after the To date gets a note under them.
 */
export function FilterFields({
  value,
  onChange,
  markets,
  allTitle,
}: {
  value: RangeFilter;
  onChange(patch: Partial<RangeFilter>): void;
  markets: SegmentOption<Wallet>[];
  /** The tooltip of the All option. */
  allTitle: string;
}) {
  return (
    <>
      <Labelled label="Coin">
        {(id) => (
          <select
            id={id}
            value={value.symbol ?? ''}
            onChange={(e) => onChange({ symbol: e.target.value || null })}
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
        <Segmented<Wallet | 'all'>
          label="Market"
          value={value.market ?? 'all'}
          options={[{ value: 'all', label: 'All', title: allTitle }, ...markets]}
          onChange={(v) => onChange({ market: v === 'all' ? null : v })}
        />
      </div>
      <Labelled label="From">
        {(id) => (
          <input
            id={id}
            type="date"
            value={value.from ?? ''}
            max={value.to ?? undefined}
            onChange={(e) => onChange({ from: e.target.value || null })}
            className={CONTROL}
          />
        )}
      </Labelled>
      <Labelled label="To (inclusive)">
        {(id) => (
          <input
            id={id}
            type="date"
            value={value.to ?? ''}
            min={value.from ?? undefined}
            onChange={(e) => onChange({ to: e.target.value || null })}
            className={CONTROL}
          />
        )}
      </Labelled>
    </>
  );
}

/**
 * The note shown when the From date is after the To date; nothing otherwise. It sits in the filter
 * bar's own section, outside the part that folds on phones, so it is seen without opening Filters.
 */
export function BackwardsNote({ value, what }: { value: RangeFilter; what: string }) {
  if (!isBackwards(value)) return null;
  return (
    <p role="status" className="border-t border-line px-3 py-1.5 text-xs text-down">
      The From date is after the To date, so {what}.
    </p>
  );
}
