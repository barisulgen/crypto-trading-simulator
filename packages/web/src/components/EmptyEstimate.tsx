/**
 * The estimate before the form is complete: what to enter, and, while the market's data is stale
 * or catching up, why the order cannot be sent now.
 */
export function EmptyEstimate({ hint, staleReason }: { hint: string; staleReason: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      {staleReason !== null && (
        <p role="status" className="rounded-ctl border border-accent/50 bg-accent-soft px-2.5 py-1.5 text-xs text-fg">
          {staleReason}
        </p>
      )}
      <p className="text-xs text-faint">{hint}</p>
    </div>
  );
}
