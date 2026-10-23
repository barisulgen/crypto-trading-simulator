// Open orders, holdings, recent fills and (Phase 2) positions, under the chart.
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { WireFill, WireOrder } from '../lib/api.ts';
import { ORDER_TYPE_LABEL, fmtBalance, fmtCost, fmtDrift, fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsd, signOf, tickDecimals } from '../lib/format.ts';
import { avgFill, holdingRows, valueTitle } from '../lib/holdings.ts';
import type { HoldingRow } from '../lib/holdings.ts';
import { useLive } from '../lib/live.ts';
import { cmpDec, floorToStep, fmtClock, fmtChartTime } from '../lib/market.ts';
import { AttachPairDialog } from './AttachPairDialog.tsx';
import type { PairTarget } from './AttachPairDialog.tsx';
import { changeClass } from './CoinList.tsx';
import { Button } from './ui.tsx';

type Tab = 'orders' | 'holdings' | 'fills' | 'positions';

const FILLS_SHOWN = 50;

// ---- a table that becomes compact cards in a narrow panel ----

/**
 * Container-query classes: from `md` (40rem) or `lg` (52rem) of panel width a list is a table
 * with a header row. Narrower (900-1279 px desktops, phones) each row is a card: a head line of
 * the `head` cells and the actions, then the other cells, labelled, four to a line. The labels
 * stay for screen readers in the table layout (the header row is visual only).
 */
const WIDE = {
  md: {
    head: 'hidden @min-[40rem]:grid',
    row: '@min-[40rem]:grid @min-[40rem]:grid-cols-(--cols) @min-[40rem]:items-center @min-[40rem]:py-1.5',
    cell: '@min-[40rem]:order-none @min-[40rem]:basis-auto',
    label: '@min-[40rem]:sr-only',
    right: '@min-[40rem]:text-right',
    action: '@min-[40rem]:order-none @min-[40rem]:ml-0',
    narrowOnly: '@min-[40rem]:hidden',
  },
  lg: {
    head: 'hidden @min-[52rem]:grid',
    row: '@min-[52rem]:grid @min-[52rem]:grid-cols-(--cols) @min-[52rem]:items-center @min-[52rem]:py-1.5',
    cell: '@min-[52rem]:order-none @min-[52rem]:basis-auto',
    label: '@min-[52rem]:sr-only',
    right: '@min-[52rem]:text-right',
    action: '@min-[52rem]:order-none @min-[52rem]:ml-0',
    narrowOnly: '@min-[52rem]:hidden',
  },
} as const;
type Width = keyof typeof WIDE;

interface Col {
  label: string;
  right?: boolean;
  title?: string;
}

function Table({
  cols,
  template,
  width = 'md',
  action = false,
  children,
}: {
  cols: Col[];
  /** grid-template-columns of the wide layout (an action column last when `action`). */
  template: string;
  width?: Width;
  action?: boolean;
  children: ReactNode;
}) {
  const w = WIDE[width];
  return (
    <div className="@container" style={{ '--cols': template } as CSSProperties}>
      <div
        aria-hidden="true"
        className={`${w.head} sticky top-0 z-[1] grid-cols-(--cols) gap-x-2 border-b border-line bg-panel px-3 py-1 text-2xs whitespace-nowrap text-faint`}
      >
        {cols.map((c) => (
          <span key={c.label} title={c.title} className={c.right ? 'text-right' : ''}>
            {c.label}
          </span>
        ))}
        {action && <span />}
      </div>
      {children}
    </div>
  );
}

