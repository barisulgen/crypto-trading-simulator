// The positions tab: every open perp position with its live figures and the close, close-part,
// margin and stop-loss / take-profit actions.
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { WirePerpOrder, WirePosition } from '../lib/api.ts';
import { fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsdFloor, tickDecimals } from '../lib/format.ts';
import { feedOf, useLive } from '../lib/live.ts';
import { fmtClock } from '../lib/market.ts';
import { actionBlocks, closeAmount, closePartQty, fmtPnl, positionFigures, positionState, positionStops } from '../lib/positions.ts';
import type { RiskLevel } from '../lib/positions.ts';
import { amountStep } from '../lib/quickAmount.ts';
import type { Pct } from '../lib/quickAmount.ts';
import { changeClass } from './CoinList.tsx';
import { Actions, Cell, Empty, Row, Table } from './ListTable.tsx';
import type { Col } from './ListTable.tsx';
import { MarginDialog } from './MarginDialog.tsx';
import { PositionTpSlDialog } from './PositionTpSlDialog.tsx';
import { QuickAmounts } from './QuickAmounts.tsx';
import { Button, Dialog, ErrorText, TextField } from './ui.tsx';

export type PositionAction = 'close' | 'part' | 'margin' | 'tpsl';

const COLS: Col[] = [
  { label: 'Coin' },
  { label: 'Side' },
  { label: 'Lev.', title: 'Leverage' },
  { label: 'Size', right: true },
  { label: 'Entry', right: true },
  { label: 'Mark', right: true },
  { label: 'Unrealised P&L', right: true, title: 'At the mark price; the percentage is of the margin' },
  { label: 'Margin', right: true },
  { label: 'Margin ratio', right: true, title: 'Maintenance margin / margin balance: liquidated at 100%' },
  { label: 'Liq. price', right: true, title: 'Rounded towards the mark; how far it is, in % of the mark' },
  { label: 'Funding', right: true, title: 'Funding so far: received (+) or paid (-)' },
  { label: 'SL / TP' },
];
/**
 * Minimums + gaps + padding fit the 54rem breakpoint (37.25 + 12 x 0.5 + 1.5 rem, plus the actions
 * as a 2 x 2 block of about 8.25 rem); the fr parts share the rest. The coin column is at least as
 * wide as its widest word, the "Catching" of the Catching up badge, so the badge keeps the column
 * gap to the side next to it.
 */
const TEMPLATE =
  'minmax(3.25rem,0.7fr) 2.25rem 2rem minmax(2.75rem,0.9fr) minmax(3.25rem,1fr) minmax(3.25rem,1fr) minmax(4.25rem,1.2fr) minmax(3.25rem,0.9fr) minmax(3rem,0.8fr) minmax(3.5rem,1fr) minmax(2.75rem,0.8fr) minmax(3.75rem,1fr) max-content';

/** The text colour of a margin ratio by its level (amber is marked by a dot: amber text is not readable on white). */
const RATIO_CLASS: Record<RiskLevel, string> = {
  none: '',
  amber: 'font-semibold',
  red: 'font-semibold text-down',
  pulse: 'font-bold text-down',
};
const RATIO_DOT: Record<RiskLevel, string | null> = { none: null, amber: 'bg-accent', red: 'bg-down', pulse: 'bg-down' };

/** 'Stale' or 'Catching up', with the reason as its tooltip and for screen readers. */
function StateBadge({ label, why }: { label: string; why: string }) {
  return (
    <span
      role="status"
      title={why}
      // Beside the coin on a card; under it in the table's narrow first column, where a two-word
      // label wraps rather than spill into the next column.
      className="ml-1.5 inline-flex items-center gap-1 rounded-ctl border border-accent/60 px-1 text-2xs font-semibold whitespace-nowrap text-fg [overflow-wrap:normal] [word-break:normal] @min-[54rem]:ml-0 @min-[54rem]:w-min @min-[54rem]:px-0.5 @min-[54rem]:whitespace-normal @min-[54rem]:leading-tight"
    >
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full border-2 border-accent @min-[54rem]:hidden" />
      {label}
      <span className="sr-only">: {why}</span>
    </span>
  );
}

/** One leg of the position's stops, at its trigger. */
function stopText(label: string, o: WirePerpOrder | null): ReactNode {
  if (!o) return null;
  return (
    <span className="block whitespace-nowrap">
      <span className="text-faint">{label}</span> {fmtPrice(o.symbol, o.triggerPrice, { market: 'perp' })}
    </span>
  );
}

/**
 * One position: side, size, leverage, entry, mark, unrealised P&L ($ and % of margin), margin,
 * margin ratio (marked at 50, 80 and 90 %), liquidation price and how far it is, funding so far
 * and its stops. Figures from a mark that is not live are dimmed and the row is flagged 'Stale'
 * (or 'Catching up'); actions the server would refuse now are off, with the reason.
 */
