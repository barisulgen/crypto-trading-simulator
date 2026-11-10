import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { FakeBinance, START_PRICES, SYMBOLS } from './fakeBinance.ts';

/** The real server's entry point, run as its own process exactly as `npm start` runs it. */
const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'esm', 'index.mjs')).href;

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
}

/** The simulator server, spawned from its entry point against the fake Binance. */
export class ServerProcess {
  readonly logs: string[] = [];
  private exited: Promise<number | null>;

  private constructor(
    private readonly child: ChildProcess,
    readonly port: number,
  ) {
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) this.logs.push(line);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  }

  static async start(o: ServerOptions): Promise<ServerProcess> {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Nothing from the developer's own settings reaches the server under test.
    for (const k of Object.keys(env)) if (/^(BINANCE_|APP_PASSWORD$|HOST$|PORT$|DB_PATH$)/.test(k)) delete env[k];
    Object.assign(env, o.fake.env(), {
      PORT: String(port),
      DB_PATH: o.dbPath,
      // Any key pair: the fake accepts every signature, so the signed leverage brackets are used.
      BINANCE_KEY: 'e2e-read-only-key',
      BINANCE_SECRET: 'e2e-read-only-secret',
    });
    const child = spawn(process.execPath, ['--import', TSX_LOADER, MAIN], { cwd: o.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const server = new ServerProcess(child, port);
    try {
      await waitFor('the server to listen', async () => {
        if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}:\n${server.logs.join('\n')}`);
        return (await fetch(`${server.url}/api/meta`)).ok;
      }, 30_000, 100);
    } catch (e) {
      await server.kill();
      throw e;
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
 * waits until the server has seen them (the recent trades sent on a subscribe include them).
 */
export async function printOpeningTrades(fake: FakeBinance, server: ServerProcess): Promise<void> {
  const ids = new Map<string, number>();
  for (const s of SYMBOLS) {
    for (const market of ['spot', 'perp'] as const) ids.set(`${market}:${s}`, fake.trade(market, s, START_PRICES[s]!, '0.5', { sellerInitiated: false }));
  }
  const probe = await server.client();
  try {
    for (const market of ['spot', 'perp'] as const) {
      const from = probe.messages.length;
      probe.subscribe(market, 'BTCUSDT');
      await probe.waitForMessage('trades', (m) => m.market === market && m.trades.some((t: any) => t.id === ids.get(`${market}:BTCUSDT`)), 5000, from);
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
export async function startScenario(freshKeys: string[] = ['spot:BTCUSDT', 'perp:BTCUSDT']) {
  const fake = new FakeBinance();
  await fake.start();
  const tmp = tempDir();
  const server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath });
  const client = await server.client();
  await client.waitForMessage('health', (h) => allFresh(h, freshKeys), 20_000);
  await printOpeningTrades(fake, server);
  return {
    fake,
    server,
    client,
    tmp,
    async cleanup() {
      client.close();
      await server.kill();
      await fake.stop();
      tmp.remove();
    },
  };
}
