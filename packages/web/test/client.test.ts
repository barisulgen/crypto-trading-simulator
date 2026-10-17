import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for the browser WebSocket: the test opens and closes it by hand. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const META = { coins: [], symbols: [], rules: {}, fees: {}, testData: true, season: { id: 1, name: 'S1', startedAt: 0 } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'sim.test' });
  vi.stubGlobal('window', { addEventListener() {} });
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(META), { status: 200 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

/** Milliseconds until the client opens its next socket (checked to the millisecond). */
async function delayUntilNextSocket(): Promise<number> {
  const before = FakeSocket.instances.length;
  for (let ms = 1; ms <= 20_000; ms++) {
    await vi.advanceTimersByTimeAsync(1);
    if (FakeSocket.instances.length > before) return ms;
  }
  throw new Error('no reconnect within 20 s');
}

describe('live WebSocket client', () => {
  it('subscribes on open and backs off 1, 2, 4, 8, 10, 10 s while the server accepts then drops', async () => {
    const { startLive } = await import('../src/lib/live.ts');
    startLive();
    expect(latest().url).toBe('ws://sim.test/ws');
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      latest().open();
      expect(JSON.parse(latest().sent[0]!)).toEqual({ type: 'subscribe', symbol: 'BTCUSDT', interval: '15m' });
      await vi.advanceTimersByTimeAsync(100);
      latest().close();
      delays.push(await delayUntilNextSocket());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it('starts again from 1 s after a connection that stayed open for 5 s', async () => {
    const { startLive, useLive } = await import('../src/lib/live.ts');
    startLive();
    for (let i = 0; i < 3; i++) {
      latest().open();
      latest().close();
      await delayUntilNextSocket();
    }
    latest().open();
    expect(useLive.getState().conn).toBe('open');
    await vi.advanceTimersByTimeAsync(5000);
    latest().close();
    expect(useLive.getState().conn).toBe('down');
    expect(await delayUntilNextSocket()).toBe(1000);
  });
});
