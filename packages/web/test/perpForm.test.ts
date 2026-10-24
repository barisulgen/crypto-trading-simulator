import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PerpEstimate } from '../src/components/PerpOrderForm.tsx';
import type { WirePerpOrder, WirePerpPreview, WirePosition } from '../src/lib/api.ts';
import {
  buildPerpRequest,
  leverageLock,
  maxPositionAt,
  perpMissingInput,
  perpPreviewMatches,
  reduceExcess,
  reduceOnlyState,
  tiersText,
} from '../src/lib/perpForm.ts';
import type { PerpFormFields } from '../src/lib/perpForm.ts';
import { marginShareNotional, perpQuickAmount, perpSizingPrice } from '../src/lib/quickAmount.ts';
import type { PerpQuickInput } from '../src/lib/quickAmount.ts';

const form = (over: Partial<PerpFormFields> = {}): PerpFormFields => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  amountIn: 'coin',
  amount: '0.01',
  price: '80000',
  reduceOnly: false,
  attach: false,
  stopLoss: '',
  takeProfit: '',
  ...over,
});

const quick = (over: Partial<PerpQuickInput> = {}): PerpQuickInput => ({
  unit: 'usd',
  pct: 100,
  free: '600',
  leverage: 20,
  taker: '0.0005',
  price: '80000',
  step: '0.001',
  reduce: null,
  ...over,
});

const position = (side: 'long' | 'short', qty = '0.5') => ({ symbol: 'BTCUSDT', side, qty }) as WirePosition;
const order = (over: Partial<WirePerpOrder>) =>
  ({ symbol: 'BTCUSDT', side: 'buy', reduceOnly: false, status: 'open', ...over }) as WirePerpOrder;

describe('perp quick amounts: free leverage USDT used as margin', () => {
  it('100 % of free 600 at 20x with taker 0.0005 is 600 × 20 ÷ 1.01, rounded down to 8 dp', () => {
    expect(marginShareNotional('600', 100, 20, '0.0005')).toBe('11881.18811881');
  });

  it('in USDT the notional is floored to the cent', () => {
    expect(perpQuickAmount(quick())).toEqual({ amount: '11881.18', belowStep: false, belowCent: false });
  });

  it('in coins the notional is then floored to the step at the price', () => {
    // 11881.18811881 / 80000 = 0.14851..., floored to the 0.001 step.
    expect(perpQuickAmount(quick({ unit: 'coin' }))).toEqual({ amount: '0.148', belowStep: false, belowCent: false });
  });

  it('25 % takes a quarter of the free USDT', () => {
    // 150 × 20 ÷ 1.01 = 2970.29702970...
    expect(marginShareNotional('600', 25, 20, '0.0005')).toBe('2970.2970297');
    expect(perpQuickAmount(quick({ pct: 25 }))?.amount).toBe('2970.29');
  });

  it('coins without a price cannot be sized; nothing free reads as below a step / a cent', () => {
    expect(perpQuickAmount(quick({ unit: 'coin', price: null }))).toBeNull();
    expect(perpQuickAmount(quick({ unit: 'coin', free: '0' }))).toEqual({
      amount: '0',
      belowStep: true,
      belowCent: false,
    });
    expect(perpQuickAmount(quick({ free: '0.0005' }))).toEqual({ amount: '0', belowStep: false, belowCent: true });
  });

  it('reduce-only takes shares of the position size instead', () => {
    const reduce = { qty: '0.503' };
    expect(perpQuickAmount(quick({ unit: 'coin', pct: 50, reduce }))).toEqual({
      amount: '0.251',
      belowStep: false,
      belowCent: false,
    });
    expect(perpQuickAmount(quick({ unit: 'coin', pct: 100, reduce }))?.amount).toBe('0.503');
  });

  it('reduce-only in USDT values the share at the price, floored to the cent; 100 % sends the coins', () => {
    const reduce = { qty: '0.5' };
    expect(perpQuickAmount(quick({ pct: 50, reduce, price: '80000.15' }))).toEqual({
      amount: '20000.03',
      belowStep: false,
      belowCent: false,
    });
    expect(perpQuickAmount(quick({ pct: 100, reduce }))).toEqual({
      amount: '40000.00',
      belowStep: false,
      belowCent: false,
      sellAll: '0.5',
    });
  });

  it('sizes at the order price or the best price, never below a known mark', () => {
    const book = { bestBid: '79990', bestAsk: '80010' };
    expect(perpSizingPrice({ type: 'market', side: 'buy', price: '', ...book, mark: '80000' })).toBe('80010');
    expect(perpSizingPrice({ type: 'market', side: 'sell', price: '', ...book, mark: '80000' })).toBe('80000');
    expect(perpSizingPrice({ type: 'limit', side: 'buy', price: '79000,5', ...book, mark: '80000' })).toBe('80000');
    expect(perpSizingPrice({ type: 'limit', side: 'buy', price: '81000', ...book, mark: '80000' })).toBe('81000');
    expect(perpSizingPrice({ type: 'post_only', side: 'sell', price: '', ...book, mark: null })).toBe('79990');
    expect(
      perpSizingPrice({ type: 'market', side: 'buy', price: '', bestBid: undefined, bestAsk: undefined, mark: null }),
    ).toBeNull();
  });
});

