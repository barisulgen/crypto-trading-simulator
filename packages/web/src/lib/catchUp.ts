// Catch-up summaries in the browser's own time zone: the server sends their times as data.
import type { CatchUpLine } from '@sim/engine';
import type { CatchUpNoticeDetail } from './api.ts';
import { fmtClock, fmtHhmm } from './market.ts';

/** A summary line with each time it names in local time: a minute as HH:MM, a moment as HH:MM:SS. */
export function catchUpLineText(line: CatchUpLine): string {
  return line.map((p) => (typeof p === 'string' ? p : p.seconds ? fmtClock(p.at) : fmtHhmm(p.at))).join('');
}

/**
 * The catch-up notice in local time: `Caught up BTCUSDT perp after the data gap 17:30–17:40:
 * <line>; <line>`, or `...: nothing to apply`. The same words as the server's text, which gives its
 * times in UTC and says so.
 */
export function catchUpNoticeText(c: CatchUpNoticeDetail): string {
  const name = c.market === 'spot' ? c.symbol : `${c.symbol} perp`;
  const head = `Caught up ${name} after the data gap ${fmtHhmm(c.from)}–${fmtHhmm(c.to)}`;
  return c.lines.length > 0 ? `${head}: ${c.lines.map(catchUpLineText).join('; ')}` : `${head}: nothing to apply`;
}
