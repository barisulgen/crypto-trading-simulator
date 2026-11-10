import { D, type Decimal } from '../decimal.ts';
import type { Position } from '../perp/types.ts';
import type { Costs, Risk, StatsEvent } from './types.ts';

const GAP_BASES = new Set(['trigger_minute_worst_price', 'candle_worst_price']);

/**
 * What the given events cost: fees by liquidity, liquidation fees, slippage (including what a stop
 * or take-profit estimated from history gapped through its trigger), and funding paid. The events
 * are trusted to be already filtered by time, coin and market. `netPnl` is the P&L of the same
 * scope, after costs.
 */
export function costs(events: StatsEvent[], netPnl: Decimal): Costs {
  let makerFees = D(0);
  let takerFees = D(0);
  let liquidationFees = D(0);
  let fundingPaid = D(0);
  let fundingReceived = D(0);
  let fillSlippage = D(0);
  let catchUpGapCost = D(0);
  let drift = D(0);
  let uncovered = D(0);
  let estimatedFills = 0;

  for (const { event: e } of events) {
    if (e.type === 'fill') {
      const f = e.fill;
      const fee = e.market === 'perp' ? f.fee : f.feeUsd;
      if (f.liquidity === 'maker') makerFees = makerFees.plus(fee);
      else takerFees = takerFees.plus(fee);
      fillSlippage = fillSlippage.plus(f.slippageUsd);
      drift = drift.plus(f.driftUsd);
      if (e.market === 'perp' && e.fill.uncovered) uncovered = uncovered.plus(e.fill.uncovered);
      if (e.catchUp) {
        estimatedFills += 1;
        if (GAP_BASES.has(e.catchUp.basis) && f.triggerPrice !== null) {
          const gap = f.side === 'sell' ? f.triggerPrice.minus(f.price) : f.price.minus(f.triggerPrice);
          if (gap.gt(0)) catchUpGapCost = catchUpGapCost.plus(gap.times(f.qty));
        }
      }
    } else if (e.type === 'liquidation') {
      liquidationFees = liquidationFees.plus(e.liquidationFee);
    } else if (e.type === 'funding') {
      if (e.amount.lt(0)) fundingPaid = fundingPaid.minus(e.amount);
      else fundingReceived = fundingReceived.plus(e.amount);
      if (e.uncollected) uncovered = uncovered.plus(e.uncollected);
    }
  }

  const fundingNet = fundingReceived.minus(fundingPaid);
  const slippage = fillSlippage.plus(catchUpGapCost);
  const total = makerFees
    .plus(takerFees)
    .plus(liquidationFees)
    .plus(slippage)
    .plus(fundingNet.lt(0) ? fundingNet.neg() : 0);
  const preCost = netPnl.plus(total);
  return {
    makerFees,
    takerFees,
    liquidationFees,
    fundingPaid,
    fundingReceived,
    fundingNet,
    slippage,
    catchUpGapCost,
    drift,
    total,
    share: preCost.gt(0) ? total.div(preCost) : null,
    preCost,
    uncovered,
    estimatedFills,
  };
}

/**
 * Liquidations in the range and the leverage of every position open at some moment of it. The
 * events are filtered by coin and market but not by time; `range` bounds are inclusive and a null
 * bound is open. Positions come from the events and `openPositions`, merged by id.
 */
export function risk(
  events: StatsEvent[],
  openPositions: Position[],
  range: { from: number | null; to: number | null },
): Risk {
  const { from, to } = range;
  let liquidations = 0;
  let lostToLiquidations = D(0);
  let liquidationFees = D(0);
  const leverage = new Map<string, number>();
  const openedAt = new Map<string, number>();
  const closedAt = new Map<string, number>();

  for (const { event: e } of events) {
    if (e.type === 'liquidation') {
      if ((from === null || e.time >= from) && (to === null || e.time <= to)) {
        liquidations += 1;
        lostToLiquidations = lostToLiquidations.plus(e.marginLost);
        liquidationFees = liquidationFees.plus(e.liquidationFee);
      }
    } else if (e.type === 'position_opened') {
      leverage.set(e.position.id, e.position.leverage);
      openedAt.set(e.position.id, e.position.openedAt);
    } else if (e.type === 'position_closed') {
      leverage.set(e.position.id, e.position.leverage);
      openedAt.set(e.position.id, e.position.openedAt);
      closedAt.set(e.position.id, e.time);
    }
  }
  for (const p of openPositions) {
    if (!leverage.has(p.id)) {
      leverage.set(p.id, p.leverage);
      openedAt.set(p.id, p.openedAt);
    }
  }

  const levs: number[] = [];
  for (const [id, lev] of leverage) {
    const opened = openedAt.get(id)!;
    const closed = closedAt.get(id);
    if (to !== null && opened > to) continue;
    if (from !== null && closed !== undefined && closed < from) continue;
    levs.push(lev);
  }

  return {
    liquidations,
    lostToLiquidations,
    liquidationFees,
    avgLeverage: levs.length === 0 ? null : levs.reduce((a, b) => a.plus(b), D(0)).div(levs.length),
    maxLeverage: levs.length === 0 ? null : Math.max(...levs),
  };
}