describe('perp reduce-only', () => {
  it('is forced on when the side is opposite the open position', () => {
    expect(reduceOnlyState('sell', position('long'), false)).toEqual({
      on: true,
      forced: true,
      label: 'Reduces your long',
    });
    expect(reduceOnlyState('buy', position('short'), false)).toEqual({
      on: true,
      forced: true,
      label: 'Reduces your short',
    });
  });

  it('is the owner choice on the same side as the position, or with no position', () => {
    expect(reduceOnlyState('buy', position('long'), false)).toEqual({ on: false, forced: false, label: 'Reduce-only' });
    expect(reduceOnlyState('buy', position('long'), true)).toEqual({ on: true, forced: false, label: 'Reduce-only' });
    expect(reduceOnlyState('sell', null, false)).toEqual({ on: false, forced: false, label: 'Reduce-only' });
  });

  it('a market order larger than the position says how much will be cancelled', () => {
    const p = { qty: '0.5' };
    expect(reduceExcess(form({ type: 'market', reduceOnly: true, amount: '0,8' }), p, null, '0.001')).toBe('0.3');
    expect(reduceExcess(form({ type: 'market', reduceOnly: true, amount: '0.5' }), p, null, '0.001')).toBeNull();
    // In USDT: converted at the mark as the server does (48000 / 80000 = 0.6).
    const usd = form({ type: 'market', reduceOnly: true, amountIn: 'usd', amount: '48000' });
    expect(reduceExcess(usd, p, '80000', '0.001')).toBe('0.1');
    // Without a mark the conversion is not guessed.
    expect(reduceExcess(usd, p, null, '0.001')).toBeNull();
    // Opening orders and limits (the server rejects an oversized reduce-only limit) get no note.
    expect(reduceExcess(form({ type: 'market', reduceOnly: false, amount: '0.8' }), p, null, '0.001')).toBeNull();
    expect(reduceExcess(form({ type: 'limit', reduceOnly: true, amount: '0.8' }), p, null, '0.001')).toBeNull();
  });
});

describe('perp order request', () => {
  it('carries reduceOnly and the attached stop-loss / take-profit, exactly as typed', () => {
    expect(
      buildPerpRequest(
        form({ type: 'limit', amount: '0,01', price: '79000,5', attach: true, stopLoss: '75000', takeProfit: '90000' }),
      ),
    ).toEqual({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      qty: '0,01',
      price: '79000,5',
      reduceOnly: false,
      attach: { stopLoss: '75000', takeProfit: '90000' },
    });
  });

  it('sends only the legs filled in', () => {
    expect(buildPerpRequest(form({ attach: true, takeProfit: '90000' })).attach).toEqual({ takeProfit: '90000' });
    expect(buildPerpRequest(form({ attach: true, stopLoss: ' 75000 ' })).attach).toEqual({ stopLoss: ' 75000 ' });
  });

  it('a reduce-only order carries reduceOnly true and never an attach', () => {
    const req = buildPerpRequest(
      form({ side: 'sell', reduceOnly: true, attach: true, stopLoss: '1', takeProfit: '2' }),
    );
    expect(req).toEqual({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: '0.01', reduceOnly: true });
  });

  it('dollars go as quoteQty; a 100 % reduce picked in dollars sends the coins', () => {
    expect(buildPerpRequest(form({ amountIn: 'usd', amount: '500' }))).toMatchObject({ quoteQty: '500' });
    const all = buildPerpRequest(form({ amountIn: 'usd', amount: '40000.00', reduceOnly: true, reduceAll: '0.5' }));
    expect(all.qty).toBe('0.5');
    expect(all.quoteQty).toBeUndefined();
  });

  it('market orders send no price', () => {
    expect(buildPerpRequest(form()).price).toBeUndefined();
  });

  it('names what is still missing', () => {
    expect(perpMissingInput(form({ amount: ' ' }))).toBe('Enter an amount');
    expect(perpMissingInput(form({ type: 'post_only', price: '' }))).toBe('Enter a limit price');
    expect(perpMissingInput(form({ attach: true }))).toBe('Enter a stop-loss or a take-profit price');
    expect(perpMissingInput(form({ attach: true, reduceOnly: true }))).toBeNull();
    expect(perpMissingInput(form({ attach: true, stopLoss: '75000' }))).toBeNull();
  });

  it('a preview is shown only for the same symbol, side, type and reduce-only setting', () => {
    const f = form();
    const key = JSON.stringify(buildPerpRequest(f));
    expect(perpPreviewMatches(key, f)).toBe(true);
    expect(perpPreviewMatches(key, form({ side: 'sell' }))).toBe(false);
    expect(perpPreviewMatches(key, form({ symbol: 'ETHUSDT' }))).toBe(false);
    expect(perpPreviewMatches(key, form({ type: 'limit' }))).toBe(false);
    expect(perpPreviewMatches(key, form({ reduceOnly: true }))).toBe(false);
    expect(perpPreviewMatches(null, f)).toBe(false);
  });
});

