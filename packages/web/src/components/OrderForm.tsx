// Buy/sell form for the selected coin with a live estimate from the server's preview.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { OrderType, Side } from '@sim/engine';
import { api, ApiError } from '../lib/api.ts';
import type { WirePreview } from '../lib/api.ts';
import { fmtBalance, fmtNum, fmtPrice, fmtQty, fmtUsd, signOf, tickDecimals } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import {
  ORDER_TYPES,
  buildOrderRequest,
  canAttach,
  createLatest,
  fillable,
  hasPrice,
  hasTrigger,
  missingInput,
} from '../lib/orderForm.ts';
import type { OrderFormFields } from '../lib/orderForm.ts';
import { Segmented, TextField } from './ui.tsx';

/** Preview after the owner stops typing for this long. */
const EDIT_DEBOUNCE_MS = 250;
/** While an amount is entered, book updates refresh the preview at most this often. */
const BOOK_REFRESH_MS = 500;

interface PreviewState {
  /** The request (JSON) this answer is for. */
  key: string | null;
  preview: WirePreview | null;
  /** An input or server error (HTTP 4xx/5xx) instead of a preview. */
  error: string | null;
}

const NO_PREVIEW: PreviewState = { key: null, preview: null, error: null };

/**
 * POST /api/orders/preview for `key` (a request as JSON; null = nothing to preview): 250 ms after
 * the last edit, and again on order-book updates at most twice a second. Only the latest
 * request's answer is shown; an older one arriving late is ignored.
 */
function usePreview(key: string | null): PreviewState {
  const [state, setState] = useState<PreviewState>(NO_PREVIEW);
  const [latest] = useState(createLatest);
  const keyRef = useRef(key);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRun = useRef(0);

  useEffect(() => {
    const clear = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const run = async () => {
      timer.current = null;
      const k = keyRef.current;
      if (k === null) return;
      lastRun.current = Date.now();
      const outcome = await latest.run(api.preview(JSON.parse(k)));
      if (outcome === null) return; // a newer request is on its way
      if (outcome.ok) setState({ key: k, preview: outcome.value, error: null });
      else {
        const e = outcome.error;
        setState({ key: k, preview: null, error: e instanceof ApiError ? e.message : String(e) });
      }
    };

    keyRef.current = key;
    clear();
    // The form changed: an answer still on its way is for an older version of it.
    latest.cancel();
    if (key === null) {
      setState(NO_PREVIEW);
      return;
    }
    timer.current = setTimeout(() => void run(), EDIT_DEBOUNCE_MS);
    // Book updates: refresh, throttled; a pending edit debounce already covers them.
    const unsubscribe = useLive.subscribe((s, prev) => {
      if (s.book === prev.book || timer.current !== null || keyRef.current === null) return;
      const wait = Math.max(0, lastRun.current + BOOK_REFRESH_MS - Date.now());
      timer.current = setTimeout(() => void run(), wait);
    });
    return () => {
      unsubscribe();
      clear();
    };
  }, [key, latest]);

  return state;
}

/** Free balance of the asset an order spends. */
function useFree(asset: string): string | undefined {
  return useLive((s) => s.account?.balances.spot[asset]?.free ?? (s.account ? '0' : undefined));
}

/** What a stop or take-profit does when its trigger is reached. */
function triggerHint(type: OrderType, side: Side): string {
  const verb = side === 'buy' ? 'Buys' : 'Sells';
  const rising = (type === 'stop_loss') === (side === 'buy');
  return `${verb} at market when a trade prints at or ${rising ? 'above' : 'below'} this price`;
}

/** A small value for the estimate: below one cent (or 0.01 %) but not zero reads '<'. */
function tiny(value: string, dp: number, prefix: string, suffix: string): string {
  if (signOf(value) > 0 && signOf(value, dp) === 0) return `<${prefix}0.${'0'.repeat(dp - 1)}1${suffix}`;
  return `${prefix}${fmtNum(value, dp)}${suffix}`;
}

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-faint">{label}</dt>
      <dd className={`min-w-0 text-right break-all ${strong ? 'font-semibold text-fg' : 'text-fg'}`}>{children}</dd>
    </div>
  );
}

