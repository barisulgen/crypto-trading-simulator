import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { Wallet } from '../lib/api.ts';
import { useLive } from '../lib/live.ts';
import { Button, Dialog, ErrorText, Segmented, TextField } from './ui.tsx';
import type { SegmentOption } from './ui.tsx';

const WALLETS: SegmentOption<Wallet>[] = [
  { value: 'spot', label: 'Spot wallet' },
  { value: 'leverage', label: 'Leverage wallet' },
];

/** Add fake dollars. Deposits are permanent records: they cannot be edited or deleted. */
export function DepositDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [wallet, setWallet] = useState<Wallet>('spot');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setAccount = useLive((s) => s.setAccount);
  const pushNotice = useLive((s) => s.pushNotice);

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
      // Sent exactly as typed: the server accepts '1000', '1000.50' or '1000,50'.
      setAccount(await api.deposit(wallet, amount));
      pushNotice('info', `Deposited ${amount.trim()} USDT to the ${wallet} wallet`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Deposit" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Segmented<Wallet> label="Wallet" value={wallet} onChange={setWallet} options={WALLETS} />
        <TextField
          label="Amount (USDT)"
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          placeholder="1000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint="Up to 2 decimals. Deposits are permanent: they count toward total deposited and cannot be undone."
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" tone="primary" className="h-10" disabled={busy || amount.trim() === ''}>
          {busy ? 'Depositing...' : 'Deposit'}
        </Button>
      </form>
    </Dialog>
  );
}
