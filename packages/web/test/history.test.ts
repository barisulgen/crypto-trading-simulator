import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryRow } from '../src/lib/api.ts';
import { setRules } from '../src/lib/format.ts';
import {
  EMPTY_FILTERS,
  describeEvent,
  filterParams,
  fmtDuration,
  historyQuery,
  localDayEnd,
  localDayStart,
  parseFilters,
} from '../src/lib/history.ts';
import type { EventView, HistoryFilters } from '../src/lib/history.ts';
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
      'Amount: 0.00020 BTC',
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
      'Amount: 0.00020 BTC',
      'Cancelled: by you',
      'Cancelled qty: 0.00015 BTC',
    ]);
    expect(lines(cancel('thin_book'))).toContain('Cancelled: book too thin');
    expect(lines(cancel('oco'))).toContain('Cancelled: other leg of the pair triggered');
    expect(lines(cancel('parent_cancelled'))).toContain('Cancelled: parent cancelled');
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
    expect(lines(v)).toEqual(['Side: Buy', 'Type: Post-only', 'Price: 81,400.00', 'Amount: 0.00020 BTC']);
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
      'Slippage: $0.07',
      'Delay drift: cost $0.07',
      'Role: Taker',
      'Fee: 0.00000122 BTC ~$0.10',
    ]);
    expect(tone(v, 'Delay drift')).toBe('down');
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
      'Delay drift: gain $0.03',
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
    expect(lines(gain)).toContain('Delay drift: $0.00');
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

  it('feed gap: start, end, duration and the reason', () => {
    const start = at(2026, 10, 18, 9, 3, 2);
    const v = describeEvent(row('feed_gap', { startedAt: start, endedAt: T, reason: 'No depth update for 120 s' }, 'ETHUSDT'));
    expect(v.label).toBe('Feed gap');
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
    const v = describeEvent(row('catch_up', { applied: 'funding', amount: '1.5' }));
    expect(v.label).toBe('catch_up');
    expect(v.fields).toEqual([]);
    expect(v.note).toEqual({ label: 'Data', text: '{"applied":"funding","amount":"1.5"}' });
    const long = describeEvent(row('catch_up', { text: 'x'.repeat(500) }));
    expect(long.note?.text).toHaveLength(203);
    expect(long.note?.text.endsWith('...')).toBe(true);
  });
});
