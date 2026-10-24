import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { D, Decimal, PerpEngine, assumedPrice, emptyLedger, emptyPerpState, orderCost } from '@sim/engine';
import type { Bracket, PerpCtx, PerpMarketView, PerpOrderRequest, PerpRules } from '@sim/engine';
import { PerpEstimate } from '../src/components/PerpOrderForm.tsx';
import type { PerpMark, WireLevel, WirePerpOrder, WirePerpPreview, WirePosition } from '../src/lib/api.ts';
import {
  buildPerpRequest,
  leverageLock,
  maxPositionAt,
  perpMissingInput,
  perpLiveState,
  perpPreviewMatches,
  reduceExcess,
  reduceOnlyState,
  tiersText,
} from '../src/lib/perpForm.ts';
import type { PerpFormFields } from '../src/lib/perpForm.ts';
import { floorDivToStep } from '../src/lib/market.ts';
import { perpQuickAmount } from '../src/lib/quickAmount.ts';
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

const lv = (price: string, qty: string): WireLevel => ({ price, qty });

/** A deep one-level book: any quick quantity fills at the best price. */
const BOOK = { bids: [lv('79990', '100')], asks: [lv('80010', '100')] };

const quick = (over: Partial<PerpQuickInput> = {}): PerpQuickInput => ({
  unit: 'usd',
  pct: 100,
  free: '600',
  leverage: 20,
  taker: '0.0005',
  side: 'buy',
  type: 'limit',
  price: '80000',
  ...BOOK,
  mark: '80000',
  last: '80000',
  step: '0.001',
  reduce: null,
  ...over,
});

/**
 * The engine's own cost of opening `qty` (orderCost at the engine's assumedPrice), for an order
 * filling at `fill` (a market order's walk average, a limit's price).
 */
function engineCost(i: PerpQuickInput, qty: string, fill: string): string {
  const mark = D(i.mark!);
  const imPrice =
    i.type === 'market'
      ? assumedPrice({ type: 'market', side: i.side, walkAvg: D(fill), mark, last: D(i.last!) })
      : assumedPrice({ type: 'limit', side: i.side, price: D(fill), mark, last: D(i.last!) });
  return orderCost({
    side: i.side,
    qty: D(qty),
    imPrice,
    olPrice: D(fill),
    mark,
    leverage: i.leverage,
    takerRate: D(i.taker),
  }).total.toString();
}

const atMost = (a: string, b: string) => D(a).lte(D(b));
const plusStep = (q: string, step: string) => D(q).plus(step).toString();

const position = (side: 'long' | 'short', qty = '0.5') => ({ symbol: 'BTCUSDT', side, qty }) as WirePosition;
const order = (over: Partial<WirePerpOrder>) =>
  ({ symbol: 'BTCUSDT', side: 'buy', reduceOnly: false, status: 'open', ...over }) as WirePerpOrder;

