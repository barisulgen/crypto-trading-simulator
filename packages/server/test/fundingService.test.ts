import { describe, expect, it } from 'vitest';
import { D } from '@sim/engine';
import type { Decimal } from '@sim/engine';
import { FUNDING_POLL_MS, FUNDING_SLOW_POLL_MS, FundingService, FUNDING_UNSETTLED_LOG_MS } from '../src/funding/fundingService.ts';
import type { FundingRef, FundingSim } from '../src/funding/fundingService.ts';
import type { FundingRateQuery } from '../src/binance/futuresRest.ts';
import { marketKey } from '../src/market/marketKey.ts';
import { FakeClock, FakeHistory, runnerHarness, settle, tick, TestPerpMarket } from './helpers.ts';

const perpKeyOf = (symbol: string) => marketKey('perp', symbol);

/** 2026-10-24 08:00:00 UTC. */
const T = Date.UTC(2026, 9, 24, 8, 0, 0);

/** A fundingRate endpoint the test scripts: each poll takes the next answer (none left: an empty list). */
function fakeRest(clock: FakeClock) {
  const answers: (unknown[] | Error)[] = [];
  const calls: { at: number; q: FundingRateQuery }[] = [];
  const rest = {
    fundingRate: async (q: FundingRateQuery) => {
      calls.push({ at: clock.now, q });
      const a = answers.shift() ?? [];
      if (a instanceof Error) throw a;
      return a;
    },
    fundingInfo: async () => [],
  };
  return { rest, answers, calls };
}

const silentLogger = () => ({ info() {}, warn() {}, error() {} });

const settled = (fundingTime = T + 7, fundingRate = '0.0001', markPrice = '80000') => [
  { symbol: 'BTCUSDT', fundingTime, fundingRate, markPrice },
];

