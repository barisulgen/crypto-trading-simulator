// A notice and the History row of the same event show every coin quantity and fee as the same
// string: grouped by thousands, with the decimals the value has.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D } from '../../engine/src/decimal.ts';
import { deposit, emptyLedger } from '../../engine/src/account/ledger.ts';
import { PerpEngine } from '../../engine/src/perp/engine.ts';
import { emptyPerpState } from '../../engine/src/perp/state.ts';
import { applyCatchUp, SimEngine } from '../../engine/src/sim.ts';
import type { SimCtx, SimEvent } from '../../engine/src/sim.ts';
import { SpotEngine } from '../../engine/src/spot/engine.ts';
import { emptySpotState } from '../../engine/src/spot/state.ts';
import { btcRules, FakeMarket, seedCoins } from '../../engine/test/fixtures.ts';
import { btcPerpRules, FakePerpMarket } from '../../engine/test/perpFixtures.ts';
import { noticesFor } from '../../server/src/notices.ts';
import type { HistoryRow } from '../src/lib/api.ts';
import { setPerpRules, setRules } from '../src/lib/format.ts';
import { describeEvent } from '../src/lib/history.ts';
import type { EventView } from '../src/lib/history.ts';

const T = Date.UTC(2026, 9, 24, 12, 10);
const wire = (e: object) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
const row = (type: string, payload: object, market: 'spot' | 'perp', symbol = 'BTCUSDT'): HistoryRow => ({
  id: 1,
  time: T,
  type,
  symbol,
  market,
  payload: wire(payload),
});
const field = (v: EventView, label: string) => {
  const f = v.fields.find((x) => x.label === label);
  if (!f) throw new Error(`no ${label} in ${JSON.stringify(v.fields)}`);
  return f.value;
};
const lookup = {
  spotRules: (s: string) => (s === 'BTCUSDT' ? btcRules : null),
  perpRules: () => btcPerpRules,
  liquidationPrice: () => null,
};
const text = (e: SimEvent) => noticesFor([e], lookup)[0]!.text;

beforeEach(() => {
  // The rules as the screens load them: the step sizes would pad a quantity to more decimals.
  setRules({ BTCUSDT: { tickSize: '0.01000000', stepSize: '0.00001000' }, DOGEUSDT: { tickSize: '0.00001', stepSize: '1' } });
  setPerpRules({ BTCUSDT: { tickSize: '0.10', stepSize: '0.001' } });
});
afterEach(() => {
  setRules({});
  setPerpRules({});
});

const spotFill = (symbol: string, qty: string, price: string, fee: string, feeAsset: string) => ({
  type: 'fill' as const,
  time: T,
  fill: {
    id: 'f1', orderId: 'o1', symbol, side: 'buy' as const, qty: D(qty), price: D(price), quote: D(qty).mul(price),
    liquidity: 'taker' as const, feeAsset, fee: D(fee), feeUsd: D(fee).mul(price), bestAtArrival: D(price),
    bestAtSubmit: D(price), slippageUsd: D('0'), driftUsd: D('0'), triggerPrice: null, realizedPnl: null,
    roundTripId: null, time: T,
  },
  order: {
    id: 'o1', symbol, side: 'buy', type: 'market', qty: D(qty), quoteQty: null, price: null, triggerPrice: null,
    status: 'filled', filledQty: D(qty), filledQuote: D(qty).mul(price), fee: D(fee), feeAsset, lockAsset: 'USDT',
    lockAmount: D('0'), ocoGroupId: null, parentId: null, attach: null, createdAt: T, arrivesAt: T, cancelArrivesAt: null,
    triggeredAt: null, bestAtSubmit: D(price), rejectReason: null,
  },
});

