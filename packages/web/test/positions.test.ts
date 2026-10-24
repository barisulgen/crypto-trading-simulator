import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiquidationAlertDialog, LiquidationAlertView, holdOnEscape } from '../src/components/LiquidationAlert.tsx';
import { LastPriceHint } from '../src/components/PositionTpSlDialog.tsx';
import { PositionLine } from '../src/components/PositionsTab.tsx';
import { WarningBannerView } from '../src/components/WarningBanner.tsx';
import type { AccountSnapshot, WirePerpOrder, WirePosition } from '../src/lib/api.ts';
import { pricesLoading, pricesPausedLabel } from '../src/lib/holdings.ts';
import { initialLiveData, reduce, useLive } from '../src/lib/live.ts';
import type { LiveData } from '../src/lib/live.ts';
import {
  actionBlocks,
  bannerEntries,
  chartLines,
  closeAmount,
  closePartQty,
  fmtPnl,
  leverageWalletLine,
  liqDistancePct,
  marginSubmitReady,
  pnlPctOfMargin,
  positionFigures,
  positionState,
  positionStops,
  ratioPct,
  riskLevel,
} from '../src/lib/positions.ts';
import type { BannerEntry } from '../src/lib/positions.ts';

/** A long 0.01 BTC at 80000 with 39.6 of margin, marked at 79000 (as the server sends it). */
const wire = (over: Partial<WirePosition> = {}): WirePosition => ({
  id: 'p1',
  symbol: 'BTCUSDT',
  side: 'long',
  qty: '0.01',
  entryPrice: '80000',
  leverage: 20,
  margin: '39.6',
  openedAt: 1000,
  realizedPnl: '0',
  fees: '0.4',
  funding: '-0.0123',
  warnLevel: 0,
  marginMode: 'isolated',
  catchingUp: false,
  markPrice: '79000',
  markFresh: true,
  markAt: 2000,
  unrealizedPnl: '-10',
  marginBalance: '29.6',
  maintenanceMargin: '3.16',
  marginRatio: '0.10675675675675675676',
  liquidationPrice: '76345.40160642570281',
  maxRemovableMargin: '0',
  ...over,
});

describe('position row maths, from a wire position', () => {
  it('P&L % is the unrealised P&L over the margin, rounded against the owner', () => {
    // -10 / 39.6 = -25.2525...%: a loss rounds away from zero, a gain towards it.
    expect(pnlPctOfMargin('-10', '39.6')).toBe('-25.26');
    expect(pnlPctOfMargin('10', '39.6')).toBe('25.25');
    expect(pnlPctOfMargin('0', '39.6')).toBe('0.00');
    expect(pnlPctOfMargin('1', '0')).toBeNull();
  });

  it('the distance to liquidation is |mark - liq| / mark, rounded down (towards danger)', () => {
    // (79000 - 76345.5) / 79000 = 3.36012...%
    expect(liqDistancePct('79000', '76345.5')).toBe('3.36');
    // A short: the liquidation price is above the mark.
    expect(liqDistancePct('80000', '83999.9')).toBe('4.99');
    // Past it (a stale or lagging mark): still a distance, never negative.
    expect(liqDistancePct('76000', '76345.5')).toBe('0.45');
  });

  it('the margin ratio shows as a percentage rounded up; a gone balance is infinite', () => {
    expect(ratioPct('0.10675675675675675676')).toBe('10.7%');
    expect(ratioPct('0.8')).toBe('80.0%');
    expect(ratioPct('Infinity')).toBe('∞');
  });

  it('every figure of a row comes from the wire position, the liquidation price at the tick towards the mark', () => {
    expect(positionFigures(wire(), '0.1')).toEqual({
      pnl: '-10',
      pnlPct: '-25.26',
      ratioPct: '10.7%',
      level: 'none',
      liq: '76345.5',
      // From the price shown (76345.5), not the unrounded one: the nearer of the two.
      liqDistancePct: '3.36',
    });
  });

  it('without the tick no liquidation price or distance is shown (never rounded to nearest)', () => {
    expect(positionFigures(wire(), undefined)).toMatchObject({ liq: null, liqDistancePct: null });
  });

  it('with no mark yet, no P&L, ratio or distance', () => {
    const p = wire({ markPrice: null, markFresh: false, markAt: null, unrealizedPnl: null, marginBalance: null, maintenanceMargin: null, marginRatio: null });
    expect(positionFigures(p, '0.1')).toEqual({ pnl: null, pnlPct: null, ratioPct: null, level: 'none', liq: '76345.5', liqDistancePct: null });
  });

  it('signed dollars are rounded against the owner: a loss away from zero, a gain towards it', () => {
    expect(fmtPnl('-0.0123')).toBe('-$0.02');
    expect(fmtPnl('0.0199')).toBe('+$0.01');
    expect(fmtPnl('-1234.561')).toBe('-$1,234.57');
    expect(fmtPnl('0')).toBe('$0.00');
    expect(fmtPnl(null)).toBe('-');
  });
});

