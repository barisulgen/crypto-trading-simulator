import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, Meta, ServerMessage, WireAggTrade, WireOrder } from '../src/lib/api.ts';
import { initialLiveData, reduce, useLive } from '../src/lib/live.ts';
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
  pricesPaused: [],
  balances: {
    spot: { USDT: { free: '1000', locked: '0' } },
    leverage: { USDT: { free: '0', locked: '0' } },
  },
  basis: {},
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

  it('keeps at most 50 notices, dropping the oldest', () => {
    let s = initialLiveData();
    for (let i = 1; i <= 60; i++) s = apply(s, { type: 'notice', kind: 'fill', level: 'info', text: `Fill ${i}` }, T0 + i * 5000);
    expect(s.notices).toHaveLength(50);
    expect(s.notices[0]?.text).toBe('Fill 11');
    expect(s.notices[49]?.text).toBe('Fill 60');
  });

  it('collapses an error into the identical error still on screen, however late it comes', () => {
    let s = initialLiveData();
    const err = { type: 'error', error: 'Could not load market rules: Cannot reach the server' } as const;
    s = apply(s, err, T0);
    s = apply(s, err, T0 + 30_000);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ level: 'error', count: 2, at: T0 + 30_000 });
    // Once dismissed, the next one shows again.
    s = { ...s, notices: [] };
    s = apply(s, err, T0 + 60_000);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]?.count).toBe(1);
  });

  it('turns a server error message into an error notice', () => {
    const s = apply(initialLiveData(), { type: 'error', error: 'Unknown symbol FOO' });
    expect(s.notices[0]).toMatchObject({ level: 'error', text: 'Unknown symbol FOO' });
  });
  it('counts fill and partial-fill notices so the chart can reload its fill markers', () => {
    let s = initialLiveData();
    expect(s.fillSeq).toBe(0);
    s = apply(s, { type: 'notice', kind: 'fill', level: 'info', text: 'Bought 0.001 BTC' }, T0);
    s = apply(s, { type: 'notice', kind: 'fill', level: 'info', text: 'Bought 0.001 BTC' }, T0 + 100);
    s = apply(s, { type: 'notice', kind: 'partial_fill', level: 'info', text: 'Partial fill: Sold 1 ETH' }, T0 + 200);
    s = apply(s, { type: 'notice', kind: 'rejected', level: 'error', text: 'Insufficient funds' }, T0 + 300);
    // The second identical fill is collapsed into one toast but is still a new fill.
    expect(s.fillSeq).toBe(3);
  });

  it('also bumps fillSeq when open orders or their filled quantities change, not on identical pushes', () => {
    const order = (id: string, filledQty: string, status = 'open') => ({ id, filledQty, status }) as unknown as WireOrder;
    let s = initialLiveData();
    s = apply(s, { type: 'orders', orders: [] });
    expect(s.fillSeq).toBe(0);
    s = apply(s, { type: 'orders', orders: [order('a', '0')] });
    expect(s.fillSeq).toBe(1);
    s = apply(s, { type: 'orders', orders: [order('a', '0')] });
    expect(s.fillSeq).toBe(1);
    s = apply(s, { type: 'orders', orders: [order('a', '0.5', 'partially_filled')] });
    expect(s.fillSeq).toBe(2);
    // A resting limit that filled while we were offline: it simply disappears from the open set.
    s = apply(s, { type: 'orders', orders: [] });
    expect(s.fillSeq).toBe(3);
  });

  it('bumps fillSeq when wallet balances change, but not on the 1 s account push with only prices moving', () => {
    let s = apply(initialLiveData(), { type: 'account', account });
    expect(s.fillSeq).toBe(0);
    s = apply(s, { type: 'account', account: { ...account, total: '1001.5', netPnl: '1.5' } });
    expect(s.fillSeq).toBe(0);
    const bought: AccountSnapshot = {
      ...account,
      balances: { ...account.balances, spot: { USDT: { free: '950', locked: '0' }, BTC: { free: '0.0006', locked: '0' } } },
    };
    s = apply(s, { type: 'account', account: bought });
    expect(s.fillSeq).toBe(1);
    s = apply(s, { type: 'account', account: { ...bought, total: '999' } });
    expect(s.fillSeq).toBe(1);
  });
});

describe('live store actions', () => {
  it('priceClicked records the clicked book price with a new sequence number each time', () => {
    expect(useLive.getState().priceClick).toBeNull();
    useLive.getState().priceClicked('81232.01');
    const first = useLive.getState().priceClick;
    expect(first?.price).toBe('81232.01');
    useLive.getState().priceClicked('81232.01');
    expect(useLive.getState().priceClick?.price).toBe('81232.01');
    expect(useLive.getState().priceClick?.seq).toBe((first?.seq ?? 0) + 1);
  });
});

