// Open orders, holdings, recent fills and positions, under the chart.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { Market, WireFillRow, WireOrder, WirePerpOrder } from '../lib/api.ts';
import { ORDER_TYPE_LABEL, driftSign, fmtBalance, fmtCost, fmtDrift, fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsd, signOf, tickDecimals } from '../lib/format.ts';
import { avgFill, holdingRows, valueTitle } from '../lib/holdings.ts';
import type { HoldingRow } from '../lib/holdings.ts';
import { catchingUpBlock, useLive } from '../lib/live.ts';
import type { LiveState } from '../lib/live.ts';
import { cmpDec, floorToStep, fmtClock, fmtChartTime } from '../lib/market.ts';
import { AttachPairDialog } from './AttachPairDialog.tsx';
import type { PairTarget } from './AttachPairDialog.tsx';
import { changeClass } from './CoinList.tsx';
import { Actions, Cell, Empty, Row, Table } from './ListTable.tsx';
import type { Col } from './ListTable.tsx';
import { PositionsTab } from './PositionsTab.tsx';
import { Button } from './ui.tsx';

type Tab = 'orders' | 'holdings' | 'fills' | 'positions';

const FILLS_SHOWN = 50;

const MARKET_LABEL: Record<Market, string> = { spot: 'Spot', perp: 'Perp' };

/** The tick size of a symbol in a market (the perpetual's own differs from the spot pair's). */
function tickOf(s: LiveState, market: Market, symbol: string): string | undefined {
  return market === 'perp' ? (s.meta?.perp?.[symbol]?.rules?.tickSize ?? undefined) : s.meta?.rules[symbol]?.tickSize;
}

// ---- open orders ----

/** An open order of either market, tagged with it. */
type AnyOrder = (WireOrder & { market: 'spot' }) | (WirePerpOrder & { market: 'perp' });

function statusLabel(o: Pick<WireOrder, 'status' | 'arrivesAt' | 'type'>): string {
  switch (o.status) {
    case 'pending':
      // Stops attached to an entry wait for fresh data to arm; anything else is in its arrival delay.
      return o.arrivesAt === null ? 'Waiting for data' : 'Pending';
    case 'open':
      return o.type === 'stop_loss' || o.type === 'take_profit' ? 'Armed' : 'Open';
    case 'partially_filled':
      return 'Partly filled';
    case 'triggered':
      return 'Executing';
    default:
      return o.status;
  }
}

/** A triggered stop or a market order in flight is already executing: no Cancel (the engine refuses it). */
function cancellable(o: Pick<WireOrder, 'status' | 'type'>): boolean {
  return o.status !== 'triggered' && o.type !== 'market';
}

/** A cancel is on its way to the exchange (it takes an arrival delay): shown instead of the Cancel button. */
function Cancelling() {
  return <span className="text-2xs whitespace-nowrap text-muted">Cancelling…</span>;
}

/** A cancel button, off with the reason while the order's market and coin catch up (the server refuses it). */
function CancelButton({ market, symbol, label, onClick }: { market: Market; symbol: string; label: string; onClick(): void }) {
  const blocked = useLive((s) => catchingUpBlock(s, market, symbol));
  return (
    <Button tone="quiet" size="sm" disabled={blocked !== null} title={blocked ?? undefined} onClick={onClick}>
      {label}
    </Button>
  );
}

const ORDER_COLS: Col[] = [
  { label: 'Coin' },
  { label: 'Market' },
  { label: 'Type' },
  { label: 'Side' },
  { label: 'Price / trigger', right: true },
  { label: 'Amount', right: true },
  { label: 'Filled', right: true },
  { label: 'Avg fill', right: true },
  { label: 'Margin', right: true, title: 'Leverage-wallet USDT a perp order keeps locked as margin' },
  { label: 'Status' },
];
/** Minimums + gaps + padding fit the 52rem breakpoint (39 + 5 + 1.5 rem); the fr parts share the rest. */
const ORDER_TEMPLATE =
  'minmax(2.5rem,0.7fr) 2.5rem minmax(4.5rem,1fr) 2.25rem minmax(4.5rem,1.2fr) minmax(3.5rem,1fr) minmax(3.5rem,1fr) minmax(4.5rem,1.2fr) minmax(3.5rem,1fr) minmax(4.25rem,1fr) 3.5rem';