describe('banner level', () => {
  it('none below 0.5, amber from 0.5, red from 0.8, pulsing from 0.9', () => {
    expect(riskLevel('0.49')).toBe('none');
    // Shown as 50.0% (rounded up): amber, as the figure says.
    expect(riskLevel('0.4999999')).toBe('amber');
    expect(riskLevel('0.5')).toBe('amber');
    expect(riskLevel('0.79')).toBe('amber');
    expect(riskLevel('0.8')).toBe('red');
    expect(riskLevel('0.89')).toBe('red');
    expect(riskLevel('0.9')).toBe('pulse');
    expect(riskLevel('Infinity')).toBe('pulse');
    expect(riskLevel(null)).toBe('none');
  });

  it('is taken from the ratio as shown (rounded up), so the colour never disagrees with the figure', () => {
    expect([ratioPct('0.4996'), riskLevel('0.4996')]).toEqual(['50.0%', 'amber']);
    expect([ratioPct('0.7995'), riskLevel('0.7995')]).toEqual(['80.0%', 'red']);
    expect([ratioPct('0.8995'), riskLevel('0.8995')]).toEqual(['90.0%', 'pulse']);
    expect([ratioPct('0.499'), riskLevel('0.499')]).toEqual(['49.9%', 'none']);
  });
});

describe('position state', () => {
  it('is live only with a fresh mark, an open connection and no catch-up', () => {
    expect(positionState(wire(), false)).toEqual({ live: true, staleReason: null, catchingUp: false });
    expect(positionState(wire({ markFresh: false }), false)).toMatchObject({ live: false, staleReason: 'No mark price update for over 10 s' });
    expect(positionState(wire(), true)).toMatchObject({ live: false, staleReason: 'Connection to the simulator lost' });
    expect(positionState(wire({ markPrice: null, markFresh: false }), false)).toMatchObject({ live: false, staleReason: 'No mark price yet' });
    expect(positionState(wire({ catchingUp: true }), false)).toEqual({
      live: false,
      staleReason: 'Catching up after a data gap: the figures may still change',
      catchingUp: true,
    });
  });
});

describe('warning banner entries', () => {
  const at = (ratio: string, over: Partial<WirePosition> = {}) => wire({ marginRatio: ratio, ...over });
  const tick = () => '0.1';

  it('lists each position at a ratio of 0.5 or more, worst first, with its distance to liquidation', () => {
    const eth = at('0.83', { symbol: 'ETHUSDT', side: 'short', markPrice: '2300', liquidationPrice: '2400.04' });
    const out = bannerEntries([], [at('0.55'), eth, at('0.2', { symbol: 'SOLUSDT' })], { down: false, tick });
    expect(out.map((e) => [e.symbol, e.side, e.level, e.ratioPct, e.liqDistancePct, e.stale])).toEqual([
      ['ETHUSDT', 'short', 'red', '83.0%', '4.34', false],
      ['BTCUSDT', 'long', 'amber', '55.0%', '3.36', false],
    ]);
  });

  it('a stale mark neither raises nor clears a level: the last live one stays, marked stale', () => {
    const live = bannerEntries([], [at('0.85')], { down: false, tick });
    expect(live.map((e) => [e.level, e.stale])).toEqual([['red', false]]);
    // The stale mark says 0.95 (would raise) or 0.3 (would clear): neither is acted on.
    for (const ratio of ['0.95', '0.3']) {
      const held = bannerEntries(live, [at(ratio, { markFresh: false })], { down: false, tick });
      expect(held).toEqual([{ ...live[0]!, stale: true }]);
    }
    // The connection down is not live either.
    expect(bannerEntries(live, [at('0.3')], { down: true, tick })).toEqual([{ ...live[0]!, stale: true }]);
    // A position first seen on a stale mark raises nothing.
    expect(bannerEntries([], [at('0.95', { markFresh: false })], { down: false, tick })).toEqual([]);
  });

  it('a live mark clears a level, and a closed position leaves the banner', () => {
    const live = bannerEntries([], [at('0.85')], { down: false, tick });
    expect(bannerEntries(live, [at('0.49')], { down: false, tick })).toEqual([]);
    expect(bannerEntries(live, [], { down: false, tick })).toEqual([]);
    // Positions not received yet: nothing is known, the last entries stay, stale.
    expect(bannerEntries(live, null, { down: false, tick })).toEqual([{ ...live[0]!, stale: true }]);
  });
});

