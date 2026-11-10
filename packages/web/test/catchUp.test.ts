import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hhmm, hhmmss, line, utcText } from '../../engine/src/catchup/plan.ts';
import type { CatchUpEvent, CatchUpLine } from '@sim/engine';
import { noticesFor } from '../../server/src/notices.ts';
import { catchUpNoticeText } from '../src/lib/catchUp.ts';

describe("the web's catch-up notice text is the server's, read in the browser's time zone", () => {
  // In UTC the two differ only by the server saying so: every " UTC" it writes.
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const U = (h: number, m: number, sec = 0) => Date.UTC(2026, 9, 24, h, m, sec);
  const lookup = { spotRules: () => null, perpRules: () => null, liquidationPrice: () => null };
  const summary = (market: 'spot' | 'perp', lines: CatchUpLine[]): CatchUpEvent => ({
    type: 'catch_up',
    market,
    symbol: 'BTCUSDT',
    time: U(12, 10),
    from: U(12, 0, 5),
    to: U(12, 10, 1),
    actions: lines.map(utcText),
    lines,
  });

  for (const [name, event] of [
    [
      'a perp summary with minutes and moments',
      summary('perp', [
        line`Stop-loss filled 0.1 BTC at 77,800 (worst price of ${hhmm(U(12, 2))}; estimated)`,
        line`Cancel of limit buy took effect at ${hhmmss(U(12, 4, 50))} (estimated)`,
      ]),
    ],
    ['a spot summary with nothing to apply', summary('spot', [])],
  ] as const) {
    it(name, () => {
      const [notice] = noticesFor([event], lookup);
      expect(notice!.catchUp).toBeDefined();
      expect(catchUpNoticeText(notice!.catchUp!)).toBe(notice!.text.replaceAll(' UTC', ''));
    });
  }
});
