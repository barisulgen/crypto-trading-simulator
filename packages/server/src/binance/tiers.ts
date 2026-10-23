import { readFileSync } from 'node:fs';
import { D } from '@sim/engine';
import type { Bracket, Decimal, TierSet } from '@sim/engine';
import { redact } from '../log.ts';
import type { Logger } from '../log.ts';
import type { PauseController, RawJson } from './restCore.ts';

/** Binance's public (unofficial, unsigned) leverage-bracket endpoint used by its web site. */
export const UNOFFICIAL_BRACKETS_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets';
const UNOFFICIAL_TIMEOUT_MS = 15_000;
const SNAPSHOT_URL = new URL('./tiers-snapshot.json', import.meta.url);

/** One bracket as stored in the bundled snapshot: decimal strings. */
export interface SnapshotBracket {
  floor: string;
  cap: string;
  mmr: string;
  cum: string;
  maxLeverage: number;
}

export interface TierSnapshot {
  fetchedAt: number;
  source: string;
  brackets: Record<string, SnapshotBracket[]>;
}

const DECIMAL = /^\d+(\.\d+)?$/;

function decimalOf(v: unknown, what: string): Decimal {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return D(v);
  if (typeof v === 'string' && DECIMAL.test(v)) return D(v);
  throw new Error(`${what} is not a number (${String(v)})`);
}

function leverageOf(v: unknown, what: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new Error(`${what} is not a leverage (${String(v)})`);
  return n;
}

/** Maps every listed symbol's entry with `map`, sorted ascending by floor; other symbols are ignored. */
function collect(
  entries: unknown,
  symbols: readonly string[],
  list: (e: any) => unknown,
  map: (b: any, where: string) => Bracket,
): Record<string, Bracket[]> {
  if (!Array.isArray(entries)) throw new Error('no list of symbols');
  const out: Record<string, Bracket[]> = {};
  for (const e of entries) {
    const symbol = e?.symbol;
    if (typeof symbol !== 'string' || !symbols.includes(symbol)) continue;
    if (out[symbol]) throw new Error(`${symbol} is listed twice`);
    const raw = list(e);
    if (!Array.isArray(raw)) throw new Error(`${symbol} has no brackets`);
    out[symbol] = raw.map((b, i) => map(b, `${symbol} bracket ${i + 1}`)).sort((a, b) => a.floor.comparedTo(b.floor));
  }
  return out;
}

/** The signed /fapi/v1/leverageBracket answer: `[{ symbol, brackets: [{ notionalFloor, notionalCap, maintMarginRatio, cum, initialLeverage }] }]`. */
export function parseOfficialBrackets(raw: unknown, symbols: readonly string[]): Record<string, Bracket[]> {
  return collect(raw, symbols, (e) => e.brackets, (b, where) => ({
    floor: decimalOf(b?.notionalFloor, `${where} notionalFloor`),
    cap: decimalOf(b?.notionalCap, `${where} notionalCap`),
    mmr: decimalOf(b?.maintMarginRatio, `${where} maintMarginRatio`),
    cum: decimalOf(b?.cum, `${where} cum`),
    maxLeverage: leverageOf(b?.initialLeverage, `${where} initialLeverage`),
  }));
}

/** The public endpoint's answer: `{ code: '000000', data: { brackets: [{ symbol, riskBrackets: [...] }] } }`. */
export function parseUnofficialBrackets(raw: unknown, symbols: readonly string[]): Record<string, Bracket[]> {
  const r = raw as { code?: unknown; data?: { brackets?: unknown } } | null;
  if (r?.code !== '000000') throw new Error(`answered code ${String(r?.code)}`);
  return collect(r.data?.brackets, symbols, (e) => e.riskBrackets, (b, where) => ({
    floor: decimalOf(b?.bracketNotionalFloor, `${where} bracketNotionalFloor`),
    cap: decimalOf(b?.bracketNotionalCap, `${where} bracketNotionalCap`),
    mmr: decimalOf(b?.bracketMaintenanceMarginRate, `${where} bracketMaintenanceMarginRate`),
    cum: decimalOf(b?.cumFastMaintenanceAmount, `${where} cumFastMaintenanceAmount`),
    maxLeverage: leverageOf(b?.maxOpenPosLeverage, `${where} maxOpenPosLeverage`),
  }));
}

/** The bundled snapshot as a TierSet (source 'bundled', dated when the snapshot was taken); throws on a malformed file. */
export function parseSnapshot(raw: unknown, symbols: readonly string[]): TierSet {
  const s = raw as Partial<TierSnapshot> | null;
  if (typeof s?.fetchedAt !== 'number' || !Number.isSafeInteger(s.fetchedAt) || s.fetchedAt <= 0) {
    throw new Error('snapshot has no fetchedAt');
  }
  if (typeof s.source !== 'string' || !s.brackets || typeof s.brackets !== 'object') throw new Error('snapshot is malformed');
  const entries = Object.entries(s.brackets).map(([symbol, brackets]) => ({ symbol, brackets }));
  const brackets = collect(entries, symbols, (e) => e.brackets, (b, where) => ({
    floor: decimalOf(b?.floor, `${where} floor`),
    cap: decimalOf(b?.cap, `${where} cap`),
    mmr: decimalOf(b?.mmr, `${where} mmr`),
    cum: decimalOf(b?.cum, `${where} cum`),
    maxLeverage: leverageOf(b?.maxLeverage, `${where} maxLeverage`),
  }));
  return { source: 'bundled', fetchedAt: s.fetchedAt, brackets };
}

/**
 * Null when every symbol has brackets that start at 0, are contiguous (each floor is the previous
 * cap) and hold usable numbers; otherwise what is wrong.
 */