/** What a perp order is beyond its type: closing the whole position, or reduce-only. */
function perpFlag(o: WirePerpOrder): string | null {
  if (o.closePosition) return 'close position';
  return o.reduceOnly ? 'reduce-only' : null;
}

function OrderRow({ o, onCancel, cancel = true }: { o: AnyOrder; onCancel(o: AnyOrder): void; cancel?: boolean }) {
  const w = 'lg';
  const market = o.market;
  const tick = useLive((s) => tickOf(s, market, o.symbol));
  const price =
    o.type === 'market'
      ? 'Market'
      : fmtPrice(o.symbol, o.type === 'limit' || o.type === 'post_only' ? o.price : o.triggerPrice, { market });
  const avg = avgFill(o.filledQuote, o.filledQty, tickDecimals(tick ?? '0.01') + 2);
  const flag = o.market === 'perp' ? perpFlag(o) : null;
  const attach = o.attach;
  return (
    <Row width={w}>
      <Cell width={w} label="Coin" head>
        <span className="font-semibold">{o.symbol.replace(/USDT$/, '')}</span>
      </Cell>
      <Cell width={w} label="Market" head>
        <span className="text-muted">{MARKET_LABEL[market]}</span>
      </Cell>
      <Cell
        width={w}
        label="Type"
        head
        title={
          attach
            ? `Stop-loss ${attach.stopLoss ?? '-'} / take-profit ${attach.takeProfit ?? '-'} attached: placed when this order ${market === 'perp' ? 'first fills' : 'finishes'}`
            : undefined
        }
      >
        <span className="whitespace-nowrap">{ORDER_TYPE_LABEL[o.type]}</span>
        {attach && <span className="ml-1 text-faint">+SL/TP</span>}
        {flag && <span className="block text-2xs whitespace-nowrap text-faint">{flag}</span>}
      </Cell>
      <Cell width={w} label="Side" head>
        <span className={o.side === 'buy' ? 'text-up' : 'text-down'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span>
      </Cell>
      <Cell width={w} label="Price / trigger" right>
        {price}
      </Cell>
      <Cell width={w} label="Amount" right>
        {o.qty !== null ? fmtQty(o.symbol, o.qty, { market }) : o.quoteQty !== null ? fmtUsd(o.quoteQty) : 'Position'}
      </Cell>
      <Cell width={w} label="Filled" right>
        {fmtQty(o.symbol, o.filledQty, { market })}
      </Cell>
      <Cell width={w} label="Avg fill" right>
        {avg === null ? '-' : fmtNum(avg, tickDecimals(tick ?? '0.01') + 2)}
      </Cell>
      <Cell width={w} label="Margin" right>
        {o.market === 'perp' ? (signOf(o.lockAmount) > 0 ? fmtCost(o.lockAmount) : 'None') : '-'}
      </Cell>
      <Cell width={w} label="Status" head>
        <span className={o.status === 'triggered' ? 'font-semibold text-accent' : 'text-muted'}>{statusLabel(o)}</span>
      </Cell>
      <Actions width={w}>
        {cancel &&
          cancellable(o) &&
          (o.cancelArrivesAt !== null ? (
            <Cancelling />
          ) : (
            <CancelButton market={market} symbol={o.symbol} label="Cancel" onClick={() => onCancel(o)} />
          ))}
      </Actions>
    </Row>
  );
}

/** Open orders of both markets, newest first; the two legs of a linked pair stay together under one Cancel. */
function OpenOrders() {
  const spot = useLive((s) => s.orders);
  const perp = useLive((s) => s.perpOrders);
  const pushNotice = useLive((s) => s.pushNotice);

  async function cancel(o: AnyOrder) {
    try {
      await api.cancelOrder(o.id);
    } catch (e) {
      pushNotice('error', e instanceof ApiError ? e.message : String(e));
    }
  }

  const orders: AnyOrder[] = [
    ...spot.map((o) => ({ ...o, market: 'spot' as const })),
    ...perp.map((o) => ({ ...o, market: 'perp' as const })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  if (orders.length === 0) return <Empty>No open orders.</Empty>;
  const seen = new Set<string>();
  const items: ReactNode[] = [];
  for (const o of orders) {
    if (o.ocoGroupId === null) {
      items.push(<OrderRow key={o.id} o={o} onCancel={cancel} />);
      continue;
    }
    const group = `${o.market}:${o.ocoGroupId}`;
    if (seen.has(group)) continue;
    seen.add(group);
    const legs = orders
      .filter((l) => l.market === o.market && l.ocoGroupId === o.ocoGroupId)
      .sort((a, b) => (a.type === b.type ? 0 : a.type === 'stop_loss' ? -1 : 1));
    const executing = legs.some((l) => !cancellable(l));
    // One cancel covers the pair, whichever leg it was sent for.
    const cancelling = legs.some((l) => l.cancelArrivesAt !== null);
    items.push(
      <div key={group} role="group" aria-label="Linked pair" className="border-l-2 border-faint">
        <div className="flex items-center justify-between gap-2 px-3 pt-1.5 text-2xs text-muted">
          <span>Linked pair - when one triggers, the other is cancelled</span>
          {!executing &&
            (cancelling ? (
              <Cancelling />
            ) : (
              <CancelButton market={o.market} symbol={o.symbol} label="Cancel pair" onClick={() => void cancel(legs[0]!)} />
            ))}
        </div>
        {legs.map((l) => (
          <OrderRow key={l.id} o={l} onCancel={cancel} cancel={false} />
        ))}
      </div>,
    );
  }
  return (
    <Table cols={ORDER_COLS} template={ORDER_TEMPLATE} width="lg" action>
      {items}
    </Table>
  );
}

// ---- holdings ----

const HOLDING_COLS: Col[] = [
  { label: 'Coin' },
  { label: 'Amount', right: true },
  { label: 'Avg cost', right: true, title: 'USDT paid per coin, buy fees included' },
  { label: 'Value at bid', right: true, title: 'What the coins would sell for at the best bid' },
  { label: 'Unrealised P&L', right: true },
];
const HOLDING_TEMPLATE = 'minmax(2.5rem,0.7fr) minmax(5.5rem,1fr) minmax(5rem,1fr) minmax(5rem,1fr) minmax(7rem,1.3fr) 6rem';

function HoldingLine({ h, onAttach }: { h: HoldingRow; onAttach(h: HoldingRow, qty: string): void }) {
  const tick = useLive((s) => s.meta?.rules[h.symbol]?.tickSize);
  const step = useLive((s) => s.meta?.rules[h.symbol]?.stepSize);
  const blocked = useLive((s) => catchingUpBlock(s, 'spot', h.symbol));
  // Whole steps only: a buy's fee leaves a remainder the exchange would reject (LOT_SIZE).
  const wholeFree = step ? floorToStep(h.free, step) : h.free;
  return (
    <Row>
      <Cell label="Coin" head>
        <span className="font-semibold">{h.asset}</span>
      </Cell>
      <Cell label="Amount" right>
        {fmtBalance(h.symbol, h.qty)}
        {cmpDec(h.locked, '0') > 0 && <span className="block text-2xs text-faint">{fmtBalance(h.symbol, h.locked)} in orders</span>}
      </Cell>
      <Cell label="Avg cost" right>
        {h.avgCost === null ? '-' : fmtNum(h.avgCost, tickDecimals(tick ?? '0.01'))}
      </Cell>
      <Cell label="Value at bid" right title={valueTitle(h)}>
        {h.priced ? (
          <span className={h.fresh ? '' : 'text-muted'}>{fmtUsd(h.value)}</span>
        ) : (
          <span className="text-muted">No price yet</span>
        )}
        {/* Visible on touch screens too, where the tooltip is not. */}
        {h.priced && !h.fresh && (
          <span className="block text-2xs whitespace-nowrap text-faint">
            {h.bidAt === null ? 'last bid' : `last bid ${fmtClock(h.bidAt)}`}
          </span>
        )}
      </Cell>
      <Cell label="Unrealised P&L" right title={valueTitle(h)}>
        <span className={h.fresh ? '' : 'opacity-60'}>
          <span className={changeClass(h.pnl)}>{fmtUsd(h.pnl, { sign: true })}</span>
          {h.pnlPct !== null && <span className={`ml-1.5 ${changeClass(h.pnlPct)}`}>{fmtPct(h.pnlPct)}</span>}
        </span>
      </Cell>
      <Actions>
        <Button
          size="sm"
          disabled={wholeFree === '0' || blocked !== null}
          title={
            blocked ??
            (wholeFree === '0'
              ? 'Less than one size step is free: the rest is locked in open orders'
              : 'Attach a linked stop-loss and take-profit')
          }
          onClick={() => onAttach(h, wholeFree)}
        >
          Attach SL/TP
        </Button>
      </Actions>
    </Row>
  );
}

function Holdings() {
  const account = useLive((s) => s.account);
  const rules = useLive((s) => s.meta?.rules);
  const [target, setTarget] = useState<PairTarget | null>(null);
  const rows = account ? holdingRows(account, (s) => tickDecimals(rules?.[s]?.tickSize ?? '0.01')) : [];
  return (
    <>
      {rows.length === 0 ? (
        <Empty>{account ? 'No coins held yet.' : 'Loading account...'}</Empty>
      ) : (
        <Table cols={HOLDING_COLS} template={HOLDING_TEMPLATE} action>
          {rows.map((h) => (
            <HoldingLine
              key={h.asset}
              h={h}
              onAttach={(x, qty) => setTarget({ symbol: x.symbol, base: x.asset, free: x.free, qty })}
            />
          ))}
        </Table>
      )}
      <AttachPairDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

// ---- recent fills ----

const FILL_COLS: Col[] = [
  { label: 'Time' },
  { label: 'Coin' },
  { label: 'Market' },
  { label: 'Side' },
  { label: 'Qty', right: true },
  { label: 'Price', right: true },
  { label: 'Best at arrival', right: true },
  { label: 'Slippage', right: true, title: 'Average price against the best price at arrival (a cost)' },
  { label: 'Delay drift', right: true, title: 'The best price moving during the arrival delay: a cost or a gain to you' },
  { label: 'Role' },
  { label: 'Fee', right: true },
];
/** Minimums + gaps + padding fit the 52rem breakpoint (44 + 5 + 1.5 rem). */
const FILL_TEMPLATE =
  '4.5rem minmax(2.5rem,0.6fr) 2.5rem 2.5rem minmax(4.5rem,1fr) minmax(5.5rem,1.2fr) minmax(5rem,1fr) minmax(3.5rem,0.8fr) minmax(4.5rem,0.9fr) 3rem minmax(6rem,1.3fr)';

/** Delay drift in words ('cost $0.08' / 'gain $0.02'), coloured as its effect on the owner. */
function drift(driftUsd: string): ReactNode {
  const s = driftSign(driftUsd);
  return <span className={s > 0 ? 'text-down' : s < 0 ? 'text-up' : 'text-muted'}>{fmtDrift(driftUsd)}</span>;
}

function FillLine({ f }: { f: WireFillRow }) {
  const market = f.market;
  const tick = useLive((s) => tickOf(s, market, f.symbol));
  const w = 'lg';
  return (
    <Row width={w}>
      <Cell width={w} label="Time" head title={fmtChartTime(f.time)}>
        {fmtClock(f.time)}
      </Cell>
      <Cell width={w} label="Coin" head>
        <span className="font-semibold">{f.symbol.replace(/USDT$/, '')}</span>
      </Cell>
      <Cell width={w} label="Market" head>
        <span className="text-muted">{MARKET_LABEL[market]}</span>
      </Cell>
      <Cell width={w} label="Side" head>
        <span className={f.side === 'buy' ? 'text-up' : 'text-down'}>{f.side === 'buy' ? 'Buy' : 'Sell'}</span>
      </Cell>
      <Cell width={w} label="Qty" right>
        {fmtQty(f.symbol, f.qty, { market })}
      </Cell>
      <Cell width={w} label="Price" right>
        {fmtNum(f.price, tickDecimals(tick ?? '0.01') + 2)}
      </Cell>
      <Cell width={w} label="Best at arrival" right>
        {fmtPrice(f.symbol, f.bestAtArrival, { market })}
      </Cell>
      <Cell width={w} label="Slippage" right>
        {/* An unsigned cost (always >= 0), as in the preview and the fill notices. */}
        <span className={signOf(f.slippageUsd) > 0 ? '' : 'text-muted'}>{fmtCost(f.slippageUsd)}</span>
      </Cell>
      <Cell width={w} label="Delay drift" right>
        {drift(f.driftUsd)}
      </Cell>
      <Cell width={w} label="Role" head>
        {f.liquidity === 'maker' ? 'Maker' : 'Taker'}
      </Cell>
      <Cell width={w} label="Fee" right>
        {f.fee} {f.feeAsset}
      </Cell>
    </Row>
  );
}

/**
 * The latest fills of both markets on every coin, newest first; reloaded whenever fills may have
 * changed or after a reconnect.
 */
function RecentFills() {
  const fillSeq = useLive((s) => s.fillSeq);
  const reconnects = useLive((s) => s.reconnects);
  const [fills, setFills] = useState<WireFillRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    Promise.all([api.fills({ limit: FILLS_SHOWN }), api.fills({ limit: FILLS_SHOWN, market: 'perp' })]).then(
      ([spot, perp]) => {
        if (!current) return;
        setFills([...spot, ...perp].sort((a, b) => b.time - a.time).slice(0, FILLS_SHOWN));
        setError('');
      },
      (e: unknown) => {
        if (current) setError(e instanceof ApiError ? e.message : String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [fillSeq, reconnects]);

  if (fills === null) return <Empty>{error ? `Could not load fills: ${error}` : 'Loading fills...'}</Empty>;
  if (fills.length === 0) return <Empty>No fills yet.</Empty>;
  return (
    <>
      {error && <p className="px-3 py-1 text-2xs text-down">Could not refresh: {error}</p>}
      <Table cols={FILL_COLS} template={FILL_TEMPLATE} width="lg">
        {fills.map((f) => (
          <FillLine key={`${f.market}:${f.id}`} f={f} />
        ))}
      </Table>
    </>
  );
}

// ---- tabs ----

/**
 * Bottom tabs of the trade screen: open orders, holdings, recent fills and positions. While any
 * position is open its tab comes first, and is the one shown until the owner picks another.
 */
export function BottomTabs() {
  const [picked, setTab] = useState<Tab | null>(null);
  const openCount = useLive((s) => s.orders.length + s.perpOrders.length);
  const holdingCount = useLive((s) => s.account?.coins.length ?? 0);
  const positionCount = useLive((s) => s.positions?.length ?? 0);
  const tab = picked ?? (positionCount > 0 ? 'positions' : 'orders');
  const positionsTab = { id: 'positions' as const, label: 'Positions', count: positionCount };
  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...(positionCount > 0 ? [positionsTab] : []),
    { id: 'orders', label: 'Open orders', count: openCount },
    { id: 'holdings', label: 'Holdings', count: holdingCount },
    { id: 'fills', label: 'Recent fills' },
    ...(positionCount > 0 ? [] : [positionsTab]),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Orders and holdings" className="flex h-9 flex-none overflow-x-auto border-b border-line px-1">
        {tabs.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`bt-${t.id}`}
              aria-selected={on}
              aria-controls="bt-panel"
              onClick={() => setTab(t.id)}
              className={`flex flex-none items-center gap-1.5 px-2.5 text-xs whitespace-nowrap ${
                on ? 'font-semibold text-fg shadow-[inset_0_-2px_0_var(--color-accent)]' : 'text-muted hover:text-fg'
              }`}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="rounded-full bg-raised px-1.5 text-2xs text-muted">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="bt-panel"
        aria-labelledby={`bt-${tab}`}
        className="flex min-h-0 flex-1 flex-col overflow-auto"
      >
        {tab === 'orders' && <OpenOrders />}
        {tab === 'holdings' && <Holdings />}
        {tab === 'fills' && <RecentFills />}
        {tab === 'positions' && <PositionsTab />}
      </div>
    </div>
  );
}
