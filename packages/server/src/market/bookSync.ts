import type { Logger } from '../log.ts';
import type { RawJson } from '../binance/restCore.ts';
import type { FeedHealth } from './feedHealth.ts';
import type { BookMode, DepthDiff, LocalBook } from './localBook.ts';
import { eventTime, parseDiff, parseLevels } from './streamParse.ts';
import type { DepthLevels } from './streamParse.ts';
import type { SetTimer } from './ws.ts';

const SNAPSHOT_STAGGER_MS = 200;
const RETRY_START_MS = 1000;
const RETRY_MAX_MS = 30_000;
const BUFFER_CAP = 1000;

type Diff = DepthDiff & DepthLevels;

interface SymState {
  /** Bumped on every resync / disconnect so stale snapshot fetches are ignored. */
  epoch: number;
  snapshotApplied: boolean;
  /** Diffs seen while waiting for a snapshot; bounded by BUFFER_CAP (oldest dropped). */
  buffer: Diff[];
  /** Consecutive failed/forced resyncs; drives the per-symbol exponential backoff. */
  failures: number;
  reportedValid: boolean;
  cancelTimer: (() => void) | null;
}

export interface BookSyncDeps {
  /** Names the feed in log lines, e.g. 'spot feed'. */
  name: string;
  mode: BookMode;
  symbols: string[];
  books: Map<string, LocalBook>;
  /** The health of the connection carrying the depth stream. */
  health: FeedHealth;
  /** A REST depth snapshot (lastUpdateId, bids, asks). */
  depth: (symbol: string, limit: number) => Promise<RawJson>;
  logger: Logger;
  setTimer: SetTimer;
  /** The feed's events: 'book' (symbol, DepthLevels) after each applied update, 'snapshot' (symbol) whenever a book is replaced. */
  emit(event: string, ...args: unknown[]): boolean;
  /** A symbol's book became valid (its first update applied since the last resync). */
  onSynced: (symbol: string) => void;
}

/**
 * Per-symbol order-book sync over a depth stream: buffers updates until a REST snapshot arrives,
 * replays the ones the snapshot does not cover, and on a gap or a malformed update empties the
 * book and resyncs it with a per-symbol backoff (1 s doubling to 30 s). An invalid book serves
 * nothing.
 */
export class BookSync {
  readonly st = new Map<string, SymState>();
  private closed = false;

  constructor(private readonly d: BookSyncDeps) {
    for (const s of d.symbols) {
      this.st.set(s, { epoch: 0, snapshotApplied: false, buffer: [], failures: 0, reportedValid: false, cancelTimer: null });
    }
  }

  /** The connection opened: every book syncs afresh, snapshots staggered 200 ms apart. */
  resyncAll(): void {
    this.d.symbols.forEach((s, i) => {
      this.st.get(s)!.failures = 0;
      this.resync(s, i * SNAPSHOT_STAGGER_MS);
    });
  }

  /** The connection went down: every book is emptied and waits for the next connection. */
  reset(): void {
    for (const [sym, s] of this.st) {
      s.epoch++;
      s.cancelTimer?.();
      s.cancelTimer = null;
      s.snapshotApplied = false;
      s.reportedValid = false;
      s.buffer = [];
      s.failures = 0;
      this.emptyBook(sym);
    }
  }

  close(): void {
    this.closed = true;
    for (const s of this.st.values()) {
      s.epoch++;
      s.cancelTimer?.();
      s.cancelTimer = null;
    }
  }

  /** One depth stream message for `symbol`, received at `now`. */
  onDepth(symbol: string, data: any, now: number): void {
    const s = this.st.get(symbol)!;
    const diff = parseDiff(data, this.d.mode);
    this.d.health.onDepth(symbol, now, eventTime(diff !== null, data));
    if (!diff) {
      this.d.logger.warn(`${this.d.name}: malformed depth event for ${symbol}; resyncing`);
      this.invalidate(symbol);
      return;
    }
    if (!s.snapshotApplied) {
      s.buffer.push(diff);
      // Bounded: a later snapshot only has to bridge the first retained diff.
      if (s.buffer.length > BUFFER_CAP) s.buffer.splice(0, s.buffer.length - BUFFER_CAP);
      return;
    }
    this.apply(symbol, diff);
  }

