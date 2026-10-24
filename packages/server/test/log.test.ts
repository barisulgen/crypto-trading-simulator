import { describe, it, expect } from 'vitest';
import { createLogger, listeningLine, redact } from '../src/log.ts';

describe('redact', () => {
  it('replaces secrets, signatures and api-key headers', () => {
    expect(redact('key k123 sig ?signature=abc', ['k123'])).toBe('key [REDACTED] sig ?signature=[REDACTED]');
    expect(redact('X-MBX-APIKEY: abcd', [])).toBe('X-MBX-APIKEY: [REDACTED]');
    expect(redact('{"X-MBX-APIKEY":"abcd","a":1}', [])).toBe('{"X-MBX-APIKEY":"[REDACTED]","a":1}');
    expect(redact('k123 and k123', ['k123'])).toBe('[REDACTED] and [REDACTED]');
  });
  it('redacts the key header however it is quoted, and a signature as a JSON field', () => {
    expect(redact("{ 'X-MBX-APIKEY': 'abcd' }", [])).toBe("{ 'X-MBX-APIKEY': '[REDACTED]' }");
    expect(redact("headers: { 'x-mbx-apikey': 'abcd' }", [])).toBe("headers: { 'x-mbx-apikey': '[REDACTED]' }");
    expect(redact('X-MBX-APIKEY=abcd&x=1', [])).toBe('X-MBX-APIKEY=[REDACTED]&x=1');
    expect(redact('/fapi/v1/leverageBracket?timestamp=1&recvWindow=5000&signature=0fab9', [])).toBe(
      '/fapi/v1/leverageBracket?timestamp=1&recvWindow=5000&signature=[REDACTED]',
    );
    expect(redact('{"signature":"0fab9"}', [])).toBe('{"signature":"[REDACTED]"}');
  });
  it('handles regex metacharacters in secrets and ignores empty ones', () => {
    expect(redact('a.b*c and axbbc', ['a.b*c', ''])).toBe('[REDACTED] and axbbc');
  });
});

describe('createLogger', () => {
  it('writes one redacted line per call with timestamp and level', () => {
    const out: string[] = [];
    const log = createLogger(['k123'], (_s, line) => out.push(line));
    log.info('key k123 sig ?signature=abc');
    log.warn('w');
    log.error('e');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z info key \[REDACTED\] sig \?signature=\[REDACTED\]$/);
    expect(out[1]).toMatch(/ warn w$/);
    expect(out[2]).toMatch(/ error e$/);
  });
});

describe('listeningLine', () => {
  it('marks the data as test data only for a database recorded before catch-up existed', () => {
    const at = { host: '127.0.0.1', port: 8787, seasonId: 1 };
    expect(listeningLine({ ...at, testData: false })).toBe('Server listening on http://127.0.0.1:8787 (season 1)');
    expect(listeningLine({ ...at, testData: true })).toBe(
      'Server listening on http://127.0.0.1:8787 (season 1, TEST DATA - recorded before catch-up existed; npm run db:wipe starts real practice)',
    );
  });
});
