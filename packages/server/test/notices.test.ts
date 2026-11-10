import { D } from '@sim/engine';
import type { Fill, PerpEvent, PerpFill, PerpOrder, SimEvent, SpotOrder } from '@sim/engine';
import { describe, expect, it } from 'vitest';
import { btcRules } from '../../engine/test/fixtures.ts';
import { btcPerpRules } from '../../engine/test/perpFixtures.ts';
import { marginWarningNotice, noticesFor } from '../src/notices.ts';

const lookup = { spotRules: () => btcRules, perpRules: () => btcPerpRules, liquidationPrice: () => null };
const text = (e: SimEvent) => noticesFor([e], lookup)[0]!.text;

describe('notice figures are rounded half up, as the web app shows them', () => {
  it('a liquidation mark ending in 5', () => {
    const position = {
      id: 'p1', symbol: 'BTCUSDT', side: 'long' as const, qty: D('0.1'), entryPrice: D('80000'), leverage: 20,
      margin: D('396'), openedAt: 0, realizedPnl: D('0'), fees: D('4'), funding: D('0'), warnLevel: 0 as const,
    };
    const e: PerpEvent = {
      type: 'liquidation', market: 'perp', time: 0, symbol: 'BTCUSDT', position, markPrice: D('76345.25'),
      marginLost: D('396'), tradingLoss: D('365.475'), liquidationFee: D('30.525'), remainder: D('0'),
      feeRateKnown: true, cancelledOrderIds: [],
    };
    expect(text(e)).toBe('LIQUIDATED: BTCUSDT long 0.1 at mark 76,345.3 — margin lost $396.00 (fee $30.53)');
  });

  it('a funding rate on a half', () => {
    const e: PerpEvent = {
      type: 'funding', market: 'perp', time: 0, symbol: 'BTCUSDT', positionId: 'p1', fundingTime: 0,
      rate: D('0.0001225'), markPrice: D('80000'), qty: D('0.1'), side: 'long', amount: D('-0.98'),
      target: 'margin', uncollected: null,
    };
    expect(text(e)).toBe('Funding paid $0.98 on BTCUSDT long (rate 0.0123%)');
  });

  it('a spot fill price at tick decimals + 2 on a half', () => {
    const fill = {
      id: 'f1', orderId: 'o1', symbol: 'BTCUSDT', side: 'buy', qty: D('0.001'), price: D('100.0025'), quote: D('0.1000025'),
      liquidity: 'taker', feeAsset: 'BTC', fee: D('0.000001'), feeUsd: D('0.0001'), bestAtArrival: null, bestAtSubmit: null,
      slippageUsd: D('0'), driftUsd: D('0'), triggerPrice: null, realizedPnl: null, roundTripId: null, time: 0,
    } as Fill;
    const e = { type: 'fill', time: 0, fill, order: { status: 'filled' } as SpotOrder } as SimEvent;
    expect(text(e)).toContain('@ 100.0025');
    const half = { ...fill, price: D('100.00125') };
    expect(text({ ...e, fill: half } as SimEvent)).toContain('@ 100.0013');
  });
});

