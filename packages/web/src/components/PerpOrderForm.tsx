// Long/short form for the selected perpetual with a live estimate from the server's perp preview.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Side } from '@sim/engine';
import { api, ApiError } from '../lib/api.ts';
import type { WirePerpPreview } from '../lib/api.ts';
import { fmtCost, fmtFloor, fmtNum, fmtPrice, fmtQty, fmtUsd, signOf, tickDecimals } from '../lib/format.ts';
import { feedOf, useLive } from '../lib/live.ts';
import { liqPriceAtTick } from '../lib/market.ts';
import { hasPrice } from '../lib/orderForm.ts';
import {
  PERP_ORDER_TYPES,
  buildPerpRequest,
  leverageLock,
  perpMissingInput,
  perpLiveState,
  perpPreviewMatches,
  perpQuickHint,
  positionSideOf,
  reduceExcess,
  reduceOnlyState,
} from '../lib/perpForm.ts';
import type { PerpFormFields, PerpOrderType } from '../lib/perpForm.ts';
import { NO_PREVIEW, PreviewLoop } from '../lib/previewLoop.ts';
import type { PreviewState } from '../lib/previewLoop.ts';
import { NO_QUICK, amountStep, perpQuickAmount, quickStep } from '../lib/quickAmount.ts';
import type { Pct, QuickEvent, QuickState } from '../lib/quickAmount.ts';
import { LeverageDialog, MarginModeDialog } from './LeverageDialog.tsx';
import { QuickAmounts } from './QuickAmounts.tsx';
import { TiersNote } from './TiersNote.tsx';
import { Segmented, TextField } from './ui.tsx';

type PerpPreviewState = PreviewState<WirePerpPreview>;

/**
 * POST /api/perp/orders/preview for `key` (a request as JSON; null = nothing to preview), driven by
 * a PreviewLoop: 250 ms after the last edit, and on perp book updates at most twice a second. A
 * change in the feed's or the mark's freshness, or in the leverage, asks again at once.
 */
function usePerpPreview(key: string | null, leverage: number | undefined): PerpPreviewState {
  const [state, setState] = useState<PerpPreviewState>(NO_PREVIEW);
  const [loop] = useState(() => new PreviewLoop<WirePerpPreview>((k) => api.perpPreview(JSON.parse(k)), setState));
  useEffect(() => {
    const unsubscribe = useLive.subscribe((s, prev) => {
      if (s.book !== prev.book && s.book?.market === 'perp') loop.bookChanged();
      const symbol = s.selected.symbol;
      if (symbol !== prev.selected.symbol) return;
      const key = `perp:${symbol}`;
      // The feed or the mark went stale or came back: an estimate made before says nothing about now.
      if (s.markets[key]?.fresh !== prev.markets[key]?.fresh || s.marks[symbol]?.fresh !== prev.marks[symbol]?.fresh) {
        loop.refresh();
      }
    });
    return () => {
      unsubscribe();
      loop.dispose();
    };
  }, [loop]);
  useEffect(() => loop.setKey(key), [loop, key]);
  // The margin and the liquidation price depend on the leverage, which the request does not carry.
  const seenLeverage = useRef(leverage);
  useEffect(() => {
    if (seenLeverage.current === leverage) return;
    seenLeverage.current = leverage;
    loop.refresh();
  }, [loop, leverage]);
  return state;
}

/** A small value for the estimate: below 0.01 % but not zero reads '<0.01%'. */
function tinyPct(value: string): string {
  if (signOf(value) > 0 && signOf(value, 2) === 0) return '<0.01%';
  return `${fmtNum(value, 2)}%`;
}

/** A figure of the estimate: a number may wrap anywhere (it is never cut off), `words` only between words. */
function Row({
  label,
  children,
  strong,
  words,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
  words?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="whitespace-nowrap text-faint">{label}</dt>
      <dd
        className={`min-w-0 text-right ${words ? 'break-words' : 'break-all'} ${strong ? 'font-semibold text-fg' : 'text-fg'}`}
      >
        {children}
      </dd>
    </div>
  );
}

