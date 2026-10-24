import { useState } from 'react';
import type { ReactNode } from 'react';
import type { AccountSnapshot } from '../lib/api.ts';
import { fmtPct, fmtUsd, fmtUsdFloor } from '../lib/format.ts';
import { pricesLoading, pricesPausedLabel } from '../lib/holdings.ts';
import { useLive } from '../lib/live.ts';
import { leverageWalletLine } from '../lib/positions.ts';
import { changeClass } from './CoinList.tsx';
import { DepositDialog } from './DepositDialog.tsx';
import { TransferDialog } from './TransferDialog.tsx';
import { Button } from './ui.tsx';

const DASH = '\u2013';
const LOADING_TITLE =
  'A coin you hold or an open position has no price yet: total value and net P&L are shown once everything has been priced';

function Stat({
  label,
  children,
  className = '',
  dim = false,
  title,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  dim?: boolean;
  title?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col desk:flex-none ${className}`} title={title}>
      <span className="text-2xs text-faint desk:text-xs">{label}</span>
      {/*
        Money is never cut off: each amount is one unbreakable piece (nowrap), the words around it
        may wrap, and on desktop the bar wraps onto a second row before anything is hidden.
        Dimmed while the bar is frozen (no live connection to the simulator), or when `dim`.
      */}
      <div className={`group-data-frozen/bar:opacity-45 ${dim ? 'opacity-45' : ''}`}>{children}</div>
    </div>
  );
}

function Badge({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span title={title} className="rounded-ctl border border-down px-1 text-2xs font-semibold whitespace-nowrap text-down">
      {children}
    </span>
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
 * The leverage wallet: free · in orders · in positions, positions valued at the mark (margin plus
 * unrealised P&L). Positions on a stale mark are dimmed and say so; one never priced shows a dash.
 */
function LeverageStat() {
  const a = useLive((s) => s.account);
  const line = a ? leverageWalletLine(a) : null;
  const title = !line
    ? undefined
    : line.loading
      ? 'An open position has no mark price yet: its value is shown once it has one'
      : line.stale
        ? `No live mark for ${a!.marksPaused.join(', ')}: positions valued at the last mark received`
        : 'Leverage wallet = free + in orders + in positions (margin plus unrealised P&L at the mark)';
  return (
    <Stat label="Leverage wallet" title={title}>
      <span className="whitespace-nowrap">{fmtUsdFloor(line?.free)}</span>
      <span className="text-muted"> free</span>
      {/* In orders and in positions under it, except on wide desktops (1280 px and up) where all fits on one line. */}
      <span className="block text-xs text-muted min-[80rem]:inline">
        <span className="hidden min-[80rem]:inline"> · </span>
        <span className="whitespace-nowrap">{fmtUsdFloor(line?.inOrders)}</span> in orders ·{' '}
        <span className={line?.stale ? 'opacity-50' : ''}>
          <span className="whitespace-nowrap">{line?.loading ? DASH : fmtUsdFloor(line?.inPositions)}</span> in positions
        </span>
      </span>
    </Stat>
  );
}

/** Why total value and net P&L are not live: the coins without a live bid, the positions without a live mark. */
function pausedText(a: AccountSnapshot): string {
  const parts = [
    a.pricesPaused.length > 0 && `no live bid for ${a.pricesPaused.join(', ')}`,
    a.marksPaused.length > 0 && `no live mark for ${a.marksPaused.join(', ')}`,
  ].filter(Boolean);
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}: valued at the last real price received`;
}

/**
 * What the owner always sees: total value, total deposited, net P&L in $ and %,
 * free and locked dollars per wallet, and the Deposit / Transfer actions.
 */
export function AccountBar() {
  const a = useLive((s) => s.account);
  // Our server connection is down: the numbers are the last ones received, dimmed and labelled.
  const frozen = useLive((s) => s.conn === 'down');
  // Some held coin has no live bid (feed interrupted): total value and net P&L are not live either.
  // Right after start a held coin may have no bid yet (its value is a placeholder 0) or a position no
  // mark (it counts as its margin only), so the headline would show a figure that is not real. Show a
  // dash until everything has been priced once.
  const loading = a ? pricesLoading(a) : false;
  const paused = a && !loading ? pricesPausedLabel(a) : null;
  const pausedTitle = paused ? pausedText(a!) : undefined;
  const [dialog, setDialog] = useState<'deposit' | 'transfer' | null>(null);

  return (
    <div
      data-frozen={frozen || undefined}
      className="group/bar flex-none border-b border-line bg-panel px-3 py-2 desk:px-4"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 desk:flex desk:flex-wrap desk:items-center desk:gap-x-5 min-[80rem]:gap-x-7">
        {/* Phones: Net P&L wraps under the total when the buttons leave too little room. */}
        <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-1 desk:contents">
          <Stat
            dim={paused !== null}
            title={loading ? LOADING_TITLE : pausedTitle}
            label={
              <span className="flex flex-wrap items-center gap-x-1.5">
                Total value
                {frozen ? (
                  <Badge title="Connection to the simulator lost - showing the last values received">Not live</Badge>
                ) : loading ? (
                  <Badge title={LOADING_TITLE}>Prices loading</Badge>
                ) : (
                  paused && <Badge title={pausedTitle!}>{paused}</Badge>
                )}
              </span>
            }
          >
            <span className="text-lg font-semibold whitespace-nowrap [font-stretch:108%] min-[80rem]:text-xl">{loading ? DASH : fmtUsd(a?.total)}</span>
          </Stat>
          <Stat label="Net P&L" dim={paused !== null} title={loading ? LOADING_TITLE : pausedTitle}>
            <span className={`text-base font-semibold whitespace-nowrap ${changeClass(loading ? null : a?.netPnl)}`}>{loading ? DASH : fmtUsd(a?.netPnl, { sign: true })}</span>
            <span className={`ml-1.5 text-xs whitespace-nowrap ${changeClass(loading ? null : a?.netPnlPct)}`}>
              {a && !loading ? (a.netPnlPct === null ? 'no deposits yet' : fmtPct(a.netPnlPct)) : ''}
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
          <LeverageStat />
        </div>
      </div>

      <DepositDialog open={dialog === 'deposit'} onClose={() => setDialog(null)} />
      <TransferDialog open={dialog === 'transfer'} onClose={() => setDialog(null)} />
    </div>
  );
}
