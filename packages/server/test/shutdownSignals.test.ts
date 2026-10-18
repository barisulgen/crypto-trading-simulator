import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { onShutdownSignals } from '../src/shutdownSignals.ts';

describe('onShutdownSignals', () => {
  it('runs the graceful shutdown on SIGINT, SIGTERM and the Windows console signals SIGBREAK and SIGHUP', () => {
    const proc = new EventEmitter();
    const got: string[] = [];
    onShutdownSignals(proc, (signal) => got.push(signal));
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) proc.emit(s);
    expect(got).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  });
});