export function PositionLine({
  p,
  stops,
  down,
  tick,
  feed,
  busy,
  onAction,
}: {
  p: WirePosition;
  stops: { stopLoss: WirePerpOrder | null; takeProfit: WirePerpOrder | null };
  down: boolean;
  /** The perpetual's tick size; undefined before its rules load. */
  tick: string | undefined;
  feed?: { fresh: boolean; reason: string | null } | undefined;
  /** A close of this position is on its way. */
  busy: boolean;
  onAction(action: PositionAction, p: WirePosition): void;
}) {
  const w = 'xl';
  const base = p.symbol.replace(/USDT$/, '');
  const f = positionFigures(p, tick);
  const state = positionState(p, down);
  const blocks = actionBlocks(p, feed);
  const dim = state.live ? '' : 'opacity-50';
  const staleWhy =
    state.staleReason === null
      ? ''
      : p.markAt !== null && !state.catchingUp
        ? `${state.staleReason}: figures from the mark received at ${fmtClock(p.markAt)}`
        : state.staleReason;
  const dot = RATIO_DOT[f.level];
  const action = (a: PositionAction, label: string, why: string | null) => (
    <Button size="sm" disabled={busy || why !== null} title={why ?? undefined} onClick={() => onAction(a, p)}>
      {label}
    </Button>
  );
  return (
    <Row width={w} stale={!state.live}>
      <Cell width={w} label="Coin" head>
        <span className="font-semibold">{base}</span>
        {state.catchingUp ? (
          <StateBadge label="Catching up" why={staleWhy} />
        ) : (
          !state.live && <StateBadge label="Stale" why={staleWhy} />
        )}
      </Cell>
      <Cell width={w} label="Side" head>
        <span className={p.side === 'long' ? 'text-up' : 'text-down'}>{p.side === 'long' ? 'Long' : 'Short'}</span>
      </Cell>
      <Cell width={w} label="Leverage" head>
        <span className="text-muted">{p.leverage}x</span>
      </Cell>
      <Cell width={w} label="Size" right>
        {fmtQty(p.symbol, p.qty, { market: 'perp' })}
      </Cell>
      <Cell width={w} label="Entry" right>
        {fmtPrice(p.symbol, p.entryPrice, { market: 'perp' })}
      </Cell>
      <Cell width={w} label="Mark" right title={staleWhy || undefined}>
        <span className={dim}>{fmtPrice(p.symbol, p.markPrice, { market: 'perp' })}</span>
      </Cell>
      <Cell width={w} label="Unrealised P&L" right title={staleWhy || undefined}>
        <span className={dim}>
          <span className={`whitespace-nowrap ${changeClass(f.pnl)}`}>{fmtPnl(f.pnl)}</span>
          {f.pnlPct !== null && <span className={`block whitespace-nowrap ${changeClass(f.pnlPct)}`}>{fmtPct(f.pnlPct)}</span>}
        </span>
      </Cell>
      <Cell width={w} label="Margin" right>
        {fmtUsdFloor(p.margin)}
      </Cell>
      <Cell width={w} label="Margin ratio" right title={staleWhy || undefined}>
        <span data-level={f.level} className={`inline-flex items-center gap-1 whitespace-nowrap ${dim} ${RATIO_CLASS[f.level]}`}>
          {dot && <span aria-hidden="true" className={`size-1.5 flex-none rounded-full ${dot}`} />}
          {f.ratioPct ?? '-'}
        </span>
      </Cell>
      <Cell
        width={w}
        label="Liq. price"
        right
        title={tick === undefined ? 'Price rules not loaded yet' : staleWhy || undefined}
      >
        {f.liq === null ? '-' : fmtPrice(p.symbol, f.liq, { market: 'perp' })}
        {f.liqDistancePct !== null && (
          <span className={`block text-2xs whitespace-nowrap text-faint ${dim}`}>{fmtNum(f.liqDistancePct, 2)}% away</span>
        )}
      </Cell>
      <Cell width={w} label="Funding" right>
        <span className={changeClass(p.funding)}>{fmtPnl(p.funding)}</span>
      </Cell>
      <Cell width={w} label="SL / TP">
        {stops.stopLoss || stops.takeProfit ? (
          <>
            {stopText('SL', stops.stopLoss)}
            {stopText('TP', stops.takeProfit)}
          </>
        ) : (
          <span className="text-faint">-</span>
        )}
      </Cell>
      <Actions width={w}>
        {/* A row of four on a card; a 2 x 2 block in the table. */}
        <div className="flex flex-wrap justify-end gap-1 @min-[54rem]:grid @min-[54rem]:grid-cols-2">
          {action('close', 'Close', blocks.close)}
          {action('part', 'Close part', blocks.close)}
          {action('margin', 'Margin', blocks.margin)}
          {action('tpsl', 'SL/TP', blocks.tpsl)}
        </div>
      </Actions>
    </Row>
  );
}

/**
 * Close part of a position at market (reduce-only): an amount typed, or 25 / 50 / 75 / 100 % of
 * it, always floored to the step, never more than the position.
 */
