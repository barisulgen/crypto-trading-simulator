import { describe, expect, it } from 'vitest';
import type { AccountSnapshot, WireLevel } from '../src/lib/api.ts';
import { setRules } from '../src/lib/format.ts';
import { floorDivToStep, floorToStep, mulDec, subDec } from '../src/lib/market.ts';
import {
  NO_QUICK,
  amountStep,
  availableLine,
  quickAmount,
  quickHint,
  quickStep,
  spotFree,
} from '../src/lib/quickAmount.ts';
import type { QuickInput, QuickResult } from '../src/lib/quickAmount.ts';

const STEP = '0.00001';
const lv = (price: string, qty: string): WireLevel => ({ price, qty });

const input = (over: Partial<QuickInput> = {}): QuickInput => ({
  side: 'sell',
  unit: 'coin',
  pct: 100,
  type: 'market',
  freeBase: '0',
  freeQuote: '0',
  bids: [],
  asks: [],
  price: '',
  trigger: '',
  step: STEP,
  ...over,
});

const account = (spot: Record<string, { free: string; locked: string }>) =>
  ({ balances: { spot, leverage: {} } }) as unknown as AccountSnapshot;

describe('exact decimal helpers for quick amounts', () => {
  it('multiplies exactly', () => {
    expect(mulDec('0.25', '0.00120879')).toBe('0.0003021975');
    expect(mulDec('0.00120879', '80826.00')).toBe('97.70166054');
    expect(mulDec('3', '4')).toBe('12');
  });

  it('divides and floors to a step', () => {
    expect(floorDivToStep('850', '81327.39', STEP)).toBe('0.01045');
    expect(floorDivToStep('99.5', '99.5', STEP)).toBe('1');
    expect(floorDivToStep('70.07', '100.10', STEP)).toBe('0.7');
    expect(floorDivToStep('1', '3', '0.01')).toBe('0.33');
  });
});

describe('quick amount: step flooring', () => {
  it('25% of 0.00120879 BTC floors to the 0.00001 step', () => {
    expect(quickAmount(input({ pct: 25, freeBase: '0.00120879' }))).toEqual({
      amount: '0.0003',
      belowStep: false,
      belowCent: false,
    });
  });

  it('100% leaves the sub-step dust behind', () => {
    const r = quickAmount(input({ pct: 100, freeBase: '0.00120879' }))!;
    expect(r.amount).toBe('0.0012');
    expect(subDec('0.00120879', r.amount)).toBe('0.00000879');
  });

  it('market orders use the market step, others the lot step', () => {
    const rules = { stepSize: '0.00001000', marketStepSize: '0.00100000' };
    expect(amountStep(rules, 'market')).toBe('0.00100000');
    expect(amountStep(rules, 'limit')).toBe('0.00001000');
    expect(amountStep(rules, 'stop_loss')).toBe('0.00001000');
    expect(amountStep({ stepSize: '0.00001000', marketStepSize: '0.00000000' }, 'market')).toBe('0.00001000');
  });
});

describe('quick amount: free balance only', () => {
  const acct = account({ BTC: { free: '0.001', locked: '0.0005' }, USDT: { free: '100', locked: '50' } });

  it('a 100% sell uses the free coins, not free + locked', () => {
    expect(spotFree(acct, 'BTC')).toBe('0.001');
    expect(quickAmount(input({ freeBase: spotFree(acct, 'BTC') }))!.amount).toBe('0.001');
  });

  it('a 100% buy uses the free USDT, not free + locked', () => {
    expect(spotFree(acct, 'USDT')).toBe('100');
    expect(quickAmount(input({ side: 'buy', unit: 'usd', freeQuote: spotFree(acct, 'USDT') }))!.amount).toBe('100.00');
  });

  it('a coin with no balance row has nothing free', () => {
    expect(spotFree(acct, 'ETH')).toBe('0');
  });
});

