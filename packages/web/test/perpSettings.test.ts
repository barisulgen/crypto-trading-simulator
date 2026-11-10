import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { btcBrackets, btcPerpRules } from '../../engine/test/perpFixtures.ts';
import { PerpOrderForm } from '../src/components/PerpOrderForm.tsx';
import type { Meta, PerpMeta, ServerMessage } from '../src/lib/api.ts';
import { initialLiveData, perpSettingOf, reduce, useLive } from '../src/lib/live.ts';

const wire = <T>(v: T) => JSON.parse(JSON.stringify(v));
/** /api/meta as loaded at start: BTCUSDT's perpetual at 20x. */
const meta = {
  coins: ['BTC'],
  symbols: ['BTCUSDT'],
  rules: {},
  perp: {
    BTCUSDT: { rules: wire(btcPerpRules), maxLeverage: 150, brackets: wire(btcBrackets), leverage: 20, marginMode: 'isolated' } as PerpMeta,
  },
  fees: { spot: { maker: '0.001', taker: '0.001' }, perp: { maker: '0.0002', taker: '0.0005' } },
  testData: false,
  season: { id: 1, name: 'Season 1', startedAt: 0 },
} as Meta;
const pushed = (leverage: number): ServerMessage => ({
  type: 'perpSettings',
  settings: { BTCUSDT: { leverage, marginMode: 'isolated' } },
});

/** The leverage chip's label as the perp order form renders it from the store as it is now. */
function chip(): string {
  // Server rendering reads the store's initial state (the object zustand keeps for it): it is given
  // the current state for the render, then restored.
  const initial = useLive.getInitialState() as unknown as Record<string, unknown>;
  const saved = { ...initial };
  Object.assign(initial, useLive.getState());
  let html: string;
  try {
    html = renderToStaticMarkup(createElement(PerpOrderForm));
  } finally {
    for (const k of Object.keys(initial)) delete initial[k];
    Object.assign(initial, saved);
  }
  const found = /aria-label="(Leverage [^"]*)"/.exec(html);
  if (!found) throw new Error('no leverage chip');
  return found[1]!;
}

afterEach(() => useLive.setState({ ...initialLiveData(), meta: null }));

describe('perp settings pushed over the socket', () => {
  it('the store applies them: each symbol reads the pushed setting, ahead of the one /api/meta loaded', () => {
    let s = { ...initialLiveData(), meta };
    expect(perpSettingOf(s, 'BTCUSDT')).toEqual({ leverage: 20, marginMode: 'isolated' });
    s = { ...s, ...reduce(s, pushed(25), 0) };
    expect(s.perpSettings).toEqual({ BTCUSDT: { leverage: 25, marginMode: 'isolated' } });
    expect(perpSettingOf(s, 'BTCUSDT')).toEqual({ leverage: 25, marginMode: 'isolated' });
    // A symbol neither knows: nothing is guessed.
    expect(perpSettingOf(s, 'ETHUSDT')).toBeUndefined();
  });

  it('the leverage chip follows a change made elsewhere, with no reload', () => {
    useLive.setState({ ...initialLiveData(), meta, selected: { symbol: 'BTCUSDT', market: 'perp' } });
    expect(chip()).toBe('Leverage 20x');
    useLive.setState((s) => reduce(s, pushed(25), 0));
    expect(chip()).toBe('Leverage 25x');
  });
});