describe('coin quantities and fees read the same in a notice and its History row', () => {
  it('a spot fill of 1,000 coins or more with its fee in the coin', () => {
    for (const [symbol, qty, price, fee, base, shownQty, shownFee] of [
      ['BTCUSDT', '1234.5', '60000', '1.2345', 'BTC', '1,234.5 BTC', '1.2345 BTC'],
      ['DOGEUSDT', '1500000', '0.2', '1500', 'DOGE', '1,500,000 DOGE', '1,500 DOGE'],
    ] as const) {
      const e = spotFill(symbol, qty, price, fee, base) as unknown as SimEvent;
      const v = describeEvent(row('fill', e, 'spot', symbol));
      expect(field(v, 'Qty')).toBe(shownQty);
      expect(field(v, 'Fee').startsWith(`${shownFee} ~`)).toBe(true);
      expect(text(e)).toContain(`Bought ${shownQty} @ `);
      expect(text(e)).toContain(` · fee ${shownFee}`);
    }
  });

  it('a perp fill of 1,000 coins or more', () => {
    const e = {
      type: 'fill', market: 'perp', time: T,
      fill: {
        ...spotFill('BTCUSDT', '1234.5', '80000', '49380', 'USDT').fill, market: 'perp', positionId: 'pos1',
        marginIn: D('4938000'), uncovered: null,
      },
      order: {
        id: 'o1', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: D('1234.5'), quoteQty: null, price: null,
        triggerPrice: null, reduceOnly: false, closePosition: false, leverage: 20, status: 'filled', filledQty: D('1234.5'),
        filledQuote: D('98760000'), fee: D('49380'), lockAmount: D('0'), ocoGroupId: null, parentId: null, attach: null,
        createdAt: T, arrivesAt: T, triggeredAt: null, cancelArrivesAt: null, bestAtSubmit: D('80000'), rejectReason: null,
        realizedPnl: D('0'),
      },
    } as unknown as SimEvent;
    const v = describeEvent(row('fill', e, 'perp'));
    expect(field(v, 'Qty')).toBe('1,234.5 BTC');
    expect(text(e)).toContain('Increased long 1,234.5 BTC @ ');
  });

  it('a liquidation of a position of 1,000 coins or more', () => {
    const position = {
      id: 'pos1', symbol: 'BTCUSDT', side: 'long', qty: D('1234.5'), entryPrice: D('80000'), leverage: 20, margin: D('4938000'),
      openedAt: T, realizedPnl: D('0'), fees: D('0'), funding: D('0'), warnLevel: 0,
    };
    const e = {
      type: 'liquidation', market: 'perp', time: T, symbol: 'BTCUSDT', position, markPrice: D('76345.2'),
      marginLost: D('4938000'), tradingLoss: D('4512000'), liquidationFee: D('426000'), remainder: D('0'),
      feeRateKnown: true, cancelledOrderIds: [],
    } as unknown as SimEvent;
    const v = describeEvent(row('liquidation', e, 'perp'));
    expect(field(v, 'Position')).toBe('Long 1,234.5 BTC');
    expect(text(e)).toContain('LIQUIDATED: BTCUSDT long 1,234.5 at mark ');
  });

  it('a catch-up line of 1,000 coins or more, and the estimated fill it applied', () => {
    // A real catch-up run: a stop-loss on 12,000 DOGE reached during a gap.
    const at = (h: number, m: number) => Date.UTC(2026, 9, 24, h, m);
    const spotMarket = new FakeMarket();
    spotMarket.setRules('DOGEUSDT', {
      ...btcRules, symbol: 'DOGEUSDT', base: 'DOGE', tickSize: D('0.00001'), minPrice: D('0.00001'), maxPrice: D('1000'),
      stepSize: D('1'), minQty: D('1'), maxQty: D('90000000'), marketMaxQty: D('90000000'),
    });
    spotMarket.setFresh('DOGEUSDT', true);
    spotMarket.setAvgPrice('DOGEUSDT', D('0.2'));
    spotMarket.setLastPrice('DOGEUSDT', D('0.2'));
    const ctx: SimCtx = {
      now: at(11, 50),
      rng: () => 0,
      newId: (prefix) => `${prefix}1`,
      spotMarket,
      perpMarket: new FakePerpMarket(),
      fees: { spot: { maker: D('0.001'), taker: D('0.001') }, perp: { maker: D('0.0002'), taker: D('0.0005') } },
    };
    const ledger = emptyLedger(['USDT', 'DOGE']);
    const sim = new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));
    deposit(ledger, 'spot', D('1000'), ctx);
    seedCoins(sim.spot.state, 'DOGE', D('20000'), D('0.2'));
    const [placed] = sim.submit('spot', { symbol: 'DOGEUSDT', side: 'sell', type: 'stop_loss', qty: '12000', triggerPrice: '0.19' }, ctx);
    if (placed?.type !== 'order_placed') throw new Error(`not placed: ${JSON.stringify(placed)}`);
    ctx.now = placed.order.arrivesAt!;
    sim.arrive('spot', placed.order.id, ctx);
    const candles = Array.from({ length: 10 }, (_, m) => {
      const low = m === 4 ? '0.188' : '0.2';
      return { openTime: at(12, m), open: D(low), high: D('0.2005'), low: D(low), close: D('0.2005') };
    });
    ctx.now = at(12, 10) + 1000;
    const events = applyCatchUp(
      sim,
      { market: 'spot', symbol: 'DOGEUSDT', from: at(12, 0), to: at(12, 10), lastTradeIdBefore: 100, endTradeId: null, candles, trades: [] },
      ctx,
    );
    const filled = events.find((e) => e.type === 'fill')!;
    const summary = events.at(-1)!;
    const qty = field(describeEvent(row('fill', filled, 'spot', 'DOGEUSDT')), 'Qty');
    expect(qty).toBe('12,000 DOGE');
    const [notice] = noticesFor([summary], lookup);
    expect(notice!.text).toContain(`Stop-loss filled ${qty} at 0.188`);
    const items = describeEvent(row('catch_up', summary, 'spot', 'DOGEUSDT')).list!.items;
    expect(items[0]).toContain(`Stop-loss filled ${qty} at 0.188`);
  });
});
