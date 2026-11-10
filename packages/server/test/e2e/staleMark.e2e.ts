import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, Decimal } from '@sim/engine';
import { allFresh, startScenario, waitFor } from './harness.ts';
import type { LiveClient } from './harness.ts';
import type { FakeBinance } from './fakeBinance.ts';
import { deposit, openPosition, position } from './ops.ts';

const SYMBOL = 'BTCUSDT';

/**
 * Sends a buyer-initiated trade that can fill nothing and waits until the client sees it: the
 * server handles a trade before relaying it, so everything sent before is handled by then.
 */
async function marker(fake: FakeBinance, client: LiveClient): Promise<void> {
  const from = client.messages.length;
  const id = fake.trade('perp', SYMBOL, '80000', '0.001', { sellerInitiated: false });
  await client.waitForMessage('trades', (m) => m.market === 'perp' && m.trades.some((t: any) => t.id === id), 5000, from);
}

describe('e2e: no liquidation while the mark price is stale', () => {
  let s: Awaited<ReturnType<typeof startScenario>>;
  beforeAll(async () => {
    s = await startScenario();
    s.client.subscribe('perp', SYMBOL);
    await deposit(s.server, 'leverage', '2000');
  });
  afterAll(async () => {
    await s?.cleanup();
  });

  it('trades through the liquidation price liquidate nothing while the mark stream is stopped, until a fresh mark beyond it arrives', async () => {
    const { fake, server, client } = s;
    const pos = await openPosition(server, { symbol: SYMBOL, side: 'buy', qty: '0.01', leverage: 50 });
    const liq = D(pos.liquidationPrice);
    expect(liq.gt('78000') && liq.lt('80000')).toBe(true);

    // The mark stream stops; trades and depth go on.
    const paused = client.messages.length;
    fake.pauseMarks(SYMBOL);
    const health = await client.waitForMessage(
      'health',
      (h) => h.markets['perp:BTCUSDT'].fresh === false && /mark price/i.test(h.markets['perp:BTCUSDT'].reason),
      20_000,
      paused,
    );
    expect(health.markets['perp:BTCUSDT'].reason).toBe('No mark price for 10s');
    // Only the mark is stale: the spot market and the other perps are live.
    expect(health.markets['spot:BTCUSDT'].fresh).toBe(true);
    expect(health.markets['perp:ETHUSDT'].fresh).toBe(true);
    const gap = await client.waitForMessage('notice', (n) => n.kind === 'feed_gap' && n.text.includes('BTCUSDT perp'), 5000, paused);
    expect(gap.text).toBe('Live data interrupted for BTCUSDT perp: No mark price for 10s');

    // The last trade price falls well through the liquidation price.
    const below = liq.minus(500).toDecimalPlaces(1, Decimal.ROUND_DOWN).toString();
    for (let i = 0; i < 5; i++) {
      fake.trade('perp', SYMBOL, below, '0.2');
      fake.depth('perp', SYMBOL, { b: [[below, '3']] });
    }
    await marker(fake, client);
    const held = await position(server, SYMBOL);
    expect(held).not.toBeNull();
    expect(held.markFresh).toBe(false);
    expect(D(held.markPrice).eq(pos.markPrice)).toBe(true);
    expect(client.notices('liquidation')).toHaveLength(0);
    expect(await server.history({ types: 'liquidation' })).toHaveLength(0);

    // A fresh mark beyond the liquidation price.
    const mark = liq.minus(20).toDecimalPlaces(1, Decimal.ROUND_DOWN);
    const resumed = client.messages.length;
    fake.pauseMarks(SYMBOL, false);
    fake.setMark(SYMBOL, { markPrice: mark.toString() });
    const n = await client.waitForMessage('notice', (m) => m.kind === 'liquidation', 10_000, resumed);
    expect(n.liquidation).toMatchObject({ symbol: SYMBOL, side: 'long', qty: '0.01', markPrice: mark.toString() });
    expect(n.text).not.toContain('catch-up');
    await waitFor('the position to be gone', async () => (await position(server, SYMBOL)) === null);
    const rows = await server.history({ types: 'liquidation' });
    expect(rows).toHaveLength(1);
    expect(D(rows[0].payload.markPrice).eq(mark)).toBe(true);
    expect(rows[0].payload.catchUp).toBeUndefined();
  });

  it('a mark update that arrives late, beyond the liquidation price, liquidates nothing; a current one does', async () => {
    const { fake, server, client } = s;
    // Back to the starting price and live again.
    const back = client.messages.length;
    fake.setMark(SYMBOL, { markPrice: '80000' });
    fake.trade('perp', SYMBOL, '80000', '0.1', { sellerInitiated: false });
    await client.waitForMessage('health', (h) => allFresh(h, ['perp:BTCUSDT']), 15_000, back);
    const pos = await openPosition(server, { symbol: SYMBOL, side: 'buy', qty: '0.01', leverage: 50 });
    const liq = D(pos.liquidationPrice);
    const beyond = liq.minus(20).toDecimalPlaces(1, Decimal.ROUND_DOWN).toString();

    // The stream goes quiet, and one update beyond the liquidation price arrives stamped 6 s ago:
    // past the 5 s the feed may lag, so the mark it carries is not fresh.
    fake.pauseMarks(SYMBOL);
    const late = client.messages.length;
    fake.sendMarkUpdate(SYMBOL, beyond, { eventLagMs: 6000 });
    const health = await client.waitForMessage('health', (h) => h.markets['perp:BTCUSDT'].fresh === false, 5000, late);
    expect(health.markets['perp:BTCUSDT'].reason).toMatch(/^Feed lagging by 6\.\ds$/);
    await marker(fake, client);
    const held = await position(server, SYMBOL);
    expect(held).not.toBeNull();
    // The server holds the late mark, and knows it is stale.
    expect(D(held.markPrice).eq(beyond)).toBe(true);
    expect(held.markFresh).toBe(false);
    expect(client.notices('liquidation')).toHaveLength(1);
    expect(await server.history({ types: 'liquidation' })).toHaveLength(1);

    // The same price, stamped now: liquidated at it.
    const current = client.messages.length;
    fake.sendMarkUpdate(SYMBOL, beyond);
    const n = await client.waitForMessage('notice', (m) => m.kind === 'liquidation', 10_000, current);
    expect(n.liquidation).toMatchObject({ symbol: SYMBOL, side: 'long', qty: '0.01', markPrice: beyond });
    await waitFor('the position to be gone', async () => (await position(server, SYMBOL)) === null);
    expect(await server.history({ types: 'liquidation' })).toHaveLength(2);
    fake.pauseMarks(SYMBOL, false);
  });
});

