const BASE = 'https://api.binance.com';

// Raw Binance shapes, typed loosely on purpose.
export type RawJson = any;

export class BinanceRest {
  private pausedUntilMs = 0;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Epoch ms before which no REST call is made (after an HTTP 429/418); 0 if not paused. */
  get pausedUntil(): number {
    return this.pausedUntilMs;
  }

  private async get(path: string, query: string): Promise<RawJson> {
    if (this.now() < this.pausedUntilMs) {
      throw new Error(`Binance REST paused for ${Math.ceil((this.pausedUntilMs - this.now()) / 1000)}s (rate limited)`);
    }
    const res = await this.fetchImpl(`${BASE}${path}${query ? `?${query}` : ''}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 || res.status === 418) {
      const ra = Number(res.headers?.get?.('retry-after'));
      const seconds = Number.isFinite(ra) && ra > 0 ? ra : 60;
      this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + seconds * 1000);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Binance ${path} HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }

  exchangeInfo(symbols: string[]): Promise<RawJson> {
    return this.get('/api/v3/exchangeInfo', `symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  }

  depth(symbol: string, limit = 1000): Promise<RawJson> {
    return this.get('/api/v3/depth', `symbol=${symbol}&limit=${limit}`);
  }

  avgPrice(symbol: string): Promise<RawJson> {
    return this.get('/api/v3/avgPrice', `symbol=${symbol}`);
  }

  klines(symbol: string, interval: string, limit: number, endTime?: number): Promise<RawJson> {
    const end = endTime === undefined ? '' : `&endTime=${endTime}`;
    return this.get('/api/v3/klines', `symbol=${symbol}&interval=${interval}&limit=${limit}${end}`);
  }

  serverTime(): Promise<RawJson> {
    return this.get('/api/v3/time', '');
  }
}