describe('close part', () => {
  it('a share of the position is floored to the step', () => {
    expect(closePartQty('0.037', 25, '0.001')).toBe('0.009'); // 0.00925
    expect(closePartQty('0.037', 50, '0.001')).toBe('0.018'); // 0.0185
    expect(closePartQty('0.037', 75, '0.001')).toBe('0.027'); // 0.02775
    expect(closePartQty('0.037', 100, '0.001')).toBe('0.037');
    expect(closePartQty('7.5', 50, '1')).toBe('3');
  });

  it('a typed amount is floored to the step, comma accepted; nothing, too little or more than the position is refused', () => {
    expect(closeAmount('0.0129', '0.037', '0.001')).toEqual({ qty: '0.012' });
    expect(closeAmount('0,02', '0.037', '0.001')).toEqual({ qty: '0.02' });
    expect(closeAmount('', '0.037', '0.001')).toEqual({ error: 'Enter an amount' });
    expect(closeAmount('abc', '0.037', '0.001')).toEqual({ error: 'Enter an amount' });
    expect(closeAmount('0.0009', '0.037', '0.001')).toEqual({ error: 'Less than one step (0.001)' });
    expect(closeAmount('0.04', '0.037', '0.001')).toEqual({ error: 'More than the position (0.037)' });
  });
});

describe('stop-loss and take-profit of a position', () => {
  const stop = (over: Partial<WirePerpOrder>) =>
    ({ id: 'o', symbol: 'BTCUSDT', side: 'sell', closePosition: true, reduceOnly: true, status: 'open', ...over }) as WirePerpOrder;

  it('are its close-position stops on the closing side', () => {
    const sl = stop({ id: 'sl', type: 'stop_loss', triggerPrice: '70000' });
    const tp = stop({ id: 'tp', type: 'take_profit', triggerPrice: '90000' });
    const other = stop({ id: 'x', symbol: 'ETHUSDT', type: 'stop_loss', triggerPrice: '2000' });
    const limit = stop({ id: 'l', type: 'limit', closePosition: false, price: '85000' });
    expect(positionStops([other, limit, tp, sl], wire())).toEqual({ stopLoss: sl, takeProfit: tp });
    expect(positionStops([other], wire())).toEqual({ stopLoss: null, takeProfit: null });
  });
});

describe('leverage wallet line', () => {
  const account = (over: Partial<AccountSnapshot['leverage']> = {}, top: Partial<AccountSnapshot> = {}) =>
    ({
      balances: { spot: {}, leverage: { USDT: { free: '600', locked: '12.5' } } },
      leverage: {
        free: '600',
        locked: '12.5',
        value: '1000.5',
        positions: [{ symbol: 'BTCUSDT', side: 'long', qty: '0.1', margin: '396', markPrice: '80000', markFresh: true, markAt: 1, unrealizedPnl: '-8' }],
        ...over,
      },
      marksPaused: [],
      ...top,
    }) as unknown as AccountSnapshot;

  it('is free, in orders and in positions (margin plus unrealised P&L at the mark)', () => {
    expect(leverageWalletLine(account())).toEqual({ free: '600', inOrders: '12.5', inPositions: '388', stale: false, loading: false });
  });

  it('flags positions valued at a stale mark, and waits for a mark never received', () => {
    expect(leverageWalletLine(account({}, { marksPaused: ['BTCUSDT'] }))).toMatchObject({ inPositions: '388', stale: true });
    const unpriced = account({
      positions: [{ symbol: 'BTCUSDT', side: 'long', qty: '0.1', margin: '396', markPrice: null, markFresh: false, markAt: null, unrealizedPnl: null }],
    } as never);
    expect(leverageWalletLine(unpriced)).toMatchObject({ inPositions: null, loading: true });
  });
});

