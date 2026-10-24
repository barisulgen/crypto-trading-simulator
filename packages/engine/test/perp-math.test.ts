import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.ts';
import {
  assumedPrice,
  fundingAmount,
  liquidationPrice,
  liquidationSplit,
  maintenanceMargin,
  marginBalance,
  marginRatio,
  maxRemovableMargin,
  orderCost,
  perpFee,
  unrealizedPnl,
} from '../src/perp/math.ts';
import { bracketFor, maxLeverage, maxNotionalAt } from '../src/perp/tiers.ts';
import { brackets, btcBrackets, btcPerpRules, solBrackets } from './perpFixtures.ts';

describe('tiers', () => {
  it('finds the bracket with floor inclusive and cap exclusive', () => {
    expect(bracketFor(btcBrackets, D('300000')).mmr.toString()).toBe('0.005');
    expect(bracketFor(btcBrackets, D('299999.99')).mmr.toString()).toBe('0.004');
    expect(bracketFor(btcBrackets, D('0')).mmr.toString()).toBe('0.004');
  });
  it('uses the last bracket above the last cap', () => {
    expect(bracketFor(btcBrackets, D('5000000000')).mmr.toString()).toBe('0.5');
  });
  it('reads the maximum leverage and the largest notional at a leverage', () => {
    expect(maxLeverage(btcBrackets)).toBe(150);
    expect(maxNotionalAt(btcBrackets, 150).toString()).toBe('300000');
    expect(maxNotionalAt(btcBrackets, 100).toString()).toBe('800000');
    expect(maxNotionalAt(btcBrackets, 75).toString()).toBe('3000000');
    expect(maxNotionalAt(btcBrackets, 50).toString()).toBe('12000000');
    expect(maxNotionalAt(btcBrackets, 20).toString()).toBe('100000000');
  });
});

describe('liquidation price', () => {
  it('long in the first tier', () => {
    expect(liquidationPrice(btcBrackets, 'long', D('0.1'), D('80000'), D('400'))?.toFixed(8)).toBe('76305.22088353');
  });
  it('long with the margin left after a 4.00 opening fee', () => {
    expect(liquidationPrice(btcBrackets, 'long', D('0.1'), D('80000'), D('396'))?.toFixed(8)).toBe('76345.38152610');
  });
  it('long takes the bracket at the liquidation price, not at entry', () => {
    // Notional 304 000 at entry (tier 2) but about 274 699 at the result (tier 1); tier 2 would give 68668.34170854.
    expect(liquidationPrice(btcBrackets, 'long', D('4'), D('76000'), D('30400'))?.toFixed(8)).toBe('68674.69879518');
  });
  it('short takes the bracket at the liquidation price, not at entry', () => {
    // Tier 1 at entry, tier 2 at the result; tier 1 would give 81075.69721116.
    expect(liquidationPrice(btcBrackets, 'short', D('4'), D('74000'), D('29600'))?.toFixed(8)).toBe('81069.65174129');
  });
  it('a result exactly on an edge is the same from both brackets', () => {
    // Maintenance margin is 1200 either side of notional 300 000, so both brackets give 75000.
    expect(liquidationPrice(btcBrackets, 'long', D('4'), D('76000'), D('5200'))?.toString()).toBe('75000');
  });
  it('with no self-consistent bracket, takes the result nearest to its own bracket', () => {
    // A table whose maintenance margin drops at the edge (100 below notional 1000, 50 above), so neither bracket holds its own result.
    const gapped = brackets([
      ['0', '1000', '0.1', '0', 10],
      ['1000', '1000000', '0.1', '50', 10],
    ]);
    // First bracket: 920 / 0.9 = 1022.2… (22.2 past its cap); second: 870 / 0.9 = 966.6… (33.3 short of its floor).
    expect(liquidationPrice(gapped, 'long', D('1'), D('2000'), D('1080'))?.toFixed(8)).toBe('1022.22222222');
  });
  it('short on another table', () => {
    expect(liquidationPrice(solBrackets, 'short', D('50'), D('100'), D('500'))?.toFixed(8)).toBe('109.45273632');
  });
  it('a 1x long cannot be liquidated', () => {
    expect(liquidationPrice(btcBrackets, 'long', D('0.1'), D('80000'), D('8000'))).toBeNull();
  });
});

describe('maintenance, balance and ratio', () => {
  it('maintenance margin is notional × mmr − cum at the bracket for that notional', () => {
    expect(maintenanceMargin(btcBrackets, D('4'), D('76000')).toString()).toBe('1220');
    expect(maintenanceMargin(btcBrackets, D('0.1'), D('76340')).toString()).toBe('30.536');
  });
  it('unrealised P&L and margin balance follow the side', () => {
    expect(unrealizedPnl('long', D('0.1'), D('80000'), D('78000')).toString()).toBe('-200');
    expect(unrealizedPnl('short', D('0.1'), D('80000'), D('78000')).toString()).toBe('200');
    expect(marginBalance(D('396'), 'long', D('0.1'), D('80000'), D('78000')).toString()).toBe('196');
  });
  it('margin ratio for a long 0.1 @ 80000 with margin 396', () => {
    const ratioAt = (mark: string) =>
      marginRatio(
        maintenanceMargin(btcBrackets, D('0.1'), D(mark)),
        marginBalance(D('396'), 'long', D('0.1'), D('80000'), D(mark)),
      ).toFixed(6);
    expect(ratioAt('78000')).toBe('0.159184');
    expect(ratioAt('76600')).toBe('0.547143');
    expect(ratioAt('76400')).toBe('0.848889');
    expect(ratioAt('76370')).toBe('0.925697');
  });
  it('margin ratio is infinite when the balance is gone', () => {
    expect(marginRatio(D('30'), D('0')).isFinite()).toBe(false);
    expect(marginRatio(D('30'), D('-5')).isFinite()).toBe(false);
  });
});

