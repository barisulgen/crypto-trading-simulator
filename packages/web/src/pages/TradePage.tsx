import { useEffect, useRef, useState } from 'react';
import { BottomTabs } from '../components/BottomTabs.tsx';
import { CoinList } from '../components/CoinList.tsx';
import { OrderBook } from '../components/OrderBook.tsx';
import { OrderForm } from '../components/OrderForm.tsx';
import { Panel } from '../components/Panel.tsx';
import { IntervalPicker, PriceChart } from '../components/PriceChart.tsx';
import { RecentTrades } from '../components/RecentTrades.tsx';
import type { Slot } from '../components/Panel.tsx';
import { fmtPrice } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';

/** Phone tabs, in order. On desktop every slot is visible in the grid (see .trade-grid). */
const TABS: { slot: Slot; label: string }[] = [
  { slot: 'coins', label: 'Coins' },
  { slot: 'chart', label: 'Chart' },
  { slot: 'book', label: 'Book' },
  { slot: 'trades', label: 'Trades' },
  { slot: 'form', label: 'Trade' },
  { slot: 'tabs', label: 'Orders' },
];

/** The selected coin and its last price, as the chart panel's title. */
function SelectedTitle() {
  const symbol = useLive((s) => s.selected.symbol);
  const last = useLive((s) => s.tickers[symbol]?.last);
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-sm text-fg">{symbol.replace(/USDT$/, '')}/USDT</span>
      <span className="text-fg">{fmtPrice(symbol, last)}</span>
    </span>
  );
}

/**
 * Trade screen. Desktop (900 px and up): coin list left, chart centre, book over trades, order
 * form right, orders/holdings/fills tabs under the chart. Phones: one panel at a time, picked
 * from the tab bar at the bottom.
 */
export function TradePage() {
  const [tab, setTab] = useState<Slot>('chart');
  const symbol = useLive((s) => s.selected.symbol);
  const interval = useLive((s) => s.interval);
  const on = (slot: Slot) => tab === slot;

  // Phones: a click on an order-book price opens the order form with that price filled in.
  const priceSeq = useLive((s) => s.priceClick?.seq);
  const seenPrice = useRef(priceSeq);
  useEffect(() => {
    if (priceSeq === undefined || priceSeq === seenPrice.current) return;
    seenPrice.current = priceSeq;
    setTab('form');
  }, [priceSeq]);

  return (
    <div className="flex h-full min-h-0 flex-col desk:p-1.5">
      <div className="trade-grid min-h-0 flex-1">
        <Panel slot="coins" active={on('coins')} title="Coins">
          <CoinList onPicked={() => setTab('chart')} />
        </Panel>

        <Panel slot="chart" active={on('chart')} title={<SelectedTitle />} actions={<IntervalPicker />}>
          <PriceChart symbol={symbol} interval={interval} />
        </Panel>

        <Panel slot="book" active={on('book')} title="Order book">
          <OrderBook />
        </Panel>

        <Panel slot="trades" active={on('trades')} title="Recent trades">
          <RecentTrades />
        </Panel>

        <Panel slot="form" active={on('form')} title="Place order">
          <OrderForm />
        </Panel>

        <Panel slot="tabs" active={on('tabs')}>
          <BottomTabs />
        </Panel>
      </div>

      <nav
        aria-label="Trade panels"
        className="flex flex-none border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] desk:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t.slot}
            type="button"
            aria-pressed={on(t.slot)}
            onClick={() => setTab(t.slot)}
            className={`h-11 flex-1 text-xs ${on(t.slot) ? 'font-semibold text-fg shadow-[inset_0_2px_0_var(--color-accent)]' : 'text-muted'}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
