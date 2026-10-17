import { useState } from 'react';
import type { ReactNode } from 'react';
import { fmtPct, fmtUsd } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { changeClass } from './CoinList.tsx';
import { DepositDialog } from './DepositDialog.tsx';
import { TransferDialog } from './TransferDialog.tsx';
import { Button } from './ui.tsx';

function Stat({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col ${className}`}>
      <span className="text-2xs text-faint desk:text-xs">{label}</span>
      <div className="truncate">{children}</div>
    </div>
  );
}

/** Free and locked USDT of one wallet. */
function WalletStat({ label, free, locked }: { label: string; free?: string; locked?: string }) {
  return (
    <Stat label={label}>
      {fmtUsd(free)}
      <span className="text-muted"> free</span>
      <span className="block text-xs text-muted desk:ml-2 desk:inline">
        {fmtUsd(locked)} <span>locked</span>
      </span>
    </Stat>
  );
}

/**
 * What the owner always sees: total value, total deposited, net P&L in $ and %,
 * free and locked dollars per wallet, and the Deposit / Transfer actions.
 */
export function AccountBar() {
  const a = useLive((s) => s.account);
  const [dialog, setDialog] = useState<'deposit' | 'transfer' | null>(null);
  const lev = a?.balances.leverage.USDT;

  return (
    <div className="flex-none border-b border-line bg-panel px-3 py-2 desk:px-4">
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 desk:flex desk:items-center desk:gap-x-7">
        <div className="flex items-end gap-4 desk:contents">
          <Stat label="Total value">
            <span className="text-lg font-semibold [font-stretch:108%] desk:text-xl">{fmtUsd(a?.total)}</span>
          </Stat>
          <Stat label="Net P&L">
            <span className={`text-base font-semibold ${changeClass(a?.netPnl)}`}>{fmtUsd(a?.netPnl, { sign: true })}</span>
            <span className={`ml-1.5 text-xs ${changeClass(a?.netPnlPct)}`}>
              {a ? (a.netPnlPct === null ? 'no deposits yet' : fmtPct(a.netPnlPct)) : ''}
            </span>
          </Stat>
        </div>

        <div className="flex gap-2 desk:order-last desk:ml-auto">
          <Button tone="primary" onClick={() => setDialog('deposit')}>
            Deposit
          </Button>
          <Button onClick={() => setDialog('transfer')} disabled={!a}>
            Transfer
          </Button>
        </div>

        <div className="col-span-2 grid grid-cols-3 gap-3 border-t border-line pt-2 text-xs desk:contents desk:text-sm">
          <Stat label="Deposited" className="desk:border-l desk:border-line desk:pl-7">
            {fmtUsd(a?.totalDeposited)}
          </Stat>
          <WalletStat label="Spot wallet" free={a?.spotUsdtFree} locked={a?.spotUsdtLocked} />
          <WalletStat label="Leverage wallet" free={lev?.free} locked={lev?.locked} />
        </div>
      </div>

      <DepositDialog open={dialog === 'deposit'} onClose={() => setDialog(null)} />
      <TransferDialog open={dialog === 'transfer'} onClose={() => setDialog(null)} />
    </div>
  );
}