function Note({ tone, children }: { tone: 'warn' | 'error'; children: ReactNode }) {
  const colours = tone === 'warn' ? 'border-accent/50 bg-accent-soft' : 'border-down/40 bg-down-soft';
  return (
    <p role="status" className={`rounded-ctl border px-2.5 py-1.5 text-xs text-fg ${colours}`}>
      {children}
    </p>
  );
}

/**
 * The estimate: size, margin, entry (or exit) price, slippage for market orders, fee and the
 * liquidation price of the position the fill would leave, then any note or problem. While the
 * feed or the mark is not live the estimate is dimmed and the liquidation price is not shown.
 */
export function PerpEstimate({
  symbol,
  side,
  type,
  reduceOnly,
  base,
  priceDp,
  tick,
  leverage,
  state,
  current,
  staleReason,
  missing,
  excess,
}: {
  symbol: string;
  side: Side;
  type: PerpOrderType;
  reduceOnly: boolean;
  base: string;
  /** Decimals for the estimated average price (tick decimals + 2, as in fill notices). */
  priceDp: number;
  /** The perpetual's tick size; undefined before its rules load. */
  tick: string | undefined;
  /** The leverage the form shows; undefined when it is not known. */
  leverage?: number | undefined;
  state: PerpPreviewState;
  /** False while the shown answer is for an older version of the form. */
  current: boolean;
  /** Set while the perp feed or the mark is not live: the estimate is dimmed and says why. */
  staleReason: string | null;
  missing: string | null;
  /** A reduce-only market order's quantity beyond the position (it will be cancelled). */
  excess: string | null;
}) {
  const p = state.preview;
  if (missing !== null && state.key === null) {
    return <p className="text-xs text-faint">{missing} to see the margin, fee and liquidation price.</p>;
  }
  if (state.error !== null) return <Note tone="error">{state.error}</Note>;
  if (!p) return <p className="text-xs text-faint">Estimating...</p>;

  // The position whose liquidation price is shown: the one opened or added to, or the one reduced.
  const liqSide = reduceOnly ? (side === 'buy' ? 'short' : 'long') : positionSideOf(side);
  let liq: string;
  let liqWords = true;
  if (staleReason !== null) liq = 'Not shown: no live mark';
  else if (p.estLiquidationPrice !== null) {
    liqWords = false;
    liq = `${fmtPrice(symbol, liqPriceAtTick(p.estLiquidationPrice, liqSide, tick), { market: 'perp' })} USDT`;
  } else if (p.notional === null || p.rejectReason !== null) liq = '-';
  else liq = reduceOnly ? 'None (position closed)' : 'None';

  // Made before a leverage change (or at a leverage set elsewhere): not an estimate of this order.
  const otherLeverage = leverage !== undefined && p.leverage !== leverage;
  const zeroMargin = p.marginRequired !== null && signOf(p.marginRequired) === 0;
  return (
    <div className={`flex flex-col gap-2 ${current && !otherLeverage && staleReason === null ? '' : 'opacity-60'}`}>
      {staleReason !== null && (
        <Note tone="warn">
          <span className="font-semibold">Estimate may be out of date: </span>
          {staleReason}
        </Note>
      )}
      <dl className="flex flex-col gap-1 text-xs">
        <Row label="Size (notional)">{p.notional === null ? '-' : fmtUsd(p.notional)}</Row>
        <Row label="Margin required" strong words={zeroMargin && reduceOnly}>
          {p.marginRequired === null
            ? '-'
            : zeroMargin && reduceOnly
              ? 'None (reduce-only)'
              : fmtCost(p.marginRequired)}
        </Row>
        <Row label={reduceOnly ? 'Est. exit price' : 'Est. entry price'}>
          {p.estAvgPrice === null ? '-' : `${fmtNum(p.estAvgPrice, priceDp)} USDT`}
        </Row>
        {type === 'market' && (
          <Row label="Est. slippage">
            {p.estSlippageUsd === null
              ? '-'
              : `${fmtCost(p.estSlippageUsd)} (${p.estSlippagePct === null ? '-' : tinyPct(p.estSlippagePct)})`}
          </Row>
        )}
        <Row label="Fee">{fmtCost(p.fee)}</Row>
        <Row label="Est. liq. price" strong words={liqWords}>
          {liq}
        </Row>
      </dl>
      {otherLeverage && (
        <Note tone="warn">Estimated at {p.leverage}x, not the {leverage}x shown.</Note>
      )}
      {excess !== null && (
        <Note tone="warn">
          {excess} {base} more than your position: only the position is closed, the excess is cancelled.
        </Note>
      )}
      {p.exhausted &&
        (p.bandLimited ? (
          <Note tone="warn">
            Limited by the market price band around the mark: only part fills now, the rest is cancelled.
          </Note>
        ) : (
          <Note tone="warn">Book too thin: only part fills now, the rest is cancelled.</Note>
        ))}
      {p.note && <p className="text-xs text-muted">{p.note}</p>}
      {p.rejectReason && (
        <Note tone="error">
          <span className="font-semibold">Would be rejected: </span>
          {p.rejectReason}
          <span className="mt-0.5 block text-muted">Submitting records the rejection in history.</span>
        </Note>
      )}
    </div>
  );
}

