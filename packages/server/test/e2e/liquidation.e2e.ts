import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, Decimal } from '@sim/engine';
import { startScenario, waitFor } from './harness.ts';
import { deposit, longMarkAtRatio, openPosition, position } from './ops.ts';

const SYMBOL = 'BTCUSDT';
const TICK = D('0.1');

describe('e2e: the mark price falls through a long’s liquidation price', () => {
  let s: Awaited<ReturnType<typeof startScenario>>;
  beforeAll(async () => {
    s = await startScenario();
  });
  afterAll(async () => {
    await s?.cleanup();
  });

  it('warns at 50, 80 and 90 %, then liquidates with the structured detail, the history split and the wallet untouched', async () => {
    const { fake, server, client } = s;
    client.subscribe('perp', SYMBOL);
    await deposit(server, 'leverage', '1000');
    const pos = await openPosition(server, { symbol: SYMBOL, side: 'buy', qty: '0.01', leverage: 50 });
    expect(pos.side).toBe('long');
    const freeAfterOpen = D((await server.get('/api/account')).balances.leverage.USDT.free);
    // The whole 1000 less the margin and the opening fee: nothing else is held.
    expect(freeAfterOpen.plus(pos.margin).plus(pos.fees).toString()).toBe('1000');

    const meta = await server.get('/api/meta');
    const bracket = meta.perp[SYMBOL].brackets[0];
    const mmr = D(bracket.mmr);
    expect(D(bracket.cum).isZero()).toBe(true);
    const liq = D(pos.liquidationPrice);

    // A mark one tick past each level (rounded down, so the ratio is at or past it).
    const markFor = (ratio: string) => longMarkAtRatio(pos, D(ratio), mmr).toDecimalPlaces(1, Decimal.ROUND_DOWN);
    const steps: { ratio: string; level: 'warn' | 'error' }[] = [
      { ratio: '0.5', level: 'warn' },
      { ratio: '0.8', level: 'error' },
      { ratio: '0.9', level: 'error' },
    ];
    for (const step of steps) {
      const mark = markFor(step.ratio);
      expect(mark.gt(liq)).toBe(true);
      const from = client.messages.length;
      fake.setMark(SYMBOL, { markPrice: mark.toString() });
      const n = await client.waitForMessage('notice', (m) => m.kind === 'margin_warning', 10_000, from);
      expect(n.level).toBe(step.level);
      const shown = D(/Margin ratio ([\d.]+)% on BTCUSDT long/.exec(n.text)![1]!);
      expect(shown.gte(D(step.ratio).mul(100))).toBe(true);
      expect(shown.lt(D(step.ratio).mul(100).plus(1))).toBe(true);
      expect(n.text).toContain(`liquidation at ${liq.toDecimalPlaces(1, Decimal.ROUND_UP).toFixed(1)}`);
    }
    const warnings = client.notices('margin_warning');
    expect(warnings.map((w) => w.level)).toEqual(['warn', 'error', 'error']);
    expect(warnings.map((w) => /Margin ratio ([\d.]+)%/.exec(w.text)![1]).map(Number)).toEqual(
      [...warnings.map((w) => Number(/Margin ratio ([\d.]+)%/.exec(w.text)![1]))].sort((a, b) => a - b),
    );
    expect(client.notices('liquidation')).toHaveLength(0);
    expect(await position(server, SYMBOL)).not.toBeNull();

    // Through the liquidation price.
    const crash = liq.minus(TICK.mul(50)).toDecimalPlaces(1, Decimal.ROUND_DOWN);
    fake.setMark(SYMBOL, { markPrice: crash.toString() });
    const notice = await client.waitForMessage('notice', (m) => m.kind === 'liquidation');
    const detail = notice.liquidation;
    expect(detail).toMatchObject({ symbol: SYMBOL, side: 'long', qty: '0.01', markPrice: crash.toString() });
    expect(typeof detail.eventId).toBe('number');
    expect(D(detail.marginLost).eq(pos.margin)).toBe(true);
    expect(notice.text).toBe(
      `LIQUIDATED: BTCUSDT long 0.01 at mark ${crash.toFixed(1)} — margin lost $${D(pos.margin).toFixed(2, Decimal.ROUND_UP)} (fee $${D(detail.liquidationFee).toFixed(2, Decimal.ROUND_UP)})`,
    );
    // The warnings came first, in order, and none after the liquidation.
    const kinds = client.notices().map((n) => n.kind).filter((k) => k === 'margin_warning' || k === 'liquidation');
    expect(kinds).toEqual(['margin_warning', 'margin_warning', 'margin_warning', 'liquidation']);
    await waitFor('the position to be gone', async () => (await position(server, SYMBOL)) === null);

    // A browser that connects now is alerted again, with the same detail, until acknowledged.
    const late = await server.client();
    const replay = await late.waitForMessage('notice', (m) => m.kind === 'liquidation');
    expect(replay.liquidation).toEqual(detail);
    expect(replay.text).toBe(notice.text);
    late.close();

    // The history row: trading loss + fee + remainder = the margin lost.
    const rows = await server.history({ market: 'perp', types: 'liquidation' });
    expect(rows).toHaveLength(1);
    const p = rows[0].payload;
    expect(rows[0].id).toBe(detail.eventId);
    expect(p.symbol).toBe(SYMBOL);
    expect(D(p.marginLost).eq(pos.margin)).toBe(true);
    expect(D(p.tradingLoss).plus(p.liquidationFee).plus(p.remainder).eq(p.marginLost)).toBe(true);
    const loss = D(pos.entryPrice).minus(crash).mul('0.01');
    expect(D(p.tradingLoss).eq(Decimal.min(D(pos.margin), loss.toDecimalPlaces(8, Decimal.ROUND_UP)))).toBe(true);
    const fee = crash.mul('0.01').mul(meta.perp[SYMBOL].rules.liquidationFee).toDecimalPlaces(8, Decimal.ROUND_UP);
    expect(D(p.liquidationFee).eq(Decimal.min(D(p.marginLost).minus(p.tradingLoss), fee))).toBe(true);
    expect(D(p.remainder).gte(0)).toBe(true);
    expect(p.feeRateKnown).toBe(true);

    // Only the margin was lost: the wallet holds exactly what it held once the position was open.
    const account = await server.get('/api/account');
    expect(D(account.balances.leverage.USDT.free).eq(freeAfterOpen)).toBe(true);
    expect(D(account.balances.leverage.USDT.locked).isZero()).toBe(true);

    // Acknowledged: the next browser is not alerted again.
    await server.ok('/api/liquidations/ack', { eventId: detail.eventId });
    const after = await server.client();
    await after.waitForMessage('positions');
    await new Promise((r) => setTimeout(r, 300));
    expect(after.notices('liquidation')).toHaveLength(0);
    after.close();
  });
});
