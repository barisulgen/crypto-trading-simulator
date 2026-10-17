const BASE = 'https://api.binance.com';

// Raw Binance shapes, typed loosely on purpose.
export type RawJson = any;

export class BinanceRest {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get(path: string, query: string): Promise<RawJson> {
    const res = await this.fetchImpl(`${BASE}${path}${query ? `?${query}` : ''}`, {
      signal: AbortSignal.timeout(10_000),
    });
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