  /** Applies one validated diff to a synced book. Returns false on a gap (resync already scheduled). */
  private apply(symbol: string, diff: Diff): boolean {
    const s = this.st.get(symbol)!;
    const book = this.d.books.get(symbol)!;
    const r = book.applyDiff(diff);
    if (r === 'gap') {
      this.d.logger.warn(`${this.d.name}: sequence gap on ${symbol}; resyncing`);
      this.invalidate(symbol, [diff]); // keep the triggering diff for the next snapshot to bridge
      return false;
    }
    if (r === 'applied') {
      if (!s.reportedValid) {
        s.reportedValid = true;
        s.failures = 0;
        this.d.health.setBookValid(symbol, true);
        this.d.onSynced(symbol);
      }
      this.d.emit('book', symbol, { b: diff.b, a: diff.a } satisfies DepthLevels);
    }
    return true;
  }

  /** An invalid book serves nothing: drop its contents until the next snapshot. */
  private emptyBook(symbol: string): void {
    this.d.books.get(symbol)?.applySnapshot({ lastUpdateId: 0, bids: [], asks: [] });
    this.d.emit('snapshot', symbol);
  }

  private nextDelay(s: SymState): number {
    const delay = Math.min(RETRY_START_MS * 2 ** s.failures, RETRY_MAX_MS);
    s.failures++;
    return delay;
  }

  /** Forced resync (gap, malformed event, failure): per-symbol backoff, 1 s doubling to 30 s. */
  private invalidate(symbol: string, keep: Diff[] = []): void {
    this.resync(symbol, this.nextDelay(this.st.get(symbol)!), keep);
  }

  /** Starts (or restarts) the snapshot sync for one symbol after `delayMs`. */
  private resync(symbol: string, delayMs: number, keep: Diff[] = []): void {
    const s = this.st.get(symbol)!;
    s.epoch++;
    s.cancelTimer?.();
    s.snapshotApplied = false;
    s.reportedValid = false;
    s.buffer = keep.slice(-BUFFER_CAP);
    this.d.health.setBookValid(symbol, false);
    this.emptyBook(symbol);
    this.scheduleFetch(symbol, delayMs);
  }

  private scheduleFetch(symbol: string, delayMs: number): void {
    const s = this.st.get(symbol)!;
    const epoch = s.epoch;
    s.cancelTimer?.();
    s.cancelTimer = this.d.setTimer(() => {
      s.cancelTimer = null;
      void this.fetchSnapshot(symbol, epoch);
    }, delayMs);
  }

  private async fetchSnapshot(symbol: string, epoch: number): Promise<void> {
    const s = this.st.get(symbol)!;
    try {
      let snap: any;
      try {
        snap = await this.d.depth(symbol, 1000);
      } catch (e) {
        if (s.epoch !== epoch || this.closed) return;
        this.d.logger.warn(`${this.d.name}: snapshot fetch failed for ${symbol}: ${(e as Error).message}`);
        this.scheduleFetch(symbol, this.nextDelay(s)); // keeps the (bounded) buffer
        return;
      }
      if (s.epoch !== epoch || this.closed) return;
      const bids = parseLevels(snap?.bids);
      const asks = parseLevels(snap?.asks);
      if (!bids || !asks || !Number.isSafeInteger(snap?.lastUpdateId)) {
        this.d.logger.warn(`${this.d.name}: malformed snapshot for ${symbol}`);
        this.scheduleFetch(symbol, this.nextDelay(s));
        return;
      }
      this.d.books.get(symbol)!.applySnapshot({ lastUpdateId: snap.lastUpdateId, bids, asks });
      this.d.emit('snapshot', symbol);
      s.snapshotApplied = true;
      const buffered = s.buffer;
      s.buffer = [];
      for (const diff of buffered) {
        if (!this.apply(symbol, diff)) {
          // Snapshot older than the buffered diffs (or a real gap): apply() already scheduled
          // the backed-off retry. Keep every diff so a newer snapshot can bridge them.
          s.buffer = buffered;
          return;
        }
      }
    } catch (e) {
      // e.g. a throwing 'book' listener during replay: never an unhandled rejection.
      this.d.logger.error(`${this.d.name}: sync failed for ${symbol}: ${(e as Error).message}`);
      if (!this.closed && s.epoch === epoch) this.invalidate(symbol);
    }
  }
}
