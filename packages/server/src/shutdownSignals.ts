/**
 * Signals that end the server gracefully: Ctrl+C and kill, plus on Windows Ctrl+Break (SIGBREAK)
 * and closing the console window (SIGHUP), which would otherwise end it without a shutdown.
 */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;

export function onShutdownSignals(
  proc: { on(event: string, listener: () => void): unknown },
  shutdown: (signal: string) => void,
): void {
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, () => shutdown(signal));
}
