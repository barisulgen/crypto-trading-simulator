/**
 * History (T16): every event, newest first, with filters (coin, spot or leverage, event type,
 * date range) kept in the hash query, e.g. '#/history?symbol=BTCUSDT'. Placeholder until then.
 */
export function HistoryPage({ params }: { params: URLSearchParams }) {
  void params;
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-faint">
      The full history of deposits, orders and fills will be listed here.
    </div>
  );
}
