import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatchUpIndicatorView } from '../src/components/CatchUpIndicator.tsx';
import { FeedStatusList, feedLabel } from '../src/components/FeedIndicator.tsx';
import { TestBannerView } from '../src/components/TestBanner.tsx';
import type { MarketHealth } from '../src/lib/api.ts';
import { catchingUpFeeds, feedStatus, feedSummary, initialLiveData } from '../src/lib/live.ts';
import type { LiveData } from '../src/lib/live.ts';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const fresh = { fresh: true, reason: null, catchingUp: false };

/** Every feed of both coins fresh and live, then the changes given. */
function state(patch: { markets?: MarketHealth; catchingUp?: string[]; health?: LiveData['health'] } = {}) {
  return {
    ...initialLiveData(),
    health: { BTCUSDT: { fresh: true, reason: null }, ETHUSDT: { fresh: true, reason: null }, ...patch.health },
    markets: {
      'spot:BTCUSDT': fresh,
      'spot:ETHUSDT': fresh,
      'perp:BTCUSDT': fresh,
      'perp:ETHUSDT': fresh,
      ...patch.markets,
    },
    catchingUp: patch.catchingUp ?? [],
  };
}

describe('feed status per coin and market', () => {
  it('live when the feed is fresh and nothing is catching up', () => {
    expect(feedStatus(state(), 'spot', 'BTCUSDT')).toEqual({ state: 'live', reason: null });
    expect(feedStatus(state(), 'perp', 'BTCUSDT')).toEqual({ state: 'live', reason: null });
  });

  it('a perp key catching up is read from the catching-up list, not the spot health', () => {
    const s = state({ catchingUp: ['perp:BTCUSDT'] });
    expect(feedStatus(s, 'perp', 'BTCUSDT').state).toBe('catching_up');
    // The same coin's spot market is live: catching up is per market.
    expect(feedStatus(s, 'spot', 'BTCUSDT').state).toBe('live');
    expect(feedStatus(s, 'perp', 'ETHUSDT').state).toBe('live');
  });

  it('a key catching up is also read from the per-market health map', () => {
    const s = state({ markets: { 'perp:ETHUSDT': { ...fresh, catchingUp: true } } });
    expect(feedStatus(s, 'perp', 'ETHUSDT').state).toBe('catching_up');
    const spot = state({ markets: { 'spot:ETHUSDT': { ...fresh, catchingUp: true } } });
    expect(feedStatus(spot, 'spot', 'ETHUSDT').state).toBe('catching_up');
  });

  it('a stale feed is interrupted, with its reason, even while a catch-up is pending', () => {
    const s = state({
      markets: { 'perp:BTCUSDT': { fresh: false, reason: 'Mark price stale', catchingUp: true } },
      catchingUp: ['perp:BTCUSDT'],
    });
    expect(feedStatus(s, 'perp', 'BTCUSDT')).toEqual({ state: 'interrupted', reason: 'Mark price stale' });
  });

  it('spot falls back to the per-symbol health before the per-market map arrives', () => {
    const s = { ...initialLiveData(), health: { BTCUSDT: { fresh: false, reason: 'No depth update for 10 s' } } };
    expect(feedStatus(s, 'spot', 'BTCUSDT')).toEqual({ state: 'interrupted', reason: 'No depth update for 10 s' });
    expect(feedStatus(s, 'perp', 'BTCUSDT')).toEqual({ state: 'unknown', reason: null });
  });

  it('sums both markets of every coin', () => {
    const s = state({
      markets: { 'spot:ETHUSDT': { fresh: false, reason: 'x', catchingUp: false } },
      catchingUp: ['perp:BTCUSDT'],
    });
    expect(feedSummary(s, SYMBOLS)).toEqual({ feeds: 4, known: 4, interrupted: 1, catchingUp: 1 });
  });

  it('lists the feeds catching up in coin order, spot before perp', () => {
    const s = state({ catchingUp: ['perp:ETHUSDT', 'perp:BTCUSDT', 'spot:ETHUSDT'] });
    expect(catchingUpFeeds(s, SYMBOLS)).toEqual([
      { symbol: 'BTCUSDT', market: 'perp' },
      { symbol: 'ETHUSDT', market: 'spot' },
      { symbol: 'ETHUSDT', market: 'perp' },
    ]);
  });
});

