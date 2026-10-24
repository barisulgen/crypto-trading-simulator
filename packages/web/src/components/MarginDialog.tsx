// Add margin to an open isolated position, or take some out, with the server's estimate of what
// the change leaves.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { WireMarginPreview } from '../lib/api.ts';
import { fmtFloor, fmtPrice, fmtUsdFloor } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { cmpDec, liqPriceAtTick } from '../lib/market.ts';
import { actionBlocks } from '../lib/positions.ts';
import { NO_PREVIEW, PreviewLoop } from '../lib/previewLoop.ts';
import type { PreviewState } from '../lib/previewLoop.ts';
import { Button, Dialog, ErrorText, Segmented, TextField } from './ui.tsx';

type Action = 'add' | 'remove';
type MarginPreviewState = PreviewState<WireMarginPreview>;

/**
 * POST /api/perp/margin/preview for `key` (the request as JSON; null = nothing to ask), 250 ms after
 * the last edit; asked again at once whenever `version` changes (the position or what may be
 * removed moved, so an answer made before says nothing about now).
 */
function useMarginPreview(key: string | null, version: string): MarginPreviewState {
  const [state, setState] = useState<MarginPreviewState>(NO_PREVIEW);
  const [loop] = useState(() => new PreviewLoop<WireMarginPreview>((k) => api.marginPreview(JSON.parse(k)), setState));
  useEffect(() => () => loop.dispose(), [loop]);
  useEffect(() => loop.setKey(key), [loop, key]);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    loop.refresh();
  }, [loop, version]);
  return state;
}

function Figure({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="whitespace-nowrap text-faint">{label}</dt>
      <dd className={`min-w-0 text-right break-words ${strong ? 'font-semibold text-fg' : 'text-fg'}`}>{children}</dd>
    </div>
  );
}

/**
 * The margin dialog of one position: add free leverage USDT to its margin or remove some of it.
 * The most that may be removed and the liquidation price after the change are the server's
 * figures (the engine's own checks), never worked out here; the price is rounded towards the mark.
 * A removal needs a live mark, so without one nothing is offered as removable.
 */
