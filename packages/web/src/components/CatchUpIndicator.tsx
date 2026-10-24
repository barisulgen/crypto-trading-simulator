// The amber strip shown while any market of any coin catches up after a data gap.
import { catchingUpFeeds, useLive } from '../lib/live.ts';
import type { Selection } from '../lib/live.ts';

/**
 * Names every market catching up ('BTC perp, ETH spot'): its feed is fresh again, but what
 * happened during the gap is still being applied, so trading on it waits. Nothing without any.
 */
export function CatchUpIndicatorView({ feeds }: { feeds: Selection[] }) {
  if (feeds.length === 0) return null;
  const names = feeds.map((f) => `${f.symbol.replace(/USDT$/, '')} ${f.market}`).join(', ');
  const them = feeds.length === 1 ? 'it' : 'them';
  return (
    <div
      role="status"
      className="flex flex-none items-start gap-2 border-b border-accent/60 bg-accent-soft px-3 py-1.5 text-xs text-fg desk:px-4"
    >
      <span aria-hidden="true" className="mt-[0.2rem] size-2.5 flex-none animate-pulse rounded-full bg-accent" />
      <p className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-semibold">Catching up</span> after a data gap: {names}. What happened during the gap is
        being applied; trading on {them} resumes when it is done, and what it applies is marked estimated in the
        history.
      </p>
    </div>
  );
}

/** The strip for the live store; hidden while our own connection is down, since its list is then old. */
export function CatchUpIndicator() {
  const health = useLive((s) => s.health);
  const markets = useLive((s) => s.markets);
  const catchingUp = useLive((s) => s.catchingUp);
  const open = useLive((s) => s.conn === 'open');
  const symbols = useLive((s) => s.meta?.symbols) ?? Object.keys(health);
  const feeds = open ? catchingUpFeeds({ health, markets, catchingUp }, symbols) : [];
  return <CatchUpIndicatorView feeds={feeds} />;
}