describe('notice prices and dollar amounts are grouped by thousands, as the screens show them', () => {
  const position = {
    id: 'p1', symbol: 'BTCUSDT', side: 'long' as const, qty: D('2'), entryPrice: D('80000'), leverage: 20,
    margin: D('8000'), openedAt: 0, realizedPnl: D('0'), fees: D('4'), funding: D('0'), warnLevel: 0 as const,
  };

  it('a liquidation: the mark at the tick, margin lost and fee rounded up', () => {
    const e: PerpEvent = {
      type: 'liquidation', market: 'perp', time: 0, symbol: 'BTCUSDT', position, markPrice: D('76345.25'),
      marginLost: D('8000'), tradingLoss: D('7309.5'), liquidationFee: D('1234.561'), remainder: D('0'),
      feeRateKnown: true, cancelledOrderIds: [],
    };
    expect(text(e)).toBe('LIQUIDATED: BTCUSDT long 2 at mark 76,345.3 — margin lost $8,000.00 (fee $1,234.57)');
  });

  it('a trigger at the tick', () => {
    const order = { symbol: 'BTCUSDT', type: 'stop_loss' } as PerpOrder;
    const e = { type: 'order_triggered', market: 'perp', time: 0, order, lastPrice: D('73596') } as PerpEvent;
    expect(text(e)).toBe('Stop triggered at 73,596.0');
  });

  it('a perp fill: price, fee, P&L and the liquidation price rounded towards the mark', () => {
    const fill = {
      id: 'f1', orderId: 'o1', market: 'perp', symbol: 'BTCUSDT', side: 'sell', qty: D('2'), price: D('81234.5'),
      quote: D('162469'), liquidity: 'taker', feeAsset: 'USDT', fee: D('1081.2345'), feeUsd: D('1081.2345'),
      bestAtArrival: null, bestAtSubmit: null, slippageUsd: D('0'), driftUsd: D('0'), triggerPrice: null,
      realizedPnl: D('-1234.561'), positionId: 'p1', marginIn: null, uncovered: null, time: 0,
    } as unknown as PerpFill;
    const e = { type: 'fill', market: 'perp', time: 0, fill, order: { status: 'filled' } as PerpOrder } as PerpEvent;
    const withLiq = { ...lookup, liquidationPrice: () => D('76345.21') };
    expect(noticesFor([e], withLiq)[0]!.text).toBe(
      'Reduced long 2 BTC @ 81,234.5 · fee $1,081.24 · P&L -$1,234.57 · liq 76,345.3',
    );
  });

  it('a spot fill at tick decimals + 2, and its slippage', () => {
    const fill = {
      id: 'f1', orderId: 'o1', symbol: 'BTCUSDT', side: 'buy', qty: D('20'), price: D('73596.12345'), quote: D('1471922.469'),
      liquidity: 'taker', feeAsset: 'BTC', fee: D('0.02'), feeUsd: D('1471.92'), bestAtArrival: null, bestAtSubmit: null,
      slippageUsd: D('1234.561'), driftUsd: D('0'), triggerPrice: null, realizedPnl: null, roundTripId: null, time: 0,
    } as Fill;
    const e = { type: 'fill', time: 0, fill, order: { status: 'filled' } as SpotOrder } as SimEvent;
    expect(text(e)).toBe('Bought 20 BTC @ 73,596.1235 · slippage $1,234.57 · fee 0.02 BTC');
  });

  it('funding paid (rounded up) and received (rounded down), and what could not be collected', () => {
    const base = {
      type: 'funding' as const, market: 'perp' as const, time: 0, symbol: 'BTCUSDT', positionId: 'p1', fundingTime: 0,
      rate: D('0.0001'), markPrice: D('80000'), qty: D('2'), side: 'long' as const, target: 'margin' as const,
    };
    expect(text({ ...base, amount: D('-1234.561'), uncollected: D('1000.001') })).toBe(
      'Funding paid $1,234.57 on BTCUSDT long (rate 0.0100%) · $1,000.01 of it could not be collected',
    );
    expect(text({ ...base, amount: D('1234.569'), uncollected: null })).toBe('Funding received $1,234.56 on BTCUSDT long (rate 0.0100%)');
  });

  it("a margin warning's liquidation price, rounded towards the mark", () => {
    const w = {
      symbol: 'BTCUSDT', positionId: 'p1', side: 'short' as const, level: 0.8 as const, ratio: D('0.8'),
      markPrice: D('80000'), liquidationPrice: D('83456.78'),
    };
    expect(marginWarningNotice(w, btcPerpRules).text).toBe('Margin ratio 80.0% on BTCUSDT short — liquidation at 83,456.7');
  });
});
