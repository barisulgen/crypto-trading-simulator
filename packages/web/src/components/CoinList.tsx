import { fmtPct, fmtPrice, signOf } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { Segmented } from './ui.tsx';

const FALLBACK_COINS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];
/** Coin (shrinks, clips), last price (its own width), 24 h % (fixed, so prices line up across rows). */
const ROW_COLS = 'grid-cols-[minmax(0,1fr)_auto_3.75rem]';

/** Up/down colour of a change: teal for gains, rose for losses, muted for none. */
export function changeClass(value: string | null | undefined, dp = 2): string {
  const s = signOf(value, dp);
  return s > 0 ? 'text-up' : s < 0 ? 'text-down' : 'text-muted';
}

/** The 10 coins with last price and 24 h change; selecting one loads it everywhere else. */
export function CoinList({ onPicked }: { onPicked?(symbol: string): void }) {
  const coins = useLive((s) => s.meta?.coins) ?? FALLBACK_COINS;
  const tickers = useLive((s) => s.tickers);
  const health = useLive((s) => s.health);
  const selected = useLive((s) => s.selected.symbol);
  const select = useLive((s) => s.select);
  const down = useLive((s) => s.conn === 'down');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none p-2">
        <Segmented
          label="Market"
          value="spot"
          onChange={() => {}}
          options={[
            { value: 'spot', label: 'Spot' },
            {
              value: 'perp',
              disabled: true,
              title: 'Perpetuals arrive in Phase 2',
              label: (
                <>
                  Perp <span className="text-2xs text-faint">Phase 2</span>
                </>
              ),
            },
          ]}
        />
      </div>
      <div className={`grid flex-none ${ROW_COLS} gap-2 border-b border-line px-3 pb-1.5 text-2xs text-faint`}>
        <span>Coin</span>
        <span className="text-right">Last</span>
        <span className="text-right">24h</span>
      </div>
      <ul className={`@container min-h-0 flex-1 overflow-auto ${down ? 'opacity-60' : ''}`}>
        {coins.map((coin) => {
          const symbol = `${coin}USDT`;
          const t = tickers[symbol];
          const h = health[symbol];
          const on = symbol === selected;
          return (
            <li key={symbol}>
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => {
                  select(symbol);
                  onPicked?.(symbol);
                }}
                className={`grid w-full ${ROW_COLS} items-center gap-2 border-l-2 px-3 py-2 text-left desk:py-1.5 ${
                  on ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised/60'
                }`}
              >
                <span className="flex min-w-0 items-baseline gap-1 overflow-hidden">
                  <span className="font-semibold">{coin}</span>
                  {/* Only where the list is wide enough (phones); the narrow desktop column would collide with the price. */}
                  <span className="hidden text-2xs text-faint @min-[16rem]:inline">/USDT</span>
                  {h && !h.fresh && (
                    <span
                      title={h.reason ?? 'Paused'}
                      aria-label={`Paused: ${h.reason ?? 'no fresh data'}`}
                      className="ml-1 size-2 flex-none self-center rounded-full border-2 border-accent"
                    />
                  )}
                </span>
                <span className="text-right">{fmtPrice(symbol, t?.last)}</span>
                <span className={`text-right ${changeClass(t?.change24hPct)}`}>{fmtPct(t?.change24hPct)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