describe('totals wait for every price', () => {
  const base = {
    coins: [],
    pricesPaused: [],
    marksPaused: [],
    pricesLoading: false,
    leverage: { free: '0', locked: '0', value: '0', positions: [] },
  };
  it('a position with no mark yet holds the total back, like a coin with no bid', () => {
    const unpriced = {
      ...base,
      leverage: { ...base.leverage, positions: [{ symbol: 'BTCUSDT', markPrice: null, unrealizedPnl: null }] },
    } as unknown as AccountSnapshot;
    expect(pricesLoading(unpriced)).toBe(true);
    expect(pricesLoading({ ...base, pricesLoading: true } as unknown as AccountSnapshot)).toBe(true);
    expect(pricesLoading(base as unknown as AccountSnapshot)).toBe(false);
  });

  it('positions on a stale mark count as paused prices', () => {
    expect(pricesPausedLabel({ ...base, marksPaused: ['BTCUSDT'] } as unknown as AccountSnapshot)).toBe('Prices paused (1 position)');
    expect(pricesPausedLabel({ ...base, pricesPaused: ['ETH'], marksPaused: ['BTCUSDT', 'SOLUSDT'] } as unknown as AccountSnapshot)).toBe(
      'Prices paused (1 coin, 2 positions)',
    );
  });
});

describe('chart lines of a position', () => {
  it('draw no liquidation line before the tick is known, never the price rounded to nearest', () => {
    expect(chartLines(wire(), undefined, false)).toEqual({ entry: '80000', liq: null, dimmed: false });
    expect(chartLines(wire(), '0.1', false)).toEqual({ entry: '80000', liq: '76345.5', dimmed: false });
    expect(chartLines(undefined, '0.1', false)).toEqual({ entry: null, liq: null, dimmed: false });
  });

  it('are dimmed while the socket is down or the mark is stale', () => {
    expect(chartLines(wire(), '0.1', true).dimmed).toBe(true);
    expect(chartLines(wire({ markFresh: false }), '0.1', false).dimmed).toBe(true);
  });
});

describe('position actions', () => {
  it('while catching up all are off (the server answers 409); on a stale mark or feed all are off too, margin included', () => {
    const catching = actionBlocks(wire({ catchingUp: true }), undefined);
    expect([catching.close, catching.margin, catching.tpsl].every((r) => r !== null && /^Catching up/.test(r))).toBe(true);
    const noMark = 'No live mark price: the server would reject it now';
    expect(actionBlocks(wire({ markFresh: false }), undefined)).toEqual({ close: noMark, margin: noMark, tpsl: noMark });
    const interrupted = 'Live data interrupted (Binance depth stream interrupted): the server would reject it now';
    expect(actionBlocks(wire(), { fresh: false, reason: 'Binance depth stream interrupted' })).toEqual({
      close: interrupted,
      margin: interrupted,
      tpsl: interrupted,
    });
    expect(actionBlocks(wire(), { fresh: true, reason: null })).toEqual({ close: null, margin: null, tpsl: null });
  });

  it('a margin change is sent only with an amount, nothing blocking it, and no refusal in the current preview', () => {
    const ok = { hasAmount: true, blocked: null, noRemove: null, current: true, rejectReason: null };
    expect(marginSubmitReady(ok)).toBe(true);
    expect(marginSubmitReady({ ...ok, rejectReason: 'At most 0 USDT can be removed now' })).toBe(false);
    // A refusal for an older amount says nothing about this one.
    expect(marginSubmitReady({ ...ok, current: false, rejectReason: 'At most 0 USDT can be removed now' })).toBe(true);
    expect(marginSubmitReady({ ...ok, hasAmount: false })).toBe(false);
    expect(marginSubmitReady({ ...ok, blocked: 'Catching up' })).toBe(false);
    expect(marginSubmitReady({ ...ok, noRemove: 'No live mark price' })).toBe(false);
  });
});