const MARGIN_MODE_LABEL: Record<'isolated', string> = { isolated: 'Isolated' };

/** A compact button opening a dialog (margin mode, leverage). */
function Chip({
  children,
  disabled,
  title,
  describedBy,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  describedBy?: string;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={describedBy}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-ctl border border-line bg-raised px-3 text-sm font-semibold text-fg enabled:hover:border-faint disabled:cursor-not-allowed disabled:opacity-60 desk:h-8"
    >
      {children}
    </button>
  );
}

const LOCK_ICON = (
  <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true" className="flex-none">
    <rect x="1" y="5" width="9" height="6.5" rx="1" fill="currentColor" />
    <path d="M3 5V3.5a2.5 2.5 0 015 0V5" stroke="currentColor" strokeWidth="1.3" fill="none" />
  </svg>
);

/** Which way an attached leg must sit from the reference price, for the field hint. */
function legHint(leg: 'stop_loss' | 'take_profit', side: Side, type: PerpOrderType): string {
  const below = (leg === 'stop_loss') === (side === 'buy');
  return `${below ? 'Below' : 'Above'} the ${type === 'market' ? 'last' : 'limit'} price`;
}

/**
 * The perp order form (Trade slot): long or short, order type, limit price, amount in coins or
 * dollars, the margin-mode and leverage chips, reduce-only, an optional stop-loss / take-profit on
 * opening orders, the live estimate and the submit button. Isolated margin only. Every field is
 * sent exactly as typed; results arrive as the server's notices.
 */
