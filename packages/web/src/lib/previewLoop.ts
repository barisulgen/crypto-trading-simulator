// When the order form asks the server for a preview: after edits (debounced) and on order-book
// updates (throttled), showing only the answer for the current form.
import type { WirePreview } from './api.ts';
import { createLatest } from './orderForm.ts';

/** Preview after the owner stops typing for this long. */
export const EDIT_DEBOUNCE_MS = 250;
/** While the form is complete, book updates refresh the preview at most this often. */
export const BOOK_REFRESH_MS = 500;

export interface PreviewState {
  /** The request (JSON) this answer is for; null when there is nothing to preview. */
  key: string | null;
  preview: WirePreview | null;
  /** An input or server error (HTTP 4xx/5xx) instead of a preview. */
  error: string | null;
}

export const NO_PREVIEW: PreviewState = { key: null, preview: null, error: null };

/**
 * `setKey` on every form change (a request as JSON, or null), `bookChanged` on every order-book
 * update. A form change cancels the answer still on its way and asks again 250 ms later. A book
 * update asks again at most every 500 ms, and never while a request for the same form is still
 * on its way, so a slow server still gets its answers shown.
 */
export class PreviewLoop {
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAsk = 0;
  /** The key of the request on its way, if any. */
  private inFlight: string | null = null;
  private readonly latest = createLatest();

  constructor(
    private readonly fetch: (key: string) => Promise<WirePreview>,
    private readonly onState: (s: PreviewState) => void,
  ) {}

  setKey(key: string | null): void {
    if (key === this.key) return;
    this.key = key;
    this.clearTimer();
    // The form changed: an answer still on its way is for an older version of it.
    this.latest.cancel();
    this.inFlight = null;
    if (key === null) {
      this.onState(NO_PREVIEW);
      return;
    }
    this.timer = setTimeout(() => void this.ask(), EDIT_DEBOUNCE_MS);
  }

  bookChanged(): void {
    if (this.key === null || this.timer !== null || this.inFlight === this.key) return;
    const wait = Math.max(0, this.lastAsk + BOOK_REFRESH_MS - Date.now());
    this.timer = setTimeout(() => void this.ask(), wait);
  }

  /**
   * Ask again now for the same form (the coin's feed state changed, so the answer on screen or on
   * its way may no longer hold). An answer still on its way is dropped.
   */
  refresh(): void {
    if (this.key === null) return;
    this.clearTimer();
    this.latest.cancel();
    this.inFlight = null;
    this.timer = setTimeout(() => void this.ask(), 0);
  }

  dispose(): void {
    this.clearTimer();
    this.latest.cancel();
    this.key = null;
    this.inFlight = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async ask(): Promise<void> {
    this.timer = null;
    const key = this.key;
    if (key === null) return;
    this.lastAsk = Date.now();
    this.inFlight = key;
    const outcome = await this.latest.run(this.fetch(key));
    if (outcome === null) return; // cancelled by a form change (which also cleared inFlight)
    this.inFlight = null;
    if (outcome.ok) this.onState({ key, preview: outcome.value, error: null });
    else {
      const e = outcome.error;
      this.onState({ key, preview: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
