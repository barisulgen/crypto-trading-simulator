import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { E2E_KEY, E2E_SECRET, FakeBinance, START_PRICES, SYMBOLS } from './fakeBinance.ts';

export { E2E_KEY, E2E_SECRET };

/** The real server's entry point, run as its own process exactly as `npm start` runs it. */
const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const require = createRequire(import.meta.url);
/** tsx's ESM loader, resolved through its package exports. */
export const TSX_LOADER = pathToFileURL(require.resolve('tsx/esm')).href;
/** How many times a server is started on a fresh port when the one it was given is taken. */
const PORT_ATTEMPTS = 3;

/** Server processes started and not yet exited. */
const liveServers = new Set<ChildProcess>();

/**
 * Every server still running dies with the test process, however it ends: normally, on an
 * uncaught error, or on Ctrl+C / a kill signal.
 */
function killAll(): void {
  for (const c of liveServers) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  liveServers.clear();
}
process.on('exit', killAll);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    killAll();
    process.exit(code);
  });
}

/** How many server processes are running now. */
export function liveServerCount(): number {
  return liveServers.size;
}

/** Polls `check` until it returns a value other than undefined/false, or fails after `timeoutMs` saying `what`. */
export async function waitFor<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 15_000, everyMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await check();
      if (v !== undefined && v !== false) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A temporary directory for one scenario: the database and the server's working directory. */
export function tempDir(): { dir: string; dbPath: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'sim-e2e-'));
  return {
    dir,
    dbPath: join(dir, 'sim.sqlite'),
    remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

export interface ServerOptions {
  fake: FakeBinance;
  /** The scenario's directory: the server runs in it (no settings file there) with its database. */
  dir: string;
  dbPath: string;
  /** Extra settings for the server, over the ones pointing it at the fake. */
  env?: Record<string, string>;
  /** The port to try first (default: a free one). */
  port?: number;
}

/** The server could not listen: its port was taken. */
class PortTaken extends Error {}

/** The simulator server, spawned from its entry point against the fake Binance. */
export class ServerProcess {
  readonly logs: string[] = [];
  private readonly exited: Promise<number | null>;

  private constructor(
    readonly child: ChildProcess,
    readonly port: number,
  ) {
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) this.logs.push(line);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  }

  /**
   * Spawns the server and resolves once it answers. A server that exits first rejects at once with
   * its output; one whose port was taken meanwhile is started again on another.
   */
  static async start(o: ServerOptions): Promise<ServerProcess> {
    for (let attempt = 1; ; attempt++) {
      const port = attempt === 1 && o.port !== undefined ? o.port : await freePort();
      try {
        return await ServerProcess.startOn(o, port);
      } catch (e) {
        if (!(e instanceof PortTaken) || attempt >= PORT_ATTEMPTS) throw e;
      }
    }
  }

  private static async startOn(o: ServerOptions, port: number): Promise<ServerProcess> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Nothing from the developer's own settings reaches the server under test.
    for (const k of Object.keys(env)) if (/^(BINANCE_|APP_PASSWORD$|HOST$|PORT$|DB_PATH$)/.test(k)) delete env[k];
    Object.assign(env, o.fake.env(), {
      PORT: String(port),
      DB_PATH: o.dbPath,
      // The fake checks the signed leverage-bracket request against this pair.
      BINANCE_KEY: E2E_KEY,
      BINANCE_SECRET: E2E_SECRET,
      ...o.env,
    });
    const child = spawn(process.execPath, ['--import', TSX_LOADER, MAIN], { cwd: o.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    liveServers.add(child);
    child.once('exit', () => liveServers.delete(child));
    const server = new ServerProcess(child, port);
    let starting = true;
    const exited = server.exited.then((code) => {
      if (!starting) return;
      const output = server.logs.join('\n');
      if (/EADDRINUSE|Could not listen on/.test(output)) throw new PortTaken(output);
      throw new Error(`server exited with ${code} while starting:\n${output}`);
    });
    // Ready only once this process says it listens on this port: another server that took the port
    // first may answer the probe too. Each probe then gives up after a second, as whatever holds a
    // port may accept and never answer.
    const listeningLine = `listening on http://127.0.0.1:${port} `;
    const listening = waitFor('the server to listen', async () => {
      if (!starting) return true;
      if (!server.logs.some((l) => l.includes(listeningLine))) return false;
      const res = await fetch(`${server.url}/api/meta`, { signal: AbortSignal.timeout(1000) });
      return res.ok && child.exitCode === null;
    }, 30_000, 100);
    try {
      await Promise.race([listening, exited]);
    } catch (e) {
      await server.kill();
      throw e;
    } finally {
      starting = false;
      listening.catch(() => {});
      exited.catch(() => {});
    }
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Stops the server as the owner does (Ctrl+C: a clean shutdown) where the platform can signal a
   * process; on Windows the process is ended at once, as when the window is closed.
   */
  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    const timeout = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    await this.exited;
    clearTimeout(timeout);
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }

  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.url}${path}`);
    const body = await res.json();
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(body)}`);
    return body as T;
  }

  /** A POST as the web app sends it; the status and body are returned whatever the status. */
  async post<T = any>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** A POST that must succeed. */
  async ok<T = any>(path: string, body: unknown): Promise<T> {
    const r = await this.post<T>(path, body);
    if (r.status !== 200) throw new Error(`POST ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /** The history rows (newest first), as the History page reads them. */
  async history(query: Record<string, string> = {}): Promise<any[]> {
    const qs = new URLSearchParams({ limit: '200', ...query }).toString();
    return (await this.get<{ rows: any[] }>(`/api/history?${qs}`)).rows;
  }

  /** Opens a browser-like live connection. */
  client(): Promise<LiveClient> {
    return LiveClient.connect(`ws://127.0.0.1:${this.port}/ws`);
  }
}

