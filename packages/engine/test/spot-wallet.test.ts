import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import { FakeMarket, testCtx } from './fixtures.ts';

function setup() {
  const engine = new SpotEngine(emptySpotState(['USDT', 'BTC']));
  const ctx = testCtx(new FakeMarket(), { now: 5000 });
  return { engine, ctx };
}

describe('emptySpotState', () => {
  it('creates zero spot balances for every asset and leverage USDT only', () => {
    const s = emptySpotState(['USDT', 'BTC']);
    expect(Object.keys(s.balances.spot)).toEqual(['USDT', 'BTC']);
    expect(Object.keys(s.balances.leverage)).toEqual(['USDT']);
    expect(s.balances.spot.BTC!.free.toString()).toBe('0');
    expect(s.balances.spot.BTC!.locked.toString()).toBe('0');
    expect(s.orders.size).toBe(0);
    expect(s.basis).toEqual({});
    expect(s.totalDeposited.toString()).toBe('0');
  });
});

describe('deposit', () => {
  it('credits free USDT and totalDeposited', () => {
    const { engine, ctx } = setup();
    const r = engine.deposit('spot', D('1000'), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(engine.state.balances.spot.USDT!.free.toString()).toBe('1000');
    expect(engine.state.totalDeposited.toString()).toBe('1000');
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type).toBe('deposit');
    if (e.type !== 'deposit') return;
    expect(e.time).toBe(5000);
    expect(e.wallet).toBe('spot');
    expect(e.amount.toString()).toBe('1000');
    expect(e.totalDeposited.toString()).toBe('1000');
  });

  it('can deposit to the leverage wallet', () => {
    const { engine, ctx } = setup();
    engine.deposit('leverage', D('50.25'), ctx);
    expect(engine.state.balances.leverage.USDT!.free.toString()).toBe('50.25');
    expect(engine.state.totalDeposited.toString()).toBe('50.25');
  });

  it('rejects zero and negative amounts', () => {
    const { engine, ctx } = setup();
    expect(engine.deposit('spot', D('0'), ctx)).toEqual({ ok: false, reason: 'Deposit must be greater than 0' });
    expect(engine.deposit('spot', D('-5'), ctx)).toEqual({ ok: false, reason: 'Deposit must be greater than 0' });
    expect(engine.state.totalDeposited.toString()).toBe('0');
  });

  it('rejects more than 2 decimals', () => {
    const { engine, ctx } = setup();
    expect(engine.deposit('spot', D('10.555'), ctx)).toEqual({
      ok: false,
      reason: 'Deposit has at most 2 decimals',
    });
    expect(engine.state.balances.spot.USDT!.free.toString()).toBe('0');
  });
});

describe('transfer', () => {
  it('moves free USDT between wallets', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx);
    const r = engine.transfer('spot', 'leverage', D('300'), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(engine.state.balances.spot.USDT!.free.toString()).toBe('700');
    expect(engine.state.balances.leverage.USDT!.free.toString()).toBe('300');
    expect(engine.state.totalDeposited.toString()).toBe('1000');
    const e = r.events[0]!;
    expect(e).toMatchObject({ type: 'transfer', time: 5000, from: 'spot', to: 'leverage' });
    if (e.type === 'transfer') expect(e.amount.toString()).toBe('300');
  });

  it('rejects more than the free balance', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx);
    engine.transfer('spot', 'leverage', D('300'), ctx);
    expect(engine.transfer('spot', 'leverage', D('800'), ctx)).toEqual({
      ok: false,
      reason: 'Insufficient free USDT in spot wallet: need 800, available 700',
    });
    expect(engine.state.balances.spot.USDT!.free.toString()).toBe('700');
  });

  it('does not move locked USDT', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('200'), ctx);
    engine.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1.2' }, ctx);
    expect(engine.transfer('spot', 'leverage', D('100'), ctx)).toEqual({
      ok: false,
      reason: 'Insufficient free USDT in spot wallet: need 100, available 79.93',
    });
  });

  it('rejects a transfer to the same wallet', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx);
    expect(engine.transfer('spot', 'spot', D('100'), ctx)).toEqual({
      ok: false,
      reason: 'Choose two different wallets',
    });
    expect(engine.state.balances.spot.USDT!.free.toString()).toBe('1000');
  });

  it('rejects zero amounts', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx);
    expect(engine.transfer('spot', 'leverage', D('0'), ctx)).toEqual({
      ok: false,
      reason: 'Transfer must be greater than 0',
    });
  });
});
