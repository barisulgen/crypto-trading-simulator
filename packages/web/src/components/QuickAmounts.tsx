// The order form's quick-amount buttons and its "Available" line (free balance in both units).
import type { Side } from '@sim/engine';
import { useLive } from '../lib/live.ts';
import { PCTS, availableLine } from '../lib/quickAmount.ts';
import type { Pct } from '../lib/quickAmount.ts';

/** 25 / 50 / 75 / 100 % of the free balance in one row; the active one is pressed. */
export function QuickAmounts({
  active,
  disabled,
  of,
  onPick,
}: {
  active: Pct | null;
  disabled: boolean;
  /** The asset the percentages are of (USDT on a buy, the coin on a sell). */
  of: string;
  onPick(pct: Pct): void;
}) {
  return (
    <div role="group" aria-label={`Share of free ${of}`} className="grid grid-cols-4 gap-1">
      {PCTS.map((pct) => {
        const on = active === pct;
        return (
          <button
            key={pct}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            title={`${pct}% of free ${of}`}
            onClick={() => onPick(pct)}
            className={`h-9 min-w-0 rounded-ctl border border-line text-xs tabular-nums disabled:cursor-not-allowed disabled:opacity-50 desk:h-7 ${
              on
                ? 'bg-raised font-semibold text-fg shadow-[inset_0_-2px_0_var(--color-accent)]'
                : 'bg-canvas text-muted enabled:hover:border-faint enabled:hover:text-fg'
            }`}
          >
            {pct}%
          </button>
        );
      })}
    </div>
  );
}

/**
 * 'Available 0.00120879 BTC ≈ $97.70' (sell) or 'Available 850.00 USDT ≈ 0.01045 BTC' (buy). The
 * estimate follows the best bid / ask, so this re-renders with the book, not the whole form.
 */
export function Available({
  side,
  symbol,
  base,
  quote,
  stepSize,
  free,
}: {
  side: Side;
  symbol: string;
  base: string;
  quote: string;
  stepSize: string;
  free: string | undefined;
}) {
  const bestBid = useLive((s) => (s.book?.symbol === symbol ? s.book.bids[0]?.price : undefined));
  const bestAsk = useLive((s) => (s.book?.symbol === symbol ? s.book.asks[0]?.price : undefined));
  const fresh = useLive((s) => s.health[symbol]?.fresh ?? true);
  const line = availableLine({ side, symbol, base, quote, stepSize, free, bestBid, bestAsk, fresh });
  return (
    <p>
      Available <span className="whitespace-nowrap text-muted">{line.free}</span>
      {line.approx !== null && <span className="whitespace-nowrap"> {line.approx}</span>}
    </p>
  );
}
