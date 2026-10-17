import type { ReactNode } from 'react';

/** Trade-screen slot names; each is a grid area on desktop and a tab on phones. */
export type Slot = 'coins' | 'chart' | 'book' | 'trades' | 'form' | 'tabs';

/**
 * One trade-screen panel. On desktop it sits in its grid area; under 900 px only the active
 * panel is shown and fills the space. `title` and `actions` make a slim header row.
 */
export function Panel({
  slot,
  active,
  title,
  actions,
  children,
}: {
  slot: Slot;
  /** Shown on phones (desktop shows every panel). */
  active: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-slot={slot}
      aria-label={typeof title === 'string' ? title : slot}
      style={{ gridArea: slot }}
      className={`${active ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col overflow-hidden bg-panel desk:flex desk:rounded-panel desk:border desk:border-line`}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex h-9 flex-none items-center justify-between gap-2 border-b border-line px-3">
          <h2 className="text-xs font-semibold text-muted">{title}</h2>
          {actions}
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </section>
  );
}
