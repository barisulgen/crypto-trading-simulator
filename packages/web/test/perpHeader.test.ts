import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PerpHeaderView } from '../src/components/PerpHeader.tsx';
import type { PerpMark } from '../src/lib/api.ts';

const NOW = 1_792_713_600_000;
const mark = (nextFundingTime: number): PerpMark => ({
  markPrice: '80000',
  indexPrice: '80010',
  fundingRate: '0.0001',
  nextFundingTime,
  fresh: true,
});

/** The "Next funding" value the header renders. */
function nextFunding(m: PerpMark | undefined): string {
  const html = renderToStaticMarkup(createElement(PerpHeaderView, { symbol: 'BTCUSDT', mark: m, down: false, now: NOW }));
  const found = /Next funding<\/dt><dd[^>]*>([^<]*)<\/dd>/.exec(html);
  if (!found) throw new Error(`no Next funding in ${html}`);
  return found[1]!;
}

describe('PerpHeader next funding', () => {
  it('counts down to a funding time ahead', () => {
    expect(nextFunding(mark(NOW + 3 * 3_600_000 + 12 * 60_000 + 45_000))).toBe('03:12:45');
  });

  it('shows a dash when the funding time is 0, already past, or there is no mark', () => {
    expect(nextFunding(mark(0))).toBe('-');
    expect(nextFunding(mark(NOW - 1000))).toBe('-');
    expect(nextFunding(mark(NOW))).toBe('-');
    expect(nextFunding(undefined)).toBe('-');
  });
});
