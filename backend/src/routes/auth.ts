import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import {
  createSession,
  resolveSession,
  revokeSession,
  verifyPassword,
  throttleCheck,
  throttleFail,
  throttleClear,
  type SessionUser,
} from '../auth/auth.js';
import { config } from '../core/config.js';

export const SESSION_COOKIE = 'fpl_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function getClientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip;
}

export async function authRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  app.decorateRequest('user', null);

  // session resolution for every request in this app
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await resolveSession(db, token) : null;
  });

  // CSRF hardening: state-changing API routes require our custom header
  // (cookies are SameSite=Lax; cross-origin forms cannot set headers).
  app.addHook('preHandler', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
      if (req.url === '/api/auth/login') return; // login carries no session yet
      const header = req.headers['x-requested-with'];
      if (header !== 'fpl-frontend') {
        return reply.code(403).send({ error: 'missing CSRF header' });
      }
    }
  });

  const LoginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid credentials payload' });
    const { email, password } = parsed.data;
    const ip = getClientIp(req);
    const throttleKeys = [`acct:${email.toLowerCase()}`, `ip:${ip}`];

    const waitMs = await throttleCheck(db, throttleKeys);
    if (waitMs > 0) {
      await db('auth_events').insert({ email, kind: 'lockout', ip });
      return reply.code(429).send({ error: 'too many attempts', retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }

    const user = await db('users').where({ email: email.toLowerCase() }).first();
    const ok = user && user.status === 'active' && (await verifyPassword(user.password_hash, password));
    if (!ok) {
      await throttleFail(db, throttleKeys);
      await db('auth_events').insert({ email, kind: 'login_fail', ip, user_id: user?.id ?? null });
      return reply.code(401).send({ error: 'invalid email or password' });
    }

    await throttleClear(db, throttleKeys);
    const token = await createSession(db, user.id, ip, req.headers['user-agent']);
    await db('auth_events').insert({ email, kind: 'login_ok', ip, user_id: user.id });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      maxAge: config.sessionAbsoluteHours * 3600,
    });
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tokenBalance: Number(user.token_balance) },
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      await revokeSession(db, token);
      if (req.user) await db('auth_events').insert({ email: req.user.email, kind: 'logout', user_id: req.user.id, ip: getClientIp(req) });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'not authenticated' });
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        tokenBalance: req.user.token_balance,
      },
    };
  });
}

export function requireAuth(req: FastifyRequest): asserts req is FastifyRequest & { user: SessionUser } {
  if (!req.user) {
    const err = new Error('not authenticated') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
}

export function requireAdmin(req: FastifyRequest): asserts req is FastifyRequest & { user: SessionUser } {
  requireAuth(req);
  if (req.user.role !== 'admin') {
    const err = new Error('admin only') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}
