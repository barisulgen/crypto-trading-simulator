import { useEffect, useRef, useState } from 'react';
import { feedStatus, feedSummary, useLive } from '../lib/live.ts';
import type { Connection, FeedState, FeedSummary, LiveData } from '../lib/live.ts';
import type { Market } from '../lib/api.ts';

type Overall = 'live' | 'catching_up' | 'interrupted' | 'down' | 'connecting';

/** Green: live. Amber: catching up after a gap. Red: interrupted, or our own connection lost. */
const DOT: Record<Overall, string> = {
  live: 'bg-up rounded-full',
  catching_up: 'bg-accent rounded-full',
  interrupted: 'border-2 border-down rounded-full',
  down: 'bg-down rounded-[1px]',
  connecting: 'border-2 border-faint rounded-full',
};

const canHover = () => matchMedia('(hover: hover)').matches;

/**
 * The indicator's summary: its tone, the desktop label and the shorter phone label. Interrupted
 * feeds outrank those catching up, which outrank live ones.
 */
export function feedLabel(conn: Connection, f: FeedSummary): { tone: Overall; long: string; short: string } {
  if (conn === 'down') return { tone: 'down', long: 'Server disconnected', short: 'Disconnected' };
  if (conn === 'connecting' || f.known === 0) return { tone: 'connecting', long: 'Connecting', short: 'Connecting' };
  if (f.interrupted > 0) {
    const catching = f.catchingUp > 0 ? `, ${f.catchingUp} catching up` : '';
    return { tone: 'interrupted', long: `${f.interrupted} of ${f.feeds} interrupted${catching}`, short: 'Interrupted' };
  }
  if (f.catchingUp > 0) return { tone: 'catching_up', long: `${f.catchingUp} catching up`, short: 'Catching up' };
  return { tone: 'live', long: 'Live', short: 'Live' };
}

const MARKET_ROWS: { market: Market; label: string }[] = [
  { market: 'spot', label: 'Spot' },
  { market: 'perp', label: 'Perp' },
];

const STATE_WORD: Record<Exclude<FeedState, 'unknown'>, string> = {
  live: 'Live',
  catching_up: 'Catching up',
  interrupted: 'Interrupted',
};

/**
 * A feed's state in words. `lastKnown`: our own connection is down, so the state is only the last
 * one received: shown muted and marked so, never as a green Live.
 */
function StateText({ state, reason, lastKnown }: { state: FeedState; reason: string | null; lastKnown: boolean }) {
  if (state === 'unknown') return <span className="text-faint">No status yet</span>;
  if (lastKnown) {
    return (
      <span className="text-muted">
        {STATE_WORD[state]} (last known) {state === 'interrupted' && reason ? `- ${reason}` : ''}
      </span>
    );
  }
  switch (state) {
    case 'live':
      return <span className="text-up">Live</span>;
    case 'catching_up':
      return (
        <span className="text-fg">
          <span className="font-semibold text-accent">Catching up</span> - applying the gap
        </span>
      );
    default:
      return (
        <span className="text-fg">
          <span className="text-down">Interrupted</span> {reason ? `- ${reason}` : ''}
        </span>
      );
  }
}

/**
 * Each coin with the state of its spot and its perp feed, and the reason a feed is interrupted;
 * with `lastKnown` (our connection is down) every state is dimmed and marked as last known.
 */
export function FeedStatusList({
  data,
  symbols,
  lastKnown = false,
}: {
  data: Pick<LiveData, 'health' | 'markets' | 'catchingUp'>;
  symbols: readonly string[];
  lastKnown?: boolean;
}) {
  return (
    <ul className={`flex flex-col divide-y divide-line border-t border-line ${lastKnown ? 'opacity-70' : ''}`}>
      {symbols.map((s) => (
        <li key={s} className="flex items-start gap-2 py-1.5 text-xs">
          <span className="w-12 flex-none font-semibold">{s.replace(/USDT$/, '')}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            {MARKET_ROWS.map(({ market, label }) => (
              <div key={market} className="flex min-w-0 gap-2">
                <span className="w-8 flex-none text-faint">{label}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <StateText {...feedStatus(data, market, s)} lastKnown={lastKnown} />
                </span>
              </div>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Whether live data is flowing: the connection to our server plus the feed of each coin's spot
 * and perp market. Hover (desktop) or tap (phone) shows each one's state and why it is not live.
 */
export function FeedIndicator() {
  const conn = useLive((s) => s.conn);
  const health = useLive((s) => s.health);
  const markets = useLive((s) => s.markets);
  const catchingUp = useLive((s) => s.catchingUp);
  const symbols = useLive((s) => s.meta?.symbols) ?? Object.keys(health);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const data = { health, markets, catchingUp };
  const { tone, long, short } = feedLabel(conn, feedSummary(data, symbols));
  const text = tone === 'down' || tone === 'interrupted' ? 'text-down' : tone === 'catching_up' ? 'text-fg' : '';

  return (
    <div
      ref={box}
      className="relative"
      onMouseEnter={() => canHover() && setOpen(true)}
      onMouseLeave={() => canHover() && setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-2 rounded-ctl px-2 text-xs text-muted hover:bg-raised"
      >
        <span aria-hidden="true" className={`size-2.5 flex-none ${DOT[tone]}`} />
        <span className={`whitespace-nowrap ${text}`}>
          <span className="desk:hidden">{short}</span>
          <span className="hidden desk:inline">{long}</span>
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Live data status"
          className="absolute right-0 top-full z-30 mt-1 w-[19rem] rounded-panel border border-line bg-panel p-3 shadow-[0_8px_24px_rgb(0_0_0/0.35)]"
        >
          <div className="mb-2 flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted">Connection to the simulator</span>
            <span className={conn === 'open' ? 'text-up' : conn === 'down' ? 'text-down' : 'text-muted'}>
              {conn === 'open' ? 'Connected' : conn === 'down' ? 'Lost - reconnecting' : 'Connecting'}
            </span>
          </div>
          {conn === 'down' && (
            <p className="mb-2 text-xs text-faint">Prices, balances and the states below are frozen until the connection returns.</p>
          )}
          <FeedStatusList data={data} symbols={symbols} lastKnown={conn !== 'open'} />
          <p className="mt-2 text-2xs text-faint">
            Trading on an interrupted market waits for fresh data; nothing fills on an old price. A market catching up
            applies what happened during the gap, marked estimated in the history, before trading on it resumes.
          </p>
        </div>
      )}
    </div>
  );
}