function Row({ width = 'md', children }: { width?: Width; children: ReactNode }) {
  const w = WIDE[width];
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line/60 px-3 py-2 text-xs ${w.row}`}>
      {children}
      {/* Card layout: ends the head line; the labelled cells (order 1) follow. */}
      <span aria-hidden="true" className={`order-0 h-0 basis-full ${w.narrowOnly}`} />
    </div>
  );
}

function Cell({
  label,
  head = false,
  right,
  width = 'md',
  title,
  children,
}: {
  label: string;
  /** On a card: in the head line, unlabelled. */
  head?: boolean;
  right?: boolean;
  width?: Width;
  title?: string;
  children: ReactNode;
}) {
  const w = WIDE[width];
  const place = head ? 'order-0' : 'order-1 basis-[calc(25%-0.375rem)]';
  return (
    <div title={title} className={`min-w-0 ${place} ${w.cell} ${right ? w.right : ''}`}>
      <span className={head ? 'sr-only' : `block text-2xs text-faint ${w.label}`}>{label}</span>
      {/* Never truncated: a value too wide for its column wraps instead of being cut off. */}
      <span className="block [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** Buttons: at the end of the head line on a card, the last column in a table. */
function Actions({ width = 'md', children }: { width?: Width; children?: ReactNode }) {
  return <div className={`order-0 ml-auto flex justify-end gap-2 ${WIDE[width].action}`}>{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-auto max-w-[32ch] p-6 text-center text-xs text-faint">{children}</p>;
}

// ---- open orders ----

function statusLabel(o: WireOrder): string {
  switch (o.status) {
    case 'pending':
      // A pair attached to a buy waits for fresh data to arm; anything else is in its arrival delay.
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
function cancellable(o: WireOrder): boolean {
  return o.status !== 'triggered' && o.type !== 'market';
}

/** A cancel is on its way to the exchange (it takes an arrival delay): shown instead of the Cancel button. */
function Cancelling() {
  return <span className="text-2xs whitespace-nowrap text-muted">Cancelling…</span>;
}

const ORDER_COLS: Col[] = [
  { label: 'Coin' },
  { label: 'Type' },
  { label: 'Side' },
  { label: 'Price / trigger', right: true },
  { label: 'Amount', right: true },
  { label: 'Filled', right: true },
  { label: 'Avg fill', right: true },
  { label: 'Status' },
];
/** Minimums + gaps + padding fit the 40rem breakpoint (33 + 4 + 1.5 rem); the fr parts share the rest. */
const ORDER_TEMPLATE =
  'minmax(2.5rem,0.7fr) minmax(4.5rem,1fr) 2.25rem minmax(4.5rem,1.2fr) minmax(3.5rem,1fr) minmax(3.5rem,1fr) minmax(4.5rem,1.2fr) minmax(4.25rem,1fr) 3.5rem';

function OrderRow({ o, onCancel, cancel = true }: { o: WireOrder; onCancel(o: WireOrder): void; cancel?: boolean }) {
  const base = o.symbol.replace(/USDT$/, '');
  const tick = useLive((s) => s.meta?.rules[o.symbol]?.tickSize);
  const price =
    o.type === 'market' ? 'Market' : fmtPrice(o.symbol, o.type === 'limit' || o.type === 'post_only' ? o.price : o.triggerPrice);
  const avg = avgFill(o.filledQuote, o.filledQty, tickDecimals(tick ?? '0.01') + 2);
  return (
    <Row>
      <Cell label="Coin" head>
        <span className="font-semibold">{base}</span>
      </Cell>
      <Cell
        label="Type"
        head
        title={
          o.attach
            ? `Stop-loss ${o.attach.stopLoss} / take-profit ${o.attach.takeProfit} attached: placed when this buy finishes`
            : undefined
        }
      >
        {ORDER_TYPE_LABEL[o.type]}
        {o.attach && <span className="ml-1 text-faint">+SL/TP</span>}
      </Cell>
      <Cell label="Side" head>
        <span className={o.side === 'buy' ? 'text-up' : 'text-down'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span>
      </Cell>
      <Cell label="Price / trigger" right>
        {price}
      </Cell>
      <Cell label="Amount" right>
        {o.qty !== null ? fmtQty(o.symbol, o.qty) : fmtUsd(o.quoteQty)}
      </Cell>
      <Cell label="Filled" right>
        {fmtQty(o.symbol, o.filledQty)}
      </Cell>
      <Cell label="Avg fill" right>
        {avg === null ? '-' : fmtNum(avg, tickDecimals(tick ?? '0.01') + 2)}
      </Cell>
      <Cell label="Status" head>
        <span className={o.status === 'triggered' ? 'font-semibold text-accent' : 'text-muted'}>{statusLabel(o)}</span>
      </Cell>
      <Actions>
        {cancel &&
          cancellable(o) &&
          (o.cancelArrivesAt !== null ? (
            <Cancelling />
          ) : (
            <Button tone="quiet" size="sm" onClick={() => onCancel(o)}>
              Cancel
            </Button>
          ))}
      </Actions>
    </Row>
  );
}

/** Open orders, newest first; the two legs of a linked pair stay together under one Cancel. */
function OpenOrders() {
  const orders = useLive((s) => s.orders);
  const pushNotice = useLive((s) => s.pushNotice);

  async function cancel(o: WireOrder) {
    try {
      await api.cancelOrder(o.id);
    } catch (e) {
      pushNotice('error', e instanceof ApiError ? e.message : String(e));
    }
  }

  if (orders.length === 0) return <Empty>No open orders.</Empty>;
  const seen = new Set<string>();
  const items: ReactNode[] = [];
  for (const o of orders) {
    if (o.ocoGroupId === null) {
      items.push(<OrderRow key={o.id} o={o} onCancel={cancel} />);
      continue;
    }
    if (seen.has(o.ocoGroupId)) continue;
    seen.add(o.ocoGroupId);
    const legs = orders
      .filter((l) => l.ocoGroupId === o.ocoGroupId)
      .sort((a, b) => (a.type === b.type ? 0 : a.type === 'stop_loss' ? -1 : 1));
    const executing = legs.some((l) => !cancellable(l));
    // One cancel covers the pair, whichever leg it was sent for.
    const cancelling = legs.some((l) => l.cancelArrivesAt !== null);
    items.push(
      <div key={o.ocoGroupId} role="group" aria-label="Linked pair" className="border-l-2 border-faint">
        <div className="flex items-center justify-between gap-2 px-3 pt-1.5 text-2xs text-muted">
          <span>Linked pair - when one triggers, the other is cancelled</span>
          {!executing &&
            (cancelling ? (
              <Cancelling />
            ) : (
              <Button tone="quiet" size="sm" onClick={() => void cancel(legs[0]!)}>
                Cancel pair
              </Button>
            ))}
        </div>
        {legs.map((l) => (
          <OrderRow key={l.id} o={l} onCancel={cancel} cancel={false} />
        ))}
      </div>,
    );
  }
  return (
    <Table cols={ORDER_COLS} template={ORDER_TEMPLATE} action>
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
          disabled={wholeFree === '0'}
          title={
            wholeFree === '0'
              ? 'Less than one size step is free: the rest is locked in open orders'
              : 'Attach a linked stop-loss and take-profit'
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
  { label: 'Side' },
  { label: 'Qty', right: true },
  { label: 'Price', right: true },
  { label: 'Best at arrival', right: true },
  { label: 'Slippage', right: true, title: 'Average price against the best price at arrival (a cost)' },
  { label: 'Delay drift', right: true, title: 'The best price moving during the arrival delay: a cost or a gain to you' },
  { label: 'Role' },
  { label: 'Fee', right: true },
];
const FILL_TEMPLATE =
  '4.5rem minmax(2.5rem,0.6fr) 2.5rem minmax(4.5rem,1fr) minmax(5.5rem,1.2fr) minmax(5rem,1fr) minmax(3.5rem,0.8fr) minmax(4.5rem,0.9fr) 3rem minmax(6rem,1.3fr)';

/** Delay drift in words ('cost $0.07' / 'gain $0.03'), coloured as its effect on the owner. */
function drift(driftUsd: string): ReactNode {
  const s = signOf(driftUsd, 2);
  return <span className={s > 0 ? 'text-down' : s < 0 ? 'text-up' : 'text-muted'}>{fmtDrift(driftUsd)}</span>;
}

function FillLine({ f }: { f: WireFill }) {
  const tick = useLive((s) => s.meta?.rules[f.symbol]?.tickSize);
  const w = 'lg';
  return (
    <Row width={w}>
      <Cell width={w} label="Time" head title={fmtChartTime(f.time)}>
        {fmtClock(f.time)}
      </Cell>
      <Cell width={w} label="Coin" head>
        <span className="font-semibold">{f.symbol.replace(/USDT$/, '')}</span>
      </Cell>
      <Cell width={w} label="Side" head>
        <span className={f.side === 'buy' ? 'text-up' : 'text-down'}>{f.side === 'buy' ? 'Buy' : 'Sell'}</span>
      </Cell>
      <Cell width={w} label="Qty" right>
        {fmtQty(f.symbol, f.qty)}
      </Cell>
      <Cell width={w} label="Price" right>
        {fmtNum(f.price, tickDecimals(tick ?? '0.01') + 2)}
      </Cell>
      <Cell width={w} label="Best at arrival" right>
        {fmtPrice(f.symbol, f.bestAtArrival)}
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

/** The latest fills on every coin; reloaded whenever fills may have changed or after a reconnect. */
function RecentFills() {
  const fillSeq = useLive((s) => s.fillSeq);
  const reconnects = useLive((s) => s.reconnects);
  const [fills, setFills] = useState<WireFill[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    api.fills({ limit: FILLS_SHOWN }).then(
      (f) => {
        if (!current) return;
        setFills(f);
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
          <FillLine key={f.id} f={f} />
        ))}
      </Table>
    </>
  );
}

// ---- tabs ----

/** Bottom tabs of the trade screen: open orders, holdings, recent fills, positions (Phase 2). */
export function BottomTabs() {
  const [tab, setTab] = useState<Tab>('orders');
  const openCount = useLive((s) => s.orders.length);
  const holdingCount = useLive((s) => s.account?.coins.length ?? 0);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'orders', label: 'Open orders', count: openCount },
    { id: 'holdings', label: 'Holdings', count: holdingCount },
    { id: 'fills', label: 'Recent fills' },
    { id: 'positions', label: 'Positions' },
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
        {tab === 'positions' && <Empty>Leverage arrives in Phase 2</Empty>}
      </div>
    </div>
  );
}
