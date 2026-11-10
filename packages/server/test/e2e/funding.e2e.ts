import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, Decimal } from '@sim/engine';
import { startScenario, waitFor } from './harness.ts';
import { deposit, openPosition, position } from './ops.ts';

const RATE = '0.00012345';
const SETTLED = { BTCUSDT: '80123.45678', ETHUSDT: '3001.2345' };

describe('e2e: a funding settlement on positions open across the funding time', () => {
  let s: Awaited<ReturnType<typeof startScenario>>;
  beforeAll(async () => {
    s = await startScenario(['perp:BTCUSDT', 'perp:ETHUSDT']);
  });
  afterAll(async () => {
    await s?.cleanup();
  });

  it('a long pays (rounded up) and a short receives (rounded down) qty × settlement mark × rate; notice, position and history agree', async () => {
    const { fake, server, client } = s;
    await deposit(server, 'leverage', '2000');
    const long = await openPosition(server, { symbol: 'BTCUSDT', side: 'buy', qty: '0.01', leverage: 10 });
    const short = await openPosition(server, { symbol: 'ETHUSDT', side: 'sell', qty: '0.5', leverage: 10 });
    expect([long.side, short.side]).toEqual(['long', 'short']);
    const marginBefore = D(long.margin);
    const freeBefore = D((await server.get('/api/account')).balances.leverage.USDT.free);

    // The next funding time, a few seconds ahead; its window opens at once.
    const T = Math.ceil((Date.now() + 3000) / 1000) * 1000;
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) fake.setMark(symbol, { nextFundingTime: T, fundingRate: RATE });
    await waitFor('the funding time to pass', () => Date.now() > T + 200, 10_000);
    for (const [symbol, markPrice] of Object.entries(SETTLED)) fake.publishFunding(symbol, { fundingTime: T, rate: RATE, markPrice });

    // The window closes 15 s after T; the settlement is polled 30 s after that.
    await waitFor('both funding notices', () => client.notices('funding').length >= 2 || undefined, 60_000, 200);
    const paid = D('0.01').mul(SETTLED.BTCUSDT).mul(RATE);
    const received = D('0.5').mul(SETTLED.ETHUSDT).mul(RATE);
    const paidAmount = paid.toDecimalPlaces(8, Decimal.ROUND_UP);
    const receivedAmount = received.toDecimalPlaces(8, Decimal.ROUND_DOWN);
    // Chosen so the rounding direction shows at cents: 0.0989… pays $0.10, 0.1852… receives $0.18.
    expect(paid.toFixed(2, Decimal.ROUND_DOWN)).toBe('0.09');
    expect(received.toFixed(2, Decimal.ROUND_UP)).toBe('0.19');
    expect(client.notices('funding').map((n) => n.text).sort()).toEqual([
      'Funding paid $0.10 on BTCUSDT long (rate 0.0123%)',
      'Funding received $0.18 on ETHUSDT short (rate 0.0123%)',
    ]);

    const rows = await server.history({ market: 'perp', types: 'funding' });
    expect(rows).toHaveLength(2);
    const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r.payload]));
    expect(bySymbol.BTCUSDT).toMatchObject({ side: 'long', fundingTime: T, target: 'margin', uncollected: null, positionId: long.id });
    expect(D(bySymbol.BTCUSDT.amount).eq(paidAmount.neg())).toBe(true);
    expect(D(bySymbol.BTCUSDT.qty).eq('0.01')).toBe(true);
    expect(D(bySymbol.BTCUSDT.markPrice).eq(SETTLED.BTCUSDT)).toBe(true);
    expect(D(bySymbol.BTCUSDT.rate).eq(RATE)).toBe(true);
    expect(bySymbol.ETHUSDT).toMatchObject({ side: 'short', fundingTime: T, target: 'wallet', uncollected: null, positionId: short.id });
    expect(D(bySymbol.ETHUSDT.amount).eq(receivedAmount)).toBe(true);
    expect(D(bySymbol.ETHUSDT.qty).eq('0.5')).toBe(true);
    expect(D(bySymbol.ETHUSDT.markPrice).eq(SETTLED.ETHUSDT)).toBe(true);

    // The positions show the same figures: the payment came out of the long's margin, the receipt
    // went to the wallet.
    const btc = await position(server, 'BTCUSDT');
    const eth = await position(server, 'ETHUSDT');
    expect(D(btc.funding).eq(paidAmount.neg())).toBe(true);
    expect(D(btc.margin).eq(marginBefore.minus(paidAmount))).toBe(true);
    expect(D(eth.funding).eq(receivedAmount)).toBe(true);
    const freeAfter = D((await server.get('/api/account')).balances.leverage.USDT.free);
    expect(freeAfter.eq(freeBefore.plus(receivedAmount))).toBe(true);
    // Settled once: no second poll applies it again.
    expect(fake.requests.filter((r) => r.path === '/fapi/v1/fundingRate').length).toBeGreaterThanOrEqual(2);
    expect((await server.history({ market: 'perp', types: 'funding' })).length).toBe(2);
  });
});
