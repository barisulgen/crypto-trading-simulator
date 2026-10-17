/** The persistent TEST DATA band (global constraints): every Phase 1 record is test data. */
export function TestBanner() {
  return (
    <div role="note" className="hazard flex h-[22px] flex-none items-center gap-3 text-2xs font-bold">
      <span className="tracking-wide [font-stretch:110%]">TEST DATA — Phase 1</span>
      <span className="hidden font-medium opacity-80 desk:inline">Fake money on live Binance prices</span>
      <span className="flex-1" />
    </div>
  );
}
