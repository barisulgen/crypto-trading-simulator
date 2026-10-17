import { EventEmitter } from 'node:events';

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

