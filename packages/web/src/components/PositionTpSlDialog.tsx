// Set a stop-loss and/or take-profit on an open position (close-position stops), or cancel them.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { WirePerpOrder } from '../lib/api.ts';
import { fmtPrice } from '../lib/format.ts';
import { feedOf, useLive } from '../lib/live.ts';
import { actionBlocks, positionStops } from '../lib/positions.ts';
import { Button, Dialog, ErrorText, TextField } from './ui.tsx';

const blank = (v: string) => v.trim() === '';

/**
 * Which side of the last price a trigger must be. While the last price is not live (the perp feed
 * stale, or our connection down) it is dimmed and marked stale: the side may have moved.
 */
export function LastPriceHint({
  below,
  symbol,
  last,
  stale,
}: {
  below: boolean;
  symbol: string;
  last: string | undefined;
  stale: boolean;
}) {
  return (
    <>
      <span className={stale ? 'opacity-50' : ''}>
        {`${below ? 'Below' : 'Above'} the last price ${fmtPrice(symbol, last, { market: 'perp' })}`}
      </span>
      {stale && <span className="ml-1.5 whitespace-nowrap text-muted">(Stale: live data interrupted)</span>}
    </>
  );
}

/**
 * A stop already set on the position: its trigger, and its Cancel (or that a cancel is on its way).
 * Cancel removes this stop only: the other of a pair stays armed.
 */
export function StopLeg({ o, label, onCancel }: { o: WirePerpOrder; label: string; onCancel(o: WirePerpOrder): void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-ctl border border-line bg-canvas px-3 py-2 text-sm">
      <span>
        <span className="text-muted">{label}</span> {fmtPrice(o.symbol, o.triggerPrice, { market: 'perp' })} USDT
      </span>
      {o.cancelArrivesAt !== null ? (
        <span className="text-xs text-muted">Cancelling…</span>
      ) : (
        <Button
          size="sm"
          disabled={o.status === 'triggered'}
          title={o.ocoGroupId !== null ? `Cancels this ${label.toLowerCase()} only; the other stays armed` : undefined}
          onClick={() => onCancel(o)}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

/**
 * POST /api/perp/tpsl: a stop-loss and/or take-profit that close the whole position at market when
 * the last price reaches them (both set: when one triggers, the other is cancelled). A position has
 * at most one of each, so a leg already set is shown with its Cancel instead of a field. Refused
 * legs come back with the server's reason, shown as it said it.
 */
export function PositionTpSlDialog({ symbol, onClose }: { symbol: string | null; onClose(): void }) {
  const p = useLive((s) => (symbol ? (s.positions?.find((x) => x.symbol === symbol) ?? null) : null));
  const orders = useLive((s) => s.perpOrders);
  const feed = useLive((s) => (symbol ? feedOf(s, 'perp', symbol) : undefined));
  const last = useLive((s) => (symbol ? s.perpTickers[symbol]?.last : undefined));
  const down = useLive((s) => s.conn !== 'open');
  const pushNotice = useLive((s) => s.pushNotice);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = symbol?.replace(/USDT$/, '') ?? '';

  useEffect(() => {
    if (symbol === null) return;
    setStopLoss('');
    setTakeProfit('');
    setError('');
  }, [symbol]);

  const stops = p ? positionStops(orders, p) : { stopLoss: null, takeProfit: null };
  const blocked = p ? actionBlocks(p, feed).tpsl : null;
  const long = p?.side !== 'short';
  const lastStale = down || feed?.fresh === false;
  const hint = (below: boolean) => <LastPriceHint below={below} symbol={symbol ?? ''} last={last} stale={lastStale} />;

  async function cancel(o: WirePerpOrder) {
    setError('');
    try {
      await api.cancelOrder(o.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!p || symbol === null) return;
    setBusy(true);
    setError('');
    try {
      // Only the legs filled in, exactly as typed.
      const legs = await api.setPositionTpSl(symbol, {
        ...(blank(stopLoss) || stops.stopLoss ? {} : { stopLoss }),
        ...(blank(takeProfit) || stops.takeProfit ? {} : { takeProfit }),
      });
      const rejected = legs.find((l) => l.status === 'rejected');
      if (rejected) {
        setError(rejected.rejectReason ?? 'Rejected');
        return;
      }
      pushNotice('info', `Stops set on the ${base} ${p.side}: they close the whole position at market`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const leg = (o: WirePerpOrder, label: string) => <StopLeg o={o} label={label} onCancel={(x) => void cancel(x)} />;

  const typed = (!stops.stopLoss && !blank(stopLoss)) || (!stops.takeProfit && !blank(takeProfit));
  return (
    <Dialog open={symbol !== null} title={`Stop-loss / take-profit · ${base} ${p?.side ?? ''}`} onClose={onClose}>
      {!p ? (
        <p className="text-sm text-muted">This position is closed.</p>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {stops.stopLoss ? (
            leg(stops.stopLoss, 'Stop-loss')
          ) : (
            <TextField
              label="Stop-loss trigger"
              unit="USDT"
              name="positionStopLoss"
              inputMode="decimal"
              autoComplete="off"
              data-autofocus
              value={stopLoss}
              onChange={(e) => setStopLoss(e.target.value)}
              hint={hint(long)}
            />
          )}
          {stops.takeProfit ? (
            leg(stops.takeProfit, 'Take-profit')
          ) : (
            <TextField
              label="Take-profit trigger"
              unit="USDT"
              name="positionTakeProfit"
              inputMode="decimal"
              autoComplete="off"
              value={takeProfit}
              onChange={(e) => setTakeProfit(e.target.value)}
              hint={hint(!long)}
            />
          )}
          <p className="text-xs text-muted">
            When the last price reaches a trigger, the whole position closes at market (no estimate here) and the other
            stop is cancelled. One stop-loss and one take-profit per position: cancel one to replace it.
          </p>
          {blocked && <ErrorText>{blocked}</ErrorText>}
          <ErrorText>{error}</ErrorText>
          <Button type="submit" tone="primary" className="h-10" disabled={busy || blocked !== null || !typed}>
            {busy ? 'Setting...' : 'Set stops'}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
