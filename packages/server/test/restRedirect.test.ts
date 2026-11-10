import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FuturesRest } from '../src/binance/futuresRest.ts';
import { BinanceRest } from '../src/binance/rest.ts';
import { PauseController } from '../src/binance/restCore.ts';

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe('REST requests and redirects', () => {
  it('a REST request that is redirected fails instead of following, so the key header is never sent elsewhere', async () => {
    const elsewhere: IncomingMessage[] = [];
    const other = await listen((req, res) => {
      elsewhere.push(req);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now() }));
    });
    const relay = await listen((req, res) => {
      res.writeHead(302, { location: `${other.url}${req.url}` }).end();
    });
    try {
      const pause = new PauseController(Date.now);
      const futures = new FuturesRest(fetch, Date.now, { pause, base: relay.url });
      await expect(futures.leverageBracket('the-key', 'the-secret')).rejects.toThrow();
      const spot = new BinanceRest(fetch, Date.now, { pause, base: relay.url });
      await expect(spot.serverTime()).rejects.toThrow();
      expect(elsewhere).toHaveLength(0);
    } finally {
      await close(relay.server);
      await close(other.server);
    }
  });

  it('every REST request is sent with redirects refused', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
    }) as unknown as typeof fetch;
    const pause = new PauseController(Date.now);
    await new BinanceRest(fetchImpl, Date.now, { pause }).serverTime();
    await new FuturesRest(fetchImpl, Date.now, { pause }).leverageBracket('k', 's');
    expect(inits.length).toBe(3);
    for (const init of inits) expect(init.redirect).toBe('error');
  });
});
