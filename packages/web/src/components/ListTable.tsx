// Lists that are a table in a wide panel and compact cards in a narrow one (bottom tabs).
import type { CSSProperties, ReactNode } from 'react';

/**
 * Container-query classes: from `md` (40rem), `lg` (52rem) or `xl` (54rem) of panel width a list
 * is a table with a header row. Narrower (900-1279 px desktops, phones) each row is a card: a head line of
 * the `head` cells and the actions, then the other cells, labelled, four to a line. The labels
 * stay for screen readers in the table layout (the header row is visual only).
 */
const WIDE = {
  md: {
    head: 'hidden @min-[40rem]:grid',
    row: '@min-[40rem]:grid @min-[40rem]:grid-cols-(--cols) @min-[40rem]:items-center @min-[40rem]:py-1.5',
    cell: '@min-[40rem]:order-none @min-[40rem]:basis-auto',
    label: '@min-[40rem]:sr-only',
    right: '@min-[40rem]:text-right',
    action: '@min-[40rem]:order-none @min-[40rem]:ml-0',
    narrowOnly: '@min-[40rem]:hidden',
  },
  lg: {
    head: 'hidden @min-[52rem]:grid',
    row: '@min-[52rem]:grid @min-[52rem]:grid-cols-(--cols) @min-[52rem]:items-center @min-[52rem]:py-1.5',
    cell: '@min-[52rem]:order-none @min-[52rem]:basis-auto',
    label: '@min-[52rem]:sr-only',
    right: '@min-[52rem]:text-right',
    action: '@min-[52rem]:order-none @min-[52rem]:ml-0',
    narrowOnly: '@min-[52rem]:hidden',
  },
  xl: {
    head: 'hidden @min-[54rem]:grid',
    row: '@min-[54rem]:grid @min-[54rem]:grid-cols-(--cols) @min-[54rem]:items-center @min-[54rem]:py-1.5',
    cell: '@min-[54rem]:order-none @min-[54rem]:basis-auto',
    label: '@min-[54rem]:sr-only',
    right: '@min-[54rem]:text-right',
    action: '@min-[54rem]:order-none @min-[54rem]:ml-0',
    narrowOnly: '@min-[54rem]:hidden',
  },
} as const;
export type Width = keyof typeof WIDE;

export interface Col {
  label: string;
  right?: boolean;
  title?: string;
}

export function Table({
  cols,
  template,
  width = 'md',
  action = false,
  children,
}: {
  cols: Col[];
  /** grid-template-columns of the wide layout (an action column last when `action`). */
  template: string;
  width?: Width;
  action?: boolean;
  children: ReactNode;
}) {
  const w = WIDE[width];
  return (
    <div className="@container" style={{ '--cols': template } as CSSProperties}>
      <div
        aria-hidden="true"
        className={`${w.head} sticky top-0 z-[1] grid-cols-(--cols) gap-x-2 border-b border-line bg-panel px-3 py-1 text-2xs whitespace-nowrap text-faint`}
      >
        {cols.map((c) => (
          <span key={c.label} title={c.title} className={c.right ? 'text-right' : ''}>
            {c.label}
          </span>
        ))}
        {action && <span />}
      </div>
      {children}
    </div>
  );
}

/** One list item; `stale` marks one whose figures are not live (the cells say how). */
export function Row({ width = 'md', stale, children }: { width?: Width; stale?: boolean; children: ReactNode }) {
  const w = WIDE[width];
  return (
    <div
      data-stale={stale || undefined}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line/60 px-3 py-2 text-xs ${w.row}`}
    >
      {children}
      {/* Card layout: ends the head line; the labelled cells (order 1) follow. */}
      <span aria-hidden="true" className={`order-0 h-0 basis-full ${w.narrowOnly}`} />
    </div>
  );
}

export function Cell({
  label,
  head = false,
  right,
  width = 'md',
  title,
  children,
}: {
  label: string;
  /** On a card: in the head line, unlabelled. */
  head?: boolean;
  right?: boolean;
  width?: Width;
  title?: string;
  children: ReactNode;
}) {
  const w = WIDE[width];
  const place = head ? 'order-0' : 'order-1 basis-[calc(25%-0.375rem)]';
  return (
    <div title={title} className={`min-w-0 ${place} ${w.cell} ${right ? w.right : ''}`}>
      <span className={head ? 'sr-only' : `block text-2xs text-faint ${w.label}`}>{label}</span>
      {/* Never truncated: a value too wide for its column wraps instead of being cut off. */}
      <span className="block [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** Buttons: at the end of the head line on a card, the last column in a table. */
export function Actions({ width = 'md', children }: { width?: Width; children?: ReactNode }) {
  return <div className={`order-0 ml-auto flex justify-end gap-2 ${WIDE[width].action}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-auto max-w-[32ch] p-6 text-center text-xs text-faint">{children}</p>;
}
