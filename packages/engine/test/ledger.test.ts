import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { deposit, emptyLedger, transfer } from '../src/account/ledger.ts';
import { PerpEngine } from '../src/perp/engine.ts';
import { emptyPerpState } from '../src/perp/state.ts';
import { SimEngine } from '../src/sim.ts';
import { SpotEngine } from '../src/spot/engine.ts';
import { emptySpotState } from '../src/spot/state.ts';
import { FakeMarket, testCtx } from './fixtures.ts';

const ASK = D('67000.5');

function setup() {
  const ledger = emptyLedger(['USDT', 'BTC']);
  const spot = new SpotEngine(emptySpotState(ledger));
  const engine = {
    ledger,
    spot,
    deposit: (...a: Parameters<typeof deposit> extends [unknown, ...infer R] ? R : never) => deposit(ledger, ...a),
    transfer: (...a: Parameters<typeof transfer> extends [unknown, ...infer R] ? R : never) => transfer(ledger, ...a),
  };
  const ctx = testCtx(new FakeMarket(), { now: 5000 });
  return { engine, ctx };
}

describe('emptyLedger', () => {
  it('creates zero spot balances for every asset and leverage USDT only', () => {
    const s = emptyLedger(['USDT', 'BTC']);
    expect(Object.keys(s.balances.spot)).toEqual(['USDT', 'BTC']);
    expect(Object.keys(s.balances.leverage)).toEqual(['USDT']);
    expect(s.balances.spot.BTC!.free.toString()).toBe('0');
    expect(s.balances.spot.BTC!.locked.toString()).toBe('0');
    expect(s.totalDeposited.toString()).toBe('0');
  });
});

describe('deposit', () => {
  it('credits free USDT and totalDeposited', () => {
    const { engine, ctx } = setup();
    const r = engine.deposit('spot', D('1000'), ctx, ASK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(engine.ledger.balances.spot.USDT!.free.toString()).toBe('1000');
    expect(engine.ledger.totalDeposited.toString()).toBe('1000');
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type).toBe('deposit');
    if (e.type !== 'deposit') return;
    expect(e.time).toBe(5000);
    expect(e.wallet).toBe('spot');
    expect(e.amount.toString()).toBe('1000');
    expect(e.totalDeposited.toString()).toBe('1000');
  });

  it('records the BTC ask it was given with the deposit', () => {
    const { engine, ctx } = setup();
    const r = engine.deposit('spot', D('1000'), ctx, D('67012.34'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.events[0]!;
    if (e.type !== 'deposit') throw new Error('expected a deposit event');
    expect(e.btcAsk?.toString()).toBe('67012.34');
  });

  it('can deposit to the leverage wallet', () => {
    const { engine, ctx } = setup();
    engine.deposit('leverage', D('50.25'), ctx, ASK);
    expect(engine.ledger.balances.leverage.USDT!.free.toString()).toBe('50.25');
    expect(engine.ledger.totalDeposited.toString()).toBe('50.25');
  });

  it('rejects zero and negative amounts', () => {
    const { engine, ctx } = setup();
    expect(engine.deposit('spot', D('0'), ctx, ASK)).toEqual({ ok: false, reason: 'Deposit must be greater than 0' });
    expect(engine.deposit('spot', D('-5'), ctx, ASK)).toEqual({ ok: false, reason: 'Deposit must be greater than 0' });
    expect(engine.ledger.totalDeposited.toString()).toBe('0');
  });

  it('rejects more than 2 decimals', () => {
    const { engine, ctx } = setup();
    expect(engine.deposit('spot', D('10.555'), ctx, ASK)).toEqual({
      ok: false,
      reason: 'Deposit has at most 2 decimals',
    });
    expect(engine.ledger.balances.spot.USDT!.free.toString()).toBe('0');
  });
});

describe('transfer', () => {
  it('moves free USDT between wallets', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx, ASK);
    const r = engine.transfer('spot', 'leverage', D('300'), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(engine.ledger.balances.spot.USDT!.free.toString()).toBe('700');
    expect(engine.ledger.balances.leverage.USDT!.free.toString()).toBe('300');
    expect(engine.ledger.totalDeposited.toString()).toBe('1000');
    const e = r.events[0]!;
    expect(e).toMatchObject({ type: 'transfer', time: 5000, from: 'spot', to: 'leverage' });
    if (e.type === 'transfer') expect(e.amount.toString()).toBe('300');
  });

  it('rejects more than the free balance', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx, ASK);
    engine.transfer('spot', 'leverage', D('300'), ctx);
    expect(engine.transfer('spot', 'leverage', D('800'), ctx)).toEqual({
      ok: false,
      reason: 'Insufficient free USDT in spot wallet: need 800, available 700',
    });
    expect(engine.ledger.balances.spot.USDT!.free.toString()).toBe('700');
  });

  it('does not move locked USDT', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('200'), ctx, ASK);
    engine.spot.submit({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1.2' }, ctx);
    expect(engine.transfer('spot', 'leverage', D('100'), ctx)).toEqual({
      ok: false,
      reason: 'Insufficient free USDT in spot wallet: need 100, available 79.93',
    });
  });

  it('rejects a transfer to the same wallet', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx, ASK);
    expect(engine.transfer('spot', 'spot', D('100'), ctx)).toEqual({
      ok: false,
      reason: 'Choose two different wallets',
    });
    expect(engine.ledger.balances.spot.USDT!.free.toString()).toBe('1000');
  });

  it('rejects zero amounts', () => {
    const { engine, ctx } = setup();
    engine.deposit('spot', D('1000'), ctx, ASK);
    expect(engine.transfer('spot', 'leverage', D('0'), ctx)).toEqual({
      ok: false,
      reason: 'Transfer must be greater than 0',
    });
  });
});

describe('SimEngine', () => {
  it('shares the ledger with the spot and perp engines', () => {
    const ledger = emptyLedger(['USDT', 'BTC']);
    const sim = new SimEngine(ledger, new SpotEngine(emptySpotState(ledger)), new PerpEngine(emptyPerpState(ledger)));
    const ctx = testCtx(new FakeMarket(), { now: 5000 });
    const dep = sim.deposit('spot', D('1000'), ctx, ASK);
    expect(dep.ok && dep.events[0]).toMatchObject({ type: 'deposit', btcAsk: ASK });
    expect(sim.spot.state.ledger).toBe(sim.ledger);
    expect(sim.perp.state.ledger).toBe(sim.ledger);
    expect(sim.spot.state.ledger.balances.spot.USDT!.free.toString()).toBe('1000');
    expect(sim.transfer('spot', 'leverage', D('300'), ctx).ok).toBe(true);
    expect(sim.spot.state.ledger.balances.leverage.USDT!.free.toString()).toBe('300');
    expect(sim.ledger.totalDeposited.toString()).toBe('1000');
  });
});
