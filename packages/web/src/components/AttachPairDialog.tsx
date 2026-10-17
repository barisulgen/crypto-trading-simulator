// Attach a linked stop-loss / take-profit pair (one-cancels-other) to coins already held.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { fmtBalance, fmtPrice } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { Button, Dialog, ErrorText, TextField } from './ui.tsx';

export interface PairTarget {
  symbol: string;
  base: string;
  /** Free (unlocked) holding. */
  free: string;
  /** Prefilled quantity: the free holding in whole steps. */
  qty: string;
}

/**
 * POST /api/oco: a sell stop-loss and a sell take-profit over the same coins; when one triggers
 * the other is cancelled. The server answers with both legs, or with them rejected and the reason.
 */
export function AttachPairDialog({ target, onClose }: { target: PairTarget | null; onClose(): void }) {
  const [qty, setQty] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useLive((s) => (target ? s.tickers[target.symbol]?.last : undefined));
  const pushNotice = useLive((s) => s.pushNotice);

  useEffect(() => {
    if (!target) return;
    setQty(target.qty);
    setStopLoss('');
    setTakeProfit('');
    setError('');
  }, [target]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      // Sent exactly as typed; the server parses '1,5'.
      const legs = await api.attachOco({ symbol: target.symbol, qty, stopLoss, takeProfit });
      const rejected = legs.find((l) => l.status === 'rejected');
      if (rejected) {
        setError(rejected.rejectReason ?? 'Rejected');
        return;
      }
      pushNotice('info', `Stop-loss and take-profit attached to ${qty.trim()} ${target.base}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = qty.trim() !== '' && stopLoss.trim() !== '' && takeProfit.trim() !== '';
  return (
    <Dialog open={target !== null} title={`Attach stop-loss / take-profit${target ? ` - ${target.base}` : ''}`} onClose={onClose}>
      {target && (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <TextField
            label="Quantity"
            unit={target.base}
            name="qty"
            inputMode="decimal"
            autoComplete="off"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            hint={`Free: ${fmtBalance(target.symbol, target.free)} ${target.base}. The coins are locked while the pair is open.`}
          />
          <TextField
            label="Stop-loss trigger"
            unit="USDT"
            name="stopLoss"
            inputMode="decimal"
            autoComplete="off"
            data-autofocus
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            hint={`Sells at market when a trade prints at or below this. Last ${fmtPrice(target.symbol, last)}`}
          />
          <TextField
            label="Take-profit trigger"
            unit="USDT"
            name="takeProfit"
            inputMode="decimal"
            autoComplete="off"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            hint="Sells at market when a trade prints at or above this. When one triggers, the other is cancelled."
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" tone="primary" className="h-10" disabled={busy || !ready}>
            {busy ? 'Attaching...' : 'Attach pair'}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
