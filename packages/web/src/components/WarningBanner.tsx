// The margin warning bar over the trade screen: shown while any position nears liquidation.
import { useEffect, useRef } from 'react';
import { useLive } from '../lib/live.ts';
import { bannerEntries } from '../lib/positions.ts';
import type { BannerEntry } from '../lib/positions.ts';

const LEVEL: Record<BannerEntry['level'], { bar: string; word: string }> = {
  amber: { bar: 'bg-accent text-on-accent', word: 'Margin warning' },
  red: { bar: 'bg-down text-panel', word: 'Near liquidation' },
  pulse: { bar: 'bg-down text-panel danger-pulse', word: 'Liquidation imminent' },
};

/**
 * One full-width bar per position at a margin ratio of 50 % or more: amber from 50 %, red from
 * 80 %, red and pulsing from 90 %. It names the coin, the ratio and how far the liquidation price
 * is from the mark, and has no dismiss: it goes only when the ratio does. Figures from the last
 * live mark are marked stale.
 */
export function WarningBannerView({ entries }: { entries: BannerEntry[] }) {
  if (entries.length === 0) return null;
  return (
    // A polite status, not an alert: the figures change every second.
    <div role="status" aria-label="Margin warnings" className="flex flex-none flex-col">
      {entries.map((e) => {
        const l = LEVEL[e.level];
        return (
          <p
            key={`${e.symbol}:${e.side}`}
            data-level={e.level}
            className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm desk:px-4 ${l.bar}`}
          >
            <span className="font-bold whitespace-nowrap uppercase [font-stretch:108%]">{l.word}</span>
            <span className="whitespace-nowrap">
              <span className="font-semibold">{`${e.symbol.replace(/USDT$/, '')} ${e.side}`}</span> margin ratio{' '}
              <span className="font-semibold">{e.ratioPct}</span>
            </span>
            {e.liqDistancePct !== null && (
              <span className="whitespace-nowrap">
                liquidation <span className="font-semibold">{`${e.liqDistancePct}%`}</span> from the mark
              </span>
            )}
            {e.stale && (
              <span className="rounded-ctl border border-current px-1 text-2xs font-semibold whitespace-nowrap">
                Stale: last live figures
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
}

/**
 * The banner from the live positions. A level comes and goes only on a live mark; while a
 * position's mark is not live (stale, our connection down, catching up) its last level stays.
 */
export function WarningBanner() {
  const positions = useLive((s) => s.positions);
  const down = useLive((s) => s.conn !== 'open');
  const perp = useLive((s) => s.meta?.perp);
  const last = useRef<BannerEntry[]>([]);
  const entries = bannerEntries(last.current, positions, {
    down,
    tick: (symbol) => perp?.[symbol]?.rules?.tickSize ?? undefined,
  });
  useEffect(() => {
    last.current = entries;
  });
  return <WarningBannerView entries={entries} />;
}
