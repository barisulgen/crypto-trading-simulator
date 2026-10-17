import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../log.ts';

export const SESSION_COOKIE = 'sim_session';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** /api/* and /ws are gated; the static web UI is not (it shows the login form). */
function isGated(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === '/ws' || path.startsWith('/api/');
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function hostnameOf(hostOrOrigin: string, isOrigin: boolean): string | null {
  try {
    return new URL(isOrigin ? hostOrOrigin : `http://${hostOrOrigin}`).hostname;
  } catch {
    return null;
  }
}

function deny(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}

/**
 * With an APP_PASSWORD (LAN mode), POST /api/login compares the password in constant
 * time and sets an HttpOnly SameSite=Strict session cookie (random token, kept in memory);
 * every /api route and /ws then needs it (401 otherwise).
 * Without one (localhost only), requests whose Host or Origin is not local are refused (403),
 * so another website cannot reach the API through DNS rebinding or a cross-site WebSocket.
 */
export function registerAuth(app: FastifyInstance, opts: { appPassword: string | null; logger: Logger }): void {
  if (opts.appPassword === null) {
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const host = hostnameOf(req.headers.host ?? '', false);
      if (host === null || !LOCAL_HOSTNAMES.has(host)) return deny(reply, 403, 'Forbidden host');
      const origin = req.headers.origin;
      if (origin !== undefined && !LOCAL_HOSTNAMES.has(hostnameOf(origin, true) ?? '')) {
        return deny(reply, 403, 'Forbidden origin');
      }
    });
    return;
  }

  const expected = digest(opts.appPassword);
  const sessions = new Set<string>();

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isGated(req.url) || req.url.split('?')[0] === '/api/login') return;
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (token === null || !sessions.has(token)) return deny(reply, 401, 'Login required');
  });

  app.post('/api/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { password?: unknown } | null;
    const password = body && typeof body === 'object' ? body.password : undefined;
    if (typeof password !== 'string' || password === '') return deny(reply, 400, 'Missing field password');
    // Equal-length digests: the comparison time reveals neither the password nor its length.
    if (!timingSafeEqual(digest(password), expected)) {
      opts.logger.warn(`Failed login from ${req.ip}`);
      return deny(reply, 401, 'Wrong password');
    }
    const token = randomBytes(32).toString('hex');
    sessions.add(token);
    reply.header('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return reply.code(200).send({ ok: true });
  });
}