describe('quick amount: buy in coins', () => {
  const asks = [lv('100.00', '0.5'), lv('100.10', '1.0'), lv('100.50', '2.0')];

  it('market walks the asks with the budget, as the engine does', () => {
    expect(quickAmount(input({ side: 'buy', type: 'market', freeQuote: '120.07', asks }))!.amount).toBe('1.2');
  });

  it('market prices what the visible book cannot cover at the last ask', () => {
    // 50 + 100.10 + 201 = 351.10 buys 3.5; 100.50 more at the last ask buys 1 more.
    expect(quickAmount(input({ side: 'buy', type: 'market', freeQuote: '451.60', asks }))!.amount).toBe('4.5');
  });

  it('limit uses the entered price', () => {
    expect(
      quickAmount(input({ side: 'buy', type: 'limit', pct: 50, freeQuote: '199', price: '99.50', asks }))!.amount,
    ).toBe('1');
  });

  it('limit with no valid price uses the best ask', () => {
    expect(quickAmount(input({ side: 'buy', type: 'limit', freeQuote: '200', price: 'abc', asks }))!.amount).toBe('2');
    expect(quickAmount(input({ side: 'buy', type: 'post_only', freeQuote: '200', price: '', asks }))!.amount).toBe('2');
  });

  it('a stop uses the trigger price, which is what the engine reserves', () => {
    expect(quickAmount(input({ side: 'buy', type: 'stop_loss', freeQuote: '202', trigger: '101', asks }))!.amount).toBe(
      '2',
    );
    expect(
      quickAmount(input({ side: 'buy', type: 'take_profit', freeQuote: '202', trigger: '101,0', asks }))!.amount,
    ).toBe('2');
  });

  it('a stop with no valid trigger uses the best ask', () => {
    expect(quickAmount(input({ side: 'buy', type: 'stop_loss', freeQuote: '200', trigger: '0', asks }))!.amount).toBe(
      '2',
    );
  });

  it('nothing to price against gives null', () => {
    expect(quickAmount(input({ side: 'buy', type: 'market', freeQuote: '200' }))).toBeNull();
    expect(quickAmount(input({ side: 'buy', type: 'limit', freeQuote: '200', price: '' }))).toBeNull();
  });
});

describe('quick amount: buy in dollars', () => {
  it('75% of 850.004 USDT floors to the cent', () => {
    expect(quickAmount(input({ side: 'buy', unit: 'usd', pct: 75, freeQuote: '850.004' }))).toEqual({
      amount: '637.50',
      belowStep: false,
      belowCent: false,
    });
  });

  it('needs no book', () => {
    expect(quickAmount(input({ side: 'buy', unit: 'usd', pct: 50, freeQuote: '199', type: 'limit' }))!.amount).toBe(
      '99.50',
    );
  });

  it('less than a cent fills 0', () => {
    expect(quickAmount(input({ side: 'buy', unit: 'usd', pct: 25, freeQuote: '0.03' }))).toEqual({
      amount: '0',
      belowStep: false,
      belowCent: true,
    });
  });
});

describe('quick amount: sell in dollars', () => {
  const bids = [lv('99.90', '0.4'), lv('99.80', '1.0'), lv('99.00', '3.0')];

  it('limit values the floored coins at the limit price', () => {
    expect(quickAmount(input({ unit: 'usd', type: 'limit', pct: 50, freeBase: '1', price: '101', bids }))!.amount).toBe(
      '50.50',
    );
  });

  it('market walks the bids', () => {
    expect(quickAmount(input({ unit: 'usd', type: 'market', freeBase: '1.5', bids }))!.amount).toBe('149.66');
  });

  it('market prices coins beyond the visible bids at the last bid', () => {
    // 39.96 + 99.80 + 297.00 = 436.76 for 4.4; 0.6 more at 99.00 = 59.40.
    expect(quickAmount(input({ unit: 'usd', type: 'market', freeBase: '5', bids }))!.amount).toBe('496.16');
  });

  it('a stop values the coins at the trigger', () => {
    expect(quickAmount(input({ unit: 'usd', type: 'stop_loss', freeBase: '2', trigger: '95.555', bids }))!.amount).toBe(
      '191.11',
    );
  });

  it('no valid price values the coins at the best bid', () => {
    expect(quickAmount(input({ unit: 'usd', type: 'limit', freeBase: '2', price: '', bids }))!.amount).toBe('199.80');
  });

  it('floors the coins to the step before valuing them', () => {
    // 0.00120879 -> 0.0012 BTC x 80,000 = 96.00, not 96.70.
    expect(quickAmount(input({ unit: 'usd', type: 'limit', freeBase: '0.00120879', price: '80000' }))!.amount).toBe(
      '96.00',
    );
  });

  it('nothing to price against gives null', () => {
    expect(quickAmount(input({ unit: 'usd', type: 'market', freeBase: '1' }))).toBeNull();
  });
});