describe('perp quick amounts: the share of free leverage USDT the engine would lock', () => {
  it("the brief's 600 at 20x case holds for a limit buy at or below the mark (its own price, no open loss)", () => {
    // 600 × 20 ÷ 1.01 = 11881.188118811..., less the 3e-8 kept back for the engine's three 8 dp round-ups.
    expect(perpQuickAmount(quick())).toEqual({ amount: '11881.18', belowStep: false, belowCent: false });
    // 0.14851... floored to the 0.001 step.
    expect(perpQuickAmount(quick({ unit: 'coin' }))).toEqual({ amount: '0.148', belowStep: false, belowCent: false });
    expect(perpQuickAmount(quick({ pct: 25 }))?.amount).toBe('2970.29');
  });

  const cases: [string, Partial<PerpQuickInput>, string, string][] = [
    // Reserved at last × 1.0015 = 80120 (above the ask), plus 20 of open loss a coin against the mark.
    ['market buy', { type: 'market', side: 'buy', mark: '79990' }, '80010', '0.147'],
    // Reserved at 80120 as well (above the mark and the bid), plus 10 of open loss a coin.
    ['market sell', { type: 'market', side: 'sell' }, '79990', '0.147'],
    // Reserved at its own price, below the mark: no buffer and no open loss.
    ['limit buy', { type: 'limit', side: 'buy', price: '79000' }, '79000', '0.15'],
    // A limit sell above the buffered last: reserved at its price.
    ['limit sell', { type: 'limit', side: 'sell', price: '80500' }, '80500', '0.147'],
  ];
  for (const [name, over, fill, qty] of cases) {
    it(`${name}: 100 % costs the engine at most the free USDT, one step more costs more`, () => {
      const i = quick({ unit: 'coin', ...over });
      const q = perpQuickAmount(i)!.amount;
      expect(q).toBe(qty);
      expect(atMost(engineCost(i, q, fill), i.free)).toBe(true);
      expect(atMost(engineCost(i, plusStep(q, i.step), fill), i.free)).toBe(false);
    });
  }

  it('every share fits, at every leverage', () => {
    for (const leverage of [1, 5, 20, 75, 125]) {
      for (const pct of [25, 50, 75, 100] as const) {
        const i = quick({ unit: 'coin', type: 'market', pct, leverage, free: '1234.56789', mark: '79990' });
        const q = perpQuickAmount(i)!.amount;
        const share = D(i.free).mul(pct).div(100).toString();
        expect(atMost(engineCost(i, q, '80010'), share)).toBe(true);
        expect(atMost(engineCost(i, plusStep(q, i.step), '80010'), share)).toBe(false);
      }
    }
  });

  it('a market order that walks the book is priced at the deepest level it reaches, so it still fits', () => {
    const asks = [lv('80010', '0.05'), lv('80050', '0.05'), lv('80300', '10')];
    const i = quick({ unit: 'coin', type: 'market', asks, mark: '79990' });
    const q = perpQuickAmount(i)!.amount;
    // The engine's walk average for q over those levels.
    let left = D(q);
    let quote = D(0);
    for (const l of asks) {
      const take = Decimal.min(left, D(l.qty));
      quote = quote.plus(take.mul(l.price));
      left = left.minus(take);
    }
    const avg = quote.div(q).toString();
    expect(atMost(engineCost(i, q, avg), i.free)).toBe(true);
  });

  it('in USDT the server turns the amount into the same coins as the coin amount', () => {
    for (const over of cases.map((c) => c[1])) {
      const coin = perpQuickAmount(quick({ unit: 'coin', ...over }))!.amount;
      const i = quick({ unit: 'usd', ...over });
      const usd = perpQuickAmount(i)!.amount;
      // The server converts dollars at the mark (market) or the limit price (limit), floored to the step.
      const at = i.type === 'market' ? i.mark! : i.price;
      expect(floorDivToStep(usd, at, i.step)).toBe(coin);
    }
  });

  it('without a live mark, a last price or a price there is nothing to size an opening order with', () => {
    expect(perpQuickAmount(quick({ mark: null }))).toBeNull();
    expect(perpQuickAmount(quick({ last: null }))).toBeNull();
    expect(perpQuickAmount(quick({ type: 'market', asks: [] }))).toBeNull();
    expect(perpQuickAmount(quick({ type: 'limit', price: '', asks: [] }))).toBeNull();
  });

  it('nothing free reads as below a step / a cent', () => {
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

  it('reduce-only in USDT values the share at the limit price, else the mark; 100 % sends the coins', () => {
    const reduce = { qty: '0.5' };
    expect(perpQuickAmount(quick({ pct: 50, reduce, price: '80000.15' }))).toEqual({
      amount: '20000.04',
      belowStep: false,
      belowCent: false,
    });
    expect(perpQuickAmount(quick({ pct: 100, reduce, type: 'market' }))).toEqual({
      amount: '40000.00',
      belowStep: false,
      belowCent: false,
      sellAll: '0.5',
    });
  });
});

const PERP_RULES: PerpRules = {
  symbol: 'BTCUSDT',
  base: 'BTC',
  quote: 'USDT',
  status: 'TRADING',
  tickSize: D('0.1'),
  minPrice: D('556.8'),
  maxPrice: D('4529764'),
  stepSize: D('0.001'),
  minQty: D('0.001'),
  maxQty: D('1000'),
  marketStepSize: D('0.001'),
  marketMinQty: D('0.001'),
  marketMaxQty: D('120'),
  minNotional: D('50'),
  maxNumOrders: 200,
  multiplierUp: D('1.05'),
  multiplierDown: D('0.95'),
  liquidationFee: D('0.0125'),
  marketTakeBound: D('0.05'),
};
const TIERS: Bracket[] = [{ floor: D(0), cap: D('1000000000'), mmr: D('0.004'), cum: D(0), maxLeverage: 150 }];

/**
 * The engine itself on the quick amount's book, mark, last price and free USDT: its preview, then
 * submit and arrival. 'accepted' when the order was placed and arrived without a rejection.
 */
function throughEngine(i: PerpQuickInput, qty: string): { preview: string | null; outcome: string } {
  const level = (l: WireLevel) => ({ price: D(l.price), qty: D(l.qty) });
  const book = { bids: i.bids.map(level), asks: i.asks.map(level) };
  const view: PerpMarketView = {
    isFresh: () => true,
    isMarkFresh: () => true,
    book: () => book,
    best: (_symbol, side) => (side === 'buy' ? book.asks : book.bids)[0]?.price ?? null,
    lastPrice: () => D(i.last!),
    markPrice: () => D(i.mark!),
    rules: () => PERP_RULES,
    brackets: () => TIERS,
  };
  const ledger = emptyLedger(['USDT', 'BTC']);
  ledger.balances.leverage.USDT = { free: D(i.free), locked: D(0) };
  const engine = new PerpEngine(emptyPerpState(ledger));
  engine.state.settings.BTCUSDT = { leverage: i.leverage, marginMode: 'isolated' };
  let n = 0;
  const ctx: PerpCtx = {
    now: 1_000_000,
    rng: () => 0,
    newId: (prefix) => `${prefix}${++n}`,
    market: view,
    fees: { maker: D('0.0002'), taker: D(i.taker) },
  };
  const req: PerpOrderRequest = { symbol: 'BTCUSDT', side: i.side, type: i.type, qty };
  if (i.type !== 'market') req.price = i.price;
  const preview = engine.preview(req, ctx).rejectReason;
  const submitted = engine.submit(req, ctx);
  const placed = submitted.find((e) => e.type === 'order_placed');
  if (placed?.type !== 'order_placed') {
    const rejected = submitted.find((e) => e.type === 'order_rejected');
    return { preview, outcome: `rejected at submit: ${rejected?.type === 'order_rejected' ? rejected.reason : '?'}` };
  }
  ctx.now = Math.max(ctx.now, placed.order.arrivesAt!);
  const arrived = engine.arrive(placed.order.id, ctx);
  const rejected = arrived.find((e) => e.type === 'order_rejected');
  if (rejected?.type === 'order_rejected') return { preview, outcome: `rejected at arrival: ${rejected.reason}` };
  return { preview, outcome: 'accepted' };
}

describe('perp quick amounts through the engine: placed and accepted at arrival on the same book', () => {
  const deep = (price: string) => [lv(price, '100')];
  const cases: [string, Partial<PerpQuickInput>][] = [
    // A click on the best ask prefills the price: all of it fills at once, charged at market terms.
    ['limit buy at the ask', { type: 'limit', side: 'buy', price: '80010', asks: deep('80010') }],
    // Bids above the buffered last price: the part that fills at once is reserved at the bid, above the lock's 80120.
    [
      'limit sell through a high bid',
      { type: 'limit', side: 'sell', price: '80100', bids: deep('80200'), free: '6000' },
    ],
    ['resting limit buy', { type: 'limit', side: 'buy', price: '79000' }],
    ['market buy', { type: 'market', side: 'buy', mark: '79990', asks: deep('80010') }],
    ['market sell', { type: 'market', side: 'sell', bids: deep('79990') }],
  ];
  for (const [name, over] of cases) {
    it(`${name}: 100 % is accepted and previews no problem; one step more is refused and previews it`, () => {
      const i = quick({ unit: 'coin', ...over });
      const q = perpQuickAmount(i)!.amount;
      expect(throughEngine(i, q)).toEqual({ preview: null, outcome: 'accepted' });
      const more = throughEngine(i, plusStep(q, i.step));
      expect(more.outcome).toMatch(/^rejected/);
      expect(more.preview).not.toBeNull();
    });
  }

  it('a limit buy through the ask that partly rests is accepted at arrival', () => {
    const i = quick({
      unit: 'coin',
      type: 'limit',
      side: 'buy',
      price: '80100',
      asks: [lv('80010', '0.05'), lv('80300', '5')],
    });
    const q = perpQuickAmount(i)!.amount;
    expect(throughEngine(i, q)).toEqual({ preview: null, outcome: 'accepted' });
  });

  it('a market order is never sized past the visible depth (beyond it the cost is not known)', () => {
    const i = quick({ unit: 'coin', type: 'market', side: 'buy', asks: [lv('80010', '0.05'), lv('80020', '0.03')] });
    expect(perpQuickAmount(i)!.amount).toBe('0.08');
    expect(perpQuickAmount({ ...i, unit: 'usd' })!.amount).toBe('6400.00');
  });

  it('a reduce-only amount in USDT converts back to the same coins', () => {
    const i = quick({ pct: 50, reduce: { qty: '0.5' }, price: '80000.15' });
    expect(floorDivToStep(perpQuickAmount(i)!.amount, '80000.15', i.step)).toBe('0.25');
    const m = quick({ pct: 75, reduce: { qty: '0.37' }, type: 'market', mark: '80123.4' });
    const coins = perpQuickAmount({ ...m, unit: 'coin' })!.amount;
    expect(floorDivToStep(perpQuickAmount(m)!.amount, '80123.4', m.step)).toBe(coins);
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

  it('before the tick is known the liquidation price is not shown, not even unrounded', () => {
    const html = render({ tick: undefined });
    expect(html).not.toContain('76,345');
    expect(html).toContain('Not shown: price rules not loaded');
  });

  it('an estimate made at another leverage than the chip shows is dimmed and says which', () => {
    const html = render({ leverage: 25 });
    expect(html).toContain('Estimated at 20x');
    expect(html).toContain('opacity-60');
    expect(render({ leverage: 20 })).not.toContain('opacity-60');
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

describe('perp live state', () => {
  const mark = (fresh: boolean): PerpMark => ({
    markPrice: '80000',
    indexPrice: '80010',
    fundingRate: '0.0001',
    nextFundingTime: 0,
    fresh,
  });
  const live = { fresh: true, reason: null };

  it('all live: no reason, submit allowed, the mark usable', () => {
    expect(perpLiveState({ feed: live, mark: mark(true), down: false })).toEqual({
      staleReason: null,
      blocked: false,
      liveMark: '80000',
    });
  });

  it('a stale feed blocks submit with its reason (or a default)', () => {
    expect(
      perpLiveState({ feed: { fresh: false, reason: 'No trades for 12 s' }, mark: mark(true), down: false }),
    ).toEqual({ staleReason: 'No trades for 12 s', blocked: true, liveMark: '80000' });
    expect(perpLiveState({ feed: { fresh: false, reason: null }, mark: mark(true), down: false }).staleReason).toBe(
      'No fresh data from Binance',
    );
  });

  it('a stale mark blocks submit and is never used', () => {
    expect(perpLiveState({ feed: live, mark: mark(false), down: false })).toEqual({
      staleReason: 'No mark price update for over 10 s',
      blocked: true,
      liveMark: null,
    });
  });

  it('our socket down or no mark yet: the estimate says so, the server still decides on submit', () => {
    expect(perpLiveState({ feed: live, mark: mark(true), down: true })).toEqual({
      staleReason: 'Connection to the simulator lost',
      blocked: false,
      liveMark: null,
    });
    expect(perpLiveState({ feed: undefined, mark: undefined, down: false })).toEqual({
      staleReason: 'No mark price yet',
      blocked: false,
      liveMark: null,
    });
  });

  it('catching up after a feed gap blocks submit and says why; a stale feed still names its own reason', () => {
    expect(perpLiveState({ feed: live, mark: mark(true), down: false, catchingUp: true })).toEqual({
      staleReason: 'Catching up after a feed gap: trading resumes when it is done',
      blocked: true,
      liveMark: '80000',
    });
    expect(
      perpLiveState({ feed: { fresh: false, reason: 'No trades for 12 s' }, mark: mark(true), down: false, catchingUp: true })
        .staleReason,
    ).toBe('No trades for 12 s');
  });
});