describe('leverage', () => {
  it('is locked while a position or an opening order is open on the symbol, never guessed', () => {
    expect(leverageLock('BTCUSDT', [], [])).toBeNull();
    expect(leverageLock('BTCUSDT', [position('long')], [])).toBe('Locked while your BTC long is open');
    expect(leverageLock('BTCUSDT', [], [order({})])).toBe('Locked while an order that opens a position is open on BTC');
    // Reduce-only orders (and close-position stops) cannot open anything; other symbols do not count.
    expect(leverageLock('BTCUSDT', [], [order({ reduceOnly: true })])).toBeNull();
    expect(
      leverageLock('BTCUSDT', [{ ...position('long'), symbol: 'ETHUSDT' }], [order({ symbol: 'ETHUSDT' })]),
    ).toBeNull();
    expect(leverageLock('BTCUSDT', null, [])).toBe('Waiting for your positions');
  });

  it('the maximum position at a leverage is the cap of the last tier that allows it', () => {
    const brackets = [
      { floor: '0', cap: '50000', mmr: '0.004', cum: '0', maxLeverage: 125 },
      { floor: '50000', cap: '600000', mmr: '0.005', cum: '50', maxLeverage: 100 },
      { floor: '600000', cap: '3000000', mmr: '0.0065', cum: '950', maxLeverage: 75 },
    ];
    expect(maxPositionAt(brackets, 125)).toBe('50000');
    expect(maxPositionAt(brackets, 100)).toBe('600000');
    expect(maxPositionAt(brackets, 20)).toBe('3000000');
    expect(maxPositionAt(brackets, 126)).toBe('0');
  });
});

describe('margin tiers note', () => {
  const at = new Date(2026, 9, 23, 8, 0).getTime();
  it('names the source and when the tiers were fetched', () => {
    expect(tiersText({ source: 'official', fetchedAt: at })).toBe('Margin tiers: official · fetched 2026-10-23 08:00');
    expect(tiersText({ source: 'unofficial', fetchedAt: at })).toBe(
      'Margin tiers: unofficial · fetched 2026-10-23 08:00',
    );
    expect(tiersText({ source: 'bundled', fetchedAt: at })).toBe(
      'Margin tiers: bundled snapshot from 2026-10-23 08:00',
    );
    expect(tiersText(null)).toBe('Margin tiers: not loaded yet');
  });
});

describe('perp estimate', () => {
  const preview: WirePerpPreview = {
    estAvgPrice: '80012.34',
    estSlippageUsd: '0.12',
    estSlippagePct: '0.0015',
    notional: '800.1234',
    fee: '0.4000617',
    marginRequired: '40.4',
    estLiquidationPrice: '76345.43',
    leverage: 20,
    maxLeverage: 125,
    exhausted: false,
    bandLimited: false,
    rejectReason: null,
    note: null,
  };
  const render = (over: Partial<Parameters<typeof PerpEstimate>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PerpEstimate, {
        symbol: 'BTCUSDT',
        side: 'buy',
        type: 'market',
        reduceOnly: false,
        base: 'BTC',
        priceDp: 3,
        tick: '0.1',
        state: { key: 'k', preview, error: null },
        current: true,
        staleReason: null,
        missing: null,
        excess: null,
        ...over,
      }),
    );

  it('shows size, margin, entry, slippage, fee and the liquidation price rounded towards the mark', () => {
    const html = render();
    expect(html).toContain('$800.12');
    expect(html).toContain('$40.40');
    expect(html).toContain('80,012.340');
    expect(html).toContain('Est. slippage');
    // The fee rounds up to the cent; a long liquidation rounds up (towards the mark).
    expect(html).toContain('$0.41');
    expect(html).toContain('76,345.5');
  });

  it('limits have no slippage line', () => {
    expect(render({ type: 'limit' })).not.toContain('Est. slippage');
  });

  it('never shows a liquidation price while the mark or the feed is stale', () => {
    const html = render({ staleReason: 'No mark price for 12 s' });
    expect(html).not.toContain('76,345');
    expect(html).toContain('No mark price for 12 s');
  });

  it('says a reduce-only excess will be cancelled, and names band and thin-book limits', () => {
    const html = render({
      side: 'sell',
      reduceOnly: true,
      excess: '0.3',
      state: { key: 'k', preview: { ...preview, exhausted: true, bandLimited: true }, error: null },
    });
    expect(html).toContain('0.3 BTC more than your position');
    expect(html).toContain('price band');
  });
});
