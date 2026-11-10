import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { FakeBinance } from './fakeBinance.ts';
import { liveServerCount, ServerProcess, startScenario, tempDir, TSX_LOADER, waitFor } from './harness.ts';
import type { ScenarioOptions } from './harness.ts';

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const reachable = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/api/v3/time`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
};

describe('the e2e harness leaves nothing behind', () => {
  it('a scenario whose setup fails kills its server, stops its fake and removes its directory before rethrowing', async () => {
    let fakePort: number | undefined;
    let server: ServerProcess | undefined;
    let dir: string | undefined;
    const observe: ScenarioOptions['observe'] = (p) => {
      if (p.fake) fakePort = p.fake.port;
      server ??= p.server;
      dir ??= p.dir;
    };
    // A key that never becomes fresh: the setup times out after the server is up.
    await expect(startScenario({ freshKeys: ['perp:NOSUCHUSDT'], freshTimeoutMs: 2000, observe })).rejects.toThrow(/health/);
    expect(server).toBeDefined();
    await waitFor('the server process to be gone', () => !alive(server!.child.pid), 5000);
    expect(await reachable(fakePort!)).toBe(false);
    expect(existsSync(dir!)).toBe(false);
    expect(liveServerCount()).toBe(0);
  });

  it('a server that exits while starting rejects at once, with its output', async () => {
    const fake = new FakeBinance();
    await fake.start();
    const tmp = tempDir();
    try {
      const started = Date.now();
      // Refused at startup: the key would go over plain http to another computer.
      const err = await ServerProcess.start({
        fake,
        dir: tmp.dir,
        dbPath: tmp.dbPath,
        env: { BINANCE_FUTURES_REST_URL: 'http://relay.example' },
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/exited/);
      expect((err as Error).message).toContain('BINANCE_FUTURES_REST_URL must be an https:// address');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(liveServerCount()).toBe(0);
    } finally {
      await fake.stop();
      tmp.remove();
    }
  });

  it('a port taken meanwhile is retried on another', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as AddressInfo).port;
    const fake = new FakeBinance();
    await fake.start();
    const tmp = tempDir();
    let server: ServerProcess | null = null;
    try {
      server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath, port: taken });
      expect(server.port).not.toBe(taken);
      expect((await fetch(`${server.url}/api/meta`)).ok).toBe(true);
    } finally {
      await server?.kill();
      await fake.stop();
      tmp.remove();
      blocker.close();
    }
  });

  it('a port taken by another server that answers is not mistaken for this server being ready', async () => {
    // Another scenario's server, say, took the port first and answers /api/meta.
    const impostor = createHttpServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    const taken = (impostor.address() as AddressInfo).port;
    const fake = new FakeBinance();
    await fake.start();
    const tmp = tempDir();
    let server: ServerProcess | null = null;
    try {
      server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath, port: taken });
      expect(server.port).not.toBe(taken);
      expect(server.logs.some((l) => l.includes(`listening on http://127.0.0.1:${server!.port} `))).toBe(true);
      expect(((await (await fetch(`${server.url}/api/meta`)).json()) as any).symbols).toHaveLength(10);
    } finally {
      await server?.kill();
      await fake.stop();
      tmp.remove();
      impostor.close();
    }
  });

  it('a test process that exits without cleaning up takes its servers with it', async () => {
    const script = fileURLToPath(new URL('./abandon.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', TSX_LOADER, script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const code = await new Promise<number | null>((r) => child.once('exit', r));
    expect(code, out).toBe(0);
    const pid = Number(/PID (\d+)/.exec(out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await waitFor('the abandoned server to be gone', () => !alive(pid), 5000);
  });
});
