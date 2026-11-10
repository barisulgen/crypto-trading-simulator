import { D } from '@sim/engine';
import type { Decimal } from '@sim/engine';
import { DEPOSIT_BTC_REFUSAL } from '../../src/runner.ts';
import { waitFor } from './harness.ts';
import type { ServerProcess } from './harness.ts';

/** Owner actions through the HTTP API, as the web app sends them. */

/** Sent again while the server refuses it for want of live BTC spot data (it has not arrived yet). */
export async function deposit(server: ServerProcess, wallet: 'spot' | 'leverage', amount: string): Promise<void> {
  const r = await waitFor('live BTC spot data for a deposit', async () => {
    const res = await server.post<{ error?: string }>('/api/deposit', { wallet, amount });
    return res.status === 503 && res.body.error === DEPOSIT_BTC_REFUSAL ? undefined : res;
  });
  if (r.status !== 200) throw new Error(`POST /api/deposit: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function position(server: ServerProcess, symbol: string): Promise<any | null> {
  const { positions } = await server.get<{ positions: any[] }>('/api/positions');
  return positions.find((p) => p.symbol === symbol) ?? null;
}

/** Sets the leverage and sends a market order; resolves with the position once the order has filled. */
export async function openPosition(
  server: ServerProcess,
  p: { symbol: string; side: 'buy' | 'sell'; qty: string; leverage: number },
): Promise<any> {
  await server.ok('/api/perp/leverage', { symbol: p.symbol, leverage: p.leverage });
  const { order } = await server.ok('/api/perp/orders', { symbol: p.symbol, side: p.side, type: 'market', qty: p.qty });
  if (order.status === 'rejected') throw new Error(`order rejected: ${order.rejectReason}`);
  return waitFor(`the ${p.symbol} position`, async () => {
    const pos = await position(server, p.symbol);
    return pos && D(pos.qty).eq(p.qty) ? pos : undefined;
  });
}

/** The order of either market as the server holds it now (open or recent). */
export async function findOrder(server: ServerProcess, market: 'spot' | 'perp', id: string): Promise<any | undefined> {
  for (const status of ['open', 'recent']) {
    const { orders } = await server.get<{ orders: any[] }>(`/api/orders?status=${status}&market=${market}`);
    const o = orders.find((x) => x.id === id);
    if (o) return o;
  }
  return undefined;
}

export async function waitOrderStatus(server: ServerProcess, market: 'spot' | 'perp', id: string, statuses: string[], timeoutMs = 10_000): Promise<any> {
  return waitFor(`order ${id} to be ${statuses.join(' or ')}`, async () => {
    const o = await findOrder(server, market, id);
    return o && statuses.includes(o.status) ? o : undefined;
  }, timeoutMs);
}

/**
 * The mark at which an isolated long's margin ratio (maintenance ÷ margin balance) is `ratio`, in
 * the first leverage bracket (maintenance = qty × mark × mmr): mark = r(qE − M) ÷ (q(r − mmr)).
 */
export function longMarkAtRatio(p: { qty: string; entryPrice: string; margin: string }, ratio: Decimal, mmr: Decimal): Decimal {
  const q = D(p.qty);
  return ratio.mul(q.mul(p.entryPrice).minus(p.margin)).div(q.mul(ratio.minus(mmr)));
}
