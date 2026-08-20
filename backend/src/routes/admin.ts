import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import { requireAdmin } from './auth.js';
import { hashPassword } from '../auth/auth.js';
import { applyTokens } from '../tokens/ledger.js';
import { setProviderEnabled, MaxProvidersError } from '../ingest/gateway.js';
import { setAliveProvider, buildAdapter } from '../ai/gateway.js';
import { getConfig, setConfig } from '../core/model-config.js';
import { setEnabled as setFeatureEnabled } from '../core/kernel.js';
import { resolveManually } from '../players/resolver.js';
import { config } from '../core/config.js';

export async function adminRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  // ── users
  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const users = await db('users').orderBy('id').select('id', 'email', 'name', 'role', 'status', 'token_balance', 'created_at');
    const usage = (await db('ai_calls')
      .select('user_id')
      .sum({ credits: 'credits' })
      .count({ calls: '*' })
      .groupBy('user_id')) as { user_id: number; credits: unknown; calls: unknown }[];
    const usageMap = new Map(usage.map((u) => [u.user_id, { credits: Number(u.credits ?? 0), calls: Number(u.calls) }]));
    return { users: users.map((u) => ({ ...u, token_balance: Number(u.token_balance), usage: usageMap.get(u.id) ?? { credits: 0, calls: 0 } })) };
  });

  const CreateUserSchema = z.object({
    email: z.string().email().max(254),
    name: z.string().min(1).max(120),
    password: z.string().min(10).max(200),
    role: z.enum(['user', 'admin']).default('user'),
    initialTokens: z.number().int().min(0).max(10_000_000).default(0),
  });

  app.post('/api/admin/users', async (req, reply) => {
    requireAdmin(req);
    const parsed = CreateUserSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid user' });
    const existing = await db('users').where('email', parsed.data.email.toLowerCase()).first();
    if (existing) return reply.code(409).send({ error: 'email already exists' });
    const [row] = await db('users')
      .insert({
        email: parsed.data.email.toLowerCase(),
        name: parsed.data.name,
        password_hash: await hashPassword(parsed.data.password),
        role: parsed.data.role,
        created_by: req.user.id,
      })
      .returning('id');
    const userId = Number(row.id ?? row);
    if (parsed.data.initialTokens > 0) {
      await applyTokens(db, { userId, delta: parsed.data.initialTokens, reason: 'topup', adminId: req.user.id, note: 'initial balance' });
    }
    return { id: userId };
  });

  const PatchUserSchema = z.object({
    status: z.enum(['active', 'disabled']).optional(),
    role: z.enum(['user', 'admin']).optional(),
    password: z.string().min(10).max(200).optional(),
    name: z.string().min(1).max(120).optional(),
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const parsed = PatchUserSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid patch' });
    const user = await db('users').where('id', id).first();
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const patch: Record<string, unknown> = {};
    if (parsed.data.status) patch.status = parsed.data.status;
    if (parsed.data.role) patch.role = parsed.data.role;
    if (parsed.data.name) patch.name = parsed.data.name;
    if (parsed.data.password) {
      patch.password_hash = await hashPassword(parsed.data.password);
      await db('auth_events').insert({ user_id: id, email: user.email, kind: 'password_reset', ip: null });
      await db('sessions').where('user_id', id).update({ revoked_at: db.fn.now() });
    }
    if (Object.keys(patch).length > 0) {
      patch.updated_at = db.fn.now();
      await db('users').where('id', id).update(patch);
    }
    return { ok: true };
  });

  const TopupSchema = z.object({ amount: z.number().int().min(1).max(10_000_000), note: z.string().max(300).default('') });

  app.post('/api/admin/users/:id/topup', async (req, reply) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const parsed = TopupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid top-up' });
    const user = await db('users').where('id', id).first();
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const result = await applyTokens(db, {
      userId: id,
      delta: parsed.data.amount,
      reason: 'topup',
      adminId: req.user.id,
      note: parsed.data.note || null || undefined,
    });
    return { balanceAfter: result.balanceAfter };
  });

  app.get('/api/admin/ledger', async (req) => {
    requireAdmin(req);
    const q = req.query as { userId?: string };
    let query = db('token_ledger as l')
      .join('users as u', 'u.id', 'l.user_id')
      .leftJoin('users as a', 'a.id', 'l.admin_id')
      .orderBy('l.id', 'desc')
      .limit(100)
      .select('l.*', 'u.email as user_email', 'a.email as admin_email');
    if (q.userId) query = query.where('l.user_id', Number(q.userId));
    return { ledger: await query };
  });

  // ── API provider switch (max 2) — pairing guidance shown by the UI
  app.get('/api/admin/providers', async (req) => {
    requireAdmin(req);
    const providers = await db('api_providers').orderBy('key');
    // key STATUS only — never key values (no secrets to the frontend)
    const keyStatus: Record<string, boolean> = {
      api_football: !!config.keys.apiFootball,
      sportmonks: !!config.keys.sportmonks,
      football_data: !!config.keys.footballData,
      newsdata: !!config.keys.newsdata,
      thesportsdb: !!config.keys.thesportsdb,
      fpl: true,
      understat: true,
    };
    return {
      providers: providers.map((p) => ({ ...p, keyConfigured: keyStatus[p.key] ?? false })),
      pairings: [
        { name: 'Free-only', pair: ['football_data', 'newsdata'], note: 'API-Football free cannot see the current season; Sportmonks free has no EPL. Minutes model runs statistical-only (no lineup provider).' },
        { name: 'Recommended (~$29/mo)', pair: ['api_football', 'newsdata'], note: 'API-Football Pro unlocks current season, injuries, lineups, odds — the full engine feature set.' },
        { name: 'Premium', pair: ['api_football', 'sportmonks'], note: 'Adds sidelined periods with return dates and xG redundancy — but sacrifices the news feed slot; only choose if the AI layer is disabled.' },
      ],
    };
  });

  const ProviderToggleSchema = z.object({ enabled: z.boolean() });

  app.post('/api/admin/providers/:key/toggle', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    const parsed = ProviderToggleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid toggle' });
    try {
      await setProviderEnabled(db, key, parsed.data.enabled);
    } catch (err) {
      if (err instanceof MaxProvidersError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  // ── AI provider switch (max 1 alive)
  app.get('/api/admin/ai-providers', async (req) => {
    requireAdmin(req);
    const providers = await db('ai_providers').orderBy('key');
    const keyStatus: Record<string, boolean> = {
      anthropic: !!config.keys.anthropic,
      openai: !!config.keys.openai,
      gemini: !!config.keys.gemini,
      deepseek: !!config.keys.deepseek,
      kimi: !!config.keys.kimi,
      ollama: true,
      modal: !!config.keys.modalUrl,
      mock: true,
    };
    return { providers: providers.map((p) => ({ ...p, keyConfigured: keyStatus[p.key] ?? false })) };
  });

  app.post('/api/admin/ai-providers/:key/activate', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    // probe at enable-time: failures keep the provider un-enableable, reason shown
    try {
      const row = await db('ai_providers').where({ key }).first();
      if (!row) return reply.code(404).send({ error: 'unknown provider' });
      const adapter = buildAdapter(key, row.config ?? {});
      const health = await adapter.healthCheck();
      if (!health.ok) return reply.code(422).send({ error: `health check failed: ${health.detail}` });
      await setAliveProvider(db, key);
      return { ok: true, detail: health.detail };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/ai-providers/deactivate', async (req) => {
    requireAdmin(req);
    await db('ai_providers').update({ alive: false, updated_at: db.fn.now() });
    return { ok: true };
  });

  // ── model weights & config
  app.get('/api/admin/config/:key', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    try {
      return { key, value: await getConfig(db, key) };
    } catch {
      return reply.code(404).send({ error: 'unknown config key' });
    }
  });

  app.put('/api/admin/config/:key', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    const body = req.body as { value?: unknown };
    if (body?.value === undefined) return reply.code(400).send({ error: 'missing value' });
    const version = await setConfig(db, key, body.value);
    return { key, version };
  });

  // ── feature kernel toggles
  app.get('/api/admin/features', async (req) => {
    requireAdmin(req);
    return { features: await db('feature_states').orderBy('name') };
  });

  app.post('/api/admin/features/:name/toggle', async (req, reply) => {
    requireAdmin(req);
    const name = (req.params as { name: string }).name;
    const parsed = ProviderToggleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid toggle' });
    try {
      await setFeatureEnabled(db, name, parsed.data.enabled);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  // ── logs & charts
  app.get('/api/admin/pull-log', async (req) => {
    requireAdmin(req);
    return {
      log: await db('api_pull_log').orderBy('id', 'desc').limit(100),
      quarantined: Number((await db('quarantine_rows').count({ c: '*' }).first())?.c ?? 0),
    };
  });

  app.get('/api/admin/ai-calls', async (req) => {
    requireAdmin(req);
    const calls = await db('ai_calls as c')
      .join('users as u', 'u.id', 'c.user_id')
      .orderBy('c.id', 'desc')
      .limit(100)
      .select('c.*', 'u.email as user_email');
    const daily = await db('ai_calls')
      .select(db.raw(`date_trunc('day', created_at) as day`))
      .sum({ credits: 'credits' })
      .sum({ prompt: 'prompt_tokens' })
      .sum({ completion: 'completion_tokens' })
      .sum({ cached: 'cached_tokens' })
      .groupByRaw(`date_trunc('day', created_at)`)
      .orderBy('day', 'desc')
      .limit(30);
    return { calls, daily };
  });

  // ── entity-resolution review queue
  app.get('/api/admin/resolution-queue', async (req) => {
    requireAdmin(req);
    return { queue: await db('resolution_queue').whereIn('status', ['pending', 'unmatched']).orderBy('created_at', 'desc').limit(100) };
  });

  const ResolveSchema = z.object({ playerUid: z.string().nullable() });

  app.post('/api/admin/resolution-queue/:id/resolve', async (req, reply) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid resolution' });
    try {
      await resolveManually(db, id, parsed.data.playerUid, req.user.id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });
}
