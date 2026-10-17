import { useState } from 'react';
import type { ReactNode } from 'react';
import { fmtPct, fmtUsd, fmtUsdFloor } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { changeClass } from './CoinList.tsx';
import { DepositDialog } from './DepositDialog.tsx';
import { TransferDialog } from './TransferDialog.tsx';
import { Button } from './ui.tsx';

function Stat({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col desk:flex-none ${className}`}>
      <span className="text-2xs text-faint desk:text-xs">{label}</span>
      {/*
        Money is never cut off: each amount is one unbreakable piece (nowrap), the words around it
        may wrap, and on desktop the bar wraps onto a second row before anything is hidden.
        Dimmed while the bar is frozen (no live connection to the simulator).
      */}
      <div className="group-data-frozen/bar:opacity-45">{children}</div>
    </div>
  );
}

/** Free and locked USDT of one wallet. */
function WalletStat({ label, free, locked }: { label: string; free?: string; locked?: string }) {
  return (
    <Stat label={label}>
      <span className="whitespace-nowrap">{fmtUsdFloor(free)}</span>
      <span className="text-muted"> free</span>
      {/* Locked on its own line, except on wide desktops (1280 px and up) where it fits inline. */}
      <span className="block text-xs text-muted min-[80rem]:ml-2 min-[80rem]:inline">
        <span className="whitespace-nowrap">{fmtUsdFloor(locked)}</span> locked
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
  // Our server connection is down: the numbers are the last ones received, dimmed and labelled.
  const frozen = useLive((s) => s.conn === 'down');
  const [dialog, setDialog] = useState<'deposit' | 'transfer' | null>(null);
  const lev = a?.balances.leverage.USDT;

  return (
    <div
      data-frozen={frozen || undefined}
      className="group/bar flex-none border-b border-line bg-panel px-3 py-2 desk:px-4"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 desk:flex desk:flex-wrap desk:items-center desk:gap-x-5 min-[80rem]:gap-x-7">
        {/* Phones: Net P&L wraps under the total when the buttons leave too little room. */}
        <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-1 desk:contents">
          <Stat
            label={
              <span className="flex items-center gap-1.5">
                Total value
                {frozen && (
                  <span
                    title="Connection to the simulator lost - showing the last values received"
                    className="rounded-ctl border border-down px-1 text-2xs font-semibold text-down"
                  >
                    Not live
                  </span>
                )}
              </span>
            }
          >
            <span className="text-lg font-semibold whitespace-nowrap [font-stretch:108%] min-[80rem]:text-xl">{fmtUsd(a?.total)}</span>
          </Stat>
          <Stat label="Net P&L">
            <span className={`text-base font-semibold whitespace-nowrap ${changeClass(a?.netPnl)}`}>{fmtUsd(a?.netPnl, { sign: true })}</span>
            <span className={`ml-1.5 text-xs whitespace-nowrap ${changeClass(a?.netPnlPct)}`}>
              {a ? (a.netPnlPct === null ? 'no deposits yet' : fmtPct(a.netPnlPct)) : ''}
            </span>
          </Stat>
        </div>

        <div className="flex flex-none gap-2 desk:order-last desk:ml-auto">
          <Button tone="primary" onClick={() => setDialog('deposit')}>
            Deposit
          </Button>
          <Button onClick={() => setDialog('transfer')} disabled={!a}>
            Transfer
          </Button>
        </div>

        <div className="col-span-2 grid grid-cols-3 gap-3 border-t border-line pt-2 text-xs desk:contents desk:text-sm">
          <Stat label="Deposited" className="desk:border-l desk:border-line desk:pl-5 min-[80rem]:pl-7">
            <span className="whitespace-nowrap">{fmtUsd(a?.totalDeposited)}</span>
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
