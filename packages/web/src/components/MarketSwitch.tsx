// The Spot / Perpetual switch at the head of the coin list.
import type { Market } from '../lib/api.ts';
import { useLive } from '../lib/live.ts';
import { Segmented } from './ui.tsx';

const OPTIONS: { value: Market; label: string; title: string }[] = [
  { value: 'spot', label: 'Spot', title: 'Buy and sell the coins themselves' },
  { value: 'perp', label: 'Perpetual', title: 'USDT-margined perpetual futures, with leverage' },
];

/** Switches every trade panel between the coin's spot market and its perpetual; the coin stays. */
export function MarketSwitch() {
  const market = useLive((s) => s.selected.market);
  const symbol = useLive((s) => s.selected.symbol);
  const select = useLive((s) => s.select);
  return <Segmented label="Market" value={market} onChange={(m) => select(symbol, m)} options={OPTIONS} />;
}
