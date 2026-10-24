import type { Db } from './db/db.ts';
import { loadOpenGaps, openGap } from './db/store.ts';
import type { FeedGap } from './db/store.ts';
import { marketKey, splitKey } from './market/marketKey.ts';
import type { MarketKey } from './market/marketKey.ts';

export const OFFLINE_REASON = 'Server offline';

/** A gap in the live data that has not been recorded as a feed_gap yet. */
interface Gap {
  at: number;
  reason: string;
  /** Closed only by a health poll that finds the data fresh, never by a trade. */
  pollOnly: boolean;
  /** The trade cursor when the gap opened. */
  lastTradeIdBefore: number | null;
}

export interface FeedGapsDeps {
  db: Db;
  seasonId: number;
  now: () => number;
  /** When the last frame of the key's live data connection was received. */
  lastFrameAt(key: MarketKey): number;
  /** The engine's trade cursor for the key: the id of the last trade it processed, null before any. */
  cursorOf(key: MarketKey): number | null;
}

/**
 * The open gaps in live data and the last fresh moments, per market and symbol, so the spot and
 * perp data of one symbol never share a gap. Each gap is saved in open_gaps as it opens, with the
 * trade cursor of that moment, so a crash keeps both. Database errors are thrown to the caller.
 */
export class FeedGaps {
  private readonly d: FeedGapsDeps;
  private readonly open = new Map<MarketKey, Gap>();
  /**
   * The last fresh moment: when a health poll or a processed trade last found the key's data
   * fresh, or the receive time of the last frame by then if earlier. A silence the feed still
   * tolerated is not counted as fresh once it turns out longer.
   */
  private readonly lastFreshAt = new Map<MarketKey, number>();

  constructor(deps: FeedGapsDeps) {
    this.d = deps;
  }

  /**
   * Startup: each key's gap is open from the earlier of its saved open gap (left by a crash) and
   * the last heartbeat (the server may have been down since then). A saved gap keeps its reason
   * and trade cursor; otherwise the reason is Server offline and the cursor the one just loaded.
   * The seeds are saved in one transaction, so a crash before the data is fresh again still keeps
   * the earliest start. Keys of other markets in open_gaps are left as they are. A key's `floors`
   * entry is the latest its gap may start.
   */
  seed(keys: MarketKey[], lastAlive: number | null, floors: Map<MarketKey, number> = new Map()): void {
    const now = this.d.now();
    const saved = new Map(loadOpenGaps(this.d.db, this.d.seasonId).map((g) => [marketKey(g.market, g.symbol), g]));
    for (const key of keys) {
      const row = saved.get(key);
      const floor = floors.get(key);
      if (row === undefined && lastAlive === null && floor === undefined) continue;
      const at = Math.min(row?.startedAt ?? Infinity, lastAlive ?? Infinity, floor ?? Infinity, now);
      this.open.set(key, {
        at,
        reason: row?.reason ?? OFFLINE_REASON,
        pollOnly: false,
        lastTradeIdBefore: row ? row.lastTradeIdBefore : this.d.cursorOf(key),
      });
    }
    if (this.open.size === 0) return;
    this.d.db.transaction(() => {
      for (const [key, g] of this.open) this.save(key, g);
    })();
  }

  has(key: MarketKey): boolean {
    return this.open.has(key);
  }

  /** Whether any key has a gap open. */
  any(): boolean {
    return this.open.size > 0;
  }

  /** Whether the key's open gap closes only at a health poll (it began with a pause). */
  isPollOnly(key: MarketKey): boolean {
    return this.open.get(key)?.pollOnly === true;
  }

  /** After a pause: the key's open gap, if any, now closes only at a health poll. Returns whether one was open. */
  markPollOnly(key: MarketKey): boolean {
    const gap = this.open.get(key);
    if (gap) gap.pollOnly = true;
    return gap !== undefined;
  }

  markFresh(key: MarketKey, now: number): void {
    this.lastFreshAt.set(key, Math.min(now, this.d.lastFrameAt(key)));
  }

  /**
   * Opens the key's gap, saved at once with the current trade cursor: from the last fresh moment,
   * or `pausedSince` (the poll before a pause) if that is earlier, or the last frame received if
   * that is earlier still (after a silent stretch nothing after that frame is known), or
   * `notAfter` if that is earlier still (the end of what the account has seen applied), and never
   * after now (the wall clock can step back). A gap opened by a pause closes only at a poll. An
   * open gap is kept. A key not fresh since startup has none to open: the time before is its
   * startup gap. Returns whether it opened.
   */
  start(key: MarketKey, reason: string, pausedSince: number | null = null, notAfter: number | null = null): boolean {
    const lastFresh = this.lastFreshAt.get(key);
    if (this.open.has(key) || lastFresh === undefined) return false;
    const at = Math.min(pausedSince ?? Infinity, notAfter ?? Infinity, lastFresh, this.d.lastFrameAt(key), this.d.now());
    const gap = { at, reason, pollOnly: pausedSince !== null, lastTradeIdBefore: this.d.cursorOf(key) };
    this.save(key, gap);
    this.open.set(key, gap);
    return true;
  }

  /** The key's open gap as a feed_gap ending at `now` (none if no gap is open); the caller persists it. */
  take(key: MarketKey, now: number): FeedGap[] {
    const gap = this.open.get(key);
    if (!gap) return [];
    this.open.delete(key);
    const { market, symbol } = splitKey(key);
    return [{ market, symbol, startedAt: gap.at, endedAt: now, reason: gap.reason, lastTradeIdBefore: gap.lastTradeIdBefore }];
  }

  /** Every open gap as a feed_gap ending at `now`. */
  takeAll(now: number): FeedGap[] {
    return [...this.open.keys()].flatMap((key) => this.take(key, now));
  }

  private save(key: MarketKey, g: Gap): void {
    const { market, symbol } = splitKey(key);
    openGap(this.d.db, this.d.seasonId, { market, symbol, startedAt: g.at, reason: g.reason, lastTradeIdBefore: g.lastTradeIdBefore });
  }
}
