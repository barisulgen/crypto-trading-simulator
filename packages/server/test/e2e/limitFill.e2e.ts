import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@sim/engine';
import { startScenario } from './harness.ts';
import { deposit, findOrder, position, waitOrderStatus } from './ops.ts';

const SYMBOL = 'BTCUSDT';
const LIMIT = '79900.0';
const QTY = '0.02';

describe('e2e: a perp limit buy fills only on a trade through its price', () => {
  let s: Awaited<ReturnType<typeof startScenario>>;
  beforeAll(async () => {
    s = await startScenario();
  });
  afterAll(async () => {
    await s?.cleanup();
  });

  it('rests through trades at its price, then fills at its own price with the maker fee', async () => {
    const { fake, server, client } = s;
    client.subscribe('perp', SYMBOL);
    await deposit(server, 'leverage', '1000');
    await server.ok('/api/perp/leverage', { symbol: SYMBOL, leverage: 10 });
    const { order } = await server.ok('/api/perp/orders', { symbol: SYMBOL, side: 'buy', type: 'limit', qty: QTY, price: LIMIT });
    expect(order.status).toBe('pending');
    await waitOrderStatus(server, 'perp', order.id, ['open']);

    // Sellers hit bids at exactly the limit price, more than its size in all: a touch, no fill.
    const fromTouch = client.messages.length;
    for (let i = 0; i < 4; i++) fake.trade('perp', SYMBOL, LIMIT, '0.05', { sellerInitiated: true });
    // A buyer lifting an offer below the price is no trade-through for a buy either.
    const last = fake.trade('perp', SYMBOL, '79899.0', '0.05', { sellerInitiated: false });
    // The server handles a trade before relaying it: once the last is relayed, all were handled.
    await client.waitForMessage('trades', (m) => m.market === 'perp' && m.trades.some((t: any) => t.id === last), 5000, fromTouch);
    const resting = await findOrder(server, 'perp', order.id);
    expect(resting.status).toBe('open');
    expect(D(resting.filledQty).isZero()).toBe(true);
    expect(await position(server, SYMBOL)).toBeNull();
    expect(client.notices('fill')).toHaveLength(0);
    expect((await server.get(`/api/fills?market=perp`)).fills).toHaveLength(0);

    // One seller-initiated trade a tick below: through the price.
    fake.trade('perp', SYMBOL, '79899.9', '0.03', { sellerInitiated: true });
    const filled = await waitOrderStatus(server, 'perp', order.id, ['filled']);
    expect(D(filled.filledQty).eq(QTY)).toBe(true);

    const { fills } = await server.get(`/api/fills?market=perp`);
    expect(fills).toHaveLength(1);
    const f = fills[0];
    expect(f.orderId).toBe(order.id);
    expect(D(f.price).eq(LIMIT)).toBe(true);
    expect(D(f.qty).eq(QTY)).toBe(true);
    expect(f.liquidity).toBe('maker');
    const meta = await server.get('/api/meta');
    expect(meta.fees.perp.maker).toBe('0.0002');
    expect(D(f.fee).eq(D(LIMIT).mul(QTY).mul(meta.fees.perp.maker))).toBe(true);
    expect(f.fee).toBe('0.3196');

    const pos = await position(server, SYMBOL);
    expect(pos).toMatchObject({ side: 'long' });
    expect(D(pos.qty).eq(QTY)).toBe(true);
    expect(D(pos.entryPrice).eq(LIMIT)).toBe(true);
    expect(D(pos.fees).eq(f.fee)).toBe(true);

    const notice = await client.waitForMessage('notice', (m) => m.kind === 'fill');
    expect(notice.text).toMatch(/^Opened long 0\.02 BTC @ 79,900\.0 · fee \$0\.32 · liq /);
    const rows = await server.history({ market: 'perp', types: 'fill' });
    expect(rows).toHaveLength(1);
    expect(D(rows[0].payload.fill.price).eq(LIMIT)).toBe(true);
    expect(rows[0].payload.fill.liquidity).toBe('maker');
  });
});
