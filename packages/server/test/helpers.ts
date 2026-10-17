import { EventEmitter } from 'node:events';
import type { AggTrade, BookSnapshot, Decimal } from '@sim/engine';
import { FakeMarket } from '../../engine/test/fixtures.ts';
import type { HealthTransition } from '../src/market/feedHealth.ts';

export const WATCHDOG_MS = 5000;
export const tick = () => new Promise<void>((r) => setImmediate(r));

/** Manual timers: nothing runs until the test fires it. */
export function fakeTimers() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t = { fn, ms, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  // The 5 s socket-watchdog check is bookkeeping; tests address it explicitly via fireMs.
  const pending = () => timers.filter((t) => t.live && t.ms !== WATCHDOG_MS);
  const all = () => timers.filter((t) => t.live);
  const fire = (i = 0) => {
    const t = pending()[i]!;
    t.live = false;
    t.fn();
  };
  const fireMs = (ms: number) => {
    const t = timers.find((x) => x.live && x.ms === ms)!;
    t.live = false;
    t.fn();
  };
  return { setTimer, pending, all, fire, fireMs };
}

export class FakeWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  terminated = false;
  constructor(public url: string) {
    super();
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.terminated = true;
  }
  open() {
    this.emit('open');
  }
  msg(o: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(o)), false);
  }
  drop() {
    this.emit('close');
  }
}


/** A clock with timers that run in due order when the test advances time. */
export class FakeClock {
  private timers: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
  private seq = 0;
  constructor(public now: number) {}

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = { at: this.now + Math.max(0, ms), seq: this.seq++, fn, live: true };
    this.timers.push(t);
    return () => {
      t.live = false;
    };
  };

  /** Move time forward by ms, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.live && t.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      due.live = false;
      this.now = Math.max(this.now, due.at);
      due.fn();
    }
    this.now = end;
    this.timers = this.timers.filter((t) => t.live);
  }
}

/**
 * The engine's FakeMarket plus what the runner and client hub read from MarketData:
 * bestBid, health snapshot, tickers, book top, recent trades and the 'trade' / 'book' events.
 */
export class TestMarket extends FakeMarket {
  private readonly emitter = new EventEmitter();
  staleReason = 'Disconnected';
  constructor(private readonly symbols: string[] = ['BTCUSDT']) {
    super();
  }
  on(event: string, cb: (...args: any[]) => void): this {
    this.emitter.on(event, cb);
    return this;
  }
  off(event: string, cb: (...args: any[]) => void): this {
    this.emitter.off(event, cb);
    return this;
  }
  /** Deliver a live trade, as MarketData does. */
  trade(symbol: string, t: AggTrade): void {
    this.setLastPrice(symbol, t.price);
    this.emitter.emit('trade', symbol, t);
  }
  bestBid(symbol: string): { price: Decimal; fresh: boolean } | null {
    const b = this.book(symbol).bids[0];
    return b ? { price: b.price, fresh: this.isFresh(symbol) } : null;
  }
  healthSnapshot(): Record<string, { fresh: boolean; reason: string | null }> {
    return Object.fromEntries(
      this.symbols.map((s) => [s, { fresh: this.isFresh(s), reason: this.isFresh(s) ? null : this.staleReason }]),
    );
  }
  tickers(): Record<string, { last: Decimal; open24h: Decimal; change24hPct: Decimal }> {
    return {};
  }
  bookTop(symbol: string, levels = 20): BookSnapshot {
    const b = this.book(symbol);
    return { bids: b.bids.slice(0, levels), asks: b.asks.slice(0, levels) };
  }
  recentTrades(_symbol: string, _n?: number): AggTrade[] {
    return [];
  }
}

/** FeedHealth.poll over a TestMarket's freshness; like FeedHealth, every symbol starts unreported (stale). */
export class FakeHealth {
  private reported = new Map<string, boolean>();
  constructor(
    private readonly market: TestMarket,
    private readonly symbols: string[],
  ) {}
  poll(now: number): HealthTransition[] {
    const out: HealthTransition[] = [];
    for (const symbol of this.symbols) {
      const fresh = this.market.isFresh(symbol);
      if (fresh === (this.reported.get(symbol) ?? false)) continue;
      this.reported.set(symbol, fresh);
      out.push({ symbol, fresh, reason: fresh ? null : this.market.staleReason, at: now });
    }
    return out;
  }
}
