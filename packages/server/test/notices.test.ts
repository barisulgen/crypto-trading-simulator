import { D } from '@sim/engine';
import type { Fill, PerpEvent, SimEvent, SpotOrder } from '@sim/engine';
import { describe, expect, it } from 'vitest';
import { btcRules } from '../../engine/test/fixtures.ts';
import { btcPerpRules } from '../../engine/test/perpFixtures.ts';
import { noticesFor } from '../src/notices.ts';

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
    expect(text(e)).toBe('LIQUIDATED: BTCUSDT long 0.1 at mark 76345.3 — margin lost $396.00 (fee $30.53)');
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