/** The estimate: average price, slippage, fee, total, what is received, and any problem. */
function Estimate({
  symbol,
  side,
  base,
  priceDp,
  state,
  current,
  missing,
}: {
  symbol: string;
  side: Side;
  base: string;
  /** Decimals for the estimated average price (tick decimals + 2, as in fill notices). */
  priceDp: number;
  state: PreviewState;
  /** False while the shown answer is for an older version of the form. */
  current: boolean;
  missing: string | null;
}) {
  const p = state.preview;
  if (missing !== null && state.key === null) {
    return <p className="text-xs text-faint">{missing} to see the estimated price, fee and total.</p>;
  }
  if (state.error !== null) {
    return (
      <p role="status" className="rounded-ctl border border-down/40 bg-down-soft px-2.5 py-1.5 text-xs text-fg">
        {state.error}
      </p>
    );
  }
  if (!p) return <p className="text-xs text-faint">Estimating...</p>;
  const thin = p.exhausted ? fillable(p, side) : null;
  return (
    <div className={`flex flex-col gap-2 ${current ? '' : 'opacity-60'}`}>
      <dl className="flex flex-col gap-1 text-xs">
        <Row label="Est. avg price">{p.estAvgPrice === null ? '-' : `${fmtNum(p.estAvgPrice, priceDp)} USDT`}</Row>
        <Row label="Est. slippage">
          {p.estSlippageUsd === null
            ? '-'
            : `${tiny(p.estSlippageUsd, 2, '$', '')} (${p.estSlippagePct === null ? '-' : tiny(p.estSlippagePct, 2, '', '%')})`}
        </Row>
        <Row label="Fee">
          {p.fee.amount === null ? '-' : `${p.fee.amount} ${p.fee.asset ?? ''}`}
          {p.fee.usd !== null && p.fee.asset !== 'USDT' && <span className="text-muted"> ~{fmtUsd(p.fee.usd)}</span>}
        </Row>
        {side === 'buy' ? (
          <>
            <Row label="Total cost" strong>
              {fmtUsd(p.total)}
            </Row>
            <Row label="You receive">{p.receive === null ? '-' : `${fmtQty(symbol, p.receive)} ${base}`}</Row>
          </>
        ) : (
          <Row label="You receive" strong>
            {fmtUsd(p.receive)}
          </Row>
        )}
      </dl>
      {p.exhausted && (
        <p className="rounded-ctl border border-accent/50 bg-accent-soft px-2.5 py-1.5 text-xs text-fg">
          Book too thin: only {thin === null ? 'nothing' : thin.unit === 'coin' ? `${thin.amount} ${base}` : fmtUsd(thin.amount)}{' '}
          fillable
        </p>
      )}
      {p.note && <p className="text-xs text-muted">{p.note}</p>}
      {p.rejectReason && (
        <p className="rounded-ctl border border-down/40 bg-down-soft px-2.5 py-1.5 text-xs text-fg">
          <span className="font-semibold">Would be rejected: </span>
          {p.rejectReason}
          <span className="mt-0.5 block text-muted">Submitting records the rejection in history.</span>
        </p>
      )}
    </div>
  );
}

/**
 * The order form (Trade slot): side, type, price or trigger, amount in coins or dollars, an
 * optional stop-loss / take-profit pair on buys, the live estimate and the submit button. Every
 * field is sent exactly as typed. Results arrive as the server's notices.
 */
