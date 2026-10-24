// The perp form's leverage and margin-mode dialogs.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { fmtUsd } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { maxPositionAt } from '../lib/perpForm.ts';
import { Button, Dialog, ErrorText, TextField } from './ui.tsx';

/** The store's copy of a symbol's leverage setting, after the server confirmed a change. */
function storeLeverage(symbol: string, leverage: number): void {
  useLive.setState((s) => {
    const perp = s.meta?.perp?.[symbol];
    if (!s.meta || !perp) return {};
    return { meta: { ...s.meta, perp: { ...s.meta.perp, [symbol]: { ...perp, leverage } } } };
  });
}

/** A whole number from 1 to max as typed, or null. */
function wholeIn(input: string, max: number): number | null {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

/**
 * Leverage from 1 to the coin's maximum (its first tier's), on a slider or typed, with the largest
 * position the tiers allow at the chosen leverage. The server has the last word: a refusal (the
 * leverage locked meanwhile, out of range) is shown as it said it.
 */
export function LeverageDialog({ open, symbol, onClose }: { open: boolean; symbol: string; onClose(): void }) {
  const perp = useLive((s) => s.meta?.perp?.[symbol]);
  const pushNotice = useLive((s) => s.pushNotice);
  const max = perp?.maxLeverage ?? null;
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = symbol.replace(/USDT$/, '');

  useEffect(() => {
    if (open) {
      setValue(String(perp?.leverage ?? ''));
      setError('');
    }
    // Only when the dialog opens: the field is the owner's while it is open.
  }, [open]);

  const chosen = max === null ? null : wholeIn(value, max);
  const cap = chosen !== null && perp?.brackets ? maxPositionAt(perp.brackets, chosen) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen === null) {
      setError(max === null ? 'Leverage tiers not loaded yet' : `Enter a whole number from 1 to ${max}`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api.setLeverage(symbol, chosen);
      storeLeverage(symbol, r.leverage);
      pushNotice('info', `${base} perpetual leverage set to ${r.leverage}x`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title={`Leverage · ${base} perpetual`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Leverage"
          unit="x"
          name="leverage"
          inputMode="numeric"
          autoComplete="off"
          data-autofocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError('');
          }}
          hint={max === null ? 'Leverage tiers not loaded yet' : `Whole number from 1 to ${max}`}
        />
        {max !== null && (
          <div className="flex flex-col gap-1">
            <input
              type="range"
              min={1}
              max={max}
              step={1}
              value={chosen ?? perp?.leverage ?? 1}
              onChange={(e) => {
                setValue(e.target.value);
                setError('');
              }}
              aria-label="Leverage"
              className="w-full accent-[var(--color-accent)]"
            />
            <div className="flex justify-between text-2xs text-faint">
              <span>1x</span>
              <span>{max}x</span>
            </div>
          </div>
        )}
        <dl className="flex flex-col gap-1 rounded-ctl border border-line bg-canvas px-3 py-2.5 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-faint">Maximum position{chosen !== null ? ` at ${chosen}x` : ''}</dt>
            <dd className="text-right break-all text-fg">{cap === null ? '-' : fmtUsd(cap)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted">
          Higher leverage needs less margin for the same position and puts the liquidation price closer to the entry.
        </p>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" tone="primary" className="h-10" disabled={busy || chosen === null}>
          {busy ? 'Setting...' : chosen === null ? 'Set leverage' : `Set ${chosen}x`}
        </Button>
      </form>
    </Dialog>
  );
}

/**
 * Margin mode: isolated is the only one. Cross is listed, disabled, with what it would change.
 */
export function MarginModeDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} title="Margin mode" onClose={onClose}>
      <div role="radiogroup" aria-label="Margin mode" className="flex flex-col gap-2">
        <button
          type="button"
          role="radio"
          aria-checked="true"
          data-autofocus
          onClick={onClose}
          className="flex flex-col items-start gap-0.5 rounded-ctl border border-accent bg-raised px-3 py-2.5 text-left"
        >
          <span className="text-sm font-semibold text-fg">Isolated</span>
          <span className="text-xs text-muted">
            Each position has its own margin: a liquidation loses only that margin.
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked="false"
          disabled
          className="flex flex-col items-start gap-0.5 rounded-ctl border border-line px-3 py-2.5 text-left opacity-60 disabled:cursor-not-allowed"
        >
          <span className="text-sm font-semibold text-fg">Cross — coming later</span>
          <span className="text-xs text-muted">
            All free leverage USDT backs every position, so one liquidation can take it all.
          </span>
        </button>
      </div>
    </Dialog>
  );
}
