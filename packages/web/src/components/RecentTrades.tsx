// The market's latest trades for the selected coin, newest first.
import { fmtPrice, fmtQty } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { fmtClock } from '../lib/market.ts';
import { Interrupted } from './ui.tsx';

/** Tighter padding and gaps when the panel is narrow (900-1279 px desktops put book and trades side by side). */
const COLS = 'grid grid-cols-[1fr_1fr_auto] gap-1.5 px-2 @min-[15rem]:gap-2 @min-[15rem]:px-3';
const UNIT = 'hidden @min-[15rem]:inline';

/** Up triangle for a buyer-initiated trade, down for seller-initiated: colour is not the only cue. */
function Aggressor({ buy }: { buy: boolean }) {
  return (
    <>
      <svg width="7" height="6" viewBox="0 0 7 6" aria-hidden="true" className="flex-none fill-current">
        {buy ? <path d="M3.5 0L7 6H0z" /> : <path d="M0 0h7L3.5 6z" />}
      </svg>
      <span className="sr-only">{buy ? 'Buy' : 'Sell'}</span>
    </>
  );
}

/** Price coloured by the aggressor (buyer up, seller down) with a glyph, size, local time. */
export function RecentTrades() {
  const symbol = useLive((s) => s.selected.symbol);
  const trades = useLive((s) => s.trades);
  const health = useLive((s) => s.health[symbol]);
  const base = useLive((s) => s.meta?.rules[symbol]?.base) ?? symbol.replace(/USDT$/, '');

  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col">
      <div className={`${COLS} flex-none py-1 text-2xs whitespace-nowrap text-faint`}>
        <span>
          Price <span className={UNIT}>(USDT)</span>
        </span>
        <span className="text-right">
          Size <span className={UNIT}>({base})</span>
        </span>
        <span className="w-[4.5em] text-right">Time</span>
      </div>
      {trades.length > 0 ? (
        <ol className="min-h-0 flex-1 overflow-auto">
          {trades.map((t) => {
            const buy = !t.sellerInitiated;
            return (
              <li key={t.id} className={`${COLS} text-xs leading-[1.125rem]`}>
                <span className={`flex items-center gap-1 ${buy ? 'text-up' : 'text-down'}`}>
                  <Aggressor buy={buy} />
                  {fmtPrice(symbol, t.price)}
                </span>
                <span className="text-right">{fmtQty(symbol, t.qty)}</span>
                <span className="w-[4.5em] text-right text-muted">{fmtClock(t.time)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="m-auto text-xs text-faint">Waiting for trades</p>
      )}
      {health && !health.fresh && <Interrupted reason={health.reason} />}
    </div>
  );
}
