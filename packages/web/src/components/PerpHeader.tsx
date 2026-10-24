// Mark price, index price, funding rate and the countdown to the next funding of the selected perpetual.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fmtPrice } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { fmtCountdown, fmtFundingPct } from '../lib/market.ts';

/** The current time, updated every `ms` while mounted. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function Figure({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div
      title={title}
      className="flex min-w-0 flex-col @min-[34rem]:flex-row @min-[34rem]:items-baseline @min-[34rem]:gap-1.5"
    >
      <dt className="text-2xs text-faint">{label}</dt>
      <dd className="text-sm whitespace-nowrap text-fg">{children}</dd>
    </div>
  );
}

/**
 * The selected perpetual's mark and index price, funding rate (percent, 4 dp) and the time left
 * to the next funding. All of them come with the mark price: while it is stale (no update for
 * 10 s) or our connection is down, they are dimmed and marked stale, never shown as live; before
 * the first mark they are dashes.
 */
export function PerpHeader({ symbol }: { symbol: string }) {
  const mark = useLive((s) => s.marks[symbol]);
  const down = useLive((s) => s.conn !== 'open');
  const now = useNow(1000);
  const stale = !mark || !mark.fresh || down;
  const why = !mark
    ? 'No mark price yet'
    : down
      ? 'Connection to the simulator lost: these values are frozen'
      : 'No mark price update for over 10 s: these values may be out of date';

  return (
    // Labels over values in four columns; on one line where the panel is wide enough.
    <div className="@container flex flex-none items-center gap-x-3 border-b border-line px-3 py-1.5">
      <dl className={`grid min-w-0 flex-1 grid-cols-4 gap-x-3 @min-[34rem]:flex @min-[34rem]:gap-x-5 ${stale ? 'opacity-50' : ''}`}>
        <Figure label="Mark">{fmtPrice(symbol, mark?.markPrice, { market: 'perp' })}</Figure>
        <Figure label="Index">{fmtPrice(symbol, mark?.indexPrice, { market: 'perp' })}</Figure>
        <Figure label="Funding" title="Paid by longs to shorts when positive, by shorts to longs when negative">
          {fmtFundingPct(mark?.fundingRate)}
        </Figure>
        <Figure label="Next funding" title="Time left until the next funding is settled">
          {mark ? fmtCountdown(mark.nextFundingTime - now) : '-'}
        </Figure>
      </dl>
      {mark && stale && (
        <span
          role="status"
          title={why}
          className="flex flex-none items-center gap-1.5 rounded-ctl border border-accent/60 px-1.5 py-0.5 text-2xs font-semibold text-fg"
        >
          <span aria-hidden="true" className="size-2 flex-none rounded-full border-2 border-accent" />
          Stale
          <span className="sr-only">: {why}</span>
        </span>
      )}
    </div>
  );
}
