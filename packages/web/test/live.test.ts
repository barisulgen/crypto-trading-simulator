import { describe, expect, it } from 'vitest';
import type { AccountSnapshot, ServerMessage, WireAggTrade } from '../src/lib/api.ts';
import { initialLiveData, reduce } from '../src/lib/live.ts';
import type { LiveData } from '../src/lib/live.ts';

const T0 = 1_700_000_000_000;

function apply(s: LiveData, msg: ServerMessage, now = T0): LiveData {
  return { ...s, ...reduce(s, msg, now) };
}

const account: AccountSnapshot = {
  spotUsdtFree: '1000',
  spotUsdtLocked: '0',
  leverageUsdt: '0',
  coins: [],
  total: '1000',
  totalDeposited: '1000',
  netPnl: '0',
  netPnlPct: '0',
  balances: {
    spot: { USDT: { free: '1000', locked: '0' } },
    leverage: { USDT: { free: '0', locked: '0' } },
  },
};

const trade = (id: number, price = '100'): WireAggTrade => ({ id, price, qty: '1', sellerInitiated: false, time: T0 + id });

describe('live store reducer', () => {
  it('applies the connect snapshot: tickers, health, account and open orders', () => {
    let s = initialLiveData();
    expect(s.selected).toEqual({ symbol: 'BTCUSDT', market: 'spot' });
    s = apply(s, { type: 'tickers', tickers: { BTCUSDT: { last: '67000.1', open24h: '66000', change24hPct: '1.5' } } });
    s = apply(s, { type: 'health', health: { BTCUSDT: { fresh: true, reason: null } } });
    s = apply(s, { type: 'account', account });
    s = apply(s, { type: 'orders', orders: [] });
    expect(s.tickers.BTCUSDT?.last).toBe('67000.1');
    expect(s.health.BTCUSDT).toEqual({ fresh: true, reason: null });
    expect(s.account?.total).toBe('1000');
    expect(s.orders).toEqual([]);
  });

  it('replaces tickers and account with each new message, keeping decimals as strings', () => {
    let s = apply(initialLiveData(), { type: 'tickers', tickers: { BTCUSDT: { last: '1', open24h: '1', change24hPct: '0' } } });
    s = apply(s, { type: 'tickers', tickers: { ETHUSDT: { last: '2450.10', open24h: '2400', change24hPct: '2.0875' } } });
    expect(Object.keys(s.tickers)).toEqual(['ETHUSDT']);
    expect(s.tickers.ETHUSDT?.last).toBe('2450.10');
    s = apply(s, { type: 'account', account: { ...account, total: '1012.345678901234567' } });
    expect(s.account?.total).toBe('1012.345678901234567');
  });

  it('keeps book and trades of the selected symbol only, newest trade first, without duplicates', () => {
    let s = initialLiveData();
    s = apply(s, { type: 'book', symbol: 'ETHUSDT', bids: [{ price: '1', qty: '1' }], asks: [] });
    expect(s.book).toBeNull();
    s = apply(s, { type: 'book', symbol: 'BTCUSDT', bids: [{ price: '99', qty: '2' }], asks: [{ price: '101', qty: '3' }] });
    expect(s.book).toEqual({ symbol: 'BTCUSDT', bids: [{ price: '99', qty: '2' }], asks: [{ price: '101', qty: '3' }] });
    s = apply(s, { type: 'trades', symbol: 'BTCUSDT', trades: [trade(3), trade(2), trade(1)] });
    s = apply(s, { type: 'trades', symbol: 'BTCUSDT', trades: [trade(4)] });
    s = apply(s, { type: 'trades', symbol: 'BTCUSDT', trades: [trade(4)] });
    s = apply(s, { type: 'trades', symbol: 'ETHUSDT', trades: [trade(9)] });
    expect(s.trades.map((t) => t.id)).toEqual([4, 3, 2, 1]);
  });

  it('adds notices and collapses an identical text arriving within 1 s', () => {
    let s = initialLiveData();
    const gap = { type: 'notice', kind: 'feed_gap', level: 'warn', text: 'Live data interrupted for BTCUSDT: silent' } as const;
    s = apply(s, gap, T0);
    s = apply(s, gap, T0 + 400);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ level: 'warn', text: gap.text, count: 2, at: T0 + 400 });
    s = apply(s, gap, T0 + 1500);
    expect(s.notices).toHaveLength(2);
    s = apply(s, { type: 'notice', kind: 'rejected', level: 'error', text: 'Insufficient funds' }, T0 + 1600);
    expect(s.notices.map((n) => n.level)).toEqual(['warn', 'warn', 'error']);
    expect(new Set(s.notices.map((n) => n.id)).size).toBe(3);
  });

  it('turns a server error message into an error notice', () => {
    const s = apply(initialLiveData(), { type: 'error', error: 'Unknown symbol FOO' });
    expect(s.notices[0]).toMatchObject({ level: 'error', text: 'Unknown symbol FOO' });
  });
});
