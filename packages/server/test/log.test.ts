import { describe, it, expect } from 'vitest';
import { createLogger, redact } from '../src/log.ts';

describe('redact', () => {
  it('replaces secrets, signatures and api-key headers', () => {
    expect(redact('key k123 sig ?signature=abc', ['k123'])).toBe('key [REDACTED] sig ?signature=[REDACTED]');
    expect(redact('X-MBX-APIKEY: abcd', [])).toBe('X-MBX-APIKEY: [REDACTED]');
    expect(redact('{"X-MBX-APIKEY":"abcd","a":1}', [])).toBe('{"X-MBX-APIKEY":"[REDACTED]","a":1}');
    expect(redact('k123 and k123', ['k123'])).toBe('[REDACTED] and [REDACTED]');
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
