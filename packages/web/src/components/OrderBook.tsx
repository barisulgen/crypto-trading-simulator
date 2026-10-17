// Top 20 bids and asks of the selected coin with cumulative depth bars and the spread.
import { useMemo } from 'react';
import { fmtPrice, fmtQty } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { bookView } from '../lib/market.ts';
import type { DepthRow } from '../lib/market.ts';
import { Interrupted } from './ui.tsx';

/** Price, size and (when the book is at least 15rem wide) the cumulative total. */
const COLS = 'grid grid-cols-[1fr_1fr] gap-2 px-2 @min-[15rem]:grid-cols-[1fr_1fr_1fr] @min-[15rem]:px-3';
const TOTAL = 'hidden text-right @min-[15rem]:block';

/** One price level; clicking it hands the price to the order form. */
function Level({
  symbol,
  row,
  side,
  onPick,
}: {
  symbol: string;
  row: DepthRow;
  side: 'bid' | 'ask';
  onPick(price: string): void;
}) {
  const price = fmtPrice(symbol, row.price);
  return (
    <button
      type="button"
      title="Use this price"
      aria-label={`${side === 'bid' ? 'Bid' : 'Ask'} ${price}, size ${fmtQty(symbol, row.qty)}. Use this price`}
      onClick={() => onPick(row.price)}
      className={`relative ${COLS} w-full flex-none text-xs leading-[1.125rem] hover:bg-raised`}
    >
      <span
        aria-hidden="true"
        style={{ width: `${row.depth * 100}%` }}
        className={`absolute inset-y-0 right-0 ${side === 'bid' ? 'bg-up-soft' : 'bg-down-soft'}`}
      />
      <span className={`relative text-left ${side === 'bid' ? 'text-up' : 'text-down'}`}>{price}</span>
      <span className="relative text-right">{fmtQty(symbol, row.qty)}</span>
      <span className={`relative text-muted ${TOTAL}`}>{fmtQty(symbol, row.total)}</span>
    </button>
  );
}

/**
 * The selected coin's book: asks above (lowest ask nearest the middle), bids below, the spread
 * between them in dollars and percent. Each side keeps its best levels next to the spread and
 * clips the far ones when the panel is short.
 */
export function OrderBook() {
  const symbol = useLive((s) => s.selected.symbol);
  const book = useLive((s) => s.book);
  const health = useLive((s) => s.health[symbol]);
  const base = useLive((s) => s.meta?.rules[symbol]?.base) ?? symbol.replace(/USDT$/, '');
  const priceClicked = useLive((s) => s.priceClicked);
  const view = useMemo(() => (book && book.symbol === symbol ? bookView(book) : null), [book, symbol]);

  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col">
      <div className={`${COLS} flex-none py-1 text-2xs whitespace-nowrap text-faint`}>
        <span>Price (USDT)</span>
        <span className="text-right">Size ({base})</span>
        <span className={TOTAL}>Total ({base})</span>
      </div>
      {view ? (
        <>
          {/* column-reverse: the best ask sits at the bottom, next to the spread; far asks clip at the top. */}
          <div aria-label="Asks" role="group" className="flex min-h-0 flex-1 flex-col-reverse overflow-hidden">
            {view.asks.map((r) => (
              <Level key={r.price} symbol={symbol} row={r} side="ask" onPick={priceClicked} />
            ))}
          </div>
          <div className="flex flex-none items-baseline gap-2 border-y border-line bg-canvas/40 px-3 py-1 text-xs">
            <span className="text-faint">Spread</span>
            {view.spread ? (
              <>
                <span className="text-fg">${fmtPrice(symbol, view.spread.abs)}</span>
                <span className="text-muted">{view.spread.pct}%</span>
              </>
            ) : (
              <span className="text-muted">-</span>
            )}
          </div>
          <div aria-label="Bids" role="group" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {view.bids.map((r) => (
              <Level key={r.price} symbol={symbol} row={r} side="bid" onPick={priceClicked} />
            ))}
          </div>
        </>
      ) : (
        <p className="m-auto text-xs text-faint">Loading order book</p>
      )}
      {health && !health.fresh && <Interrupted reason={health.reason} />}
    </div>
  );
}