const liqDetail = (symbol: string, side: 'long' | 'short') => ({
  symbol,
  side,
  qty: '0.1',
  markPrice: '76340',
  marginLost: '396',
  liquidationFee: '30',
});
const liqMsg = (symbol: string, side: 'long' | 'short') => ({
  type: 'notice' as const,
  kind: 'liquidation' as const,
  level: 'error' as const,
  text: `LIQUIDATED: ${symbol} ${side}`,
  liquidation: liqDetail(symbol, side),
});
/** Every message applied in turn, as the store does. */
function applyAll(msgs: Parameters<typeof reduce>[1][]): LiveData {
  let s = initialLiveData();
  msgs.forEach((m, i) => (s = { ...s, ...reduce(s, m, 1000 + i * 2000) }));
  return s;
}

describe('the liquidation alert queue', () => {
  it('keeps an unacknowledged liquidation however many notices follow (the notice list keeps 50)', () => {
    const others = Array.from({ length: 60 }, (_, i) => ({ type: 'notice' as const, kind: 'fill' as const, level: 'info' as const, text: `fill ${i}` }));
    const s = applyAll([liqMsg('BTCUSDT', 'long'), ...others]);
    expect(s.notices.some((n) => n.kind === 'liquidation')).toBe(false);
    expect(s.liquidationQueue.map((n) => n.liquidation?.symbol)).toEqual(['BTCUSDT']);
  });

  it('shows two liquidations one after the other, each until acknowledged', () => {
    const s = applyAll([liqMsg('BTCUSDT', 'long'), liqMsg('ETHUSDT', 'short')]);
    useLive.setState(s);
    // The alert as LiquidationAlert renders it from the store: the head of the queue.
    const alert = () =>
      renderToStaticMarkup(
        createElement(LiquidationAlertDialog, { shown: useLive.getState().liquidationQueue[0] ?? null, onAcknowledge: noop }),
      );
    const first = alert();
    expect(first).toContain('BTC long liquidated');
    expect(first).not.toContain('ETH short liquidated');
    useLive.getState().acknowledgeLiquidation(s.liquidationQueue[0]!.id);
    expect(alert()).toContain('ETH short liquidated');
    useLive.getState().acknowledgeLiquidation(s.liquidationQueue[1]!.id);
    expect(alert()).not.toContain('I understand');
    // Acknowledging leaves the notices themselves in the list.
    expect(useLive.getState().notices.filter((n) => n.kind === 'liquidation')).toHaveLength(2);
  });

  it('Escape does not dismiss it, and it has no close button', () => {
    let prevented = false;
    holdOnEscape({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    const html = renderToStaticMarkup(
      createElement(LiquidationAlertView, { detail: liqDetail('BTCUSDT', 'long'), text: '', onAcknowledge: noop }),
    );
    expect(html).not.toContain('aria-label="Close"');
  });
});

describe('the warning banner in the store', () => {
  it('keeps its held level across a remount: a stale mark after it neither clears nor raises it', () => {
    useLive.setState({ ...initialLiveData(), conn: 'open', meta: null, positions: [wire({ marginRatio: '0.85' })] });
    expect(useLive.getState().banner.map((e) => [e.level, e.stale])).toEqual([['red', false]]);
    // The mark goes stale: the store (not the mounted banner) still holds the last live level, so a
    // banner mounted now (WarningBanner renders the store's entries) shows it, marked stale.
    useLive.setState({ positions: [wire({ marginRatio: '0.3', markFresh: false })] });
    const html = renderToStaticMarkup(createElement(WarningBannerView, { entries: useLive.getState().banner }));
    expect(html).toContain('85.0%');
    expect(html).toContain('Stale: last live figures');
    // Live again under 0.5: cleared.
    useLive.setState({ positions: [wire({ marginRatio: '0.3' })] });
    expect(useLive.getState().banner).toEqual([]);
  });
});

describe('liquidation notices in the store', () => {
  it('keep their figures and are never folded into an identical one', () => {
    const liquidation = { symbol: 'BTCUSDT', side: 'long' as const, qty: '0.1', markPrice: '76340', marginLost: '396', liquidationFee: '30' };
    const msg = { type: 'notice' as const, kind: 'liquidation' as const, level: 'error' as const, text: 'LIQUIDATED: BTCUSDT long 0.1', liquidation };
    const s = { ...initialLiveData(), ...reduce(initialLiveData(), msg, 1000) };
    const twice = { ...s, ...reduce(s, msg, 1100) };
    expect(twice.notices.map((n) => [n.id, n.kind, n.count, n.liquidation])).toEqual([
      [1, 'liquidation', 1, liquidation],
      [2, 'liquidation', 1, liquidation],
    ]);
  });
});

// ---- rendering ----

const noop = () => {};

describe('a position row', () => {
  const row = (p: WirePosition, down = false) =>
    renderToStaticMarkup(
      createElement(PositionLine, { p, stops: { stopLoss: null, takeProfit: null }, down, tick: '0.1', onAction: noop, busy: false }),
    );

  it('on a stale mark is flagged Stale and its live figures are dimmed', () => {
    const live = row(wire());
    expect(live).not.toContain('Stale');
    const stale = row(wire({ markFresh: false }));
    expect(stale).toContain('Stale');
    expect(stale).toContain('data-stale="true"');
    expect(row(wire(), true)).toContain('Stale');
  });

  it('while catching up says so and offers no close or margin action', () => {
    const html = row(wire({ catchingUp: true }));
    expect(html).toContain('Catching up');
    for (const label of ['Close', 'Close part', 'Margin', 'SL/TP']) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
    }
  });

  it('with our socket down the actions stay on: the server judges on its own feed', () => {
    const html = row(wire(), true);
    expect(html).toContain('Stale');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(Close|Close part|Margin|SL\/TP)<\/button>/);
  });

  it('on a stale mark the close and margin actions are off, with the reason (the server would refuse them)', () => {
    const html = row(wire({ markFresh: false }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Close part<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="No live mark price: the server would reject it now"[^>]*>Margin<\/button>/);
    expect(row(wire())).not.toMatch(/<button[^>]*disabled=""[^>]*>Margin<\/button>/);
  });
});

describe('warning banner', () => {
  const entry = (over: Partial<BannerEntry> = {}): BannerEntry => ({
    symbol: 'BTCUSDT',
    side: 'long',
    level: 'red',
    ratioPct: '83.0%',
    liqDistancePct: '1.84',
    stale: false,
    ...over,
  });
  const html = (entries: BannerEntry[]) => renderToStaticMarkup(createElement(WarningBannerView, { entries }));

  it('names the coin, the ratio and the distance to liquidation, and has no dismiss button', () => {
    const out = html([entry()]);
    expect(out).toContain('BTC long');
    expect(out).toContain('83.0%');
    expect(out).toContain('1.84%');
    expect(out).not.toContain('Dismiss');
    expect(out).toContain('data-level="red"');
  });

  it('pulses from 0.9 and says when the figures are stale; nothing at all without entries', () => {
    expect(html([entry({ level: 'pulse' })])).toContain('danger-pulse');
    expect(html([entry({ stale: true })])).toContain('Stale');
    expect(html([])).toBe('');
  });
});

describe('the SL/TP hint', () => {
  it('is dimmed and marked stale while the last price is not live', () => {
    const live = renderToStaticMarkup(createElement(LastPriceHint, { below: true, symbol: 'BTCUSDT', last: '80000', stale: false }));
    expect(live).toContain('Below the last price 80,000');
    expect(live).not.toContain('Stale');
    const stale = renderToStaticMarkup(createElement(LastPriceHint, { below: false, symbol: 'BTCUSDT', last: '80000', stale: true }));
    expect(stale).toContain('Above the last price 80,000');
    expect(stale).toContain('opacity-50');
    expect(stale).toContain('Stale');
  });
});

describe('liquidation alert', () => {
  it('shows coin, size, mark, margin lost and fee, rounded against the owner, and must be acknowledged', () => {
    const out = renderToStaticMarkup(
      createElement(LiquidationAlertView, {
        detail: { symbol: 'BTCUSDT', side: 'long', qty: '0.1', markPrice: '76340', marginLost: '395.991', liquidationFee: '30.001' },
        text: 'LIQUIDATED: ...',
        onAcknowledge: noop,
      }),
    );
    expect(out).toContain('BTC');
    expect(out).toContain('0.1 BTC long');
    expect(out).toContain('76,340');
    expect(out).toContain('$396.00');
    expect(out).toContain('$30.01');
    expect(out).toContain('I understand');
  });
});
