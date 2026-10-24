import { fmtPct, fmtPrice, signOf } from '../lib/format.ts';
import { feedOf, useLive } from '../lib/live.ts';
import { fmtFundingPct } from '../lib/market.ts';
import { MarketSwitch } from './MarketSwitch.tsx';

const FALLBACK_COINS = ['BTC', 'ETH', 'SOL', 'NEAR', 'XRP', 'BNB', 'DOGE', 'SUI', 'HYPE', 'AVAX'];
/** Coin (shrinks, clips), last price (its own width), 24 h % (fixed, so prices line up across rows). */
const ROW_COLS = 'grid-cols-[minmax(0,1fr)_auto_3.75rem]';
/**
 * Perpetuals add the funding rate: a fourth column where the list is wide enough (phones), else
 * a second line under the 24 h change (the narrow desktop column).
 */
const PERP_COLS = `${ROW_COLS} @min-[20rem]:grid-cols-[minmax(0,1fr)_auto_3.75rem_4.5rem]`;
const FUNDING_CELL = 'col-start-3 text-right text-2xs @min-[20rem]:col-start-auto @min-[20rem]:text-xs';

/** Up/down colour of a change: teal for gains, rose for losses, muted for none. */
export function changeClass(value: string | null | undefined, dp = 2): string {
  const s = signOf(value, dp);
  return s > 0 ? 'text-up' : s < 0 ? 'text-down' : 'text-muted';
}

/**
 * The 10 coins of the market shown (the switch above them picks spot or the perpetuals) with
 * last price and 24 h change, and for perpetuals the funding rate; selecting one loads it
 * everywhere else. A coin whose feed is stale gets a hollow dot; a funding rate from a stale mark
 * is dimmed.
 */
export function CoinList({ onPicked }: { onPicked?(symbol: string): void }) {
  const coins = useLive((s) => s.meta?.coins) ?? FALLBACK_COINS;
  const market = useLive((s) => s.selected.market);
  const tickers = useLive((s) => (s.selected.market === 'perp' ? s.perpTickers : s.tickers));
  const marks = useLive((s) => s.marks);
  const health = useLive((s) => s.health);
  const markets = useLive((s) => s.markets);
  const selected = useLive((s) => s.selected.symbol);
  const select = useLive((s) => s.select);
  const down = useLive((s) => s.conn === 'down');
  const perp = market === 'perp';
  const cols = perp ? PERP_COLS : ROW_COLS;

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex-none p-2">
        <MarketSwitch />
      </div>
      <div className={`grid flex-none ${cols} gap-x-2 border-b border-line px-3 pb-1.5 text-2xs text-faint`}>
        <span>Coin</span>
        <span className="text-right">Last</span>
        <span className="text-right">24h</span>
        {perp && <span className={`${FUNDING_CELL} @min-[20rem]:text-2xs`}>Funding</span>}
      </div>
      <ul className={`@container min-h-0 flex-1 overflow-auto ${down ? 'opacity-60' : ''}`}>
        {coins.map((coin) => {
          const symbol = `${coin}USDT`;
          const t = tickers[symbol];
          const h = feedOf({ health, markets }, market, symbol);
          const mark = perp ? marks[symbol] : undefined;
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
                className={`grid w-full ${cols} items-center gap-x-2 border-l-2 px-3 py-2 text-left desk:py-1.5 ${
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
                <span className="text-right">{fmtPrice(symbol, t?.last, { market })}</span>
                <span className={`text-right ${changeClass(t?.change24hPct)}`}>{fmtPct(t?.change24hPct)}</span>
                {perp && (
                  <span
                    title={mark && !mark.fresh ? 'Funding rate from a stale mark price' : 'Funding rate'}
                    className={`${FUNDING_CELL} ${mark?.fresh ? 'text-muted' : 'text-faint opacity-60'}`}
                  >
                    <span className="sr-only">Funding </span>
                    {fmtFundingPct(mark?.fundingRate)}
                    {mark && !mark.fresh && <span className="sr-only"> (stale)</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
