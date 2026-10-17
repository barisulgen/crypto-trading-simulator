// Small shared building blocks: buttons, a segmented switch, a text field, a modal dialog.
import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

type Tone = 'primary' | 'plain' | 'quiet';

const TONES: Record<Tone, string> = {
  primary: 'bg-accent text-on-accent font-semibold hover:brightness-105',
  plain: 'bg-raised text-fg border border-line hover:border-faint',
  quiet: 'text-muted hover:text-fg',
};

export function Button({
  tone = 'plain',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-ctl px-3 text-sm whitespace-nowrap disabled:opacity-50 ${TONES[tone]} ${className}`}
    />
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** A row of mutually exclusive choices (radio semantics). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange(v: T): void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex rounded-ctl border border-line bg-canvas p-0.5 ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-[3px] px-2 text-xs disabled:cursor-not-allowed ${
              on ? 'bg-raised font-semibold text-fg shadow-[inset_0_-2px_0_var(--color-accent)]' : 'text-muted enabled:hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled text input; `hint` sits under it. */
export function TextField({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        className="h-10 rounded-ctl border border-line bg-canvas px-3 text-base text-fg placeholder:text-faint focus:border-accent focus:outline-none"
      />
      {hint !== undefined && <div className="text-xs text-faint">{hint}</div>}
    </div>
  );
}

/** The server's error text, as it said it. */
export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-ctl border border-down/40 bg-down-soft px-3 py-2 text-sm text-fg">
      {children}
    </p>
  );
}

/**
 * A modal dialog (native <dialog>: focus trap, Escape closes). Centred on desktop, a bottom
 * sheet on phones.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // a click on the backdrop
      }}
      className="m-0 mt-auto w-full max-w-none rounded-t-dialog border border-line bg-panel p-0 text-fg backdrop:bg-scrim desk:m-auto desk:w-[25rem] desk:rounded-dialog"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <Button tone="quiet" aria-label="Close" className="-mr-2 px-2" onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
