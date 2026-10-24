import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../log.ts';

export const SESSION_COOKIE = 'sim_session';
export const SESSION_EXPIRED = 'Session expired; log in again';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A session ends after this long without use ... */
const SESSION_IDLE_MS = 24 * 3_600_000;
/** ... or this long after login, whichever comes first. */
const SESSION_MAX_MS = 7 * 24 * 3_600_000;
const LOGIN_FAILURES_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

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

/** A LAN session seen from a long-lived connection (the /ws socket) opened with it. */
export interface SessionHandle {
  /** False once the session has expired (idle 24 h or 7 days old) or is gone. */
  alive(): boolean;
  /** Use of the session: renews its idle timer while it is alive. */
  touch(): void;
}

export interface Auth {
  /** The session of a request that passed the gate; null without a password (localhost only: no sessions). */
  sessionOf(req: FastifyRequest): SessionHandle | null;
  /** How many addresses have recent wrong passwords on record (for tests). */
  loginFailureAddresses(): number;
}

export interface AuthOptions {
  appPassword: string | null;
  logger: Logger;
  /** Matched route patterns open without a session besides POST /api/login (the static web UI). */
  publicRoutes?: string[];
  /** Clock in ms; defaults to Date.now. */
  now?: () => number;
}

/**
 * With an APP_PASSWORD (LAN mode), POST /api/login compares the password in constant
 * time and sets an HttpOnly SameSite=Strict session cookie (random token, kept in memory).
 * Deny by default: the decision uses the route the router MATCHED (after percent-decoding, so
 * `/%61pi/account` is `/api/account`), and only POST /api/login and `publicRoutes` are open;
 * every other route, /ws and unmatched paths need the session (401 otherwise).
 * A session expires after 24 h without use or 7 days after login (401 'Session expired; log in
 * again'); the owner's messages on a /ws socket count as use (sessionOf). 5 wrong passwords
 * from one address within 15 minutes block further logins from it (429) until the oldest failure is
 * 15 minutes old; every login attempt first forgets the addresses whose failures are all older.
 * Without a password (localhost only), every request whose Host or Origin is not local is
 * refused (403), so another website cannot reach the API through DNS rebinding or a
 * cross-site WebSocket.
 */
export function registerAuth(app: FastifyInstance, opts: AuthOptions): Auth {
  if (opts.appPassword === null) {
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const host = hostnameOf(req.headers.host ?? '', false);
      if (host === null || !LOCAL_HOSTNAMES.has(host)) return deny(reply, 403, 'Forbidden host');
      const origin = req.headers.origin;
      if (origin !== undefined && !LOCAL_HOSTNAMES.has(hostnameOf(origin, true) ?? '')) {
        return deny(reply, 403, 'Forbidden origin');
      }
    });
    return { sessionOf: () => null, loginFailureAddresses: () => 0 };
  }

  const expected = digest(opts.appPassword);
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, { createdAt: number; lastUsed: number }>();
  const expired = (s: { createdAt: number; lastUsed: number }, t: number): boolean =>
    t - s.lastUsed >= SESSION_IDLE_MS || t - s.createdAt >= SESSION_MAX_MS;
  /** Times (ms) of each address's recent wrong passwords, oldest first. */
  const failures = new Map<string, number[]>();
  const recentFailures = (ip: string): number[] => {
    const list = (failures.get(ip) ?? []).filter((t) => now() - t < LOGIN_WINDOW_MS);
    if (list.length === 0) failures.delete(ip);
    else failures.set(ip, list);
    return list;
  };

  const publicRoutes = new Set(opts.publicRoutes ?? []);
  const isPublic = (req: FastifyRequest): boolean => {
    const route = req.routeOptions.url; // undefined when no route matched
    if (route === undefined) return false;
    return (route === '/api/login' && req.method === 'POST') || publicRoutes.has(route);
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isPublic(req)) return;
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const session = token === null ? undefined : sessions.get(token);
    if (token === null || !session) return deny(reply, 401, 'Login required');
    const t = now();
    if (expired(session, t)) {
      sessions.delete(token);
      return deny(reply, 401, SESSION_EXPIRED);
    }
    session.lastUsed = t;
  });

  app.post('/api/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { password?: unknown } | null;
    const password = body && typeof body === 'object' ? body.password : undefined;
    if (typeof password !== 'string' || password === '') return deny(reply, 400, 'Missing field password');
    // Addresses that never came back would otherwise stay on record for good.
    for (const ip of [...failures.keys()]) recentFailures(ip);
    const recent = recentFailures(req.ip);
    if (recent.length >= LOGIN_FAILURES_MAX) {
      const minutes = Math.ceil((recent[0]! + LOGIN_WINDOW_MS - now()) / 60_000);
      return deny(reply, 429, `Too many failed logins; try again in ${minutes} min`);
    }
    // Equal-length digests: the comparison time reveals neither the password nor its length.
    if (!timingSafeEqual(digest(password), expected)) {
      recent.push(now());
      failures.set(req.ip, recent);
      opts.logger.warn(`Failed login from ${req.ip}`);
      return deny(reply, 401, 'Wrong password');
    }
    const token = randomBytes(32).toString('hex');
    const t = now();
    for (const [k, v] of sessions) if (expired(v, t)) sessions.delete(k);
    sessions.set(token, { createdAt: t, lastUsed: t });
    failures.delete(req.ip);
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`,
    );
    return reply.code(200).send({ ok: true });
  });

  return {
    // The gate has let the request through, so its cookie names a live session. Once that session
    // expires it is left in the map: the next request with the cookie is told it expired.
    sessionOf: (req) => {
      const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
      if (token === null) return null;
      const alive = () => {
        const s = sessions.get(token);
        return s !== undefined && !expired(s, now());
      };
      return {
        alive,
        touch: () => {
          if (alive()) sessions.get(token)!.lastUsed = now();
        },
      };
    },
    loginFailureAddresses: () => failures.size,
  };
}
