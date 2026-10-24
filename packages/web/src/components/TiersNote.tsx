// Where the leverage tiers behind the perp form's margin and liquidation figures came from.
import { useLive } from '../lib/live.ts';
import { tiersText } from '../lib/perpForm.ts';

const WHERE: Record<string, string> = {
  official: "From Binance's signed leverage-bracket endpoint",
  unofficial: "From Binance's public web endpoint: the same tables, not the signed API",
  bundled: 'Binance could not be reached: the copy shipped with the simulator, possibly out of date',
};

/** 'Margin tiers: official · fetched 2026-10-23 08:00', or unofficial, or the bundled snapshot's date. */
export function TiersNote() {
  const tiers = useLive((s) => s.meta?.tiers);
  return (
    <p className="text-2xs text-faint" title={tiers ? WHERE[tiers.source] : undefined}>
      {tiersText(tiers)}
    </p>
  );
}
