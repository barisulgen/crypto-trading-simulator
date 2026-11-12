// A stats worker that never answers a request for the time zone Test/Hang (it spins), and serves every
// other request with the real worker's code. The real worker's message handler is wrapped as it is
// registered, so no request can reach it before the check.
import { parentPort } from 'node:worker_threads';

const on = parentPort.on.bind(parentPort);
parentPort.on = (event, handler) =>
  event === 'message'
    ? on(event, (text) => {
        if (typeof text === 'string' && text.includes('Test/Hang')) for (;;) {}
        handler(text);
      })
    : on(event, handler);

await import('../../src/stats/statsWorker.mjs');
