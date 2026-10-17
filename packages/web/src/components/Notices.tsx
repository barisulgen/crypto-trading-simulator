import { useEffect } from 'react';
import { useLive } from '../lib/live.ts';
import type { Notice } from '../lib/live.ts';

/** Info and warning toasts close themselves after this long; errors stay until dismissed. */
const AUTO_DISMISS_MS = 6000;

const BAR: Record<Notice['level'], string> = {
  info: 'bg-faint',
  warn: 'bg-accent',
  error: 'bg-down',
};

function Toast({ n }: { n: Notice }) {
  const dismiss = useLive((s) => s.dismissNotice);
  useEffect(() => {
    if (n.level === 'error') return;
    // Restarts when an identical notice is collapsed into this one (n.at moves).
    const t = setTimeout(() => dismiss(n.id), Math.max(0, AUTO_DISMISS_MS - (Date.now() - n.at)));
    return () => clearTimeout(t);
  }, [n.id, n.at, n.level, dismiss]);

  return (
    <li
      role={n.level === 'error' ? 'alert' : 'status'}
      className="toast-in pointer-events-auto flex overflow-hidden rounded-panel border border-line bg-panel shadow-[0_6px_20px_rgb(0_0_0/0.3)]"
    >
      <span aria-hidden="true" className={`w-1 flex-none ${BAR[n.level]}`} />
      <div className="flex min-w-0 flex-1 items-start gap-2 py-2.5 pl-3 pr-1">
        <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
          {n.level === 'error' && <span className="font-semibold text-down">Error: </span>}
          {n.text}
          {n.count > 1 && <span className="ml-1.5 rounded-ctl bg-raised px-1 text-2xs text-muted">x{n.count}</span>}
        </p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => dismiss(n.id)}
          className="-my-1 flex size-7 flex-none items-center justify-center rounded-ctl text-muted hover:bg-raised hover:text-fg"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </li>
  );
}

/** The toast stack: top of the screen on phones, bottom right on desktop; newest nearest the edge. */
export function Notices() {
  const notices = useLive((s) => s.notices);
  return (
    <ol
      aria-label="Notices"
      className="pointer-events-none fixed inset-x-2 top-8 z-50 flex flex-col-reverse gap-2 desk:inset-x-auto desk:top-auto desk:right-4 desk:bottom-4 desk:w-[22rem] desk:flex-col"
    >
      {notices.slice(-5).map((n) => (
        <Toast key={n.id} n={n} />
      ))}
    </ol>
  );
}