/** A socket the test drives by hand; close() only starts closing, as a real dead one would. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
    this.readyState = FakeSocket.CLOSING;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  say(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const metaWith = (rules: string[]) =>
  ({ coins: [], symbols: ['BTCUSDT', 'DOGEUSDT'], rules: Object.fromEntries(rules.map((r) => [r, {}])) }) as unknown as Meta;

async function freshLive(meta: () => Meta) {
  vi.resetModules();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
  vi.stubGlobal('window', { addEventListener: () => {} });
  const mod = await import('../src/lib/live.ts');
  const apiMod = await import('../src/lib/api.ts');
  const metaCalls = vi.spyOn(apiMod.api, 'meta').mockImplementation(async () => meta());
  return { ...mod, metaCalls };
}

describe('live connection', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a socket that goes silent for 5 s is marked down, closed and replaced', async () => {
    const { startLive, useLive } = await freshLive(() => metaWith(['BTCUSDT', 'DOGEUSDT']));
    startLive();
    const first = FakeSocket.all[0]!;
    first.open();
    expect(useLive.getState().conn).toBe('open');
    await vi.advanceTimersByTimeAsync(4999);
    expect(useLive.getState().conn).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(useLive.getState().conn).toBe('down');
    expect(first.closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('a connection that held for a while and then went silent reconnects after the shortest delay', async () => {
    const { startLive, useLive } = await freshLive(() => metaWith(['BTCUSDT', 'DOGEUSDT']));
    startLive();
    const first = FakeSocket.all[0]!;
    first.open();
    first.onclose?.(); // accepted, then dropped at once: the backoff doubles to 2 s
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1]!;
    second.open();
    for (let t = 0; t < 6000; t += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      second.say({ type: 'tickers', tickers: {} });
    }
    await vi.advanceTimersByTimeAsync(5000); // silent: dropped
    expect(useLive.getState().conn).toBe('down');
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('a connection dropped for silence before it held keeps the backoff growing', async () => {
    const { startLive } = await freshLive(() => metaWith(['BTCUSDT', 'DOGEUSDT']));
    startLive();
    const first = FakeSocket.all[0]!;
    first.open();
    first.onclose?.(); // the backoff doubles to 2 s
    await vi.advanceTimersByTimeAsync(1000);
    FakeSocket.all[1]!.open();
    await vi.advanceTimersByTimeAsync(5000); // silent from the start: dropped after 5 s, before it held
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('a message resets the silence timer', async () => {
    const { startLive, useLive } = await freshLive(() => metaWith(['BTCUSDT', 'DOGEUSDT']));
    startLive();
    const ws = FakeSocket.all[0]!;
    ws.open();
    await vi.advanceTimersByTimeAsync(4999);
    ws.say({ type: 'tickers', tickers: {} });
    await vi.advanceTimersByTimeAsync(4999);
    expect(useLive.getState().conn).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(useLive.getState().conn).toBe('down');
  });

  it('reconnectNow replaces a socket that is not open', async () => {
    const { startLive, reconnectNow } = await freshLive(() => metaWith(['BTCUSDT', 'DOGEUSDT']));
    startLive();
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.readyState = FakeSocket.CLOSING;
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(2);
    // An open socket is kept.
    FakeSocket.all[1]!.open();
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('missing rules are refetched on health messages, at most every 5 s, until complete', async () => {
    let complete = false;
    const { startLive, metaCalls } = await freshLive(() =>
      complete ? metaWith(['BTCUSDT', 'DOGEUSDT']) : metaWith(['BTCUSDT']),
    );
    startLive();
    const ws = FakeSocket.all[0]!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    const health = { type: 'health', health: {} };
    const keepAlive = async (ms: number) => {
      for (let t = 0; t < ms; t += 1000) {
        await vi.advanceTimersByTimeAsync(1000);
        ws.say({ type: 'tickers', tickers: {} });
      }
    };
    await keepAlive(4000);
    await keepAlive(2000); // 6 s after the open fetch
    metaCalls.mockClear();
    ws.say(health);
    await keepAlive(1000);
    ws.say(health);
    await vi.advanceTimersByTimeAsync(0);
    expect(metaCalls).toHaveBeenCalledTimes(1);
    await keepAlive(4000);
    ws.say(health);
    await vi.advanceTimersByTimeAsync(0);
    expect(metaCalls).toHaveBeenCalledTimes(2);
    complete = true;
    await keepAlive(5000);
    ws.say(health);
    await vi.advanceTimersByTimeAsync(0);
    expect(metaCalls).toHaveBeenCalledTimes(3);
    await keepAlive(5000);
    ws.say(health);
    await vi.advanceTimersByTimeAsync(0);
    expect(metaCalls).toHaveBeenCalledTimes(3);
  });
});
