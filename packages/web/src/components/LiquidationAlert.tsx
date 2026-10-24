// The modal that tells the owner a position was liquidated; it stays until acknowledged.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LiquidationDetail } from '../lib/api.ts';
import { fmtCost, fmtPrice, fmtQty } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import type { Notice } from '../lib/live.ts';
import { Button } from './ui.tsx';

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="whitespace-nowrap text-faint">{label}</dt>
      <dd className="min-w-0 text-right break-words text-fg">{children}</dd>
    </div>
  );
}

/**
 * The alert's content: coin, size, the mark it happened at, the margin lost and the fee in it
 * (money rounded up: the loss is never shown smaller than it was). Without the figures as data,
 * the notice's own text.
 */
export function LiquidationAlertView({
  detail,
  text,
  onAcknowledge,
}: {
  detail: LiquidationDetail | undefined;
  text: string;
  onAcknowledge(): void;
}) {
  const base = detail?.symbol.replace(/USDT$/, '') ?? '';
  return (
    <div className="flex flex-col gap-4 p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-down">
        <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true" className="flex-none">
          <path d="M7 1l6.5 12h-13z" fill="currentColor" />
          <path d="M7 5.5v3.5M7 10.5v1" stroke="var(--color-panel)" strokeWidth="1.4" />
        </svg>
        {detail ? `${base} ${detail.side} liquidated` : 'Position liquidated'}
      </h2>
      {detail ? (
        <dl className="flex flex-col gap-1.5 rounded-ctl border border-down/40 bg-down-soft px-3 py-2.5 text-sm">
          <Figure label="Coin">{`${base} perpetual`}</Figure>
          <Figure label="Size">{`${fmtQty(detail.symbol, detail.qty, { market: 'perp' })} ${base} ${detail.side}`}</Figure>
          <Figure label="Mark price">{`${fmtPrice(detail.symbol, detail.markPrice, { market: 'perp' })} USDT`}</Figure>
          <Figure label="Margin lost">
            <span className="font-semibold">{fmtCost(detail.marginLost)}</span>
          </Figure>
          <Figure label="of which liquidation fee">{fmtCost(detail.liquidationFee)}</Figure>
        </dl>
      ) : (
        <p className="text-sm text-fg">{text}</p>
      )}
      <p className="text-xs text-muted">
        The mark price reached the liquidation price: the position was closed and its whole isolated margin is lost. The
        rest of the leverage wallet is untouched. The notice stays in your notices.
      </p>
      <Button tone="primary" className="h-10" data-autofocus onClick={onAcknowledge}>
        I understand
      </Button>
    </div>
  );
}

/**
 * On each liquidation notice, a modal with its figures. It closes only with its button (not
 * Escape, not a click outside), one liquidation after another; acknowledging it leaves the notice
 * itself in the notice list.
 */
export function LiquidationAlert() {
  const notices = useLive((s) => s.notices);
  // Notice ids only grow: everything up to `seen` has been acknowledged.
  const [seen, setSeen] = useState(0);
  const [shown, setShown] = useState<Notice | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  // The oldest liquidation not yet acknowledged; kept once shown, even if its notice is dismissed.
  useEffect(() => {
    if (shown) return;
    const next = notices.find((n) => n.kind === 'liquidation' && n.id > seen);
    if (next) setShown(next);
  }, [notices, seen, shown]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (shown && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!shown && d.open) d.close();
  }, [shown]);

  const acknowledge = () => {
    if (shown) setSeen(shown.id);
    setShown(null);
  };

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-label="Position liquidated"
      // Escape would close a dialog: this one waits for the button. Should the browser close it
      // anyway (a repeated Escape), it opens again until acknowledged.
      onCancel={(e) => e.preventDefault()}
      onClose={() => {
        if (shown) ref.current?.showModal();
      }}
      className="m-0 mt-auto w-full max-w-none rounded-t-dialog border border-down bg-panel p-0 text-fg backdrop:bg-scrim desk:m-auto desk:w-[25rem] desk:rounded-dialog"
    >
      {shown && <LiquidationAlertView detail={shown.liquidation} text={shown.text} onAcknowledge={acknowledge} />}
    </dialog>
  );
}
