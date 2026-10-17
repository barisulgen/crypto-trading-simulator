import { useState } from 'react';
import { CoinList } from '../components/CoinList.tsx';
import { Panel, SlotPlaceholder } from '../components/Panel.tsx';
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
  const on = (slot: Slot) => tab === slot;

  return (
    <div className="flex h-full min-h-0 flex-col desk:p-1.5">
      <div className="trade-grid min-h-0 flex-1">
        <Panel slot="coins" active={on('coins')} title="Coins">
          <CoinList onPicked={() => setTab('chart')} />
        </Panel>

        <Panel slot="chart" active={on('chart')} title={<SelectedTitle />}>
          {/* T14: <PriceChart /> with the 1m-1d timeframe switch in the header actions. */}
          <SlotPlaceholder>The candle chart of the selected coin goes here.</SlotPlaceholder>
        </Panel>

        <Panel slot="book" active={on('book')} title="Order book">
          {/* T14: <OrderBook /> */}
          <SlotPlaceholder>Live bids and asks with the spread go here.</SlotPlaceholder>
        </Panel>

        <Panel slot="trades" active={on('trades')} title="Recent trades">
          {/* T14: <RecentTrades /> */}
          <SlotPlaceholder>The live stream of market trades goes here.</SlotPlaceholder>
        </Panel>

        <Panel slot="form" active={on('form')} title="Place order">
          {/* T15: <OrderForm /> */}
          <SlotPlaceholder>The buy and sell form with its live cost preview goes here.</SlotPlaceholder>
        </Panel>

        <Panel slot="tabs" active={on('tabs')}>
          {/* T15: <BottomTabs /> (open orders, holdings, recent fills) */}
          <SlotPlaceholder>Open orders, holdings and recent fills go here.</SlotPlaceholder>
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