function ClosePartDialog({ symbol, onClose }: { symbol: string | null; onClose(): void }) {
  const p = useLive((s) => (symbol ? (s.positions?.find((x) => x.symbol === symbol) ?? null) : null));
  const rules = useLive((s) => (symbol ? (s.meta?.perp?.[symbol]?.rules ?? undefined) : undefined));
  const feed = useLive((s) => (symbol ? feedOf(s, 'perp', symbol) : undefined));
  const pushNotice = useLive((s) => s.pushNotice);
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState<Pct | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = symbol?.replace(/USDT$/, '') ?? '';
  const step = rules ? amountStep(rules, 'market') : undefined;

  useEffect(() => {
    if (symbol === null) return;
    setAmount('');
    setPct(null);
    setError('');
  }, [symbol]);

  const read = p && step ? closeAmount(amount, p.qty, step) : null;
  const blocked = p ? actionBlocks(p, feed).close : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!p || !read) return;
    if ('error' in read) {
      setError(read.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      // The fill arrives as the server's notice.
      await api.closePosition(p.symbol, read.qty);
      onClose();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setError(message);
      pushNotice('error', message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={symbol !== null} title={`Close part · ${base} ${p?.side ?? ''}`} onClose={onClose}>
      {!p ? (
        <p className="text-sm text-muted">This position is closed.</p>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <TextField
            label="Amount to close"
            unit={base}
            name="closeQty"
            inputMode="decimal"
            autoComplete="off"
            data-autofocus
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setPct(null);
              setError('');
            }}
            hint={
              <div className="flex flex-col gap-1.5 pt-0.5">
                <QuickAmounts
                  active={pct}
                  disabled={!step}
                  of={base}
                  whole={`your ${base} position`}
                  onPick={(x) => {
                    if (!step) return;
                    setPct(x);
                    setAmount(closePartQty(p.qty, x, step));
                    setError('');
                  }}
                />
                <p>
                  Position{' '}
                  <span className="whitespace-nowrap text-muted">
                    {fmtQty(p.symbol, p.qty, { market: 'perp' })} {base} {p.side}
                  </span>
                  {step && (
                    <span className="whitespace-nowrap"> · step {fmtNum(step, tickDecimals(step))}</span>
                  )}
                </p>
              </div>
            }
          />
          <p className="text-xs text-muted">
            {read && 'qty' in read
              ? `Closes ${fmtQty(p.symbol, read.qty, { market: 'perp' })} ${base} at market, reduce-only. Amounts are rounded down to the step.`
              : 'A reduce-only market order: it can only shrink the position. Amounts are rounded down to the step.'}
          </p>
          {blocked && <ErrorText>{blocked}</ErrorText>}
          <ErrorText>{error}</ErrorText>
          <Button
            type="submit"
            tone="primary"
            className="h-10"
            disabled={busy || blocked !== null || !read || 'error' in read}
          >
            {busy ? 'Closing...' : read && 'qty' in read ? `Close ${read.qty} ${base}` : 'Close part'}
          </Button>
        </form>
      )}
    </Dialog>
  );
}

/** Every open position (oldest first, as the server sends them) and the dialogs of their actions. */
export function PositionsTab() {
  const positions = useLive((s) => s.positions);
  const orders = useLive((s) => s.perpOrders);
  const down = useLive((s) => s.conn !== 'open');
  const markets = useLive((s) => s.markets);
  const perpMeta = useLive((s) => s.meta?.perp);
  const pushNotice = useLive((s) => s.pushNotice);
  const [dialog, setDialog] = useState<{ action: Exclude<PositionAction, 'close'>; symbol: string } | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  async function act(action: PositionAction, p: WirePosition) {
    if (action !== 'close') {
      setDialog({ action, symbol: p.symbol });
      return;
    }
    setClosing(p.symbol);
    try {
      // The whole position at market; the fill arrives as the server's notice.
      await api.closePosition(p.symbol);
    } catch (e) {
      pushNotice('error', e instanceof ApiError ? e.message : String(e));
    } finally {
      setClosing(null);
    }
  }

  const close = () => setDialog(null);
  return (
    <>
      {positions === null ? (
        <Empty>Loading positions...</Empty>
      ) : positions.length === 0 ? (
        <Empty>No open positions.</Empty>
      ) : (
        <Table cols={COLS} template={TEMPLATE} width="xl" action>
          {positions.map((p) => (
            <PositionLine
              key={p.id}
              p={p}
              stops={positionStops(orders, p)}
              down={down}
              tick={perpMeta?.[p.symbol]?.rules?.tickSize}
              feed={markets[`perp:${p.symbol}`]}
              busy={closing === p.symbol}
              onAction={(a, x) => void act(a, x)}
            />
          ))}
        </Table>
      )}
      <ClosePartDialog symbol={dialog?.action === 'part' ? dialog.symbol : null} onClose={close} />
      <MarginDialog symbol={dialog?.action === 'margin' ? dialog.symbol : null} onClose={close} />
      <PositionTpSlDialog symbol={dialog?.action === 'tpsl' ? dialog.symbol : null} onClose={close} />
    </>
  );
}
