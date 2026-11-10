import { D } from '../decimal.ts';
import type { Decimal } from '../decimal.ts';
import type { Position, PositionCloseReason } from '../perp/types.ts';
import type { BuiltTrades, OpenTrade, StatsEvent, Trade } from './types.ts';

interface PerpGroup {
  symbol: string;
  estimated: boolean;
  funding: Decimal;
  closed: { id: number; time: number; position: Position; realizedPnl: Decimal; fees: Decimal; reason: PositionCloseReason } | null;
}

interface SpotGroup {
  symbol: string;
  estimated: boolean;
  fees: Decimal;
  closed: { id: number; openedAt: number; closedAt: number; pnl: Decimal } | null;
}

/**
 * The closed trades of a recorded event list, and what is still open. A perp trade is one position
 * from open to close, with every fill and funding payment that names it, including funding settled
 * after the close. A spot trade is one round trip, with every fill that carries its id; a sale of
 * dust left behind by a closed trip (it carries no trip) joins that coin's latest closed trip; one
 * made before any trip of its coin had closed is returned as unattributed.
 */
export function buildTrades(events: StatsEvent[]): BuiltTrades {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const perp = new Map<string, PerpGroup>();
  const spot = new Map<string, SpotGroup>();
  // The latest closed trip of each coin, for a dust sale that carries no trip.
  const lastClosedTrip = new Map<string, string>();
  const unattributed: StatsEvent[] = [];

  const perpGroup = (id: string, symbol: string): PerpGroup => {
    let g = perp.get(id);
    if (!g) {
      g = { symbol, estimated: false, funding: D(0), closed: null };
      perp.set(id, g);
    }
    return g;
  };
  const spotGroup = (id: string, symbol: string): SpotGroup => {
    let g = spot.get(id);
    if (!g) {
      g = { symbol, estimated: false, fees: D(0), closed: null };
      spot.set(id, g);
    }
    return g;
  };

  for (const row of ordered) {
    const e = row.event;
    const estimated = 'catchUp' in e && e.catchUp !== undefined;
    if (e.type === 'fill') {
      if (e.market === 'perp') {
        const g = perpGroup(e.fill.positionId, e.fill.symbol);
        if (estimated) g.estimated = true;
      } else {
        const tripId = e.fill.roundTripId ?? (e.fill.side === 'sell' ? lastClosedTrip.get(e.fill.symbol) : undefined);
        if (tripId === undefined) {
          if (e.fill.side === 'sell') unattributed.push(row);
          continue;
        }
        const g = spotGroup(tripId, e.fill.symbol);
        g.fees = g.fees.plus(e.fill.feeUsd);
        if (estimated) g.estimated = true;
        // A dust sale adds its P&L to the trip it came from; a trip's own sells are in its closing pnl.
        if (e.fill.roundTripId === null && g.closed && e.fill.realizedPnl) {
          g.closed.pnl = g.closed.pnl.plus(e.fill.realizedPnl);
        }
      }
    } else if (e.type === 'position_opened') {
      const g = perpGroup(e.position.id, e.position.symbol);
      if (estimated) g.estimated = true;
    } else if (e.type === 'funding') {
      const g = perpGroup(e.positionId, e.symbol);
      g.funding = g.funding.plus(e.amount);
      if (estimated) g.estimated = true;
    } else if (e.type === 'liquidation') {
      const g = perpGroup(e.position.id, e.symbol);
      if (estimated) g.estimated = true;
    } else if (e.type === 'position_closed') {
      const g = perpGroup(e.position.id, e.position.symbol);
      g.closed = {
        id: row.id,
        time: e.time,
        position: e.position,
        realizedPnl: e.realizedPnl,
        fees: e.fees,
        reason: e.reason,
      };
      if (estimated) g.estimated = true;
    } else if (e.type === 'round_trip_closed') {
      const g = spotGroup(e.roundTrip.id, e.roundTrip.symbol);
      g.closed = { id: row.id, openedAt: e.roundTrip.openedAt, closedAt: e.roundTrip.closedAt, pnl: e.roundTrip.pnl };
      lastClosedTrip.set(e.roundTrip.symbol, e.roundTrip.id);
      if (estimated) g.estimated = true;
    }
  }

  const trades: Trade[] = [];
  const open: OpenTrade[] = [];

  for (const [id, g] of perp) {
    if (!g.closed) {
      open.push({ market: 'perp', symbol: g.symbol, id });
      continue;
    }
    const c = g.closed;
    trades.push({
      id,
      market: 'perp',
      symbol: c.position.symbol,
      side: c.position.side,
      leverage: c.position.leverage,
      openedAt: c.position.openedAt,
      closedAt: c.time,
      closeEventId: c.id,
      result: c.realizedPnl.minus(c.fees).plus(g.funding),
      fees: c.fees,
      funding: g.funding,
      estimated: g.estimated,
      reason: c.reason,
    });
  }

  for (const [id, g] of spot) {
    if (!g.closed) {
      open.push({ market: 'spot', symbol: g.symbol, id });
      continue;
    }
    trades.push({
      id,
      market: 'spot',
      symbol: g.symbol,
      side: 'long',
      leverage: null,
      openedAt: g.closed.openedAt,
      closedAt: g.closed.closedAt,
      closeEventId: g.closed.id,
      result: g.closed.pnl,
      fees: g.fees,
      funding: D(0),
      estimated: g.estimated,
      reason: 'round_trip',
    });
  }

  trades.sort((a, b) => a.closedAt - b.closedAt || a.closeEventId - b.closeEventId);
  return { trades, open, unattributed };
}