/** A runner holding a long 0.1 at 80000 (margin 396), the clock at 07:59:00, and a funding service over it. */
async function setup(opts: { db?: ReturnType<typeof runnerHarness>['db']; clock?: FakeClock; long?: boolean } = {}) {
  const clock = opts.clock ?? new FakeClock(T - 60_000);
  const perpMarket = new TestPerpMarket();
  // Bound late, as main.ts binds them: the service is built over the runner.
  let funding: FundingService | null = null;
  const hooks = {
    fundingTimes: (s: string, start: number, end: number) => funding!.fundingTimes(s, start, end),
    caughtUp: (s: string, since: number) => funding!.caughtUp(s, since),
  };
  const t = runnerHarness({ db: opts.db, clock, perpMarket, funding: hooks });
  t.runner.start();
  if (opts.long ?? true) {
    t.runner.deposit('leverage', D('1000'));
    t.runner.submitPerp({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.1' });
    clock.advance(100);
  }
  const r = fakeRest(clock);
  funding = new FundingService({ rest: r.rest, sim: t.runner, market: perpMarket, now: () => clock.now, setTimer: clock.setTimer, logger: t.logger });
  const advance = async (ms: number) => {
    // Step in small slices so each poll's answer is handled before the next timer.
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.advance(Math.min(1000, end - clock.now));
      await tick();
      await tick();
    }
  };
  const fundingEvents = () => t.eventsOf('funding');
  const windows = () => t.sim.perp.state.funding;
  return { ...t, ...r, funding: funding as FundingService, advance, fundingEvents, windows };
}

describe('FundingService', () => {
  it('opens the window at T − 15 s, closes it at T + 15 s, polls every 30 s until settled, applies exactly once', async () => {
    const t = await setup();
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    await t.advance(T - 15_000 - 1 - t.clock.now);
    expect(t.windows().windows).toEqual({});
    await t.advance(1); // 07:59:45
    expect(t.windows().windows.BTCUSDT?.fundingTime).toBe(T);
    const saved = t.db.prepare('SELECT funding FROM perp_state').get() as { funding: string };
    expect(JSON.parse(saved.funding).windows.BTCUSDT.fundingTime).toBe(T); // saved as it opened
    t.perp.mark('BTCUSDT', '80000', T); // the same funding time again: nothing more is scheduled

    await t.advance(30_000 - 1); // 08:00:14.999
    expect(t.windows().windows.BTCUSDT?.fundingTime).toBe(T);
    await t.advance(1); // 08:00:15
    expect(t.windows().windows).toEqual({});
    expect(t.windows().pending.map((w) => w.fundingTime)).toEqual([T]);

    t.answers.push([], [], settled());
    await t.advance(FUNDING_POLL_MS * 3);
    expect(t.calls.map((c) => c.at)).toEqual([T + 15_000 + 30_000, T + 15_000 + 60_000, T + 15_000 + 90_000]);
    expect(t.calls[0]!.q).toEqual({ symbol: 'BTCUSDT', startTime: T - 60_000, endTime: T + 60_000, limit: 10 });
    expect(t.fundingEvents().map((e) => [e.payload.fundingTime, e.payload.rate, e.payload.markPrice, e.payload.amount])).toEqual([
      [T, '0.0001', '80000', '-0.8'],
    ]);
    expect(t.windows().pending).toEqual([]);
    expect(t.notices()).toContain('Funding paid $0.80 on BTCUSDT long (rate 0.0100%)');

    await t.advance(FUNDING_POLL_MS * 4);
    expect(t.calls).toHaveLength(3); // settled: no more polls
    expect(t.fundingEvents()).toHaveLength(1);
    expect(t.fatal).toEqual([]);
  });

  it('a record more than 60 s from the funding time, or with no usable mark price, is not the settlement', async () => {
    const t = await setup();
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    await t.advance(T + 15_000 - t.clock.now);
    t.answers.push(settled(T + 60_001), settled(T, '0.0001', ''), settled(T - 60_000));
    await t.advance(FUNDING_POLL_MS * 3);
    expect(t.calls).toHaveLength(3);
    expect(t.fundingEvents().map((e) => e.payload.fundingTime)).toEqual([T]);
  });

  it('a restart between the window closing and the settlement still applies it exactly once', async () => {
    const a = await setup();
    a.funding.start();
    a.perp.mark('BTCUSDT', '80000', T);
    await a.advance(T + 15_000 + FUNDING_POLL_MS - a.clock.now); // closed, one poll answered with nothing
    expect(a.calls).toHaveLength(1);
    expect(a.windows().pending.map((w) => w.fundingTime)).toEqual([T]);
    a.funding.stop();
    a.runner.stop();

    await a.advance(10_000); // down for a while
    const b = await setup({ db: a.db, clock: a.clock, long: false });
    expect(b.windows().pending.map((w) => w.fundingTime)).toEqual([T]);
    b.answers.push(settled());
    // Every pending window is polled again, once the symbol has caught up after the downtime
    // (the first fresh poll; the window is applied once either way).
    b.funding.start();
    await b.advance(0);
    expect(b.calls).toHaveLength(0);
    await b.advance(1000);
    await settle();
    await b.advance(1);
    expect(b.calls).toHaveLength(1);
    expect(b.fundingEvents()).toHaveLength(1);
    expect(b.fundingEvents()[0]!.payload.amount).toBe('-0.8');
    await b.advance(FUNDING_POLL_MS * 3);
    expect(a.calls).toHaveLength(1); // the stopped service never polls again
    expect(b.calls).toHaveLength(1);
    expect(b.fundingEvents()).toHaveLength(1);
  });

  it('a restart inside the window keeps it open and closes it at T + 15 s; one whose close never ran is closed at start', async () => {
    const a = await setup();
    a.funding.start();
    a.perp.mark('BTCUSDT', '80000', T);
    await a.advance(T - 5000 - a.clock.now); // inside the window
    expect(a.windows().windows.BTCUSDT?.fundingTime).toBe(T);
    a.funding.stop();
    a.runner.stop();

    const b = await setup({ db: a.db, clock: a.clock, long: false });
    b.funding.start();
    await b.advance(5000 + 15_000 - 1);
    expect(b.windows().windows.BTCUSDT?.fundingTime).toBe(T); // still open: changes in it still count
    await b.advance(1);
    expect(b.windows().pending.map((w) => w.fundingTime)).toEqual([T]);
    b.funding.stop();
    b.runner.stop();

    // A window left open past its close (the server was down at T + 15 s).
    const c0 = await setup({ long: false, clock: new FakeClock(T - 20_000) });
    c0.runner.deposit('leverage', D('1000'));
    c0.funding.start();
    c0.perp.mark('BTCUSDT', '80000', T);
    await c0.advance(6000); // open since T − 15 s
    expect(c0.windows().windows.BTCUSDT?.fundingTime).toBe(T);
    c0.funding.stop();
    c0.runner.stop();
    c0.clock.now = T + 120_000;
    const c = await setup({ db: c0.db, clock: c0.clock, long: false });
    c.answers.push(settled());
    c.funding.start();
    await c.advance(1000); // the first fresh poll: the symbol catches up, which closes the window at T + 15 s
    await settle();
    await c.advance(1);
    expect(c.windows().windows).toEqual({});
    expect(c.windows().pending).toEqual([]);
    expect(c.calls).toHaveLength(1);
    expect(c.windows().applied.BTCUSDT).toEqual([T]);
  });

  it('starting after T + 15 s with no window never opens one: funding the server was down for is left to catch-up', async () => {
    const t = await setup({ clock: new FakeClock(T + 16_000), long: false });
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T); // a mark still naming the funding time just passed
    await t.advance(120_000);
    expect(t.windows().windows).toEqual({});
    expect(t.windows().pending).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('never estimates: unsettled after 6 h it logs once and keeps polling every 5 min; a failing poll is retried', async () => {
    const t = await setup();
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    await t.advance(T + 15_000 - t.clock.now);
    t.answers.push(new Error('Binance /fapi/v1/fundingRate HTTP 503: '));
    await t.advance(FUNDING_UNSETTLED_LOG_MS - 15_000 - 30_000);
    const before = t.calls.length;
    expect(t.calls.at(-1)!.at - t.calls.at(-2)!.at).toBe(FUNDING_POLL_MS);
    expect(t.logs.filter((l) => l.includes('not settled'))).toEqual([]);
    await t.advance(FUNDING_SLOW_POLL_MS * 3 + 30_000);
    const late = t.calls.slice(before);
    expect(late.length).toBeGreaterThanOrEqual(3);
    expect(late.at(-1)!.at - late.at(-2)!.at).toBe(FUNDING_SLOW_POLL_MS);
    expect(t.logs.filter((l) => l.includes('BTCUSDT funding at 2026-10-24T08:00:00.000Z not settled after 6 h'))).toHaveLength(1);
    expect(t.logs.filter((l) => l.includes('fundingRate HTTP 503'))).toHaveLength(1);
    expect(t.fundingEvents()).toEqual([]);
    expect(t.windows().pending.map((w) => w.fundingTime)).toEqual([T]);
    t.answers.push(settled());
    await t.advance(FUNDING_SLOW_POLL_MS);
    expect(t.fundingEvents()).toHaveLength(1);
  });

  it('a suspend past T + 15 s before the open timer fires: the live service opens no window; the catch-up settles T once', async () => {
    const t = await setup({ clock: new FakeClock(T - 4 * 3_600_000) }); // a long held across T
    (t.history as FakeHistory).settlements.BTCUSDT = [{ time: T, rate: D('0.0001'), markPrice: D('80000') }];
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    await t.advance(60_000);
    t.clock.now = T + 2 * 3_600_000; // the laptop slept through the window: no timer ran meanwhile
    t.answers.push(settled(), settled(), settled());
    await t.advance(10 * 60_000);
    // The sleep is a gap: its catch-up settles T from the history, on the 0.1 held across it.
    expect(t.windows().windows).toEqual({});
    expect(t.windows().pending).toEqual([]);
    expect(t.windows().applied).toEqual({ BTCUSDT: [T] });
    expect(t.calls).toEqual([]);
    expect(t.fundingEvents().map((e) => [e.payload.qty, e.payload.amount, e.payload.catchUp.basis])).toEqual([
      ['0.1', '-0.8', 'funding_history'],
    ]);
    expect(t.logs.filter((l) => l.includes('left to catch-up'))).toHaveLength(1);
  });

  it('a waiting window whose time never happened (a later settlement published, none at it) is dropped: no endless polling', async () => {
    const t = await setup();
    const projected = T - 8 * 3_600_000; // projected over a gap; the interval was really 4 h, then changed
    t.runner.openFundingWindow('BTCUSDT', projected);
    t.runner.closeFundingWindow('BTCUSDT', projected);
    expect(t.windows().pending.map((w) => w.fundingTime)).toEqual([projected]);
    t.answers.push(settled(T - 4 * 3_600_000)); // only the later time is settled
    t.funding.start(); // the waiting window is polled at once
    t.clock.advance(0);
    await settle();
    // Asked from just before its time up to now, so a later settlement shows.
    expect(t.calls.map((c) => [c.q.startTime, c.q.endTime])).toEqual([[projected - 60_000, t.clock.now]]);
    expect(t.windows().pending).toEqual([]);
    const saved = t.db.prepare('SELECT funding FROM perp_state').get() as { funding: string };
    expect(JSON.parse(saved.funding).pending).toEqual([]);
    expect(t.fundingEvents()).toEqual([]);
    expect(t.logs.filter((l) => l.includes('never happened'))).toHaveLength(1);
    await t.advance(FUNDING_POLL_MS * 3);
    expect(t.calls).toHaveLength(1);
    expect(t.fatal).toEqual([]);
  });

  it('timers are armed in steps of at most 60 s, so a wake from sleep is noticed within a minute', async () => {
    const clock = new FakeClock(T - 4 * 3_600_000);
    const delays: number[] = [];
    const setTimer = (fn: () => void, ms: number) => {
      delays.push(ms);
      return clock.setTimer(fn, ms);
    };
    const sim: FundingSim = {
      fundingWindows: () => ({ open: [], pending: [] }),
      openFundingWindow: () => {},
      closeFundingWindow: () => {},
      applyFunding: () => {},
    };
    const market = new TestPerpMarket();
    const service = new FundingService({ rest: fakeRest(clock).rest, sim, market, now: () => clock.now, setTimer, logger: silentLogger() });
    service.start();
    market.mark('BTCUSDT', '80000', T);
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    service.stop();
  });

  it('a close that runs late: a position change after T + 15 s is never added to the window', async () => {
    const t = await setup();
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    await t.advance(T - t.clock.now); // the window is open, the long 0.1 in it
    expect(t.windows().windows.BTCUSDT?.fundingTime).toBe(T);
    t.clock.now = T + 3_600_000; // slept from T to T + 1 h
    // An engine call before the service's close timer runs. The sleep is a gap in the data, so the
    // window is left to that gap's catch-up: it stays open, for fills the gap may have had.
    t.perp.mark('BTCUSDT', '80000', T + 8 * 3_600_000); // the first mark after the wake
    expect(t.runner.gate(perpKeyOf('BTCUSDT'))).toBe('stale');
    expect(t.windows().windows.BTCUSDT?.fundingTime).toBe(T);
    // The next poll: fresh, the position held across the gap is caught up, which closes the window
    // at T + 15 s; a position change after that is never added to it.
    await t.advance(1000);
    await settle();
    expect(t.runner.gate(perpKeyOf('BTCUSDT'))).toBe('live');
    expect(t.windows().windows).toEqual({});
    expect(t.windows().pending.map((w) => [w.fundingTime, w.long.max.toString()])).toEqual([[T, '0.1']]);
    t.runner.submitPerp({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.1' });
    t.answers.push(settled());
    await t.advance(FUNDING_POLL_MS + 1000);
    expect(t.sim.perp.state.positions.BTCUSDT!.qty.toString()).toBe('0.2');
    expect(t.fundingEvents().map((e) => [e.payload.qty, e.payload.amount])).toEqual([['0.1', '-0.8']]);
  });

  it('while the account refuses engine calls, a window is given up after one logged refusal: no endless polling', async () => {
    const clock = new FakeClock(T - 60_000);
    const sim: FundingSim = {
      fundingWindows: () => ({ open: [], pending: [{ symbol: 'BTCUSDT', fundingTime: T - 8 * 3_600_000 }] }),
      openFundingWindow: () => {
        throw new Error('Account state failed integrity check; see server log');
      },
      closeFundingWindow: () => {
        throw new Error('Account state failed integrity check; see server log');
      },
      applyFunding: () => {
        throw new Error('Account state failed integrity check; see server log');
      },
    };
    const market = new TestPerpMarket();
    const r = fakeRest(clock);
    r.answers.push(settled(T - 8 * 3_600_000));
    const logs: string[] = [];
    const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const service = new FundingService({ rest: r.rest, sim, market, now: () => clock.now, setTimer: clock.setTimer, logger });
    service.start();
    market.mark('BTCUSDT', '80000', T);
    for (let i = 0; i < 24 * 60; i++) {
      clock.advance(60_000);
      await tick();
    }
    expect(r.calls).toHaveLength(1); // the pending window's one poll; its refused apply ends it
    expect(logs.filter((l) => l.includes('integrity check'))).toHaveLength(1);
    service.stop();
  });

  it('stop() then start() in one process schedules the coming windows again', async () => {
    const t = await setup();
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    t.funding.stop();
    t.funding.start();
    t.perp.mark('BTCUSDT', '80000', T);
    await t.advance(T - t.clock.now);
    expect(t.windows().windows.BTCUSDT?.fundingTime).toBe(T);
  });

  it('works against any FundingSim: open, close and apply are called with the funding time and the settled values', async () => {
    const clock = new FakeClock(T - 60_000);
    const calls: string[] = [];
    const pending: FundingRef[] = [];
    const sim: FundingSim = {
      fundingWindows: () => ({ open: [], pending }),
      openFundingWindow: (s, ft) => void calls.push(`open ${s} T${ft - T} at T${clock.now - T}`),
      closeFundingWindow: (s, ft) => {
        calls.push(`close ${s} T${ft - T} at T+${clock.now - T}`);
        pending.push({ symbol: s, fundingTime: ft });
      },
      applyFunding: (s, ft, rate: Decimal, mark: Decimal) => void calls.push(`apply ${s} T${ft - T} ${rate} ${mark} at T+${clock.now - T}`),
    };
    const market = new TestPerpMarket();
    const r = fakeRest(clock);
    r.answers.push(settled(T - 3, '-0.00025', '80123.4'));
    const logs: string[] = [];
    const service = new FundingService({
      rest: r.rest,
      sim,
      market,
      now: () => clock.now,
      setTimer: clock.setTimer,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    service.start();
    market.mark('BTCUSDT', '80000', T);
    for (let i = 0; i < 120; i++) {
      clock.advance(1000);
      await tick();
    }
    expect(calls).toEqual([
      'open BTCUSDT T0 at T-15000',
      'close BTCUSDT T0 at T+15000',
      'apply BTCUSDT T0 -0.00025 80123.4 at T+45000',
    ]);
    service.stop();
  });
});
