import type { RawJson } from '../binance/restCore.ts';
import type { SetTimer } from './ws.ts';

const STARTUP_RETRY_START_MS = 5000;
const STARTUP_RETRY_MAX_MS = 60_000;

/** Repeating background jobs that stop together. */
export class Pollers {
  private readonly cancels = new Set<() => void>();
  /** Bumped by stop(): a run still in flight from before then does not re-arm. */
  private generation = 0;

  constructor(private readonly setTimer: SetTimer) {}

  /**
   * Runs `fn` after `firstDelay`, then every `ms` (a function is asked again after each run). With
   * `untilFirstSuccess`, a failed run is retried quickly (5 s doubling to 60 s) until it first
   * succeeds, then at the normal period.
   */
  every(fn: () => Promise<boolean>, ms: number | (() => number), firstDelay: number, untilFirstSuccess: boolean): void {
    const generation = this.generation;
    const live = () => generation === this.generation;
    const period = typeof ms === 'number' ? () => ms : ms;
    let cancel: () => void = () => {};
    let ok = false;
    let retry = STARTUP_RETRY_START_MS;
    const arm = (delay: number) => {
      this.cancels.delete(cancel);
      cancel = this.setTimer(() => {
        if (!live()) return;
        void fn()
          .catch(() => false)
          .then((success) => {
            if (!live()) return;
            if (success) ok = true;
            if (ok || !untilFirstSuccess) return arm(period());
            arm(retry);
            retry = Math.min(retry * 2, STARTUP_RETRY_MAX_MS);
          });
      }, delay);
      this.cancels.add(cancel);
    };
    arm(firstDelay);
  }

  stop(): void {
    this.generation++;
    for (const c of this.cancels) c();
    this.cancels.clear();
  }
}

/**
 * Binance's clock minus ours, in ms, from one server-time request: the server time against the
 * midpoint of the request. Null when the answer holds no usable time.
 */
export async function measureClockOffset(serverTime: () => Promise<RawJson>, now: () => number): Promise<number | null> {
  const t0 = now();
  const r = await serverTime();
  const t1 = now();
  const offset = Number(r?.serverTime) - (t0 + t1) / 2;
  return Number.isFinite(offset) ? offset : null;
}