export function MarginDialog({ symbol, onClose }: { symbol: string | null; onClose(): void }) {
  const p = useLive((s) => (symbol ? (s.positions?.find((x) => x.symbol === symbol) ?? null) : null));
  const free = useLive((s) => s.account?.balances.leverage.USDT?.free);
  const tick = useLive((s) => (symbol ? (s.meta?.perp?.[symbol]?.rules?.tickSize ?? undefined) : undefined));
  const down = useLive((s) => s.conn !== 'open');
  const pushNotice = useLive((s) => s.pushNotice);
  const [action, setAction] = useState<Action>('add');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = symbol?.replace(/USDT$/, '') ?? '';

  useEffect(() => {
    if (symbol === null) return;
    setAction('add');
    setAmount('');
    setError('');
  }, [symbol]);

  const key = symbol !== null && p && amount.trim() !== '' ? JSON.stringify({ symbol, action, amount }) : null;
  // The position's margin and size, and for a removal the most removable now, all change the answer.
  const version = `${p?.margin}|${p?.qty}|${action === 'remove' ? p?.maxRemovableMargin : ''}`;
  const answer = useMarginPreview(key, version);
  const preview = answer.key === key ? answer : NO_PREVIEW;
  const current = answer.key === key;
  const blocked = p ? actionBlocks(p, undefined).margin : null;
  // The server's figure, at its fresh mark; while our connection is down it may be out of date.
  const removable = p && !down ? p.maxRemovableMargin : null;
  const noRemove =
    action === 'remove' && removable === null
      ? down
        ? 'Connection to the simulator lost: what may be removed is not known'
        : 'No live mark price: margin can be removed only at a live mark'
      : null;

  const liqAfter = (price: string | null): string => {
    if (!p) return '-';
    if (price === null) return 'None';
    if (tick === undefined) return '-';
    return `${fmtPrice(p.symbol, liqPriceAtTick(price, p.side, tick), { market: 'perp' })} USDT`;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!p || symbol === null) return;
    setBusy(true);
    setError('');
    try {
      // Sent exactly as typed; the server parses '1,5'.
      const after = await api.changeMargin(symbol, action, amount);
      const liq = after?.liquidationPrice ?? null;
      const liqText =
        liq === null || tick === undefined
          ? ''
          : ` · liquidation price ${fmtPrice(symbol, liqPriceAtTick(liq, p.side, tick), { market: 'perp' })}`;
      const moved = action === 'add' ? `Added ${amount.trim()} USDT to` : `Removed ${amount.trim()} USDT from`;
      pushNotice('info', `${moved} the ${base} ${p.side} margin${liqText}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const reject = current ? (preview.preview?.rejectReason ?? preview.error) : null;
  // The server's answer for this very amount says it would be refused: nothing to send.
  const ready = key !== null && blocked === null && noRemove === null && !(current && preview.preview?.rejectReason);
  return (
    <Dialog open={symbol !== null} title={`Margin · ${base} ${p?.side ?? ''}`} onClose={onClose}>
      {!p ? (
        <p className="text-sm text-muted">This position is closed.</p>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Segmented<Action>
            label="Margin action"
            value={action}
            onChange={(a) => {
              setAction(a);
              setError('');
            }}
            grid="grid-cols-2 gap-0.5"
            options={[
              { value: 'add', label: 'Add margin' },
              { value: 'remove', label: 'Remove margin' },
            ]}
          />
          <TextField
            label="Amount"
            unit="USDT"
            name="marginAmount"
            inputMode="decimal"
            autoComplete="off"
            data-autofocus
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError('');
            }}
            aside={
              action === 'remove' && removable !== null && cmpDec(removable, '0') > 0 ? (
                <Button tone="quiet" size="sm" onClick={() => setAmount(removable)} title="Fill in the most that may be removed now">
                  Max
                </Button>
              ) : undefined
            }
            hint={
              action === 'add' ? (
                <>
                  Available <span className="whitespace-nowrap text-muted">{free === undefined ? '-' : `${fmtFloor(free, 2)} USDT`}</span>{' '}
                  <span className="whitespace-nowrap">in the leverage wallet</span>
                </>
              ) : (
                <>
                  Maximum removable{' '}
                  <span className="whitespace-nowrap text-muted">{removable === null ? '-' : `${fmtFloor(removable, 2)} USDT`}</span>{' '}
                  <span className="whitespace-nowrap">at the current mark</span>
                </>
              )
            }
          />
          <dl
            aria-label="After the change"
            className={`flex flex-col gap-1 rounded-ctl border border-line bg-canvas px-3 py-2.5 text-xs ${current ? '' : 'opacity-60'}`}
          >
            <Figure label="Margin now">{fmtUsdFloor(p.margin)}</Figure>
            <Figure label="Liq. price now">
              {/* No price yet when the tiers (or a mark) are missing: not the same as none at all. */}
              {p.liquidationPrice === null && p.maintenanceMargin === null ? '-' : liqAfter(p.liquidationPrice)}
            </Figure>
            <Figure label="Margin after" strong>
              {preview.preview?.marginAfter ? fmtUsdFloor(preview.preview.marginAfter) : '-'}
            </Figure>
            <Figure label="Liq. price after" strong>
              {preview.preview?.marginAfter ? liqAfter(preview.preview.liquidationPriceAfter) : '-'}
            </Figure>
          </dl>
          <p className="text-xs text-muted">
            {action === 'add'
              ? 'More margin moves the liquidation price away from the entry. Isolated: only this position uses it.'
              : 'Less margin moves the liquidation price closer. At most what keeps the position above its initial margin at the mark.'}
          </p>
          {blocked && <ErrorText>{blocked}</ErrorText>}
          {noRemove && <ErrorText>{noRemove}</ErrorText>}
          {reject && !error && <ErrorText>{reject}</ErrorText>}
          <ErrorText>{error}</ErrorText>
          <Button type="submit" tone="primary" className="h-10" disabled={busy || !ready}>
            {busy ? 'Saving...' : action === 'add' ? 'Add margin' : 'Remove margin'}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
