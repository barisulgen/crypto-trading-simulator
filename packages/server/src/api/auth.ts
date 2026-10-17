import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../log.ts';

export const SESSION_COOKIE = 'sim_session';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

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

export interface AuthOptions {
  appPassword: string | null;
  logger: Logger;
  /** Matched route patterns open without a session besides POST /api/login (the static web UI). */
  publicRoutes?: string[];
}

/**
 * With an APP_PASSWORD (LAN mode), POST /api/login compares the password in constant
 * time and sets an HttpOnly SameSite=Strict session cookie (random token, kept in memory).
 * Deny by default: the decision uses the route the router MATCHED (after percent-decoding, so
 * `/%61pi/account` is `/api/account`), and only POST /api/login and `publicRoutes` are open;
 * every other route, /ws and unmatched paths need the session (401 otherwise).
 * Without a password (localhost only), every request whose Host or Origin is not local is
 * refused (403), so another website cannot reach the API through DNS rebinding or a
 * cross-site WebSocket.
 */
export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
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

  const publicRoutes = new Set(opts.publicRoutes ?? []);
  const isPublic = (req: FastifyRequest): boolean => {
    const route = req.routeOptions.url; // undefined when no route matched
    if (route === undefined) return false;
    return (route === '/api/login' && req.method === 'POST') || publicRoutes.has(route);
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isPublic(req)) return;
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