export function PerpOrderForm() {
  const symbol = useLive((s) => s.selected.symbol);
  const perp = useLive((s) => s.meta?.perp?.[symbol]);
  const rules = perp?.rules ?? undefined;
  const feed = useLive((s) => feedOf(s, 'perp', symbol));
  const mark = useLive((s) => s.marks[symbol]);
  const down = useLive((s) => s.conn !== 'open');
  const position = useLive((s) => s.positions?.find((p) => p.symbol === symbol) ?? null);
  const lock = useLive((s) => leverageLock(symbol, s.positions, s.perpOrders));
  const free = useLive((s) => (s.account ? (s.account.balances.leverage.USDT?.free ?? '0') : undefined));
  const taker = useLive((s) => s.meta?.fees.perp.taker);
  const last = useLive((s) => s.perpTickers[symbol]?.last);
  const priceClick = useLive((s) => s.priceClick);
  const base = rules?.base ?? symbol.replace(/USDT$/, '');
  const quote = rules?.quote ?? 'USDT';
  const leverage = perp?.leverage;
  const marginMode = perp ? MARGIN_MODE_LABEL[perp.marginMode] : '-';
  // Never a live-looking estimate on data that is not live.
  const { staleReason, blocked, liveMark } = perpLiveState({ feed, mark, down });

  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<PerpOrderType>('market');
  const [amountIn, setAmountIn] = useState<'coin' | 'usd'>('coin');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [reduceChecked, setReduceChecked] = useState(false);
  const [attach, setAttach] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [quick, setQuick] = useState<QuickState>(NO_QUICK);
  const [dialog, setDialog] = useState<'leverage' | 'margin' | null>(null);

  const reduce = reduceOnlyState(side, position, reduceChecked);
  const fields: PerpFormFields = {
    symbol,
    side,
    type,
    amountIn,
    amount,
    price,
    reduceOnly: reduce.on,
    attach,
    stopLoss,
    takeProfit,
    ...(quick.sellAll !== undefined ? { reduceAll: quick.sellAll } : {}),
  };
  const missing = perpMissingInput(fields);
  const key = missing === null ? JSON.stringify(buildPerpRequest(fields)) : null;
  const answer = usePerpPreview(key, leverage);
  // An answer for another symbol, side, type or reduce-only setting is never shown, not even dimmed.
  const shown = perpPreviewMatches(answer.key, fields);
  const preview = shown ? answer : NO_PREVIEW;
  const step = rules ? amountStep(rules, type) : '0.001';
  // Only a position the order reduces: on its own side, a reduce-only order is rejected.
  const excess = reduceExcess(fields, reduce.forced ? position : null, liveMark, step);

  // Quick amounts: sized against the book, mark and balances as they are at this moment (read, not
  // subscribed, so a tick never changes the field under the owner).
  function sizeQuick(pct: Pct) {
    const s = useLive.getState();
    if (!rules || !s.account || taker === undefined || leverage === undefined) return null;
    // A reduce-only order takes shares of the position it reduces, the one on the other side.
    const held = s.positions?.find((p) => p.symbol === symbol && p.side !== positionSideOf(side)) ?? null;
    if (reduce.on && !held) return null;
    const m = s.marks[symbol];
    const book = s.book?.market === 'perp' && s.book.symbol === symbol ? s.book : null;
    // The latest trade of the perp shown, else its ticker's last price.
    const lastTrade = s.selected.market === 'perp' && s.selected.symbol === symbol ? s.trades[0]?.price : undefined;
    return perpQuickAmount({
      unit: amountIn,
      pct,
      free: s.account.balances.leverage.USDT?.free ?? '0',
      leverage,
      taker,
      side,
      type,
      price,
      bids: book?.bids ?? [],
      asks: book?.asks ?? [],
      mark: m?.fresh && s.conn === 'open' ? m.markPrice : null,
      last: lastTrade ?? s.perpTickers[symbol]?.last ?? null,
      step: amountStep(rules, type),
      reduce: reduce.on && held ? { qty: held.qty } : null,
    });
  }
  function quickEvent(event: QuickEvent) {
    const next = quickStep(quick, event, sizeQuick);
    setQuick(next.state);
    if (next.amount !== undefined) setAmount(next.amount);
  }
  // An active percentage follows the unit, order type, limit price, leverage and reduce-only.
  useEffect(() => quickEvent({ type: 'reprice' }), [amountIn, type, price, leverage, reduce.on]);
  const hint = rules ? perpQuickHint(quick, step, base) : null;

  // Another coin: prices and amounts belong to the old one.
  const shownSymbol = useRef(symbol);
  useEffect(() => {
    if (shownSymbol.current === symbol) return;
    shownSymbol.current = symbol;
    setQuick(NO_QUICK);
    setAmount('');
    setPrice('');
    setStopLoss('');
    setTakeProfit('');
    setReduceChecked(false);
  }, [symbol]);

  // A click on an order-book level fills in the price (a market order becomes a limit).
  const seenClick = useRef(priceClick?.seq);
  useEffect(() => {
    if (!priceClick || priceClick.seq === seenClick.current) return;
    seenClick.current = priceClick.seq;
    if (type === 'market') setType('limit');
    setPrice(priceClick.price);
  }, [priceClick, type]);

  // Any edit clears the last submit error.
  const formKey = JSON.stringify(fields);
  useEffect(() => setError(''), [formKey]);

  const warn = shown && preview.key === key && !!preview.preview?.rejectReason;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (missing !== null) {
      setError(missing);
      return;
    }
    setBusy(true);
    setError('');
    try {
      // The outcome (placed, filled, rejected) arrives as the server's notice and order updates.
      await api.placePerpOrder(buildPerpRequest(fields));
      setAmount('');
      setQuick(NO_QUICK);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const buy = side === 'buy';
  const action = reduce.on
    ? position && reduce.forced
      ? `Reduce ${base} ${position.side}`
      : `Reduce-only ${buy ? 'buy' : 'sell'}`
    : `${buy ? 'Long' : 'Short'} ${base}`;
  const label = blocked ? 'Live data interrupted' : busy ? 'Placing order...' : action;
  const tone = warn ? 'border border-accent bg-accent-soft text-fg' : buy ? 'bg-up text-panel' : 'bg-down text-panel';
  const maxLeverage = perp?.maxLeverage ?? null;
  const leverageOff = lock !== null || maxLeverage === null || !perp?.brackets;
  const leverageWhy = lock ?? (maxLeverage === null ? 'Leverage tiers not loaded yet' : null);
  const attachable = !reduce.on;

  return (
    <>
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3 p-3"
        aria-label={`Order form for ${base} perpetual`}
      >
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-2">
            <Chip label={`Margin mode: ${marginMode}`} title="Margin mode" onClick={() => setDialog('margin')}>
              {marginMode}
            </Chip>
            <Chip
              label={`Leverage ${leverage ?? '-'}x`}
              title={leverageWhy ?? 'Change the leverage'}
              describedBy={leverageWhy ? 'perp-leverage-why' : undefined}
              disabled={leverageOff}
              onClick={() => setDialog('leverage')}
            >
              {lock !== null && LOCK_ICON}
              {leverage ?? '-'}x
            </Chip>
          </div>
          {leverageWhy && (
            <p id="perp-leverage-why" className="text-right text-xs text-faint">
              {leverageWhy}
            </p>
          )}
        </div>

        <div role="radiogroup" aria-label="Side" className="grid grid-cols-2 gap-1 rounded-ctl bg-canvas p-0.5">
          {(['buy', 'sell'] as const).map((s) => {
            const on = side === s;
            const colour = s === 'buy' ? 'bg-up text-panel' : 'bg-down text-panel';
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  if (s === side) return;
                  setSide(s);
                  quickEvent({ type: 'reset' });
                }}
                className={`h-8 rounded-[3px] text-sm font-semibold ${on ? colour : 'text-muted hover:text-fg'}`}
              >
                {s === 'buy' ? 'Buy / Long' : 'Sell / Short'}
              </button>
            );
          })}
        </div>

        <Segmented<PerpOrderType>
          label="Order type"
          value={type}
          onChange={setType}
          grid="grid-cols-3 gap-0.5"
          options={PERP_ORDER_TYPES}
        />

        {hasPrice(type) && (
          <TextField
            label="Limit price"
            unit={quote}
            name="price"
            inputMode="decimal"
            autoComplete="off"
            placeholder={last ?? ''}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint={
              type === 'post_only'
                ? 'Rejected if it would fill at once; always pays the maker fee'
                : `Mark ${liveMark === null ? '-' : fmtPrice(symbol, liveMark, { market: 'perp' })} · Last ${fmtPrice(symbol, last, { market: 'perp' })}`
            }
          />
        )}

        <TextField
          label={amountIn === 'coin' ? 'Amount' : 'Size'}
          unit={amountIn === 'coin' ? base : quote}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            quickEvent({ type: 'edit' });
          }}
          aside={
            <Segmented<'coin' | 'usd'>
              label="Amount in"
              value={amountIn}
              onChange={setAmountIn}
              className="w-[7.5rem]"
              options={[
                { value: 'coin', label: base, title: `Amount in ${base}` },
                { value: 'usd', label: '$', title: 'Position size in dollars (USDT notional)' },
              ]}
            />
          }
          hint={
            <div className="flex flex-col gap-1.5 pt-0.5">
              <QuickAmounts
                active={quick.pct}
                disabled={!rules || free === undefined || (reduce.on && !reduce.forced)}
                of="USDT"
                whole={reduce.on ? `your ${base} position` : 'free leverage USDT as margin'}
                onPick={(pct) => quickEvent({ type: 'pick', pct })}
              />
              {reduce.on ? (
                <p>
                  Position{' '}
                  <span className="whitespace-nowrap text-muted">
                    {position ? `${fmtQty(symbol, position.qty, { market: 'perp' })} ${base} ${position.side}` : 'none'}
                  </span>
                </p>
              ) : (
                <p>
                  Available{' '}
                  <span className="whitespace-nowrap text-muted">
                    {free === undefined ? '-' : `${fmtFloor(free, 2)} ${quote}`}
                  </span>{' '}
                  <span className="whitespace-nowrap">in the leverage wallet</span>
                </p>
              )}
              <p aria-live="polite" className="text-muted empty:hidden">
                {hint}
              </p>
            </div>
          }
        />

        <label
          className="flex items-center gap-2 text-xs text-fg"
          title={reduce.forced ? 'One-way mode: an order against your position can only reduce it' : undefined}
        >
          <input
            type="checkbox"
            checked={reduce.on}
            disabled={reduce.forced}
            onChange={(e) => setReduceChecked(e.target.checked)}
            className="size-4 accent-[var(--color-accent)] disabled:opacity-70"
          />
          {reduce.label}
        </label>

        {attachable && (
          <fieldset className="flex flex-col gap-3 rounded-ctl border border-line px-3 py-2.5">
            <label className="flex items-center gap-2 text-xs text-fg">
              <input
                type="checkbox"
                checked={attach}
                onChange={(e) => setAttach(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Attach stop-loss / take-profit
            </label>
            {attach && (
              <>
                <TextField
                  label="Stop-loss trigger (optional)"
                  unit={quote}
                  name="stopLoss"
                  inputMode="decimal"
                  autoComplete="off"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  hint={legHint('stop_loss', side, type)}
                />
                <TextField
                  label="Take-profit trigger (optional)"
                  unit={quote}
                  name="takeProfit"
                  inputMode="decimal"
                  autoComplete="off"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  hint={legHint('take_profit', side, type)}
                />
                <p className="text-xs text-faint">
                  Placed at the order's first fill. When the last price reaches a trigger, the whole position closes at
                  market and the other leg is cancelled. Those fills have no estimate here.
                </p>
              </>
            )}
          </fieldset>
        )}

        {/* Not a live region as a whole: it refreshes with the book. Only the problem messages inside are (role=status). */}
        <section aria-label="Estimate" className="rounded-ctl border border-line bg-canvas px-3 py-2.5">
          <PerpEstimate
            symbol={symbol}
            side={side}
            type={type}
            reduceOnly={reduce.on}
            base={base}
            priceDp={tickDecimals(rules?.tickSize ?? '0.01') + 2}
            tick={rules?.tickSize}
            leverage={leverage}
            state={preview}
            current={preview.key === key}
            staleReason={staleReason}
            missing={missing}
            excess={excess}
          />
        </section>

        <button
          type="submit"
          disabled={busy || blocked}
          className={`flex h-10 items-center justify-center gap-2 rounded-ctl text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
            blocked ? 'border border-line bg-raised text-muted' : tone
          }`}
        >
          {warn && !blocked && (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="flex-none text-accent">
              <path d="M7 1l6.5 12h-13z" fill="currentColor" />
              <path d="M7 5.5v3.5M7 10.5v1" stroke="var(--color-on-accent)" strokeWidth="1.4" />
            </svg>
          )}
          {label}
        </button>
        {error && (
          <p role="alert" className="rounded-ctl border border-down/40 bg-down-soft px-3 py-2 text-sm text-fg">
            {error}
          </p>
        )}

        <TiersNote />
      </form>
      {/* Outside the form: each dialog is a form of its own. */}
      <LeverageDialog open={dialog === 'leverage'} symbol={symbol} onClose={() => setDialog(null)} />
      <MarginModeDialog open={dialog === 'margin'} onClose={() => setDialog(null)} />
    </>
  );
}
