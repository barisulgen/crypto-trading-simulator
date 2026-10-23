import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WirePreview } from '../src/lib/api.ts';
import { PreviewLoop } from '../src/lib/previewLoop.ts';
import type { PreviewState } from '../src/lib/previewLoop.ts';

const answer = (total: string) => ({ total }) as WirePreview;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** A loop whose fetches wait until the test resolves them. */
function setup() {
  const calls: { key: string; d: ReturnType<typeof deferred<WirePreview>> }[] = [];
  const states: PreviewState[] = [];
  const loop = new PreviewLoop(
    (key) => {
      const d = deferred<WirePreview>();
      calls.push({ key, d });
      return d.promise;
    },
    (s) => states.push(s),
  );
  return { loop, calls, states };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe('preview loop', () => {
  it('asks once, 250 ms after the last edit, for the final form only', async () => {
    const { loop, calls } = setup();
    loop.setKey('a');
    await vi.advanceTimersByTimeAsync(100);
    loop.setKey('ab');
    await vi.advanceTimersByTimeAsync(100);
    loop.setKey('abc');
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => c.key)).toEqual(['abc']);
  });

  it('refreshes on book updates at most twice a second', async () => {
    const { loop, calls, states } = setup();
    loop.setKey('k');
    await vi.advanceTimersByTimeAsync(250); // first ask at t=250
    calls[0]!.d.resolve(answer('1'));
    await vi.advanceTimersByTimeAsync(50);
    expect(states.at(-1)).toEqual({ key: 'k', preview: answer('1'), error: null });
    loop.bookChanged(); // t=300: waits until 500 ms after the last ask
    loop.bookChanged();
    await vi.advanceTimersByTimeAsync(449);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
  });

  it('a slow answer is not starved: book updates never supersede a request for the same form', async () => {
    const { loop, calls, states } = setup();
    loop.setKey('k');
    await vi.advanceTimersByTimeAsync(250);
    // The server takes 2 s; the book moves every 100 ms meanwhile.
    for (let i = 0; i < 20; i++) {
      loop.bookChanged();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(calls).toHaveLength(1);
    calls[0]!.d.resolve(answer('slow'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ key: 'k', preview: answer('slow'), error: null });
  });

  it('a changed form drops the answer still on its way for the old one', async () => {
    const { loop, calls, states } = setup();
    loop.setKey('old');
    await vi.advanceTimersByTimeAsync(250);
    loop.setKey('new');
    calls[0]!.d.resolve(answer('old'));
    await vi.advanceTimersByTimeAsync(250);
    expect(states.some((s) => s.key === 'old')).toBe(false);
    calls[1]!.d.resolve(answer('new'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ key: 'new', preview: answer('new'), error: null });
  });

  it('nothing to preview (a field emptied) clears the estimate and ignores book updates', async () => {
    const { loop, calls, states } = setup();
    loop.setKey('k');
    await vi.advanceTimersByTimeAsync(250);
    calls[0]!.d.resolve(answer('1'));
    await vi.advanceTimersByTimeAsync(0);
    loop.setKey(null);
    loop.bookChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(states.at(-1)).toEqual({ key: null, preview: null, error: null });
  });

  it('a failed request shows its error text', async () => {
    const states: PreviewState[] = [];
    const loop = new PreviewLoop(() => Promise.reject(new Error('Unknown symbol X')), (s) => states.push(s));
    loop.setKey('k');
    await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)).toEqual({ key: 'k', preview: null, error: 'Unknown symbol X' });
  });
});

describe('preview loop refresh', () => {
  it('asks again at once for the same form, dropping an answer still on its way', async () => {
    const { loop, calls, states } = setup();
    loop.setKey('k');
    await vi.advanceTimersByTimeAsync(250);
    calls[0]!.d.resolve(answer('1'));
    await vi.advanceTimersByTimeAsync(0);
    loop.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.key)).toEqual(['k', 'k']);
    loop.refresh(); // the second request is now superseded
    await vi.advanceTimersByTimeAsync(0);
    calls[1]!.d.resolve(answer('stale'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ key: 'k', preview: answer('1'), error: null });
    calls[2]!.d.resolve(answer('3'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ key: 'k', preview: answer('3'), error: null });
  });

  it('does nothing without a form', async () => {
    const { loop, calls } = setup();
    loop.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(0);
  });
});