describe('feed indicator', () => {
  it('names catching up apart from interrupted in its summary', () => {
    expect(feedLabel('open', { feeds: 20, known: 20, interrupted: 0, catchingUp: 0 })).toEqual({ tone: 'live', long: 'Live', short: 'Live' });
    expect(feedLabel('open', { feeds: 20, known: 20, interrupted: 0, catchingUp: 2 })).toEqual({
      tone: 'catching_up',
      long: '2 catching up',
      short: 'Catching up',
    });
    expect(feedLabel('open', { feeds: 20, known: 20, interrupted: 3, catchingUp: 2 })).toEqual({
      tone: 'interrupted',
      long: '3 of 20 interrupted, 2 catching up',
      short: 'Interrupted',
    });
    expect(feedLabel('down', { feeds: 20, known: 20, interrupted: 0, catchingUp: 0 }).tone).toBe('down');
    expect(feedLabel('open', { feeds: 20, known: 0, interrupted: 0, catchingUp: 0 }).tone).toBe('connecting');
  });

  it('shows each coin with its spot and perp state', () => {
    const s = state({
      markets: { 'spot:ETHUSDT': { fresh: false, reason: 'No trade for 60 s', catchingUp: false } },
      catchingUp: ['perp:BTCUSDT'],
    });
    const html = renderToStaticMarkup(createElement(FeedStatusList, { data: s, symbols: SYMBOLS }));
    const btc = html.slice(html.indexOf('BTC'), html.indexOf('ETH'));
    const eth = html.slice(html.indexOf('ETH'));
    expect(btc).toContain('Spot');
    expect(btc).toContain('Live');
    expect(btc).toContain('Perp');
    expect(btc).toContain('Catching up');
    expect(eth).toContain('Interrupted');
    expect(eth).toContain('No trade for 60 s');
  });
});

describe('feed indicator while our connection is down', () => {
  it('shows each state as last known, dimmed, never as a green Live', () => {
    const s = state({ catchingUp: ['perp:BTCUSDT'] });
    const html = renderToStaticMarkup(createElement(FeedStatusList, { data: s, symbols: SYMBOLS, lastKnown: true }));
    expect(html).not.toContain('text-up');
    expect(html).toContain('Live (last known)');
    expect(html).toContain('Catching up (last known)');
    const live = renderToStaticMarkup(createElement(FeedStatusList, { data: s, symbols: SYMBOLS, lastKnown: false }));
    expect(live).toContain('text-up');
    expect(live).not.toContain('last known');
  });
});

describe('catching-up indicator', () => {
  it('shows nothing while no feed is catching up', () => {
    expect(renderToStaticMarkup(createElement(CatchUpIndicatorView, { feeds: [] }))).toBe('');
  });

  it('names each market catching up and says trading on it waits', () => {
    const html = renderToStaticMarkup(
      createElement(CatchUpIndicatorView, {
        feeds: [
          { symbol: 'BTCUSDT', market: 'perp' },
          { symbol: 'ETHUSDT', market: 'spot' },
        ],
      }),
    );
    expect(html).toContain('Catching up');
    expect(html).toContain('BTC perp');
    expect(html).toContain('ETH spot');
    expect(html).toContain('trading on them resumes when it is done');
  });
});

describe('test-data banner', () => {
  it('shows for a database recorded before catch-up existed', () => {
    const html = renderToStaticMarkup(createElement(TestBannerView, { testData: true }));
    expect(html).toContain('TEST DATA — recorded before catch-up existed. Run npm run db:wipe to start real practice.');
  });

  it('shows nothing for a new database, or before the server has said', () => {
    expect(renderToStaticMarkup(createElement(TestBannerView, { testData: false }))).toBe('');
    expect(renderToStaticMarkup(createElement(TestBannerView, { testData: null }))).toBe('');
  });
});
