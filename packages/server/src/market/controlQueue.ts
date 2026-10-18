import type { SetTimer } from './ws.ts';

/**
 * Binance drops a connection that receives more than 5 messages per second (pings, pongs and
 * JSON control messages all count). We send at most 3 per closed 1000 ms window, leaving room
 * for the pongs `ws` sends automatically.
 */
export const CONTROL_MAX_PER_WINDOW = 3;
export const CONTROL_WINDOW_MS = 1000;
/** Pending changes are collected for this long before a flush (and flushes are at least this far apart). */
export const CONTROL_FLUSH_MS = 250;

export type ControlMethod = 'SUBSCRIBE' | 'UNSUBSCRIBE';

export interface ControlQueueDeps {
  /** Sends one control message; ids and JSON are the caller's business. */
  send: (method: ControlMethod, params: string[]) => void;
  now: () => number;
  setTimer: SetTimer;
}

/**
 * Outbound SUBSCRIBE / UNSUBSCRIBE queue for ONE socket connection. A subscribe and an unsubscribe
 * of the same stream that are both still pending cancel out; all pending subscribes go out as one
 * SUBSCRIBE and all pending unsubscribes as one UNSUBSCRIBE.
 */
export class ControlQueue {
  /** Stream -> the change still to send; insertion order is kept. */
  private readonly pending = new Map<string, ControlMethod>();
  /** Send times inside the current rate window, oldest first. */
  private sentAt: number[] = [];
  private cancelTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly d: ControlQueueDeps) {}

  subscribe(streams: Iterable<string>): void {
    for (const s of streams) this.change(s, 'SUBSCRIBE');
  }

  unsubscribe(streams: Iterable<string>): void {
    for (const s of streams) this.change(s, 'UNSUBSCRIBE');
  }

  /** Drops everything pending; the connection is gone or going. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private change(stream: string, method: ControlMethod): void {
    if (this.closed) return;
    const queued = this.pending.get(stream);
    if (queued === method) return;
    if (queued) this.pending.delete(stream); // the opposite change is still queued: they cancel out
    else this.pending.set(stream, method);
    this.schedule();
  }

  private schedule(): void {
    if (this.cancelTimer || this.closed || this.pending.size === 0) return;
    const now = this.d.now();
    // The next send may happen once the oldest send counted against the limit has left the window.
    const free =
      this.sentAt.length < CONTROL_MAX_PER_WINDOW
        ? now
        : this.sentAt[this.sentAt.length - CONTROL_MAX_PER_WINDOW]! + CONTROL_WINDOW_MS + 1;
    this.cancelTimer = this.d.setTimer(() => this.flush(), Math.max(CONTROL_FLUSH_MS, free - now));
  }

  private flush(): void {
    this.cancelTimer = null;
    if (this.closed) return;
    const now = this.d.now();
    this.sentAt = this.sentAt.filter((t) => t >= now - CONTROL_WINDOW_MS);
    for (const method of ['SUBSCRIBE', 'UNSUBSCRIBE'] as const) {
      if (this.sentAt.length >= CONTROL_MAX_PER_WINDOW) break;
      const params = [...this.pending].filter(([, m]) => m === method).map(([s]) => s);
      if (params.length === 0) continue;
      for (const s of params) this.pending.delete(s);
      this.sentAt.push(now);
      this.d.send(method, params);
    }
    this.schedule();
  }
}