describe('quick amount: minimums are not enforced here', () => {
  it('25% of 0.00003 BTC is less than one step: 0 with belowStep', () => {
    expect(quickAmount(input({ pct: 25, freeBase: '0.00003' }))).toEqual({
      amount: '0',
      belowStep: true,
      belowCent: false,
    });
  });

  it('a buy budget that cannot buy one step is 0 with belowStep', () => {
    expect(quickAmount(input({ side: 'buy', type: 'limit', freeQuote: '0.5', price: '100000' }))).toEqual({
      amount: '0',
      belowStep: true,
      belowCent: false,
    });
  });

  it('a sell in dollars of less than one step is 0 with belowStep', () => {
    expect(quickAmount(input({ unit: 'usd', type: 'limit', pct: 25, freeBase: '0.00003', price: '100' }))).toEqual({
      amount: '0',
      belowStep: true,
      belowCent: false,
    });
  });

  it('25% of 0.0002 BTC at about 100 is below the minimum notional and still returned', () => {
    const bids = [lv('100.00', '1')];
    expect(quickAmount(input({ pct: 25, freeBase: '0.0002', bids }))).toEqual({
      amount: '0.00005',
      belowStep: false,
      belowCent: false,
    });
  });
});

describe('available line', () => {
  setRules({ BTCUSDT: { tickSize: '0.01000000', stepSize: '0.00001000' } });
  const base = { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', stepSize: '0.00001000', fresh: true };

  it('sell: free coins and their value at the best bid, floored to the cent', () => {
    const l = availableLine({ ...base, side: 'sell', free: '0.00120879', bestBid: '80826.00', bestAsk: '80826.01' });
    expect(l.text).toBe('Available 0.00120879 BTC ≈ $97.70');
  });

  it('buy: free USDT and what it buys at the best ask, floored to the step', () => {
    const l = availableLine({ ...base, side: 'buy', free: '850', bestBid: '81327.38', bestAsk: '81327.39' });
    expect(l.text).toBe('Available 850.00 USDT ≈ 0.01045 BTC');
  });

  it('groups large dollar values', () => {
    const l = availableLine({ ...base, side: 'sell', free: '1.5', bestBid: '80826.00', bestAsk: '80826.01' });
    expect(l.text).toBe('Available 1.50000 BTC ≈ $121,239.00');
  });

  it('stale data or no best price shows a dash for the estimate', () => {
    expect(
      availableLine({
        ...base,
        side: 'sell',
        free: '0.00120879',
        bestBid: '80826.00',
        bestAsk: '80826.01',
        fresh: false,
      }).text,
    ).toBe('Available 0.00120879 BTC ≈ —');
    expect(availableLine({ ...base, side: 'buy', free: '850', bestBid: undefined, bestAsk: undefined }).text).toBe(
      'Available 850.00 USDT ≈ —',
    );
  });

  it('no account yet: a dash and no estimate', () => {
    const l = availableLine({ ...base, side: 'buy', free: undefined, bestBid: '1', bestAsk: '1' });
    expect(l).toEqual({ free: '-', approx: null, text: 'Available -' });
  });
});

describe('quick amount highlight state', () => {
  // A form whose unit can change: the computation reads it like the order form does.
  let unit: 'coin' | 'usd' = 'coin';
  const compute = (pct: number): QuickResult | null =>
    unit === 'coin'
      ? quickAmount(input({ pct: pct as 25, freeBase: '0.00120879' }))
      : quickAmount(input({ pct: pct as 25, unit: 'usd', type: 'limit', freeBase: '0.00120879', price: '80000' }));

  it('a pick highlights the percentage and fills the field', () => {
    unit = 'coin';
    const r = quickStep(NO_QUICK, { type: 'pick', pct: 50 }, compute);
    expect(r.state.pct).toBe(50);
    expect(r.amount).toBe('0.0006');
  });

  it('a manual edit clears the highlight and leaves the amount to the owner', () => {
    unit = 'coin';
    const picked = quickStep(NO_QUICK, { type: 'pick', pct: 50 }, compute).state;
    const r = quickStep(picked, { type: 'edit' }, compute);
    expect(r.state).toEqual(NO_QUICK);
    expect(r.amount).toBeUndefined();
  });

  it('a unit toggle keeps the highlight and recomputes the amount', () => {
    unit = 'coin';
    const picked = quickStep(NO_QUICK, { type: 'pick', pct: 50 }, compute).state;
    unit = 'usd';
    const r = quickStep(picked, { type: 'reprice' }, compute);
    expect(r.state.pct).toBe(50);
    expect(r.amount).toBe('48.00');
  });

  it('a reprice with no active percentage changes nothing', () => {
    const r = quickStep(NO_QUICK, { type: 'reprice' }, compute);
    expect(r.state).toBe(NO_QUICK);
    expect(r.amount).toBeUndefined();
  });

  it('a side or coin change clears the highlight and leaves the amount as is', () => {
    unit = 'coin';
    const picked = quickStep(NO_QUICK, { type: 'pick', pct: 100 }, compute).state;
    const r = quickStep(picked, { type: 'reset' }, compute);
    expect(r.state).toEqual(NO_QUICK);
    expect(r.amount).toBeUndefined();
  });

  it('a pick below one step keeps the hint flag', () => {
    const tiny = () => quickAmount(input({ pct: 25, freeBase: '0.00003' }));
    const r = quickStep(NO_QUICK, { type: 'pick', pct: 25 }, tiny);
    expect(r.state).toEqual({ pct: 25, belowStep: true, belowCent: false });
    expect(r.amount).toBe('0');
  });

  it('a pick with nothing to price against changes nothing', () => {
    const r = quickStep(NO_QUICK, { type: 'pick', pct: 25 }, () => null);
    expect(r.state).toBe(NO_QUICK);
    expect(r.amount).toBeUndefined();
  });

  it('a reprice that can no longer be priced clears the highlight and empties the amount (it would be in the wrong unit)', () => {
    unit = 'coin';
    const picked = quickStep(NO_QUICK, { type: 'pick', pct: 25 }, compute).state;
    const r = quickStep(picked, { type: 'reprice' }, () => null);
    expect(r.state).toEqual(NO_QUICK);
    expect(r.amount).toBe('');
  });
});

describe('below-one-step hint', () => {
  it('names the step and the coin', () => {
    expect(quickHint({ pct: 25, belowStep: true, belowCent: false }, '0.00001000', 'BTC')).toBe(
      'Less than one step (0.00001 BTC) available',
    );
  });

  it('a dollar buy under one cent says so', () => {
    expect(quickHint({ pct: 25, belowStep: false, belowCent: true }, '0.00001000', 'BTC')).toBe(
      'Less than $0.01 available',
    );
  });

  it('nothing to say otherwise', () => {
    expect(quickHint({ pct: 25, belowStep: false, belowCent: false }, '0.00001000', 'BTC')).toBeNull();
    expect(quickHint(NO_QUICK, '0.00001000', 'BTC')).toBeNull();
  });
});

describe('quick amount: 100% sell in dollars', () => {
  it('rounds the dollars up so the engine sells the whole steps (0.0012, not 0.00119)', () => {
    const bids = [lv('81229', '5')];
    const r = quickAmount(input({ unit: 'usd', pct: 100, freeBase: '0.00120879', bids }))!;
    expect(r.amount).toBe('97.48');
    expect(floorToStep(floorDivToStep(r.amount, '81229', '0.00000001'), STEP)).toBe('0.0012');
    const limit = quickAmount(input({ unit: 'usd', pct: 100, type: 'limit', freeBase: '0.00120879', price: '81229', bids }))!;
    expect(limit.amount).toBe('97.48');
  });
});
