import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, Decimal } from '@sim/engine';
import { startScenario, waitFor } from './harness.ts';
import { deposit, openPosition, position } from './ops.ts';

const SYMBOL = 'BTCUSDT';

describe('e2e: no liquidation while the mark price is stale', () => {
  let s: Awaited<ReturnType<typeof startScenario>>;
  beforeAll(async () => {
    s = await startScenario();
  });
  afterAll(async () => {
    await s?.cleanup();
  });

  it('trades through the liquidation price liquidate nothing until a fresh mark beyond it arrives', async () => {
    const { fake, server, client } = s;
    client.subscribe('perp', SYMBOL);
    await deposit(server, 'leverage', '1000');
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
    const from = client.messages.length;
    for (let i = 0; i < 5; i++) {
      fake.trade('perp', SYMBOL, below, '0.2');
      fake.depth('perp', SYMBOL, { b: [[below, '3']] });
      await new Promise((r) => setTimeout(r, 200));
    }
    await client.waitForMessage('trades', (m) => m.market === 'perp' && m.trades.some((t: any) => D(t.price).eq(below)), 5000, from);
    // The hub relays a trade after the runner has handled it; a moment more for any timer-driven call.
    await new Promise((r) => setTimeout(r, 500));
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
});