export function checkTiers(brackets: Record<string, Bracket[]>, symbols: readonly string[]): string | null {
  const missing = symbols.filter((s) => !brackets[s]?.length);
  if (missing.length > 0) return `no brackets for ${missing.join(', ')}`;
  for (const symbol of symbols) {
    const list = brackets[symbol]!;
    if (!list[0]!.floor.isZero()) return `${symbol} first bracket starts at ${list[0]!.floor.toString()}, not 0`;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      const n = i + 1;
      if (!b.cap.gt(b.floor)) return `${symbol} bracket ${n} cap ${b.cap.toString()} is not above its floor ${b.floor.toString()}`;
      if (!b.mmr.gt(0) || !b.mmr.lt(1)) return `${symbol} bracket ${n} maintenance ratio ${b.mmr.toString()} is not between 0 and 1`;
      if (b.cum.isNegative()) return `${symbol} bracket ${n} maintenance amount is negative`;
      if (!Number.isSafeInteger(b.maxLeverage) || b.maxLeverage < 1) return `${symbol} bracket ${n} has no usable max leverage`;
      const next = list[i + 1];
      if (next && !next.floor.eq(b.cap)) {
        return `${symbol} brackets are not contiguous (bracket ${n} ends at ${b.cap.toString()}, the next starts at ${next.floor.toString()})`;
      }
    }
  }
  return null;
}

/** Only the listed symbols, for storing. */
export function toSnapshot(set: Pick<TierSet, 'brackets' | 'fetchedAt'>, source: string, symbols: readonly string[]): TierSnapshot {
  const brackets: Record<string, SnapshotBracket[]> = {};
  for (const s of symbols) {
    brackets[s] = set.brackets[s]!.map((b) => ({
      floor: b.floor.toString(),
      cap: b.cap.toString(),
      mmr: b.mmr.toString(),
      cum: b.cum.toString(),
      maxLeverage: b.maxLeverage,
    }));
  }
  return { fetchedAt: set.fetchedAt, source, brackets };
}

/**
 * GETs the public brackets endpoint (no key). It honours the shared REST pause, and a 429/418 from
 * it pauses the Binance REST clients too: the limits are per IP.
 */
export async function fetchUnofficialBrackets(fetchImpl: typeof fetch, pause: PauseController): Promise<RawJson> {
  pause.assertNotPaused();
  const sentAt = pause.now();
  const res = await fetchImpl(UNOFFICIAL_BRACKETS_URL, { signal: AbortSignal.timeout(UNOFFICIAL_TIMEOUT_MS) });
  if (res.status === 429 || res.status === 418) {
    pause.rateLimited(res.status, res, sentAt, 'Binance web API', 'no weight figures for this host');
  }
  if (!res.ok) throw new Error(`Binance public brackets HTTP ${res.status}`);
  pause.succeeded(sentAt);
  return res.json();
}

export interface TierLoaderDeps {
  /** Every symbol that must be covered. */
  symbols: readonly string[];
  rest: { leverageBracket(key: string, secret: string): Promise<unknown> };
  /** The read-only Binance key pair; null skips the signed source. */
  credentials?: { key: string; secret: string } | null;
  /** Fetches the public brackets endpoint (see fetchUnofficialBrackets). */
  unofficial: () => Promise<unknown>;
  /** The bundled snapshot; defaults to tiers-snapshot.json next to this file. */
  snapshot?: unknown;
  logger: Logger;
}

/**
 * Leverage tiers for every symbol, from the first source that covers all of them with checked
 * brackets: the signed leverageBracket (when a key is set), the public endpoint, then the bundled
 * snapshot. Each rejected source logs a warning that never contains the key or secret.
 */
export class TierLoader {
  constructor(private readonly d: TierLoaderDeps) {}

  async load(now: number): Promise<TierSet> {
    const creds = this.d.credentials ?? null;
    const scrub = (e: unknown) => redact(e instanceof Error ? e.message : String(e), creds ? [creds.key, creds.secret] : []);
    const reasons: string[] = [];
    if (creds) {
      try {
        const brackets = parseOfficialBrackets(await this.d.rest.leverageBracket(creds.key, creds.secret), this.d.symbols);
        const problem = checkTiers(brackets, this.d.symbols);
        if (problem === null) return { source: 'official', fetchedAt: now, brackets };
        throw new Error(problem);
      } catch (e) {
        const reason = scrub(e);
        reasons.push(`signed: ${reason}`);
        this.d.logger.warn(`Leverage tiers: signed leverageBracket not usable (${reason}); trying the public brackets endpoint`);
      }
    }
    try {
      const brackets = parseUnofficialBrackets(await this.d.unofficial(), this.d.symbols);
      const problem = checkTiers(brackets, this.d.symbols);
      if (problem === null) return { source: 'unofficial', fetchedAt: now, brackets };
      throw new Error(problem);
    } catch (e) {
      const reason = scrub(e);
      reasons.push(`public: ${reason}`);
      this.d.logger.warn(`Leverage tiers: public brackets endpoint not usable (${reason}); falling back to the bundled snapshot`);
    }
    try {
      const set = parseSnapshot(this.d.snapshot ?? JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')), this.d.symbols);
      const problem = checkTiers(set.brackets, this.d.symbols);
      if (problem !== null) throw new Error(problem);
      this.d.logger.info(`Leverage tiers: using the bundled snapshot taken ${new Date(set.fetchedAt).toISOString()}`);
      return set;
    } catch (e) {
      reasons.push(`bundled: ${scrub(e)}`);
    }
    throw new Error(`No usable leverage tier source (${reasons.join('; ')})`);
  }
}
