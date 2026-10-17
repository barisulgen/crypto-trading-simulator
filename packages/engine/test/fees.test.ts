import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import { spotFee } from '../src/fees.ts';

describe('spotFee', () => {
  it('buy pays in base', () => {
    const f = spotFee('buy', D('1.2'), D('120.07'), D('0.001'), 'BTC', 'USDT');
    expect(f.asset).toBe('BTC');
    expect(f.amount.toString()).toBe('0.0012');
    expect(f.usd.toString()).toBe('0.12007');
  });
  it('sell pays in quote', () => {
    const f = spotFee('sell', D('1.5'), D('149.66'), D('0.001'), 'BTC', 'USDT');
    expect(f.asset).toBe('USDT');
    expect(f.amount.toString()).toBe('0.14966');
    expect(f.usd.toString()).toBe('0.14966');
  });
});