/** One /ws connection, as the web app holds it: every message is kept, newest last. */
export class LiveClient {
  readonly messages: any[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => this.messages.push(JSON.parse(String(raw))));
  }

  static connect(url: string): Promise<LiveClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new LiveClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  /** As the web app does when a market and symbol are selected. */
  subscribe(market: 'spot' | 'perp', symbol: string, interval = '1m'): void {
    this.ws.send(JSON.stringify({ type: 'subscribe', market, symbol, interval }));
  }

  ofType(type: string): any[] {
    return this.messages.filter((m) => m.type === type);
  }

  latest(type: string): any {
    return this.ofType(type).at(-1);
  }

  notices(kind?: string): any[] {
    return this.ofType('notice').filter((n) => kind === undefined || n.kind === kind);
  }

  /** Waits for a message of `type` matching `pred` received after message index `from`. */
  waitForMessage(type: string, pred: (m: any) => boolean = () => true, timeoutMs = 15_000, from = 0): Promise<any> {
    return waitFor(`a ${type} message`, () => this.messages.slice(from).find((m) => m.type === type && pred(m)), timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * One trade at the starting price on every symbol of both markets (orders need a last price), and
 * waits until the server has seen them all (the recent trades sent on a subscribe include them).
 */
export async function printOpeningTrades(fake: FakeBinance, server: ServerProcess): Promise<void> {
  const ids = new Map<string, number>();
  for (const s of SYMBOLS) {
    for (const market of ['spot', 'perp'] as const) ids.set(`${market}:${s}`, fake.trade(market, s, START_PRICES[s]!, '0.5', { sellerInitiated: false }));
  }
  const probe = await server.client();
  const last = SYMBOLS.at(-1)!;
  try {
    // Sent in order on one socket per market: the last symbol's trade seen means all were.
    for (const market of ['spot', 'perp'] as const) {
      const from = probe.messages.length;
      probe.subscribe(market, last);
      await probe.waitForMessage('trades', (m) => m.market === market && m.symbol === last && m.trades.some((t: any) => t.id === ids.get(`${market}:${last}`)), 5000, from);
    }
  } finally {
    probe.close();
  }
}

/** Every key of the market fresh (and none catching up), per the latest health message. */
export function allFresh(health: any, keys: string[]): boolean {
  return !!health && keys.every((k) => health.markets?.[k]?.fresh === true && health.markets[k].catchingUp === false);
}

/**
 * A fake Binance and the server against it on a fresh database, with one live client, once the
 * given market keys are fresh. `cleanup` stops everything and deletes the temporary directory.
 */
export interface ScenarioOptions {
  /** The market keys that must be fresh before the scenario starts (default BTCUSDT spot and perp). */
  freshKeys?: string[];
  freshTimeoutMs?: number;
  /** Told of each part as it is made, so a test can check what a failed setup left behind. */
  observe?: (part: { fake?: FakeBinance; server?: ServerProcess; dir?: string }) => void;
}

export async function startScenario(opts: ScenarioOptions | string[] = {}) {
  const o: ScenarioOptions = Array.isArray(opts) ? { freshKeys: opts } : opts;
  const freshKeys = o.freshKeys ?? ['spot:BTCUSDT', 'perp:BTCUSDT'];
  const fake = new FakeBinance();
  await fake.start();
  o.observe?.({ fake });
  let tmp: ReturnType<typeof tempDir> | null = null;
  let server: ServerProcess | null = null;
  let client: LiveClient | null = null;
  // Whatever fails from here, nothing is left running or on disk.
  const teardown = async () => {
    client?.close();
    await server?.kill();
    await fake.stop();
    tmp?.remove();
  };
  try {
    tmp = tempDir();
    o.observe?.({ dir: tmp.dir });
    server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath });
    o.observe?.({ server });
    client = await server.client();
    const live = client;
    await live.waitForMessage('health', (h) => allFresh(h, freshKeys), o.freshTimeoutMs ?? 20_000);
    await printOpeningTrades(fake, server);
    assertLogHygiene(server);
  } catch (e) {
    await teardown();
    throw e;
  }
  const running = server;
  return {
    fake,
    server: running,
    client,
    tmp,
    async cleanup() {
      try {
        assertLogHygiene(running);
      } finally {
        await teardown();
      }
    },
  };
}

/** The server warned that it is not on live Binance, and never logged the key or the secret. */
export function assertLogHygiene(server: ServerProcess): void {
  const log = server.logs.join('\n');
  if (!/Binance endpoints overridden, not live Binance: BINANCE_SPOT_REST_URL \(http:\/\/127\.0\.0\.1:\d+\)/.test(log)) {
    throw new Error(`no endpoint override warning in the server log:\n${log}`);
  }
  for (const secret of [E2E_KEY, E2E_SECRET]) if (log.includes(secret)) throw new Error('the server log contains the API key or secret');
}
