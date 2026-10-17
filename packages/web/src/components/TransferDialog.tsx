import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { Wallet } from '../lib/api.ts';
import { fmtUsd } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { Button, Dialog, ErrorText, TextField } from './ui.tsx';

const NAME: Record<Wallet, string> = { spot: 'Spot wallet', leverage: 'Leverage wallet' };

/** Move free USDT between the spot and leverage wallets. Transfers are logged, not deposits. */
export function TransferDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [from, setFrom] = useState<Wallet>('spot');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const account = useLive((s) => s.account);
  const setAccount = useLive((s) => s.setAccount);
  const pushNotice = useLive((s) => s.pushNotice);
  const to: Wallet = from === 'spot' ? 'leverage' : 'spot';
  const free = account?.balances[from].USDT?.free;

  useEffect(() => {
    if (open) {
      setAmount('');
      setError('');
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setAccount(await api.transfer(from, to, amount));
      pushNotice('info', `Moved ${amount.trim()} USDT from the ${from} wallet to the ${to} wallet`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Transfer" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">From</span>
            <span className="flex h-10 items-center rounded-ctl border border-line bg-raised px-3">{NAME[from]}</span>
          </div>
          <Button
            aria-label="Swap direction"
            title="Swap direction"
            className="h-10 px-2.5"
            onClick={() => {
              setFrom(to);
              setError('');
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3" />
            </svg>
          </Button>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">To</span>
            <span className="flex h-10 items-center rounded-ctl border border-line bg-raised px-3">{NAME[to]}</span>
          </div>
        </div>
        <TextField
          label="Amount (USDT)"
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          data-autofocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint={
            <span className="flex items-center justify-between gap-2">
              <span>Free in the {from} wallet: {fmtUsd(free)}</span>
              {free !== undefined && (
                <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setAmount(free)}>
                  Use all
                </button>
              )}
            </span>
          }
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" tone="primary" className="h-10" disabled={busy || amount.trim() === ''}>
          {busy ? 'Transferring...' : 'Transfer'}
        </Button>
      </form>
    </Dialog>
  );
}
