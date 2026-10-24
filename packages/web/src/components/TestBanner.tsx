import { useLive } from '../lib/live.ts';

/**
 * The TEST DATA band, for a database recorded before catch-up existed: its records may miss what
 * happened while the app was closed. Nothing for a new database, or before the server has said.
 */
export function TestBannerView({ testData }: { testData: boolean | null }) {
  if (testData !== true) return null;
  return (
    <div role="note" className="hazard flex min-h-[22px] flex-none items-center gap-3 text-2xs font-bold">
      <span className="min-w-0 flex-1 py-0.5 tracking-wide [font-stretch:110%]">
        TEST DATA — recorded before catch-up existed. Run npm run db:wipe to start real practice.
      </span>
    </div>
  );
}

export function TestBanner() {
  const testData = useLive((s) => s.meta?.testData ?? null);
  return <TestBannerView testData={testData} />;
}
