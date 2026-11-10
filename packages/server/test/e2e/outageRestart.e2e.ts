import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, floorMinute, grouped, MINUTE_MS } from '@sim/engine';
import { ServerProcess, startScenario, waitFor } from './harness.ts';
import type { LiveClient } from './harness.ts';
import { deposit, openPosition, position, waitOrderStatus } from './ops.ts';

const SYMBOL = 'BTCUSDT';
const TRIGGER = '79000';
const CATCHING_UP = 'Catching up after a data gap; trading resumes when it is done';
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

describe('e2e: an outage, and a restart during it', () => {
  let s: Awaited<ReturnType<typeof startScenario>>;
  let restarted: ServerProcess | null = null;
  let client: LiveClient | null = null;
  beforeAll(async () => {
    s = await startScenario();
  });
  afterAll(async () => {
    client?.close();
    await restarted?.kill();
    await s?.cleanup();
  });

  it('fills a spot stop and a perp stop-loss the gap went through, estimated at their minute’s worst price, after refusing orders while catching up', async () => {
    const { fake, server } = s;

    // A spot holding with a stop-loss, and a perp long with a stop-loss, both armed.
    await deposit(server, 'spot', '10000');
    const buy = (await server.ok('/api/orders', { symbol: SYMBOL, side: 'buy', type: 'market', qty: '0.05' })).order;
    await waitOrderStatus(server, 'spot', buy.id, ['filled']);
    const stop = (await server.ok('/api/orders', { symbol: SYMBOL, side: 'sell', type: 'stop_loss', qty: '0.04', triggerPrice: TRIGGER })).order;
    await waitOrderStatus(server, 'spot', stop.id, ['open']);
    await deposit(server, 'leverage', '1000');
    const pos = await openPosition(server, { symbol: SYMBOL, side: 'buy', qty: '0.01', leverage: 10 });
    const sl = (await server.ok('/api/perp/tpsl', { symbol: SYMBOL, stopLoss: `${TRIGGER}.0` })).orders[0];
    expect(sl.type).toBe('stop_loss');
    await waitOrderStatus(server, 'perp', sl.id, ['open']);
    const usdtBefore = D((await server.get('/api/account')).balances.spot.USDT.free);

    // Binance goes dark; the server sees both markets go stale.
    fake.outage();
    await s.client.waitForMessage('health', (h) => !h.markets['spot:BTCUSDT'].fresh && !h.markets['perp:BTCUSDT'].fresh, 10_000);

    // The price moves through both stops during the gap: only the history shows it.
    const prints: [string, string][] = [['79500', '79400'], ['78600', '78500'], ['78900', '78800']];
    const gapTrades: { spot: number; perp: number }[] = [];
    for (const [spot, perp] of prints) {
      const t = Date.now();
      fake.trade('spot', SYMBOL, spot, '0.3', { time: t });
      fake.trade('perp', SYMBOL, perp, '0.3', { time: t });
      gapTrades.push({ spot: t, perp: t });
      await new Promise((r) => setTimeout(r, 300));
    }
    fake.setMark(SYMBOL, { markPrice: '78800' });
    expect(fake.connections()).toBe(0);

    // The server is stopped during the outage; Binance comes back; the server starts again, its
    // history requests held so the catching-up stretch can be seen.
    await server.stop();
    fake.resume();
    fake.holdHistory();
    restarted = await ServerProcess.start({ fake, dir: s.tmp.dir, dbPath: s.tmp.dbPath });
    client = await restarted.client();
    const catching = await client.waitForMessage(
      'health',
      (h) => h.markets['spot:BTCUSDT'].catchingUp && h.markets['perp:BTCUSDT'].catchingUp,
      30_000,
    );
    expect(catching.catchingUp).toEqual(expect.arrayContaining(['spot:BTCUSDT', 'perp:BTCUSDT']));
    expect(catching.markets['spot:BTCUSDT'].fresh).toBe(true);

    // Orders are refused while catching up, in both markets.
    const spotTry = await restarted.post('/api/orders', { symbol: SYMBOL, side: 'buy', type: 'market', quoteQty: '100' });
    expect(spotTry).toEqual({ status: 409, body: { error: CATCHING_UP } });
    const perpTry = await restarted.post('/api/perp/orders', { symbol: SYMBOL, side: 'buy', type: 'market', qty: '0.001' });
    expect(perpTry).toEqual({ status: 409, body: { error: CATCHING_UP } });
    expect(fake.heldHistoryRequests()).toBeGreaterThan(0);

    const released = client.messages.length;
    fake.releaseHistory();
    const spotSummary = await client.waitForMessage('notice', (n) => n.kind === 'catch_up' && n.text.startsWith('Caught up BTCUSDT after'), 30_000, released);
    const perpSummary = await client.waitForMessage('notice', (n) => n.kind === 'catch_up' && n.text.startsWith('Caught up BTCUSDT perp after'), 30_000, released);
    await client.waitForMessage('health', (h) => !h.markets['spot:BTCUSDT'].catchingUp && !h.markets['perp:BTCUSDT'].catchingUp, 10_000, released);

    // The trigger minute is the minute of the first gap trade through the trigger price; the fill
    // is at that minute's low, the worst price for a sell.
    const expected = (market: 'spot' | 'perp') => {
      const through = fake.tradesOf(market, SYMBOL).find((t) => t.T >= gapTrades[0]![market] && D(t.p).lte(TRIGGER))!;
      const minute = floorMinute(through.T);
      return { minute, price: D(fake.candle(market, SYMBOL, minute)[2]) };
    };
    const spotX = expected('spot');
    const perpX = expected('perp');
    expect(spotX.price.eq('78600')).toBe(true);
    expect(perpX.price.eq('78500')).toBe(true);

    // Spot: the stop filled, estimated, at its minute's worst price.
    const spotFills = (await restarted.history({ market: 'spot', types: 'fill' })).filter((r) => r.payload.order.id === stop.id);
    expect(spotFills).toHaveLength(1);
    const sf = spotFills[0];
    expect(D(sf.payload.fill.price).eq(spotX.price)).toBe(true);
    expect(D(sf.payload.fill.qty).eq('0.04')).toBe(true);
    expect(sf.payload.catchUp?.basis).toBe('candle_worst_price');
    expect(sf.time).toBeGreaterThanOrEqual(spotX.minute);
    expect(sf.time).toBeLessThan(spotX.minute + MINUTE_MS);
    expect(spotSummary.text).toContain(`Stop-loss filled 0.04 BTC at ${grouped(spotX.price)} (worst price of ${hhmm(spotX.minute)} UTC; estimated)`);
    const proceeds = spotX.price.mul('0.04');
    // The taker fee, 0.1 %, in the USDT received.
    expect(sf.payload.fill.feeAsset).toBe('USDT');
    expect(D(sf.payload.fill.fee).eq(proceeds.mul('0.001'))).toBe(true);
    const usdtAfter = D((await restarted.get('/api/account')).balances.spot.USDT.free);
    expect(usdtAfter.eq(usdtBefore.plus(proceeds).minus(D(sf.payload.fill.fee)))).toBe(true);

    // Perp: the stop-loss closed the long, estimated, at its minute's worst price.
    const perpFills = (await restarted.history({ market: 'perp', types: 'fill' })).filter((r) => r.payload.order.id === sl.id);
    expect(perpFills).toHaveLength(1);
    const pf = perpFills[0];
    expect(D(pf.payload.fill.price).eq(perpX.price)).toBe(true);
    expect(D(pf.payload.fill.qty).eq('0.01')).toBe(true);
    expect(pf.payload.catchUp?.basis).toBe('candle_worst_price');
    expect(pf.time).toBeGreaterThanOrEqual(perpX.minute);
    expect(pf.time).toBeLessThan(perpX.minute + MINUTE_MS);
    expect(perpSummary.text).toContain(`at ${grouped(perpX.price)}`);
    expect(perpSummary.text).toContain('estimated');
    expect(await position(restarted, SYMBOL)).toBeNull();
    const closedAt = D(pos.entryPrice).minus(perpX.price).mul('0.01');
    expect(D(pf.payload.fill.realizedPnl).eq(closedAt.neg())).toBe(true);

    // The catch-up summaries are in the history too, with the gap they covered.
    const summaries = await restarted.history({ types: 'catch_up' });
    expect(summaries.map((r) => `${r.market}:${r.symbol}`).sort()).toEqual(['perp:BTCUSDT', 'spot:BTCUSDT']);
    for (const r of summaries) {
      expect(r.payload.from).toBeLessThanOrEqual(gapTrades[0]!.spot);
      expect(r.payload.to).toBeGreaterThan(gapTrades.at(-1)!.spot);
      expect(r.payload.actions.length).toBeGreaterThan(0);
    }

    // Live again: orders are taken.
    await waitFor('orders to be taken again', async () => {
      const r = await restarted!.post('/api/orders/preview', { symbol: SYMBOL, side: 'buy', type: 'market', quoteQty: '100' });
      return r.status === 200;
    });
  });
});
