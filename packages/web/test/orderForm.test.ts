import { describe, expect, it } from 'vitest';
import type { WirePreview } from '../src/lib/api.ts';
import { buildOrderRequest, canAttach, createLatest, fillable, missingInput, previewMatches } from '../src/lib/orderForm.ts';
import type { OrderFormFields } from '../src/lib/orderForm.ts';

const form = (over: Partial<OrderFormFields> = {}): OrderFormFields => ({
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  amountIn: 'coin',
  amount: '0.01',
  price: '80000',
  trigger: '79000',
  attach: false,
  stopLoss: '75000',
  takeProfit: '90000',
  ...over,
});

describe('order request builder', () => {
  it('market by coin amount sends qty only, exactly as typed', () => {
    expect(buildOrderRequest(form({ amount: ' 1,5' }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      qty: ' 1,5',
    });
  });

  it('market by dollar amount sends quoteQty only', () => {
    expect(buildOrderRequest(form({ side: 'sell', amountIn: 'usd', amount: '50,25' }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'market',
      quoteQty: '50,25',
    });
  });

  it('limit and post-only send the price, never the trigger', () => {
    expect(buildOrderRequest(form({ type: 'limit', price: '80000,5' }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      qty: '0.01',
      price: '80000,5',
    });
    expect(buildOrderRequest(form({ type: 'post_only', amountIn: 'usd', amount: '100' }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'post_only',
      quoteQty: '100',
      price: '80000',
    });
  });

  it('stop-loss and take-profit send the trigger, never the price', () => {
    expect(buildOrderRequest(form({ type: 'stop_loss', side: 'sell' }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'stop_loss',
      qty: '0.01',
      triggerPrice: '79000',
    });
    expect(buildOrderRequest(form({ type: 'take_profit', side: 'sell', trigger: '91000' }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'take_profit',
      qty: '0.01',
      triggerPrice: '91000',
    });
  });

  it('attaches the stop-loss / take-profit pair only to market, limit and post-only buys with it enabled', () => {
    expect(buildOrderRequest(form({ attach: true }))).toEqual({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      qty: '0.01',
      attach: { stopLoss: '75000', takeProfit: '90000' },
    });
    expect(buildOrderRequest(form({ type: 'limit', attach: true })).attach).toEqual({
      stopLoss: '75000',
      takeProfit: '90000',
    });
    expect(buildOrderRequest(form({ attach: false })).attach).toBeUndefined();
    expect(buildOrderRequest(form({ side: 'sell', attach: true })).attach).toBeUndefined();
    expect(buildOrderRequest(form({ type: 'stop_loss', attach: true })).attach).toBeUndefined();
    expect(canAttach(form({ type: 'post_only' }))).toBe(true);
    expect(canAttach(form({ type: 'take_profit' }))).toBe(false);
    expect(canAttach(form({ side: 'sell' }))).toBe(false);
  });

  it('names the first blank field the order needs (none when complete)', () => {
    expect(missingInput(form())).toBeNull();
    expect(missingInput(form({ amount: '  ' }))).toBe('Enter an amount');
    expect(missingInput(form({ type: 'limit', price: '' }))).toBe('Enter a limit price');
    expect(missingInput(form({ type: 'post_only', price: '' }))).toBe('Enter a limit price');
    expect(missingInput(form({ type: 'stop_loss', trigger: '' }))).toBe('Enter a trigger price');
    expect(missingInput(form({ type: 'market', price: '', trigger: '' }))).toBeNull();
    expect(missingInput(form({ attach: true, stopLoss: '' }))).toBe('Enter a stop-loss price');
    expect(missingInput(form({ attach: true, takeProfit: '' }))).toBe('Enter a take-profit price');
    // Attach fields only count where a pair can be attached.
    expect(missingInput(form({ side: 'sell', attach: true, stopLoss: '' }))).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('latest-response guard', () => {
  it('ignores an older answer that arrives after a newer request started', async () => {
    const latest = createLatest();
    const first = deferred<string>();
    const second = deferred<string>();
    const a = latest.run(first.promise);
    const b = latest.run(second.promise);
    second.resolve('new');
    first.resolve('old');
    expect(await b).toEqual({ ok: true, value: 'new' });
    expect(await a).toBeNull();
  });

  it('ignores a stale failure too, and passes on a current one', async () => {
    const latest = createLatest();
    const first = deferred<string>();
    const a = latest.run(first.promise);
    const b = latest.run(Promise.reject(new Error('bad input')));
    first.reject(new Error('late'));
    expect(await a).toBeNull();
    expect(await b).toEqual({ ok: false, error: new Error('bad input') });
  });

  it('cancel() drops the answer of the request in flight', async () => {
    const latest = createLatest();
    const first = deferred<string>();
    const a = latest.run(first.promise);
    latest.cancel();
    first.resolve('too late');
    expect(await a).toBeNull();
  });
});

describe('fillable amount of an exhausted preview', () => {
  const preview = (over: Partial<WirePreview>): WirePreview => ({
    estAvgPrice: '100.05',
    estSlippageUsd: '0.05',
    estSlippagePct: '0.05',
    fee: { asset: 'BTC', amount: '0.001', usd: '0.1' },
    total: '100.05',
    receive: '0.999',
    exhausted: true,
    rejectReason: null,
    note: null,
    ...over,
  });

  it('a buy can fill what it receives plus the fee, in coins', () => {
    expect(fillable(preview({}), 'buy')).toEqual({ amount: '1', unit: 'coin' });
  });

  it('a sell can raise its total plus the fee, in dollars', () => {
    expect(
      fillable(preview({ fee: { asset: 'USDT', amount: '0.04994', usd: '0.04994' }, total: '49.89006', receive: '49.89006' }), 'sell'),
    ).toEqual({ amount: '49.94', unit: 'usd' });
  });

  it('nothing fillable gives null', () => {
    expect(fillable(preview({ receive: null, total: null, fee: { asset: null, amount: null, usd: null } }), 'buy')).toBeNull();
  });
});

describe('previewMatches', () => {
  it('accepts only an answer for the same symbol, side and type', () => {
    const key = JSON.stringify(buildOrderRequest(form({ side: 'sell' })));
    expect(previewMatches(key, form({ side: 'sell' }))).toBe(true);
    expect(previewMatches(key, form({ side: 'buy' }))).toBe(false);
    expect(previewMatches(key, form({ side: 'sell', symbol: 'ETHUSDT' }))).toBe(false);
    expect(previewMatches(key, form({ side: 'sell', type: 'limit' }))).toBe(false);
    expect(previewMatches(null, form())).toBe(false);
  });
});
