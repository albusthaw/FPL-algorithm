/**
 * Ingest gateway (fpl-project.md §4.2–4.3): capability routing over the
 * ≤2 enabled providers, max-2 switch enforced server-side in a transaction,
 * circuit breaker, quota accounting, entitlement learning.
 */
import type { Knex } from 'knex';
import { PullError } from './errors.js';
import { log } from '../core/logger.js';

export class MaxProvidersError extends Error {
  constructor() {
    super('at most 2 providers may be enabled — disable one first');
    this.name = 'MaxProvidersError';
  }
}

/** Max-2 switch: transactional server-side check (never trust the UI). */
export async function setProviderEnabled(db: Knex, key: string, enabled: boolean): Promise<void> {
  await db.transaction(async (trx) => {
    const rows = await trx('api_providers').forUpdate().select('key', 'enabled', 'config');
    const target = rows.find((r) => r.key === key);
    if (!target) throw new Error(`unknown provider: ${key}`);
    const isAnchor = (target.config as { anchor?: boolean } | null)?.anchor === true;
    if (isAnchor) throw new Error('the FPL anchor is always on and not part of the switch');
    if (enabled) {
      const enabledCount = rows.filter(
        (r) => r.enabled && r.key !== key && (r.config as { anchor?: boolean } | null)?.anchor !== true,
      ).length;
      if (enabledCount >= 2) throw new MaxProvidersError();
    }
    await trx('api_providers').where({ key }).update({ enabled, updated_at: trx.fn.now() });
  });
}

export type Capability = 'fixtures' | 'injuries' | 'lineups' | 'news' | 'stats' | 'odds' | 'media';

/** Priority order per capability (fpl-project.md §4.3). */
const CAPABILITY_PRIORITY: Record<Capability, string[]> = {
  injuries: ['api_football', 'sportmonks'],
  lineups: ['api_football', 'sportmonks'],
  news: ['newsdata'],
  odds: ['api_football'],
  fixtures: ['football_data'],
  stats: ['sportmonks', 'understat'],
  media: ['thesportsdb'],
};

export interface ProviderRow {
  key: string;
  enabled: boolean;
  state: string;
  circuit_failures: number;
  circuit_open_until: string | null;
  quota_used: number;
  quota_limit: number | null;
  quota_reset_at: string | null;
  config: Record<string, unknown>;
}

/** Resolve which enabled, healthy provider serves a capability. */
export async function routeCapability(db: Knex, capability: Capability): Promise<ProviderRow | null> {
  const enabled = (await db('api_providers').where('enabled', true)) as ProviderRow[];
  const now = Date.now();
  for (const key of CAPABILITY_PRIORITY[capability] ?? []) {
    const row = enabled.find((r) => r.key === key);
    if (!row) continue;
    if (row.circuit_open_until && new Date(row.circuit_open_until).getTime() > now) continue;
    if (row.quota_limit != null && row.quota_used >= row.quota_limit * 0.9) continue; // 10% deadline-day headroom
    return row;
  }
  return null;
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_OPEN_MINUTES = 30;

export async function recordPullResult(db: Knex, providerKey: string, ok: boolean, quotaConsumed = 1): Promise<void> {
  if (ok) {
    await db('api_providers')
      .where({ key: providerKey })
      .update({
        circuit_failures: 0,
        state: 'ok',
        quota_used: db.raw('quota_used + ?', [quotaConsumed]),
        updated_at: db.fn.now(),
      });
  } else {
    const row = await db('api_providers').where({ key: providerKey }).first('circuit_failures');
    const failures = (row?.circuit_failures ?? 0) + 1;
    const tripped = failures >= CIRCUIT_THRESHOLD;
    await db('api_providers')
      .where({ key: providerKey })
      .update({
        circuit_failures: failures,
        state: tripped ? 'degraded' : 'ok',
        circuit_open_until: tripped ? new Date(Date.now() + CIRCUIT_OPEN_MINUTES * 60_000) : null,
        updated_at: db.fn.now(),
      });
    if (tripped) log.warn({ provider: providerKey, failures }, 'circuit breaker OPEN — provider degraded 30 min');
  }
}

/** Entitlement learning (integration plan §1.2): PLAN_DENIED is never re-tried. */
export async function learnEntitlement(
  db: Knex,
  provider: string,
  endpoint: string,
  paramsKey: string,
  allowed: boolean,
  detail?: string,
): Promise<void> {
  await db.raw(
    `INSERT INTO provider_entitlements (provider, endpoint, params_key, allowed, detail, learned_at)
     VALUES (?, ?, ?, ?, ?, now())
     ON CONFLICT (provider, endpoint, params_key)
       DO UPDATE SET allowed = excluded.allowed, detail = excluded.detail, learned_at = now()`,
    [provider, endpoint, paramsKey, allowed, detail?.slice(0, 500) ?? null],
  );
}

export async function isEntitled(db: Knex, provider: string, endpoint: string, paramsKey: string): Promise<boolean> {
  const row = await db('provider_entitlements').where({ provider, endpoint, params_key: paramsKey }).first('allowed');
  return row ? row.allowed : true; // unknown = try once, learn from the result
}

/** Shared error-handling wrapper implementing the §1.2 handling matrix. */
export async function guardedPull<T>(
  db: Knex,
  provider: string,
  endpoint: string,
  paramsKey: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!(await isEntitled(db, provider, endpoint, paramsKey))) {
    log.debug({ provider, endpoint, paramsKey }, 'skipped: known PLAN_DENIED');
    return null;
  }
  try {
    const result = await fn();
    await recordPullResult(db, provider, true);
    return result;
  } catch (err) {
    if (err instanceof PullError) {
      switch (err.errorClass) {
        case 'PLAN_DENIED':
          await learnEntitlement(db, provider, endpoint, paramsKey, false, String(err.detail ?? err.message));
          await recordPullResult(db, provider, true); // not a health failure
          return null;
        case 'AUTH':
          await db('api_providers').where({ key: provider }).update({ state: 'error', updated_at: db.fn.now() });
          log.error({ provider }, 'AUTH failure — provider marked error (key expired/revoked?)');
          return null;
        case 'QUOTA_EXHAUSTED':
          await db('api_providers').where({ key: provider }).update({ quota_used: db.raw('COALESCE(quota_limit, quota_used)'), updated_at: db.fn.now() });
          return null;
        case 'EMPTY_OK':
          await recordPullResult(db, provider, true);
          return null;
        default:
          await recordPullResult(db, provider, false);
          return null;
      }
    }
    await recordPullResult(db, provider, false);
    log.error({ provider, endpoint, err: String(err) }, 'unclassified pull failure');
    return null;
  }
}
