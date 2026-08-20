import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { Knex } from 'knex';
import { config } from '../core/config.js';

const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP recommended argon2id baseline)
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function newSessionToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin';
  status: string;
  token_balance: number;
}

export async function createSession(
  db: Knex,
  userId: number,
  ip?: string,
  userAgent?: string,
): Promise<string> {
  const { token, hash } = newSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionAbsoluteHours * 3600_000);
  await db('sessions').insert({
    token_hash: hash,
    user_id: userId,
    expires_at: expiresAt,
    ip: ip ?? null,
    user_agent: (userAgent ?? '').slice(0, 300),
  });
  return token;
}

export async function resolveSession(db: Knex, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const hash = hashToken(token);
  const row = await db('sessions')
    .join('users', 'users.id', 'sessions.user_id')
    .where('sessions.token_hash', hash)
    .whereNull('sessions.revoked_at')
    .where('sessions.expires_at', '>', db.fn.now())
    .select(
      'users.id',
      'users.email',
      'users.name',
      'users.role',
      'users.status',
      'users.token_balance',
      'sessions.last_seen_at',
      'sessions.id as session_id',
    )
    .first();
  if (!row) return null;
  if (row.status !== 'active') return null;
  const idleCutoff = Date.now() - config.sessionIdleMinutes * 60_000;
  if (new Date(row.last_seen_at).getTime() < idleCutoff) {
    await db('sessions').where('id', row.session_id).update({ revoked_at: db.fn.now() });
    return null;
  }
  // touch at most once a minute to avoid write amplification
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await db('sessions').where('id', row.session_id).update({ last_seen_at: db.fn.now() });
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    token_balance: Number(row.token_balance),
  };
}

export async function revokeSession(db: Knex, token: string): Promise<void> {
  await db('sessions').where('token_hash', hashToken(token)).update({ revoked_at: db.fn.now() });
}

// ── Login throttling: per-account and per-IP exponential backoff ──────────

const LOCKOUT_BASE_SECONDS = 4;
const LOCKOUT_MAX_SECONDS = 3600;
const FREE_ATTEMPTS = 4;

export async function throttleCheck(db: Knex, keys: string[]): Promise<number> {
  const rows = await db('login_throttle').whereIn('key', keys);
  let waitMs = 0;
  for (const row of rows) {
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      waitMs = Math.max(waitMs, new Date(row.locked_until).getTime() - Date.now());
    }
  }
  return waitMs;
}

export async function throttleFail(db: Knex, keys: string[]): Promise<void> {
  for (const key of keys) {
    const row = await db('login_throttle').where({ key }).first();
    const failCount = (row?.fail_count ?? 0) + 1;
    const over = Math.max(0, failCount - FREE_ATTEMPTS);
    const lockSeconds = over > 0 ? Math.min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * 2 ** (over - 1)) : 0;
    const lockedUntil = lockSeconds > 0 ? new Date(Date.now() + lockSeconds * 1000) : null;
    await db.raw(
      `INSERT INTO login_throttle (key, fail_count, locked_until, updated_at)
       VALUES (?, ?, ?, now())
       ON CONFLICT (key) DO UPDATE
         SET fail_count = ?, locked_until = ?, updated_at = now()`,
      [key, failCount, lockedUntil, failCount, lockedUntil],
    );
  }
}

export async function throttleClear(db: Knex, keys: string[]): Promise<void> {
  await db('login_throttle').whereIn('key', keys).del();
}
