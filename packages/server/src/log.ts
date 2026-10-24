export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type WriteFn = (stream: 'stdout' | 'stderr', line: string) => void;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces every secret, `signature=` value and X-MBX-APIKEY header value with [REDACTED]. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  // longest first so a secret containing another is fully removed
  for (const s of [...secrets].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(s), 'g'), '[REDACTED]');
  }
  out = out.replace(/signature=[^&\s"']*/gi, 'signature=[REDACTED]');
  out = out.replace(/(["']signature["']\s*:\s*)(["'])[^"']*\2/gi, '$1$2[REDACTED]$2');
  // quoted values ("…" or '…'), then bare ones (header lines, query strings)
  out = out.replace(/(["']?X-MBX-APIKEY["']?\s*[:=]\s*)(["'])[^"']*\2/gi, '$1$2[REDACTED]$2');
  out = out.replace(/(X-MBX-APIKEY["']?\s*[:=]\s*)(?!["'[])[^\s"',}&]+/gi, '$1[REDACTED]');
  return out;
}

const defaultWrite: WriteFn = (stream, line) => {
  (stream === 'stderr' ? process.stderr : process.stdout).write(line + '\n');
};

export function createLogger(secrets: readonly string[], write: WriteFn = defaultWrite): Logger {
  const emit = (level: 'info' | 'warn' | 'error', stream: 'stdout' | 'stderr') => (msg: string) => {
    const line = redact(`${new Date().toISOString()} ${level} ${String(msg).replace(/\r?\n/g, ' ')}`, secrets);
    write(stream, line);
  };
  return { info: emit('info', 'stdout'), warn: emit('warn', 'stderr'), error: emit('error', 'stderr') };
}

/**
 * The startup line: where the server listens and the season; a database recorded before catch-up
 * existed (meta.test_data) is marked as test data, a new one is not.
 */
export function listeningLine(o: { host: string; port: number; seasonId: number; testData: boolean }): string {
  const test = o.testData ? ', TEST DATA - recorded before catch-up existed; npm run db:wipe starts real practice' : '';
  return `Server listening on http://${o.host}:${o.port} (season ${o.seasonId}${test})`;
}
