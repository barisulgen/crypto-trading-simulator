import { D } from '@sim/engine';
import type { CatchUpBasis } from '@sim/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { btcPerpRules } from '../../engine/test/perpFixtures.ts';
import { noticesFor } from '../../server/src/notices.ts';
import { LiquidationAlertView } from '../src/components/LiquidationAlert.tsx';
import type { HistoryRow } from '../src/lib/api.ts';
import { setPerpRules, setRules } from '../src/lib/format.ts';
import {
  BASIS_WHY,
  EMPTY_FILTERS,
  EVENT_TYPES,
  MARKET_FILTERS,
  describeEvent,
  filterParams,
  fmtDuration,
  historyQuery,
  localDayEnd,
  localDayStart,
  parseFilters,
} from '../src/lib/history.ts';
import type { EventView, HistoryFilters } from '../src/lib/history.ts';
import { initialLiveData, reduce } from '../src/lib/live.ts';
import { fmtDateTime } from '../src/lib/market.ts';

/** Local time, as the owner's clock shows it. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

const lines = (v: EventView) => v.fields.map((f) => `${f.label}: ${f.value}`);
const tone = (v: EventView, label: string) => v.fields.find((f) => f.label === label)?.tone;

describe('history filters in the URL', () => {
  it('round-trips every filter through the query string, multi types and dates included', () => {
    const f: HistoryFilters = {
      symbol: 'BTCUSDT',
      market: 'spot',
      types: ['order_placed', 'fill', 'feed_gap'],
      from: '2026-10-01',
      to: '2026-10-18',
    };
    const params = filterParams(f);
    expect(params).toEqual({
      symbol: 'BTCUSDT',
      market: 'spot',
      types: 'order_placed,fill,feed_gap',
      from: '2026-10-01',
      to: '2026-10-18',
    });
    expect(parseFilters(new URLSearchParams(params))).toEqual(f);
  });

  it('no filters is an empty query, and an empty query is no filters', () => {
    expect(filterParams(EMPTY_FILTERS)).toEqual({});
    expect(parseFilters(new URLSearchParams(''))).toEqual(EMPTY_FILTERS);
  });

  it('keeps event types in one fixed order without repeats, so equal filters give equal URLs', () => {
    const f = parseFilters(new URLSearchParams('types=fill,deposit,fill,round_trip_closed'));
    expect(f.types).toEqual(['deposit', 'fill', 'round_trip_closed']);
    expect(filterParams(f).types).toBe('deposit,fill,round_trip_closed');
  });

  it('drops values it does not know (a hand-edited or old bookmark) instead of failing', () => {
    expect(
      parseFilters(new URLSearchParams('symbol=PEPEUSDT&market=margin&types=fill,bogus&from=2026-13-01&to=yesterday')),
    ).toEqual({ ...EMPTY_FILTERS, types: ['fill'] });
    expect(parseFilters(new URLSearchParams('from=2026-02-30')).from).toBeNull();
  });
});

describe('date range in local time', () => {
  it('a from date starts at local midnight and a to date ends at the last millisecond of that local day', () => {
    expect(localDayStart('2026-10-18')).toBe(at(2026, 10, 18));
    expect(localDayEnd('2026-10-18')).toBe(at(2026, 10, 19) - 1);
    expect(localDayEnd('2026-10-18')).toBe(at(2026, 10, 18, 23, 59, 59, 999));
    expect(localDayEnd('2026-12-31')).toBe(at(2027, 1, 1) - 1);
    expect(localDayStart('nope')).toBeNull();
  });

  it('turns filters into the API query: whole days inclusive, page size 50', () => {
    const q = historyQuery({
      symbol: 'ETHUSDT',
      market: 'leverage',
      types: ['deposit', 'transfer'],
      from: '2026-10-01',
      to: '2026-10-02',
    });
    expect(q).toEqual({
      symbol: 'ETHUSDT',
      market: 'leverage',
      types: ['deposit', 'transfer'],
      from: at(2026, 10, 1),
      to: at(2026, 10, 3) - 1,
      limit: 50,
    });
    expect(historyQuery(EMPTY_FILTERS, 123)).toEqual({ limit: 50, before: 123 });
  });
});

describe('times', () => {
  it('shows a local date and time with seconds', () => {
    expect(fmtDateTime(at(2026, 10, 18, 9, 5, 7))).toBe('18 Oct 2026 09:05:07');
  });

  it('humanises a duration with its two largest units', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(42_900)).toBe('42s');
    expect(fmtDuration(125_000)).toBe('2m 05s');
    expect(fmtDuration(2 * 3_600_000 + 5 * 60_000 + 59_000)).toBe('2h 05m');
    expect(fmtDuration(3 * 86_400_000 + 4 * 3_600_000 + 30 * 60_000)).toBe('3d 4h');
  });
});

describe('history rows', () => {
  beforeEach(() => {
    setRules({
      BTCUSDT: { tickSize: '0.01000000', stepSize: '0.00001000' },
      ETHUSDT: { tickSize: '0.01000000', stepSize: '0.00010000' },
    });
  });
  afterEach(() => setRules({}));

  const T = at(2026, 10, 18, 9, 5, 7);
  const row = (type: string, payload: unknown, symbol: string | null = 'BTCUSDT', market: string | null = 'spot'): HistoryRow => ({
    id: 1,
    time: T,
    type,
    symbol,
    market,
    payload,
  });
  const order = (o: Record<string, unknown> = {}) => ({
    id: 'o1',
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'limit',
    qty: '0.0002',
    quoteQty: null,
    price: '78000',
    triggerPrice: null,
    status: 'open',
    filledQty: '0',
    filledQuote: '0',
    fee: '0',
    feeAsset: null,
    lockAsset: 'USDT',
    lockAmount: '15.6',
    ocoGroupId: null,
    parentId: null,
    attach: null,
    createdAt: T,
    arrivesAt: T + 150,
    cancelArrivesAt: null,
    triggeredAt: null,
    bestAtSubmit: '81000',
    rejectReason: null,
    ...o,
  });

  it('deposit: amount, wallet and the running total deposited', () => {
    const v = describeEvent(
      row('deposit', { type: 'deposit', time: T, wallet: 'spot', amount: '1000', totalDeposited: '1250.5' }, null),
    );
    expect(v.label).toBe('Deposit');
    expect(v.coin).toBeNull();
    expect(lines(v)).toEqual(['Amount: $1,000.00', 'Wallet: Spot', 'Total deposited: $1,250.50']);
  });

  it('deposit: the BTC ask recorded with it, when it has one (older deposits have none)', () => {
    const v = describeEvent(
      row(
        'deposit',
        { type: 'deposit', time: T, wallet: 'leverage', amount: '500', totalDeposited: '1750.5', btcAsk: '67012.3' },
        null,
        'leverage',
      ),
    );
    expect(v.label).toBe('Deposit');
    expect(lines(v)).toEqual(['Amount: $500.00', 'Wallet: Leverage', 'Total deposited: $1,750.50', 'BTC ask at deposit: 67,012.30']);
  });

  it('transfer: amount, from and to', () => {
    const v = describeEvent(row('transfer', { type: 'transfer', time: T, from: 'spot', to: 'leverage', amount: '200' }, null, null));
    expect(v.label).toBe('Transfer');
    expect(lines(v)).toEqual(['Amount: $200.00', 'From: Spot', 'To: Leverage']);
  });

  it('order placed: side, type, price, amount, and an attached pair', () => {
    const v = describeEvent(
      row('order_placed', {
        type: 'order_placed',
        time: T,
        order: order({ attach: { stopLoss: '70000', takeProfit: '90000.5' } }),
      }),
    );
    expect(v.label).toBe('Order placed');
    expect(v.coin).toBe('BTC');
    expect(lines(v)).toEqual([
      'Side: Buy',
      'Type: Limit',
      'Price: 78,000.00',
      'Amount: 0.0002 BTC',
      'Attached: SL 70,000.00 / TP 90,000.50',
    ]);
    expect(tone(v, 'Side')).toBe('up');
  });

  it('order placed: a market buy in dollars, and a stop leg of a linked pair', () => {
    const m = describeEvent(
      row('order_placed', { type: 'order_placed', time: T, order: order({ type: 'market', qty: null, quoteQty: '100', price: null }) }),
    );
    expect(lines(m)).toEqual(['Side: Buy', 'Type: Market', 'Price: Market', 'Amount: $100.00']);
    const leg = describeEvent(
      row('order_placed', {
        type: 'order_placed',
        time: T,
        order: order({ side: 'sell', type: 'stop_loss', price: null, triggerPrice: '73250.1', qty: '0.00121', ocoGroupId: 'g1' }),
      }),
    );
    expect(lines(leg)).toEqual(['Side: Sell', 'Type: Stop-loss (linked pair)', 'Trigger: 73,250.10', 'Amount: 0.00121 BTC']);
    expect(tone(leg, 'Side')).toBe('down');
  });

  it('order cancelled: the reason in words and the quantity left unfilled', () => {
    const cancel = (reason: string) =>
      describeEvent(
        row('order_cancelled', {
          type: 'order_cancelled',
          time: T,
          order: order({ status: 'cancelled' }),
          reason,
          cancelledQty: '0.00015',
        }),
      );
    const v = cancel('user');
    expect(v.label).toBe('Order cancelled');
    expect(lines(v)).toEqual([
      'Side: Buy',
      'Type: Limit',
      'Price: 78,000.00',
      'Amount: 0.0002 BTC',
      'Cancelled: by you',
      'Cancelled qty: 0.00015 BTC',
    ]);
    expect(lines(cancel('thin_book'))).toContain('Cancelled: book too thin');
    expect(lines(cancel('oco'))).toContain('Cancelled: other leg of the pair triggered');
    expect(lines(cancel('parent_cancelled'))).toContain('Cancelled: parent cancelled');
  });

  it('cancel failed: a cancel that arrived too late, with its reason; filterable by its own type', () => {
    const reason = 'Cancel arrived too late: order already filled';
    const v = describeEvent(
      row('cancel_rejected', {
        type: 'cancel_rejected',
        time: T,
        order: order({ status: 'filled', filledQty: '0.0002', cancelArrivesAt: null }),
        reason,
      }),
    );
    expect(v.label).toBe('Cancel failed');
    expect(v.tone).toBe('down');
    expect(v.coin).toBe('BTC');
    expect(lines(v)).toEqual(['Side: Buy', 'Type: Limit', 'Price: 78,000.00', 'Amount: 0.0002 BTC']);
    expect(v.note).toEqual({ label: 'Reason', text: reason });
    expect(EVENT_TYPES.find((t) => t.type === 'cancel_rejected')?.label).toBe('Cancels failed');
    expect(parseFilters(new URLSearchParams('types=cancel_rejected,order_cancelled')).types).toEqual([
      'order_cancelled',
      'cancel_rejected',
    ]);
  });

  it('order rejected: the reason verbatim; a triggered stop that could not execute says so', () => {
    const reason = 'Post-only order would immediately match; rejected';
    const v = describeEvent(
      row('order_rejected', {
        type: 'order_rejected',
        time: T,
        order: order({ type: 'post_only', price: '81400', status: 'rejected', rejectReason: reason }),
        reason,
      }),
    );
    expect(v.label).toBe('Order rejected');
    expect(v.tone).toBe('down');
    expect(lines(v)).toEqual(['Side: Buy', 'Type: Post-only', 'Price: 81,400.00', 'Amount: 0.0002 BTC']);
    expect(v.note).toEqual({ label: 'Reason', text: reason });

    const expired = describeEvent(
      row('order_rejected', {
        type: 'order_rejected',
        time: T,
        order: order({ side: 'sell', type: 'stop_loss', price: null, triggerPrice: '80000', status: 'rejected' }),
        reason: 'Triggered stop expired: insufficient funds at execution (need 1, available 0.5; trigger 80000, book average 79990.00)',
        afterTrigger: true,
      }),
    );
    const offTick = describeEvent(
      row('order_rejected', {
        type: 'order_rejected',
        time: T,
        order: order({ price: '100.005', qty: '0.000123', status: 'rejected' }),
        reason: 'PRICE_FILTER: price 100.005 is not a multiple of tick size 0.01',
      }),
    );
    // The values as sent, never rounded onto the tick or step: the reason must not be contradicted.
    expect(lines(offTick)).toEqual(['Side: Buy', 'Type: Limit', 'Price: 100.005', 'Amount: 0.000123 BTC']);

    expect(expired.label).toBe('Triggered stop expired');
    const expiredTp = describeEvent(
      row('order_rejected', {
        type: 'order_rejected',
        time: T,
        order: order({ side: 'sell', type: 'take_profit', price: null, triggerPrice: '90000', status: 'rejected' }),
        reason: 'Triggered take-profit expired: insufficient funds at execution',
        afterTrigger: true,
      }),
    );
    expect(expiredTp.label).toBe('Triggered take-profit expired');
    expect(expired.note?.text).toBe(
      'Triggered stop expired: insufficient funds at execution (need 1, available 0.5; trigger 80000, book average 79990.00)',
    );
  });

  it('stop triggered: trigger price and the last trade price that set it off', () => {
    const v = describeEvent(
      row('order_triggered', {
        type: 'order_triggered',
        time: T,
        order: order({ side: 'sell', type: 'stop_loss', price: null, triggerPrice: '80000', qty: '0.00121', status: 'triggered' }),
        lastPrice: '79999.99',
      }),
    );
    expect(v.label).toBe('Stop triggered');
    expect(v.tone).toBe('accent');
    expect(lines(v)).toEqual([
      'Side: Sell',
      'Type: Stop-loss',
      'Trigger: 80,000.00',
      'Amount: 0.00121 BTC',
      'Last trade: 79,999.99',
    ]);
    const tp = describeEvent(
      row('order_triggered', {
        type: 'order_triggered',
        time: T,
        order: order({ side: 'sell', type: 'take_profit', price: null, triggerPrice: '90000', status: 'triggered' }),
        lastPrice: '90000',
      }),
    );
    expect(tp.label).toBe('Take-profit triggered');
  });

  const fill = (f: Record<string, unknown> = {}) => ({
    id: 'f1',
    orderId: 'o1',
    symbol: 'BTCUSDT',
    side: 'buy',
    qty: '0.00122',
    price: '81382.0123',
    quote: '99.2860550',
    liquidity: 'taker',
    feeAsset: 'BTC',
    fee: '0.00000122',
    feeUsd: '0.0993',
    bestAtArrival: '81382.01',
    bestAtSubmit: '81380',
    slippageUsd: '0.0712',
    driftUsd: '0.0712',
    triggerPrice: null,
    realizedPnl: null,
    roundTripId: 'rt1',
    time: T,
    ...f,
  });

  it('fill (buy): best price at the time, slippage as a cost, drift in words, role and the fee with its dollar value', () => {
    const v = describeEvent(row('fill', { type: 'fill', time: T, fill: fill(), order: order({ type: 'market', status: 'filled' }) }));
    expect(v.label).toBe('Fill');
    expect(lines(v)).toEqual([
      'Side: Buy',
      'Type: Market',
      'Qty: 0.00122 BTC',
      'Price: 81,382.0123',
      'Best at the time: 81,382.01',
      'Slippage: $0.08',
      'Delay drift: cost $0.08',
      'Role: Taker',
      'Fee: 0.00000122 BTC ~$0.10',
    ]);
    expect(tone(v, 'Delay drift')).toBe('down');
  });

  it('a fill row rounds its slippage and fee value up to the cent', () => {
    const v = describeEvent(
      row('fill', { type: 'fill', time: T, fill: fill({ slippageUsd: '0.0149', feeUsd: '0.0101' }), order: order({ type: 'market', status: 'filled' }) }),
    );
    expect(lines(v)).toContain('Slippage: $0.02');
    expect(lines(v)).toContain('Fee: 0.00000122 BTC ~$0.02');
  });

  it('fill (sell from a stop): realised P&L signed, drift as a gain, the trigger price, fee in USDT', () => {
    const v = describeEvent(
      row('fill', {
        type: 'fill',
        time: T,
        fill: fill({
          side: 'sell',
          liquidity: 'maker',
          feeAsset: 'USDT',
          fee: '0.0984867',
          feeUsd: '0.0984867',
          slippageUsd: '0',
          driftUsd: '-0.026',
          triggerPrice: '81000',
          realizedPnl: '-1.2345',
        }),
        order: order({ side: 'sell', type: 'stop_loss', status: 'filled' }),
      }),
    );
    expect(lines(v)).toEqual([
      'Side: Sell',
      'Type: Stop-loss',
      'Qty: 0.00122 BTC',
      'Price: 81,382.0123',
      'Best at the time: 81,382.01',
      'Slippage: $0.00',
      'Delay drift: gain $0.02',
      'Role: Maker',
      'Fee: 0.0984867 USDT',
      'Realised P&L: -$1.23',
      'Trigger: 81,000.00',
    ]);
    expect(tone(v, 'Delay drift')).toBe('up');
    expect(tone(v, 'Realised P&L')).toBe('down');
    expect(tone(v, 'Slippage')).toBe('muted');
    const gain = describeEvent(
      row('fill', { type: 'fill', time: T, fill: fill({ side: 'sell', realizedPnl: '2.5', driftUsd: '0.001' }), order: order() }),
    );
    expect(lines(gain)).toContain('Realised P&L: +$2.50');
    // A cost under a cent still shows, rounded up; it is coloured as a cost.
    expect(lines(gain)).toContain('Delay drift: cost $0.01');
    expect(tone(gain, 'Delay drift')).toBe('down');
    expect(tone(gain, 'Realised P&L')).toBe('up');
  });

  it('a fill that leaves the order partly filled is labelled a partial fill', () => {
    const v = describeEvent(row('fill', { type: 'fill', time: T, fill: fill(), order: order({ status: 'partially_filled' }) }));
    expect(v.label).toBe('Partial fill');
  });

  it('round trip closed: opened, closed, hold time and P&L', () => {
    const opened = at(2026, 10, 18, 6, 59, 30);
    const v = describeEvent(
      row('round_trip_closed', {
        type: 'round_trip_closed',
        time: T,
        roundTrip: { id: 'rt1', symbol: 'BTCUSDT', openedAt: opened, closedAt: T, pnl: '3.456' },
      }),
    );
    expect(v.label).toBe('Round trip closed');
    expect(v.coin).toBe('BTC');
    expect(lines(v)).toEqual([
      'Opened: 18 Oct 2026 06:59:30',
      'Closed: 18 Oct 2026 09:05:07',
      'Hold time: 2h 05m',
      'P&L: +$3.46',
    ]);
    expect(tone(v, 'P&L')).toBe('up');
  });

  it('data gap: start, end, duration and the reason', () => {
    const start = at(2026, 10, 18, 9, 3, 2);
    const v = describeEvent(row('feed_gap', { startedAt: start, endedAt: T, reason: 'No depth update for 120 s' }, 'ETHUSDT'));
    expect(v.label).toBe('Data gap');
    expect(v.tone).toBe('accent');
    expect(v.coin).toBe('ETH');
    expect(lines(v)).toEqual(['Start: 18 Oct 2026 09:03:02', 'End: 18 Oct 2026 09:05:07', 'Duration: 2m 05s']);
    expect(v.note).toEqual({ label: 'Reason', text: 'No depth update for 120 s' });
  });

  it('a row whose payload cannot be read shows as unreadable instead of blanking the screen', () => {
    const v = describeEvent(row('order_placed', { type: 'order_placed', time: T }));
    expect(v.label).toBe('Unreadable event (order_placed)');
    expect(v.tone).toBe('down');
    expect(v.coin).toBe('BTC');
    expect(v.fields).toEqual([]);
    expect(v.note).toEqual({ label: 'Data', text: '{"type":"order_placed","time":' + T + '}' });
    expect(describeEvent(row('fill', null)).label).toBe('Unreadable event (fill)');
  });

  it('an unknown event type shows its type and a short raw JSON of the payload', () => {
    const v = describeEvent(row('season_reset', { applied: 'funding', amount: '1.5' }));
    expect(v.label).toBe('season_reset');
    expect(v.fields).toEqual([]);
    expect(v.note).toEqual({ label: 'Data', text: '{"applied":"funding","amount":"1.5"}' });
    const long = describeEvent(row('season_reset', { text: 'x'.repeat(500) }));
    expect(long.note?.text).toHaveLength(203);
    expect(long.note?.text.endsWith('...')).toBe(true);
  });
});

describe('history filters: the leverage side', () => {
  it('lists every event type of both markets, in one fixed order', () => {
    expect(EVENT_TYPES.map((t) => t.type)).toEqual([
      'deposit',
      'transfer',
      'leverage_set',
      'margin_changed',
      'order_placed',
      'order_cancelled',
      'cancel_rejected',
      'order_rejected',
      'order_triggered',
      'fill',
      'position_opened',
      'position_closed',
      'round_trip_closed',
      'funding',
      'liquidation',
      'feed_gap',
      'catch_up',
    ]);
    expect(parseFilters(new URLSearchParams('types=catch_up,funding,liquidation,position_closed')).types).toEqual([
      'position_closed',
      'funding',
      'liquidation',
      'catch_up',
    ]);
  });

  it('the Leverage market covers the perpetuals: a perp link is read as the leverage side', () => {
    expect(MARKET_FILTERS.map((m) => [m.value, m.label])).toEqual([
      ['spot', 'Spot'],
      ['leverage', 'Leverage'],
    ]);
    expect(MARKET_FILTERS.find((m) => m.value === 'leverage')?.title).toBe(
      'Perpetual orders, fills, positions, funding and liquidations, leverage-wallet deposits, and transfers',
    );
    expect(MARKET_FILTERS.find((m) => m.value === 'spot')?.title).toBe('Spot orders and fills, spot-wallet deposits, and transfers');
    expect(parseFilters(new URLSearchParams('market=perp')).market).toBe('leverage');
    expect(filterParams(parseFilters(new URLSearchParams('market=perp')))).toEqual({ market: 'leverage' });
    expect(historyQuery({ ...EMPTY_FILTERS, market: 'leverage' })).toEqual({ market: 'leverage', limit: 50 });
  });
});

describe('history rows: perpetuals, funding, liquidations and catch-up', () => {
  beforeEach(() => {
    setRules({ BTCUSDT: { tickSize: '0.01000000', stepSize: '0.00001000' } });
    setPerpRules({ BTCUSDT: { tickSize: '0.10', stepSize: '0.001' } });
  });
  afterEach(() => {
    setRules({});
    setPerpRules({});
  });

  const T = at(2026, 10, 18, 9, 5, 7);
  const GAP_FROM = at(2026, 10, 18, 9, 3, 2);
  const row = (type: string, payload: unknown, symbol: string | null = 'BTCUSDT', market: string | null = 'perp'): HistoryRow => ({
    id: 1,
    time: T,
    type,
    symbol,
    market,
    payload,
  });
  const perp = (type: string, payload: Record<string, unknown>) => row(type, { type, market: 'perp', time: T, ...payload });
  const order = (o: Record<string, unknown> = {}) => ({
    id: 'p1',
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'market',
    qty: '0.1',
    quoteQty: null,
    price: null,
    triggerPrice: null,
    reduceOnly: false,
    closePosition: false,
    leverage: 20,
    status: 'filled',
    filledQty: '0.1',
    filledQuote: '8000',
    fee: '4',
    lockAmount: '0',
    ocoGroupId: null,
    parentId: null,
    attach: null,
    createdAt: T,
    arrivesAt: T + 100,
    triggeredAt: null,
    cancelArrivesAt: null,
    bestAtSubmit: '80000',
    rejectReason: null,
    realizedPnl: '0',
    ...o,
  });
  const fill = (f: Record<string, unknown> = {}) => ({
    id: 'pf1',
    orderId: 'p1',
    symbol: 'BTCUSDT',
    side: 'buy',
    qty: '0.1',
    price: '80000',
    quote: '8000',
    liquidity: 'taker',
    feeAsset: 'USDT',
    fee: '4',
    feeUsd: '4',
    bestAtArrival: '80000',
    bestAtSubmit: '80000',
    slippageUsd: '0',
    driftUsd: '0',
    triggerPrice: null,
    realizedPnl: null,
    time: T,
    market: 'perp',
    positionId: 'pos1',
    marginIn: '396',
    uncovered: null,
    ...f,
  });
  const position = (p: Record<string, unknown> = {}) => ({
    id: 'pos1',
    symbol: 'BTCUSDT',
    side: 'long',
    qty: '0.1',
    entryPrice: '80000',
    leverage: 20,
    margin: '396',
    openedAt: at(2026, 10, 18, 7, 0, 0),
    realizedPnl: '0',
    fees: '4',
    funding: '0',
    warnLevel: 0,
    ...p,
  });

  it('every perp event is tagged Perp, every spot one Spot, account events neither', () => {
    expect(describeEvent(perp('position_opened', { position: position() })).market).toBe('Perp');
    expect(describeEvent(row('feed_gap', { startedAt: GAP_FROM, endedAt: T, reason: 'Mark price stale' })).market).toBe('Perp');
    expect(describeEvent(row('feed_gap', { startedAt: GAP_FROM, endedAt: T, reason: 'x' }, 'BTCUSDT', 'spot')).market).toBe('Spot');
    expect(
      describeEvent(row('deposit', { type: 'deposit', time: T, wallet: 'leverage', amount: '1', totalDeposited: '1' }, null, 'leverage'))
        .market,
    ).toBeNull();
  });

  it('perp order placed: side, type with reduce-only, price as sent, amount, leverage and its stops', () => {
    const v = describeEvent(
      perp('order_placed', {
        order: order({
          type: 'limit',
          price: '79000.15',
          status: 'pending',
          reduceOnly: true,
          attach: { stopLoss: '75000', takeProfit: null },
        }),
      }),
    );
    expect(v.label).toBe('Order placed');
    expect(v.coin).toBe('BTC');
    expect(lines(v)).toEqual([
      'Side: Buy',
      'Type: Limit, reduce-only',
      // As sent: never rounded onto the tick.
      'Price: 79,000.15',
      'Amount: 0.1 BTC',
      'Leverage: 20x',
      'Attached: SL 75,000.0',
    ]);
  });

  it('perp close-position stop: trigger, the whole position as its amount', () => {
    const v = describeEvent(
      perp('order_triggered', {
        order: order({ side: 'sell', type: 'stop_loss', qty: null, triggerPrice: '78000', closePosition: true, status: 'triggered' }),
        lastPrice: '77999.9',
      }),
    );
    expect(v.label).toBe('Stop triggered');
    expect(lines(v)).toEqual([
      'Side: Sell',
      'Type: Stop-loss, closes the position',
      'Trigger: 78,000.0',
      'Amount: Whole position',
      'Leverage: 20x',
      'Last trade: 77,999.9',
    ]);
  });

  it('perp order cancelled: the reason, and the quantity left unless it closed the whole position', () => {
    const limit = describeEvent(
      perp('order_cancelled', { order: order({ type: 'limit', price: '79000', status: 'cancelled' }), reason: 'liquidation', cancelledQty: '0.05' }),
    );
    expect(lines(limit)).toContain('Cancelled: liquidation');
    expect(lines(limit)).toContain('Cancelled qty: 0.05 BTC');
    const tp = describeEvent(
      perp('order_cancelled', {
        order: order({ side: 'sell', type: 'take_profit', qty: null, triggerPrice: '90000', closePosition: true, status: 'cancelled' }),
        reason: 'oco',
        cancelledQty: '0',
      }),
    );
    expect(lines(tp)).toEqual([
      'Side: Sell',
      'Type: Take-profit, closes the position',
      'Trigger: 90,000.0',
      'Amount: Whole position',
      'Leverage: 20x',
      'Cancelled: other leg of the pair triggered',
    ]);
  });

  it('perp opening fill: perp decimals, the fee in USDT and the margin it moved in', () => {
    const v = describeEvent(perp('fill', { fill: fill(), order: order() }));
    expect(v.label).toBe('Fill');
    expect(lines(v)).toEqual([
      'Side: Buy',
      'Type: Market',
      'Qty: 0.1 BTC',
      'Price: 80,000.000',
      'Best at the time: 80,000.0',
      'Slippage: $0.00',
      'Delay drift: $0.00',
      'Role: Taker',
      'Fee: 4 USDT ($4.00)',
      'Margin in (before fee): $396.00',
    ]);
    expect(v.note).toBeNull();
  });

  it('perp reducing fill: trading P&L rounded against the owner, and a loss nothing could cover', () => {
    const v = describeEvent(
      perp('fill', {
        fill: fill({ side: 'sell', marginIn: null, realizedPnl: '-12.341', uncovered: '1.001' }),
        order: order({ side: 'sell', reduceOnly: true }),
      }),
    );
    expect(lines(v)).toContain('Trading P&L: -$12.35');
    expect(lines(v)).toContain('Uncovered loss: $1.01');
    expect(lines(v).some((l) => l.startsWith('Margin in'))).toBe(false);
    expect(tone(v, 'Trading P&L')).toBe('down');
    expect(tone(v, 'Uncovered loss')).toBe('down');
    const gain = describeEvent(
      perp('fill', { fill: fill({ side: 'sell', marginIn: null, realizedPnl: '12.349' }), order: order({ side: 'sell' }) }),
    );
    expect(lines(gain)).toContain('Trading P&L: +$12.34');
  });

  it('a close held to the margin says the cap applied and shows the price without it', () => {
    const capped = describeEvent(
      perp('fill', {
        fill: fill({
          side: 'sell',
          price: '76040',
          marginIn: null,
          realizedPnl: '-396',
          fee: '0',
          bankruptcyCapped: true,
          uncappedPrice: '70000',
        }),
        order: order({ side: 'sell', type: 'stop_loss', closePosition: true, qty: null }),
      }),
    );
    expect(capped.note).toEqual({
      label: 'Capped',
      text:
        'Held to the position margin: filled at the bankruptcy price, 76,040.000, instead of 70,000.000, the price without the cap; the fee was cut to the 0 USDT the margin had left',
    });
    const feeCut = describeEvent(
      perp('fill', {
        fill: fill({ side: 'sell', price: '76100', marginIn: null, fee: '0.5', bankruptcyCapped: true, uncappedPrice: '76100' }),
        order: order({ side: 'sell' }),
      }),
    );
    expect(feeCut.note).toEqual({ label: 'Capped', text: 'Held to the position margin: the fee was cut to the 0.5 USDT the margin had left' });

    const closed = describeEvent(
      perp('position_closed', {
        position: position({ qty: '0', margin: '0', realizedPnl: '-396' }),
        exitPrice: '76040',
        realizedPnl: '-396',
        fees: '4',
        funding: '0',
        holdMs: 125_000,
        reason: 'stop_loss',
        bankruptcyCapped: true,
        uncappedPrice: '70000',
      }),
    );
    expect(closed.note).toEqual({
      label: 'Capped',
      text:
        'Held to the position margin: closed at the bankruptcy price, 76,040.000, instead of 70,000.000, the price without the cap; the closing fee was cut to what the margin had left',
    });
  });

  it('position opened: side, size, leverage, margin mode, entry and margin', () => {
    const v = describeEvent(perp('position_opened', { position: position() }));
    expect(v.label).toBe('Position opened');
    expect(v.coin).toBe('BTC');
    expect(lines(v)).toEqual([
      'Side: Long',
      'Size: 0.1 BTC',
      'Leverage: 20x',
      'Margin mode: Isolated',
      'Entry price: 80,000.000',
      'Margin: $396.00',
    ]);
    expect(tone(v, 'Side')).toBe('up');
    expect(tone(describeEvent(perp('position_opened', { position: position({ side: 'short' }) })), 'Side')).toBe('down');
  });

  it('position closed: entry, exit, trading P&L, fees, funding, net P&L, hold time and the reason', () => {
    const closed = (reason: string) =>
      describeEvent(
        perp('position_closed', {
          position: position({ qty: '0', margin: '0', realizedPnl: '150.5', fees: '8.004', funding: '-1.2' }),
          exitPrice: '81505',
          realizedPnl: '150.5',
          fees: '8.004',
          funding: '-1.2',
          holdMs: 2 * 3_600_000 + 5 * 60_000 + 7_000,
          reason,
        }),
      );
    const v = closed('take_profit');
    expect(v.label).toBe('Position closed');
    expect(lines(v)).toEqual([
      'Side: Long',
      'Leverage: 20x',
      'Margin mode: Isolated',
      'Entry price: 80,000.000',
      'Exit price: 81,505.000',
      'Trading P&L: +$150.50',
      'Fees: $8.01',
      'Funding: -$1.20',
      // 150.5 − 8.004 − 1.2 = 141.296: a gain is cut, never rounded up.
      'Net P&L: +$141.29',
      'Hold time: 2h 05m',
      'Reason: Take-profit',
    ]);
    expect(tone(v, 'Net P&L')).toBe('up');
    expect(lines(closed('closed'))).toContain('Reason: Closed by an order');
    expect(lines(closed('stop_loss'))).toContain('Reason: Stop-loss');
    const liq = closed('liquidated');
    expect(lines(liq)).toContain('Reason: Liquidated');
    expect(liq.tone).toBe('down');
  });

  it('leverage set: the new leverage', () => {
    const v = describeEvent(perp('leverage_set', { symbol: 'BTCUSDT', leverage: 25 }));
    expect(v.label).toBe('Leverage set');
    expect(v.coin).toBe('BTC');
    expect(lines(v)).toEqual(['Leverage: 25x']);
  });

  it('margin changed: added or removed, the amount, the margin after (a balance, cut) and the liquidation price', () => {
    const change = (c: Record<string, unknown>) =>
      describeEvent(
        perp('margin_changed', {
          symbol: 'BTCUSDT',
          side: 'long',
          action: 'add',
          amount: '50',
          marginAfter: '446.009',
          liquidationPriceAfter: '75845.3212345',
          ...c,
        }),
      );
    const v = change({});
    expect(v.label).toBe('Margin added');
    // A long's liquidation price is rounded up to the tick, a short's down: never further from the mark.
    expect(lines(v)).toEqual(['Amount: $50.00', 'Margin after: $446.00', 'Liquidation price after: 75,845.4']);
    expect(lines(change({ side: 'short', liquidationPriceAfter: '84154.6787' }))).toContain('Liquidation price after: 84,154.6');
    const out = change({ action: 'remove', amount: '20', marginAfter: '376', liquidationPriceAfter: null });
    expect(out.label).toBe('Margin removed');
    expect(lines(out)).toContain('Liquidation price after: None');
  });

  it('margin changed without its side (recorded before the side was kept): about the price, at the tick plus 2 decimals', () => {
    const legacy = (liq: string) =>
      describeEvent(
        perp('margin_changed', { symbol: 'BTCUSDT', action: 'remove', amount: '20', marginAfter: '426', liquidationPriceAfter: liq }),
      );
    // A real unrounded value from the engine.
    expect(lines(legacy('76044.17670682730923694779116465863453815'))).toContain('Liquidation price after: about 76,044.177');
    expect(lines(legacy('75843.37349397590361445783132530120481928'))).toContain('Liquidation price after: about 75,843.373');
  });

  it('margin changed before the perp tick has loaded: no liquidation price, never an unrounded one', () => {
    setPerpRules({});
    const row = (side: string | undefined) =>
      describeEvent(
        perp('margin_changed', {
          symbol: 'BTCUSDT',
          side,
          action: 'add',
          amount: '50',
          marginAfter: '446',
          liquidationPriceAfter: '76044.17670682730923694779116465863453815',
        }),
      );
    expect(lines(row('long'))).toContain('Liquidation price after: -');
    expect(lines(row(undefined))).toContain('Liquidation price after: -');
  });

  const funding = (f: Record<string, unknown> = {}) =>
    describeEvent(
      perp('funding', {
        symbol: 'BTCUSDT',
        positionId: 'pos1',
        fundingTime: at(2026, 10, 18, 9, 0, 0),
        rate: '0.0001',
        markPrice: '80000.04',
        qty: '0.1',
        side: 'long',
        amount: '-0.8001',
        target: 'margin',
        uncollected: null,
        ...f,
      }),
    );

  it('funding paid: the position, rate, mark, funding time and the amount, rounded as the notice rounds it', () => {
    const v = funding();
    expect(v.label).toBe('Funding paid');
    expect(lines(v)).toEqual([
      'Position: Long 0.1 BTC',
      'Rate: 0.0100%',
      'Mark price: 80,000.0',
      'Funding time: 18 Oct 2026 09:00:00',
      'Amount: -$0.81',
      'Taken from: Position margin (any shortfall from the leverage wallet)',
    ]);
    expect(tone(v, 'Amount')).toBe('down');
    const short = funding({ uncollected: '0.301', target: 'wallet', side: 'short' });
    expect(lines(short)).toContain('Taken from: Leverage wallet');
    expect(lines(short)).toContain('Not collected: $0.31');
  });

  it('funding received: the amount cut to the cent, paid into the leverage wallet', () => {
    const v = funding({ side: 'short', amount: '0.7999', target: 'wallet', rate: '-0.00005355' });
    expect(v.label).toBe('Funding received');
    expect(lines(v)).toContain('Rate: -0.0054%');
    expect(lines(v)).toContain('Amount: +$0.79');
    expect(lines(v)).toContain('Paid into: Leverage wallet');
    expect(tone(v, 'Amount')).toBe('up');
  });

  const liquidation = (l: Record<string, unknown> = {}) =>
    perp('liquidation', {
      symbol: 'BTCUSDT',
      position: position(),
      markPrice: '76345.38',
      marginLost: '396',
      tradingLoss: '365.462',
      liquidationFee: '25.4318',
      remainder: '5.1062',
      feeRateKnown: true,
      cancelledOrderIds: ['o1', 'o2'],
      ...l,
    });

  it('liquidation: the position, the mark, the margin lost and its split, the orders it cancelled', () => {
    const v = describeEvent(liquidation());
    expect(v.label).toBe('Liquidation');
    expect(v.tone).toBe('down');
    expect(lines(v)).toEqual([
      'Position: Long 0.1 BTC',
      'Leverage: 20x',
      'Entry price: 80,000.000',
      'Mark price: 76,345.4',
      'Margin lost: $396.00',
      // The parts add up to the margin lost: the fee and remainder rounded up, as the alert shows the fee.
      'Trading loss: $365.45',
      'Liquidation fee: $25.44',
      'Remainder: $5.11',
      'Orders cancelled: 2',
    ]);
    expect(v.note).toBeNull();
    const unknownFee = describeEvent(liquidation({ feeRateKnown: false, remainder: '0', cancelledOrderIds: [] }));
    expect(lines(unknownFee)).not.toContain('Orders cancelled: 0');
    expect(unknownFee.note).toEqual({
      label: 'Fee',
      text: 'The liquidation fee rate was not loaded: everything the trading loss left of the margin is shown as the fee',
    });
  });

  it('a liquidation row shows the same figures, rounded the same way, as its alert', () => {
    const r = liquidation({ markPrice: '76345.35', marginLost: '396.001', liquidationFee: '25.4301' });
    const v = describeEvent(r);
    const value = (label: string) => v.fields.find((f) => f.label === label)?.value;
    const p = r.payload as { markPrice: string; marginLost: string; liquidationFee: string };
    const html = renderToStaticMarkup(
      createElement(LiquidationAlertView, {
        detail: {
          symbol: 'BTCUSDT',
          side: 'long',
          qty: '0.1',
          markPrice: p.markPrice,
          marginLost: p.marginLost,
          liquidationFee: p.liquidationFee,
        },
        text: '',
        onAcknowledge: () => {},
      }),
    );
    expect(value('Mark price')).toBe('76,345.4');
    expect(value('Margin lost')).toBe('$396.01');
    expect(value('Liquidation fee')).toBe('$25.44');
    expect(html).toContain(`${value('Mark price')} USDT`);
    expect(html).toContain(`>${value('Margin lost')}<`);
    expect(html).toContain(`>${value('Liquidation fee')}<`);
  });

  it('catch-up: the gap and every action it applied, as listed', () => {
    const actions = [
      'Stop-loss filled 0.1 BTC at 76040, the bankruptcy price (worst price of 09:04 UTC was 70000; estimated)',
      'Take-profit cancelled: the other order of its pair triggered (estimated)',
    ];
    const v = describeEvent(
      row('catch_up', { type: 'catch_up', market: 'perp', symbol: 'BTCUSDT', time: T, from: GAP_FROM, to: T, actions }),
    );
    expect(v.label).toBe('Caught up');
    expect(v.tone).toBe('accent');
    expect(v.coin).toBe('BTC');
    expect(v.market).toBe('Perp');
    expect(lines(v)).toEqual(['Gap start: 18 Oct 2026 09:03:02', 'Gap end: 18 Oct 2026 09:05:07', 'Gap length: 2m 05s']);
    expect(v.list).toEqual({ label: 'Applied', items: actions });
    expect(v.note).toBeNull();
    const nothing = describeEvent(
      row(
        'catch_up',
        { type: 'catch_up', market: 'spot', symbol: 'BTCUSDT', time: T, from: GAP_FROM, to: T, actions: [] },
        'BTCUSDT',
        'spot',
      ),
    );
    expect(nothing.market).toBe('Spot');
    expect(nothing.list).toBeNull();
    expect(nothing.note).toEqual({ label: 'Applied', text: 'Nothing to apply' });
  });

  it('an event a catch-up produced carries an estimated badge with its basis and gap; a live one does not', () => {
    const tag = { from: GAP_FROM, to: T, basis: 'candle_worst_price' };
    const v = describeEvent(perp('fill', { fill: fill(), order: order(), catchUp: tag }));
    expect(v.estimated).toEqual({
      why: BASIS_WHY.candle_worst_price,
      gap: 'Data gap 18 Oct 2026 09:03:02 to 18 Oct 2026 09:05:07',
    });
    expect(describeEvent(perp('fill', { fill: fill(), order: order() })).estimated).toBeNull();
    // Spot events a catch-up produced too.
    const spotOrder = { ...order({ type: 'stop_loss', triggerPrice: '80000' }), lockAsset: 'BTC' };
    const spot = describeEvent(
      row('order_triggered', { type: 'order_triggered', time: T, order: spotOrder, lastPrice: '79990', catchUp: tag }, 'BTCUSDT', 'spot'),
    );
    expect(spot.estimated?.why).toBe(BASIS_WHY.candle_worst_price);
    // A basis this screen does not know still reads as estimated.
    const odd = describeEvent(perp('fill', { fill: fill(), order: order(), catchUp: { ...tag, basis: 'something_new' } }));
    expect(odd.estimated?.why).toBe('Estimated by the catch-up after a data gap.');
  });

  it('margin paid in is rounded up and named as before the fee; a position margin is a balance and is cut', () => {
    const fillRow = describeEvent(perp('fill', { fill: fill({ marginIn: '395.001' }), order: order() }));
    expect(lines(fillRow)).toContain('Margin in (before fee): $395.01');
    const opened = describeEvent(perp('position_opened', { position: position({ margin: '396.009' }) }));
    expect(lines(opened)).toContain('Margin: $396.00');
  });

  const cents = (v: string | undefined) => Math.round(Number((v ?? '').replace(/[$,]/g, '')) * 100);
  const split = (v: EventView) => {
    const at = (label: string) => cents(v.fields.find((f) => f.label === label)?.value);
    return { lost: at('Margin lost'), parts: at('Trading loss') + at('Liquidation fee') + at('Remainder') };
  };

  it('the liquidation split adds up to the margin lost, as shown', () => {
    const cases: Record<string, string>[] = [
      { marginLost: '395.21', tradingLoss: '364.6686747', liquidationFee: '30.5413253', remainder: '0' },
      { marginLost: '396', tradingLoss: '365.462', liquidationFee: '25.4318', remainder: '5.1062' },
      { marginLost: '10.001', tradingLoss: '0', liquidationFee: '10.001', remainder: '0' },
      { marginLost: '0.01', tradingLoss: '0', liquidationFee: '0.005', remainder: '0.005' },
      { marginLost: '1.23456789', tradingLoss: '1.00000001', liquidationFee: '0.11111111', remainder: '0.12345677' },
    ];
    for (const c of cases) {
      const v = describeEvent(liquidation(c));
      const { lost, parts } = split(v);
      expect(parts).toBe(lost);
      // Never a negative part.
      for (const label of ['Trading loss', 'Liquidation fee', 'Remainder']) {
        expect(v.fields.find((f) => f.label === label)?.value.startsWith('-')).toBe(false);
      }
    }
    const v = describeEvent(liquidation(cases[0]!));
    // The total and the fee as the alert shows them (rounded up); the trading loss takes the rest.
    expect(lines(v)).toContain('Margin lost: $395.21');
    expect(lines(v)).toContain('Liquidation fee: $30.55');
    expect(lines(v)).toContain('Trading loss: $364.66');
    expect(lines(v)).toContain('Remainder: $0.00');
  });

  describe('the notices and the history agree on every figure they share', () => {
    const lookup = {
      spotRules: () => null,
      perpRules: () => btcPerpRules,
      liquidationPrice: () => null,
    };
    const engineLiquidation = (markPrice: string, money = { marginLost: '396', tradingLoss: '365.462', liquidationFee: '25.4318', remainder: '5.1062' }) => ({
      type: 'liquidation' as const,
      market: 'perp' as const,
      time: T,
      symbol: 'BTCUSDT',
      position: {
        id: 'pos1',
        symbol: 'BTCUSDT',
        side: 'long' as const,
        qty: D('0.1'),
        entryPrice: D('80000'),
        leverage: 20,
        margin: D('396'),
        openedAt: T,
        realizedPnl: D('0'),
        fees: D('4'),
        funding: D('0'),
        warnLevel: 0 as const,
      },
      markPrice: D(markPrice),
      marginLost: D(money.marginLost),
      tradingLoss: D(money.tradingLoss),
      liquidationFee: D(money.liquidationFee),
      remainder: D(money.remainder),
      feeRateKnown: true,
      cancelledOrderIds: [],
    });
    const wire = (e: object) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

    it('a liquidation mark ending in 5 is rounded half up in both, grouped by thousands in both', () => {
      const e = engineLiquidation('76345.25');
      const [notice] = noticesFor([e], lookup);
      const v = describeEvent(perp('liquidation', wire(e)));
      const mark = v.fields.find((f) => f.label === 'Mark price')?.value;
      expect(mark).toBe('76,345.3');
      expect(notice!.text).toContain(`at mark ${mark} `);
      expect(notice!.text).toContain(`margin lost ${v.fields.find((f) => f.label === 'Margin lost')?.value}`);
      expect(notice!.text).toContain(`(fee ${v.fields.find((f) => f.label === 'Liquidation fee')?.value})`);
    });

    it('a margin lost and a fee of $1,000 or more read the same, grouped, in both', () => {
      const money = { marginLost: '8000', tradingLoss: '6765.439', liquidationFee: '1234.561', remainder: '0' };
      const e = engineLiquidation('76345.25', money);
      const [notice] = noticesFor([e], lookup);
      const v = describeEvent(perp('liquidation', wire(e)));
      const lost = v.fields.find((f) => f.label === 'Margin lost')?.value;
      const fee = v.fields.find((f) => f.label === 'Liquidation fee')?.value;
      expect([lost, fee]).toEqual(['$8,000.00', '$1,234.57']);
      expect(notice!.text).toBe(`LIQUIDATED: BTCUSDT long 0.1 at mark 76,345.3 — margin lost ${lost} (fee ${fee})`);
    });

    it('a funding rate on a half is rounded half up in both', () => {
      const e = {
        type: 'funding' as const,
        market: 'perp' as const,
        time: T,
        symbol: 'BTCUSDT',
        positionId: 'pos1',
        fundingTime: T,
        rate: D('0.0001225'),
        markPrice: D('80000'),
        qty: D('0.1'),
        side: 'long' as const,
        amount: D('-0.98'),
        target: 'margin' as const,
        uncollected: null,
      };
      const [notice] = noticesFor([e], lookup);
      const v = describeEvent(perp('funding', wire(e)));
      const rate = v.fields.find((f) => f.label === 'Rate')?.value;
      expect(rate).toBe('0.0123%');
      expect(notice!.text).toContain(`(rate ${rate})`);
      expect(notice!.text).toContain(`paid ${v.fields.find((f) => f.label === 'Amount')?.value.replace('-', '')}`);
    });

    it('a funding payment of $1,000 or more, rounded up and grouped in both', () => {
      const e = {
        type: 'funding' as const,
        market: 'perp' as const,
        time: T,
        symbol: 'BTCUSDT',
        positionId: 'pos1',
        fundingTime: T,
        rate: D('0.01'),
        markPrice: D('80000'),
        qty: D('1.5'),
        side: 'long' as const,
        amount: D('-1234.561'),
        target: 'margin' as const,
        uncollected: null,
      };
      const [notice] = noticesFor([e], lookup);
      const amount = describeEvent(perp('funding', wire(e))).fields.find((f) => f.label === 'Amount')?.value;
      expect(amount).toBe('-$1,234.57');
      expect(notice!.text).toContain(`paid ${amount!.replace('-', '')} on`);
    });
  });

  const bases: [string, string][] = [
    [
      'candle_worst_price',
      'Estimated from 1-minute price candles: the order is taken at the worst price of the minute in which the price reached it.',
    ],
    [
      'trigger_minute_worst_price',
      'Estimated from 1-minute price candles: the stop had already triggered, so it is filled at the worst price of its trigger minute.',
    ],
    ['mark_candle', 'Estimated from 1-minute mark-price candles: the mark reached the liquidation price within that minute.'],
    ['funding_history', 'Settled at the funding rate and mark price Binance published for a funding time inside the gap.'],
    ['aggtrade_replay', "Replayed from Binance's recorded trades of the gap, filling only where real trades went through the price."],
    [
      'history_unavailable',
      "Binance no longer had the gap's trades, so the resting order was cancelled at the start of the gap rather than guessed.",
    ],
    [
      'cancel_arrival',
      'Your cancel reached the exchange during the gap and was judged at its own arrival time: it cancelled the order, or arrived after the order had filled or triggered.',
    ],
  ];
  for (const [basis, why] of bases) {
    it(`estimated basis ${basis}: one plain sentence`, () => {
      expect(BASIS_WHY[basis as keyof typeof BASIS_WHY]).toBe(why);
      const v = describeEvent(perp('fill', { fill: fill(), order: order(), catchUp: { from: GAP_FROM, to: T, basis } }));
      expect(v.estimated?.why).toBe(why);
    });
  }

  it('the basis sentences cover every basis the engine defines, and no other', () => {
    const all: Record<CatchUpBasis, true> = {
      candle_worst_price: true,
      trigger_minute_worst_price: true,
      mark_candle: true,
      funding_history: true,
      aggtrade_replay: true,
      history_unavailable: true,
      cancel_arrival: true,
    };
    expect(Object.keys(BASIS_WHY).sort()).toEqual(Object.keys(all).sort());
    expect(bases.map(([b]) => b).sort()).toEqual(Object.keys(all).sort());
  });
});

describe("catch-up times in the browser's time zone", () => {
  // UTC+5:30: a time shown in it can never pass for the UTC one.
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const U = (h: number, m: number, sec = 0) => Date.UTC(2026, 9, 24, h, m, sec);
  const timed = [
    ['Stop-loss filled 0.5 BTC at 58,800 (worst price of ', { at: U(12, 4), seconds: false }, '; estimated)'],
    ['Cancel of limit buy arrived at ', { at: U(12, 4, 50), seconds: true }, ': order already filled (estimated)'],
  ];
  const actions = [
    'Stop-loss filled 0.5 BTC at 58,800 (worst price of 12:04 UTC; estimated)',
    'Cancel of limit buy arrived at 12:04:50 UTC: order already filled (estimated)',
  ];
  const summary = { type: 'catch_up', market: 'perp', symbol: 'BTCUSDT', time: U(12, 10), from: U(12, 0), to: U(12, 10), actions };
  const row = (payload: unknown): HistoryRow => ({ id: 1, time: U(12, 10), type: 'catch_up', symbol: 'BTCUSDT', market: 'perp', payload });

  it('the History row shows the gap and every time its lines name in local time', () => {
    const v = describeEvent(row({ ...summary, lines: timed }));
    expect(lines(v)).toEqual(['Gap start: 24 Oct 2026 17:30:00', 'Gap end: 24 Oct 2026 17:40:00', 'Gap length: 10m 00s']);
    expect(v.list).toEqual({
      label: 'Applied',
      items: [
        'Stop-loss filled 0.5 BTC at 58,800 (worst price of 17:34; estimated)',
        'Cancel of limit buy arrived at 17:34:50: order already filled (estimated)',
      ],
    });
  });

  it("the toast reads the same local times, and each of its lines is the History row's", () => {
    const msg = {
      type: 'notice' as const,
      kind: 'catch_up' as const,
      level: 'warn' as const,
      text: `Caught up BTCUSDT perp after the data gap 12:00–12:10 UTC: ${actions.join('; ')}`,
      catchUp: { market: 'perp' as const, symbol: 'BTCUSDT', from: U(12, 0), to: U(12, 10), lines: timed },
    };
    const text = (reduce(initialLiveData(), msg, U(12, 10)).notices ?? [])[0]!.text;
    expect(text).toBe(
      'Caught up BTCUSDT perp after the data gap 17:30–17:40: ' +
        'Stop-loss filled 0.5 BTC at 58,800 (worst price of 17:34; estimated); ' +
        'Cancel of limit buy arrived at 17:34:50: order already filled (estimated)',
    );
    for (const item of describeEvent(row({ ...summary, lines: timed })).list!.items) expect(text).toContain(item);
    const none = { ...msg, level: 'info' as const, catchUp: { ...msg.catchUp, market: 'spot' as const, lines: [] } };
    expect((reduce(initialLiveData(), none, U(12, 10)).notices ?? [])[0]!.text).toBe(
      'Caught up BTCUSDT after the data gap 17:30–17:40: nothing to apply',
    );
  });

  it('a summary recorded before its times were kept as data shows its stored text unchanged', () => {
    const v = describeEvent(row(summary));
    expect(v.list).toEqual({ label: 'Applied', items: actions });
    // And a notice without them (an older server) is shown as it was sent.
    const msg = { type: 'notice' as const, kind: 'catch_up' as const, level: 'warn' as const, text: 'Caught up BTCUSDT 12:00–12:10 UTC' };
    expect((reduce(initialLiveData(), msg, U(12, 10)).notices ?? [])[0]!.text).toBe(msg.text);
  });
});
