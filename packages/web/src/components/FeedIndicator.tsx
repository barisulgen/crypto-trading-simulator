import { useEffect, useRef, useState } from 'react';
import { useLive } from '../lib/live.ts';

type Overall = 'live' | 'partial' | 'down' | 'connecting';

const DOT: Record<Overall, string> = {
  live: 'bg-up rounded-full',
  partial: 'border-2 border-accent rounded-full',
  down: 'bg-down rounded-[1px]',
  connecting: 'border-2 border-faint rounded-full',
};

const canHover = () => matchMedia('(hover: hover)').matches;

/**
 * Whether live data is flowing: the connection to our server plus the feed health of each coin.
 * Hover (desktop) or tap (phone) shows each coin's state and the reason it is stale.
 */
export function FeedIndicator() {
  const conn = useLive((s) => s.conn);
  const health = useLive((s) => s.health);
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

  const stale = symbols.filter((s) => health[s] && !health[s].fresh);
  const known = symbols.filter((s) => health[s]).length;
  const overall: Overall =
    conn === 'down' ? 'down' : conn === 'connecting' || known === 0 ? 'connecting' : stale.length > 0 ? 'partial' : 'live';
  const label =
    overall === 'down'
      ? 'Server disconnected'
      : overall === 'connecting'
        ? 'Connecting'
        : overall === 'partial'
          ? `${stale.length} of ${symbols.length} coins paused`
          : 'Live';
  // Phones: a shorter label, so the header stays on one line.
  const shortLabel =
    overall === 'down' ? 'Disconnected' : overall === 'partial' ? `${stale.length}/${symbols.length} paused` : label;

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
        <span aria-hidden="true" className={`size-2.5 flex-none ${DOT[overall]}`} />
        <span className={`whitespace-nowrap ${overall === 'down' ? 'text-down' : overall === 'partial' ? 'text-fg' : ''}`}>
          <span className="desk:hidden">{shortLabel}</span>
          <span className="hidden desk:inline">{label}</span>
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
            <p className="mb-2 text-xs text-faint">Prices and balances below are frozen until the connection returns.</p>
          )}
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {symbols.map((s) => {
              const h = health[s];
              return (
                <li key={s} className="flex items-start gap-2 py-1.5 text-xs">
                  <span className="w-12 flex-none font-semibold">{s.replace(/USDT$/, '')}</span>
                  {!h ? (
                    <span className="text-faint">No status yet</span>
                  ) : h.fresh ? (
                    <span className="text-up">Live</span>
                  ) : (
                    <span className="text-fg">
                      <span className="text-accent">Paused</span> {h.reason ? `- ${h.reason}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-2xs text-faint">Trading on a paused coin waits for fresh data; nothing fills on an old price.</p>
        </div>
      )}
    </div>
  );
}
