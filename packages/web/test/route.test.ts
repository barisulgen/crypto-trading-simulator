import { afterEach, describe, expect, it, vi } from 'vitest';
import { href, parseHash, replaceSelection, selectionHref } from '../src/lib/route.ts';

const sol = { symbol: 'SOLUSDT', market: 'perp' } as const;

describe('trade selection in the address', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('points the trade route at the selected market and coin', () => {
    expect(selectionHref('#/?m=spot&s=BTCUSDT', sol)).toBe('#/?m=perp&s=SOLUSDT');
    expect(selectionHref('', sol)).toBe('#/?m=perp&s=SOLUSDT');
    expect(selectionHref('#/', sol)).toBe('#/?m=perp&s=SOLUSDT');
  });

  it('leaves an address that already shows the selection alone', () => {
    expect(selectionHref('#/?m=perp&s=SOLUSDT', sol)).toBeNull();
  });

  it('never writes over an address that has left the trade route', () => {
    // The trade screen re-renders once with the new address before the app swaps it out.
    expect(selectionHref('#/history?symbol=SOLUSDT', sol)).toBeNull();
    expect(selectionHref('#/history', sol)).toBeNull();
  });

  it('replaces the trade address in place, and not once the address is on History', () => {
    const replaceState = vi.fn((_state: unknown, _unused: string, url: string) => {
      loc.hash = url;
    });
    const loc = { hash: '#/?m=spot&s=BTCUSDT' };
    vi.stubGlobal('location', loc);
    vi.stubGlobal('history', { state: null, replaceState });

    replaceSelection(sol);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(loc.hash).toBe('#/?m=perp&s=SOLUSDT');

    loc.hash = '#/history?symbol=SOLUSDT';
    replaceSelection(sol);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(loc.hash).toBe('#/history?symbol=SOLUSDT');
  });
});

describe('routes', () => {
  it('parses the stats route with its query, and builds its href', () => {
    const r = parseHash('#/stats?symbol=BTCUSDT&from=2026-11-01');
    expect(r.path).toBe('/stats');
    expect(r.params.get('symbol')).toBe('BTCUSDT');
    expect(parseHash('#/stats').path).toBe('/stats');
    expect(href('/stats', { market: 'spot' })).toBe('#/stats?market=spot');
  });

  it('still sends an unknown path to Trade', () => {
    expect(parseHash('#/nowhere').path).toBe('/');
    expect(parseHash('#/history').path).toBe('/history');
  });
});