export function OrderForm() {
  const symbol = useLive((s) => s.selected.symbol);
  const rules = useLive((s) => s.meta?.rules[symbol]);
  const health = useLive((s) => s.health[symbol]);
  const last = useLive((s) => s.tickers[symbol]?.last);
  const priceClick = useLive((s) => s.priceClick);
  const base = rules?.base ?? symbol.replace(/USDT$/, '');
  const quote = rules?.quote ?? 'USDT';
  const stale = health !== undefined && !health.fresh;

  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [amountIn, setAmountIn] = useState<'coin' | 'usd'>('coin');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [trigger, setTrigger] = useState('');
  const [attach, setAttach] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fields: OrderFormFields = { symbol, side, type, amountIn, amount, price, trigger, attach, stopLoss, takeProfit };
  const missing = missingInput(fields);
  const key = missing === null ? JSON.stringify(buildOrderRequest(fields)) : null;
  const preview = usePreview(key);
  const spend = side === 'buy' ? quote : base;
  const free = useFree(spend);
  const attachable = canAttach(fields);

  // Another coin: prices and amounts belong to the old one.
  const shownSymbol = useRef(symbol);
  useEffect(() => {
    if (shownSymbol.current === symbol) return;
    shownSymbol.current = symbol;
    setAmount('');
    setPrice('');
    setTrigger('');
    setStopLoss('');
    setTakeProfit('');
  }, [symbol]);

  // A click on an order-book level fills in the price (a market order becomes a limit).
  const seenClick = useRef(priceClick?.seq);
  useEffect(() => {
    if (!priceClick || priceClick.seq === seenClick.current) return;
    seenClick.current = priceClick.seq;
    if (hasTrigger(type)) setTrigger(priceClick.price);
    else {
      if (type === 'market') setType('limit');
      setPrice(priceClick.price);
    }
  }, [priceClick, type]);

  // Any edit clears the last submit error.
  const formKey = JSON.stringify(fields);
  useEffect(() => setError(''), [formKey]);

  // The current estimate says the server would reject it: still submittable, styled as a warning.
  const warn = preview.key === key && !!preview.preview?.rejectReason;

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
      await api.placeOrder(buildOrderRequest(fields));
      setAmount('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const buy = side === 'buy';
  const label = stale ? 'Live data interrupted' : busy ? 'Placing order...' : `${buy ? 'Buy' : 'Sell'} ${base}`;
  const tone = warn
    ? 'border border-accent bg-accent-soft text-fg'
    : buy
      ? 'bg-up text-panel'
      : 'bg-down text-panel';

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 p-3" aria-label={`Order form for ${base}/${quote}`}>
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
              onClick={() => setSide(s)}
              className={`h-8 rounded-[3px] text-sm font-semibold ${on ? colour : 'text-muted hover:text-fg'}`}
            >
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          );
        })}
      </div>

      <Segmented<OrderType>
        label="Order type"
        value={type}
        onChange={setType}
        grid="grid-cols-6 gap-0.5"
        options={ORDER_TYPES.map((t, i) => ({ ...t, className: i < 3 ? 'col-span-2' : 'col-span-3' }))}
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
              : `Last price ${fmtPrice(symbol, last)}`
          }
        />
      )}
      {hasTrigger(type) && (
        <TextField
          label="Trigger price"
          unit={quote}
          name="trigger"
          inputMode="decimal"
          autoComplete="off"
          placeholder={last ?? ''}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          hint={`${triggerHint(type, side)}. Last ${fmtPrice(symbol, last)}`}
        />
      )}

      <TextField
        label={amountIn === 'coin' ? 'Amount' : 'Total'}
        unit={amountIn === 'coin' ? base : quote}
        name="amount"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aside={
          <Segmented<'coin' | 'usd'>
            label="Amount in"
            value={amountIn}
            onChange={setAmountIn}
            className="w-[7.5rem]"
            options={[
              { value: 'coin', label: base, title: `Amount in ${base}` },
              { value: 'usd', label: '$', title: 'Amount in dollars (USDT)' },
            ]}
          />
        }
        hint={
          <>
            Available{' '}
            <span className="text-muted">
              {free === undefined ? '-' : spend === quote ? `${fmtNum(free, 2)} ${quote}` : `${fmtBalance(symbol, free)} ${base}`}
            </span>
          </>
        }
      />

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
                label="Stop-loss trigger"
                unit={quote}
                name="stopLoss"
                inputMode="decimal"
                autoComplete="off"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
              />
              <TextField
                label="Take-profit trigger"
                unit={quote}
                name="takeProfit"
                inputMode="decimal"
                autoComplete="off"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
              />
              <p className="text-xs text-faint">
                A linked pair of sells over the coins received after the fee, placed when the buy finishes. When one
                triggers, the other is cancelled.
              </p>
            </>
          )}
        </fieldset>
      )}

      <section aria-label="Estimate" aria-live="polite" className="rounded-ctl border border-line bg-canvas px-3 py-2.5">
        <Estimate
          symbol={symbol}
          side={side}
          base={base}
          priceDp={tickDecimals(rules?.tickSize ?? '0.01') + 2}
          state={preview}
          current={preview.key === key}
          missing={missing}
        />
      </section>

      <button
        type="submit"
        disabled={busy || stale}
        className={`flex h-10 items-center justify-center gap-2 rounded-ctl text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
          stale ? 'border border-line bg-raised text-muted' : tone
        }`}
      >
        {warn && !stale && (
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
    </form>
  );
}