describe('order cost', () => {
  it('a buy at the ask above the mark pays the gap as open loss', () => {
    const c = orderCost({
      side: 'buy',
      qty: D('0.1'),
      imPrice: D('80000'),
      olPrice: D('80000'),
      mark: D('79900'),
      leverage: 20,
      takerRate: D('0.0005'),
    });
    expect(c.initialMargin.toString()).toBe('400');
    expect(c.openLoss.toString()).toBe('10');
    expect(c.fee.toString()).toBe('4');
    expect(c.total.toString()).toBe('414');
  });
  it('a limit sell assumes the highest of price, mark and last × 1.0015', () => {
    const imPrice = assumedPrice({ type: 'limit', side: 'sell', price: D('80000'), mark: D('80100'), last: D('80050') });
    expect(imPrice.toString()).toBe('80170.075');
    const c = orderCost({
      side: 'sell',
      qty: D('0.1'),
      imPrice,
      olPrice: D('80000'),
      mark: D('80100'),
      leverage: 20,
      takerRate: D('0.0005'),
    });
    expect(c.initialMargin.toString()).toBe('400.850375');
    expect(c.openLoss.toString()).toBe('10');
    expect(c.fee.toString()).toBe('4.00850375');
    expect(c.total.toString()).toBe('414.85887875');
  });
  it('rounds the margin and open loss up to 8 decimals', () => {
    const c = orderCost({
      side: 'buy',
      qty: D('0.001'),
      imPrice: D('80000'),
      olPrice: D('80000'),
      mark: D('80000'),
      leverage: 3,
      takerRate: D('0.0005'),
    });
    expect(c.initialMargin.toString()).toBe('26.66666667');
    expect(c.openLoss.toString()).toBe('0');
    expect(c.fee.toString()).toBe('0.04');
    expect(c.total.toString()).toBe('26.70666667');
  });
  it('assumed prices for the other order kinds', () => {
    const base = { mark: D('80100'), last: D('80000') };
    expect(assumedPrice({ ...base, type: 'limit', side: 'buy', price: D('79000') }).toString()).toBe('79000');
    expect(assumedPrice({ ...base, type: 'market', side: 'buy', walkAvg: D('80005') }).toString()).toBe('80120');
    expect(assumedPrice({ ...base, type: 'market', side: 'buy', walkAvg: D('80200') }).toString()).toBe('80200');
    expect(assumedPrice({ ...base, type: 'market', side: 'sell', walkAvg: D('79990') }).toString()).toBe('80120');
    expect(assumedPrice({ ...base, mark: D('80150'), type: 'market', side: 'sell', walkAvg: D('79990') }).toString()).toBe('80150');
  });
  it('a perp fee rounds up to 8 decimals', () => {
    expect(perpFee(D('8017.0075'), D('0.0005')).toString()).toBe('4.00850375');
    expect(perpFee(D('0.0000001'), D('0.0002')).toString()).toBe('0.00000001');
  });
});

describe('liquidation split', () => {
  const pos = { margin: D('396'), side: 'long' as const, qty: D('0.1'), entry: D('80000'), feeRate: btcPerpRules.liquidationFee };
  it('the fee takes what the loss leaves, up to the rate', () => {
    const s = liquidationSplit({ ...pos, mark: D('76340') });
    expect(s.tradingLoss.toString()).toBe('366');
    expect(s.liquidationFee.toString()).toBe('30');
    expect(s.remainder.toString()).toBe('0');
  });
  it('a gap past bankruptcy loses the whole margin and charges no fee', () => {
    const s = liquidationSplit({ ...pos, mark: D('75000') });
    expect(s.tradingLoss.toString()).toBe('396');
    expect(s.liquidationFee.toString()).toBe('0');
    expect(s.remainder.toString()).toBe('0');
  });
});

describe('funding', () => {
  it('pays rounded up and receives rounded down', () => {
    expect(fundingAmount(D('0.1'), D('80000'), D('0.0001'), true).toString()).toBe('0.8');
    expect(fundingAmount(D('0.1'), D('80000'), D('-0.00005'), false).toString()).toBe('0.4');
    expect(fundingAmount(D('0.001'), D('80000.1'), D('0.00012345'), true).toString()).toBe('0.00987602');
    expect(fundingAmount(D('0.001'), D('80000.1'), D('0.00012345'), false).toString()).toBe('0.00987601');
  });
});

describe('max removable margin', () => {
  const pos = { brackets: btcBrackets, side: 'long' as const, qty: D('0.1'), entry: D('80000'), margin: D('396'), leverage: 20 };
  it('an unrealised profit does not count: in profit, a position holding only its initial margin has nothing removable', () => {
    expect(maxRemovableMargin({ ...pos, mark: D('82000') }).toString()).toBe('0');
  });
  it('margin above the initial margin at the mark is removable, the profit still left out', () => {
    expect(maxRemovableMargin({ ...pos, margin: D('496'), mark: D('82000') }).toString()).toBe('86');
    expect(maxRemovableMargin({ ...pos, side: 'short', margin: D('496'), mark: D('78000') }).toString()).toBe('106');
  });
  it('an unrealised loss reduces it', () => {
    expect(maxRemovableMargin({ ...pos, margin: D('496'), mark: D('79000') }).toString()).toBe('1');
  });
  it('in loss with only the initial margin, nothing', () => {
    expect(maxRemovableMargin({ ...pos, mark: D('79000') }).toString()).toBe('0');
  });
  it('rounds down to 8 decimals', () => {
    expect(maxRemovableMargin({ ...pos, leverage: 30, mark: D('82000.01') }).toString()).toBe('122.66663333');
  });
});
