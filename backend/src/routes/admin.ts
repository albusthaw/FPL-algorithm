import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import { requireAdmin } from './auth.js';
import { hashPassword } from '../auth/auth.js';
import { applyTokens } from '../tokens/ledger.js';
import { setProviderEnabled, MaxProvidersError } from '../ingest/gateway.js';
import { PROVIDER_PLAN_TIERS, DEFAULT_PROVIDER_PLANS, tierFor, quotaLimitFor, type ProviderPlansConfig } from '../ingest/plans.js';
import { setAliveProvider, buildAdapter } from '../ai/gateway.js';
import { getConfig, setConfig } from '../core/model-config.js';
import { setEnabled as setFeatureEnabled } from '../core/kernel.js';
import { resolveManually } from '../players/resolver.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import {
  PROVIDER_KEY_FIELDS,
  keyConfigured,
  keyHint,
  requiresKey,
  setProviderSecret,
  SecretValidationError,
} from '../core/secrets.js';

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
    // P1 (v1.4.2): subscription model — selected tier per provider + the menu
    const plans = (await getConfig<ProviderPlansConfig>(db, 'provider_plans').catch(() => null)) ?? DEFAULT_PROVIDER_PLANS;
    // key STATUS + masked hint only — never key values (no secrets to the frontend)
    return {
      providers: providers.map((p) => ({
        ...p,
        keyConfigured: keyConfigured(p.key),
        keyHint: keyHint(p.key),
        requiresKey: requiresKey(p.key),
        plan: plans[p.key]?.plan ?? 'free',
        planTiers: (PROVIDER_PLAN_TIERS[p.key] ?? []).map((t) => ({ id: t.id, label: t.label, cost: t.cost, note: t.note })),
        keyFields: (PROVIDER_KEY_FIELDS[p.key] ?? []).map((f) => ({
          env: f.env,
          label: f.label,
          secret: f.secret,
          set: !!(process.env[f.env] ?? '').trim(),
        })),
      })),
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
    // no key, no enable — a keyless provider only produces failed pulls
    if (parsed.data.enabled && requiresKey(key) && !keyConfigured(key)) {
      return reply.code(422).send({ error: 'add this provider’s API key first (Settings → API keys)' });
    }
    try {
      await setProviderEnabled(db, key, parsed.data.enabled);
    } catch (err) {
      if (err instanceof MaxProvidersError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  // ── P1 (v1.4.2): subscription plan per provider. Writes the tier snapshot
  //    into ⚙ provider_plans, fills api_providers.quota_limit from the tier
  //    (fixes X5), and re-arms entitlement probes — learned denials for the
  //    provider are cleared so each gated scope gets ONE fresh try under the
  //    new plan (then re-learns, never hammers).
  const PlanSchema = z.object({ plan: z.string().min(1).max(40) });

  app.put('/api/admin/providers/:key/plan', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    const parsed = PlanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid plan payload' });
    const tier = tierFor(key, parsed.data.plan);
    if (!tier) return reply.code(422).send({ error: `unknown plan '${parsed.data.plan}' for provider '${key}'` });
    const plans = (await getConfig<ProviderPlansConfig>(db, 'provider_plans').catch(() => null)) ?? DEFAULT_PROVIDER_PLANS;
    const next = { ...plans, [key]: { plan: tier.id, depth: tier.depth, rate: tier.rate } };
    await setConfig(db, 'provider_plans', next);
    await db('api_providers').where({ key }).update({ quota_limit: quotaLimitFor(tier), updated_at: db.fn.now() });
    const rearmed = await db('provider_entitlements').where({ provider: key, allowed: false }).del();
    return { ok: true, plan: tier.id, quotaLimit: quotaLimitFor(tier), entitlementProbesRearmed: rearmed };
  });

  // ── P1 (v1.4.2): the Run screen's per-source depth selector (admin-gated).
  //    Merges one selection into ⚙ history_depth.per_provider; the next
  //    launch run backfills exactly what was selected (resumable ledger).
  const DepthSchema = z.object({
    provider: z.string().min(1).max(40),
    unit: z.enum(['days', 'months', 'seasons', 'career']),
    value: z.number().int().min(0).max(240),
  });

  app.put('/api/admin/history-depth', async (req, reply) => {
    requireAdmin(req);
    const parsed = DepthSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid depth payload' });
    const { DEFAULT_HISTORY_DEPTH } = await import('../ingest/backfill.js');
    const depth = (await getConfig<typeof DEFAULT_HISTORY_DEPTH>(db, 'history_depth').catch(() => null)) ?? DEFAULT_HISTORY_DEPTH;
    const next = {
      ...DEFAULT_HISTORY_DEPTH,
      ...depth,
      per_provider: {
        ...(depth.per_provider ?? {}),
        [parsed.data.provider]: { unit: parsed.data.unit, value: parsed.data.value },
      },
    };
    // vaastav/fpl selections also fold into the legacy fields so older
    // readers (coverage text, admin tab) show the same truth
    if (parsed.data.provider === 'vaastav' && parsed.data.unit === 'seasons') {
      next.mode = parsed.data.value > 1 ? 'seasons' : 'days';
      next.seasons = parsed.data.value;
    }
    if (parsed.data.provider === 'fpl' && parsed.data.unit === 'career') {
      next.career_aggregates = parsed.data.value > 0;
    }
    await setConfig(db, 'history_depth', next);
    return { ok: true, depth: next };
  });

  // ── API keys: entered here, stored server-side in shared/.env, applied
  //    immediately. The response never contains the value.
  const SecretSchema = z.object({ env: z.string().min(1).max(64), value: z.string().max(500) });

  app.put('/api/admin/keys', async (req, reply) => {
    requireAdmin(req);
    const parsed = SecretSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid key payload' });
    const hint = (v: string): string | null => (v.trim() ? `…${v.trim().slice(-4)}` : null);
    const oldHint = hint(process.env[parsed.data.env] ?? '');
    try {
      setProviderSecret(parsed.data.env, parsed.data.value);
    } catch (err) {
      if (err instanceof SecretValidationError) return reply.code(422).send({ error: err.message });
      return reply.code(500).send({ error: 'could not save the key' });
    }
    // X1: append-only audit — env name + last-4 hints only, never values
    await db('key_audit').insert({
      env_var: parsed.data.env,
      actor_user_id: req.user.id,
      old_hint: oldHint,
      new_hint: hint(parsed.data.value),
      action: parsed.data.value.trim() ? 'set' : 'clear',
    });
    return { ok: true, set: parsed.data.value.trim().length > 0 };
  });

  // X1: the audit trail for "my key vanished" reports
  app.get('/api/admin/key-audit', async (req) => {
    requireAdmin(req);
    return { audit: await db('key_audit').orderBy('id', 'desc').limit(100) };
  });

  // ── AI provider switch (max 1 alive)
  app.get('/api/admin/ai-providers', async (req) => {
    requireAdmin(req);
    const providers = await db('ai_providers').orderBy('key');
    // P4: resolved capability flags per provider for its CURRENT model —
    // the picker shows vision/params compatibility before anything breaks
    const { loadCapabilityConfig } = await import('../ai/gateway.js');
    const { resolveCapabilities } = await import('../core/ai-capabilities.js');
    const capCfg = await loadCapabilityConfig(db);
    const DEFAULT_MODEL: Record<string, string> = {
      anthropic: 'claude-haiku-4-5',
      openai: 'gpt-4o-mini',
      deepseek: 'deepseek-v4-flash',
      kimi: 'kimi-k2-0711-preview',
      gemini: 'gemini-2.5-flash',
      ollama: 'llama3.1:8b',
      modal: 'default',
      mock: 'mock-analyst-1',
    };
    return {
      providers: providers.map((p) => {
        const cfg = (p.config ?? {}) as { model?: string; vision_model?: string; capabilities?: Record<string, unknown> };
        const model = cfg.model ?? DEFAULT_MODEL[p.key] ?? '';
        const caps = resolveCapabilities(capCfg, p.key, model, cfg.capabilities ?? null);
        const visionModel = cfg.vision_model ?? model;
        const visionCaps = resolveCapabilities(capCfg, p.key, visionModel, cfg.capabilities ?? null);
        return {
          ...p,
          keyConfigured: keyConfigured(p.key),
          keyHint: keyHint(p.key),
          requiresKey: requiresKey(p.key),
          model: cfg.model ?? null,
          capabilities: {
            tokenParam: caps.tokenParam,
            temperature: caps.temperature,
            vision: visionCaps.vision,
            json: caps.json,
            learned: cfg.capabilities ?? null,
          },
          keyFields: (PROVIDER_KEY_FIELDS[p.key] ?? []).map((f) => ({
            env: f.env,
            label: f.label,
            secret: f.secret,
            set: !!(process.env[f.env] ?? '').trim(),
          })),
        };
      }),
    };
  });

  app.post('/api/admin/ai-providers/:key/activate', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    // no key, no activation — and say so plainly instead of a cryptic probe error
    if (requiresKey(key) && !keyConfigured(key)) {
      return reply.code(422).send({ error: 'add this provider’s API key first (Settings → API keys)' });
    }
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

  // ── AI models: live list from the provider ("autoload") + choice persisted
  //    in the provider's config (a model name is not a secret)
  app.get('/api/admin/ai-providers/:key/models', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    if (requiresKey(key) && !keyConfigured(key)) {
      return reply.code(422).send({ error: 'add this provider’s API key first, then load its models' });
    }
    const row = await db('ai_providers').where({ key }).first();
    if (!row) return reply.code(404).send({ error: 'unknown provider' });
    try {
      const adapter = buildAdapter(key, row.config ?? {});
      const models = adapter.listModels ? await adapter.listModels() : [];
      return { models, current: (row.config as { model?: string } | null)?.model ?? null };
    } catch (err) {
      return reply.code(502).send({ error: `could not load models: ${(err as Error).message}` });
    }
  });

  const ModelSchema = z.object({ model: z.string().min(1).max(120).regex(/^[\w.\-:/]+$/) });

  app.put('/api/admin/ai-providers/:key/model', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    const parsed = ModelSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid model name' });
    const row = await db('ai_providers').where({ key }).first();
    if (!row) return reply.code(404).send({ error: 'unknown provider' });
    // model change invalidates previously learned param facts
    const cfg = { ...(row.config ?? {}), model: parsed.data.model, capabilities: null };
    await db('ai_providers').where({ key }).update({ config: JSON.stringify(cfg), updated_at: db.fn.now() });

    // P4 probe-and-learn: one tiny live request teaches the param shape for
    // THIS model; 400s become learned overrides shown in the picker.
    // Human-triggered (admin action) — never automatic.
    let probed: Record<string, unknown> | null = null;
    if (keyConfigured(key)) {
      try {
        const { loadCapabilityConfig } = await import('../ai/gateway.js');
        const capabilityConfig = await loadCapabilityConfig(db);
        let learnedPatch: Record<string, unknown> | null = null;
        const adapter = buildAdapter(key, cfg, {
          capabilityConfig,
          onLearned: async (patch) => {
            learnedPatch = { ...(learnedPatch ?? {}), ...patch };
          },
        });
        if (adapter.probeCapabilities) {
          const caps = await adapter.probeCapabilities();
          probed = { ...caps };
          if (learnedPatch) {
            await db('ai_providers')
              .where({ key })
              .update({ config: JSON.stringify({ ...cfg, capabilities: learnedPatch }), updated_at: db.fn.now() });
          }
        }
      } catch (err) {
        log.warn({ key, err: String(err) }, 'capability probe failed — registry defaults stand');
      }
    }
    return { ok: true, model: parsed.data.model, capabilities: probed };
  });

  // P4: vision model override (e.g. deepseek-v4-flash-vision-exp) — vision
  // is a per-MODEL fact, so the provider can route uploads to a sibling model
  app.put('/api/admin/ai-providers/:key/vision-model', async (req, reply) => {
    requireAdmin(req);
    const key = (req.params as { key: string }).key;
    const parsed = z.object({ model: z.string().max(120).regex(/^[\w.\-:/]*$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid model name' });
    const row = await db('ai_providers').where({ key }).first();
    if (!row) return reply.code(404).send({ error: 'unknown provider' });
    const cfg = { ...(row.config ?? {}), vision_model: parsed.data.model || undefined };
    await db('ai_providers').where({ key }).update({ config: JSON.stringify(cfg), updated_at: db.fn.now() });
    return { ok: true, visionModel: parsed.data.model || null };
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
  // ── historical depth (v1.4.0): per-provider reach, configured depth,
  //    backfill ledger, and a human-triggered backfill (statistical only)
  app.get('/api/admin/history', async (req) => {
    requireAdmin(req);
    const { historyCoverage, DEFAULT_HISTORY_DEPTH } = await import('../ingest/backfill.js');
    const depthCfg = await getConfig<typeof DEFAULT_HISTORY_DEPTH>(db, 'history_depth').catch(() => DEFAULT_HISTORY_DEPTH);
    const coverage = await historyCoverage(db, depthCfg ?? DEFAULT_HISTORY_DEPTH);
    const ledger = await db('history_pulls').orderBy('id', 'desc').limit(50);
    return { depth: depthCfg ?? DEFAULT_HISTORY_DEPTH, coverage, ledger };
  });

  const backfillState = { running: false };
  app.post('/api/admin/backfill', async (req, reply) => {
    requireAdmin(req);
    if (backfillState.running) return reply.code(409).send({ error: 'a backfill is already running' });
    const { ensureHistoryDepth, DEFAULT_HISTORY_DEPTH } = await import('../ingest/backfill.js');
    const depthCfg = (await getConfig<typeof DEFAULT_HISTORY_DEPTH>(db, 'history_depth').catch(() => null)) ?? DEFAULT_HISTORY_DEPTH;
    const plans = (await getConfig<ProviderPlansConfig>(db, 'provider_plans').catch(() => null)) ?? DEFAULT_PROVIDER_PLANS;
    backfillState.running = true;
    // runs in the background of THIS admin action (human-triggered,
    // statistical ingestion only); progress lands in the history_pulls ledger
    void ensureHistoryDepth(db, depthCfg, { plans })
      .catch((err) => log.error({ err: String(err) }, 'backfill failed'))
      .finally(() => {
        backfillState.running = false;
      });
    return { started: true, depth: depthCfg };
  });

  // ── A4 (v1.4.5): backtest & calibration harness
  const backtestState = { running: false as boolean, last: null as unknown };
  app.post('/api/admin/backtest', async (req, reply) => {
    requireAdmin(req);
    if (backtestState.running) return reply.code(409).send({ error: 'a backtest is already running' });
    backtestState.running = true;
    const { walkForwardBacktest } = await import('../stats/backtest.js');
    // human-triggered, statistical only; results land in model_errors + runs
    void walkForwardBacktest(db, { triggeredBy: req.user.id })
      .then((m) => {
        backtestState.last = m;
      })
      .catch((err) => log.error({ err: String(err) }, 'backtest failed'))
      .finally(() => {
        backtestState.running = false;
      });
    return { started: true };
  });

  app.post('/api/admin/refit', async (req, reply) => {
    requireAdmin(req);
    if (backtestState.running) return reply.code(409).send({ error: 'a backtest is already running' });
    backtestState.running = true;
    const { refitConstants } = await import('../stats/backtest.js');
    void refitConstants(db, { triggeredBy: req.user.id })
      .then((r) => {
        backtestState.last = r;
      })
      .catch((err) => log.error({ err: String(err) }, 'refit failed'))
      .finally(() => {
        backtestState.running = false;
      });
    return { started: true };
  });

  app.get('/api/admin/backtest', async (req) => {
    requireAdmin(req);
    const runs = await db('runs').where('kind', 'backtest').orderBy('id', 'desc').limit(10).select('id', 'status', 'stages', 'started_at', 'finished_at');
    const latest = runs[0];
    let calibration: unknown = null;
    if (latest) {
      // calibration curve: predicted-xPts buckets vs realised mean points
      const rows = (await db('model_errors')
        .where('run_id', latest.id)
        .select(db.raw(`width_bucket(xpts_pred, 0, 12, 12) AS bucket`))
        .avg({ pred: 'xpts_pred', actual: 'points_actual' })
        .count({ n: '*' })
        .groupBy('bucket')
        .orderBy('bucket')) as { bucket: number; pred: string; actual: string; n: string }[];
      calibration = rows.map((r) => ({ bucket: Number(r.bucket), pred: Number(r.pred), actual: Number(r.actual), n: Number(r.n) }));
    }
    return { running: backtestState.running, lastResult: backtestState.last, runs, calibration };
  });

  // ── data-coverage audit (statengineexpansion.md X6): proves every active
  //    player is ingested, scored and reflected in the latest rankings
  app.get('/api/admin/data-coverage', async (req) => {
    requireAdmin(req);
    const latestRun = await db('runs').where('status', 'complete').orderBy('id', 'desc').first('id');
    const runId = latestRun ? Number(latestRun.id) : null;
    const players = (await db.raw(
      `SELECT p.uid, p.web_name, p.position, t.short_name AS club, p.status,
              COALESCE(h.matches, 0)::int AS history_matches,
              COALESCE(h.minutes, 0)::int AS history_minutes,
              COALESCE(h.xg_rows, 0)::int AS xg_rows,
              COALESCE(n.news7, 0)::int  AS news_7d,
              COALESCE(i.idents, 0)::int AS identities,
              (sp.player_uid IS NOT NULL) AS set_piece,
              (pm.player_uid IS NOT NULL) AS in_latest_run
       FROM players p
       LEFT JOIN teams t ON t.uid = p.team_uid
       LEFT JOIN (SELECT player_uid, count(*) AS matches, sum(minutes) AS minutes, count(xg) AS xg_rows
                  FROM player_match_stats GROUP BY player_uid) h ON h.player_uid = p.uid
       LEFT JOIN (SELECT m.player_uid, count(*) AS news7 FROM news_player_map m
                  JOIN news_items ni ON ni.id = m.news_id
                  WHERE ni.fetched_at > now() - interval '7 days' GROUP BY m.player_uid) n ON n.player_uid = p.uid
       LEFT JOIN (SELECT player_uid, count(*) AS idents FROM player_identities GROUP BY player_uid) i ON i.player_uid = p.uid
       LEFT JOIN set_piece_roles sp ON sp.player_uid = p.uid
       LEFT JOIN player_matrix pm ON pm.player_uid = p.uid AND pm.run_id = ?
       WHERE p.team_uid IS NOT NULL
       ORDER BY p.web_name`,
      [runId ?? -1],
    )) as { rows: Record<string, unknown>[] };
    const rows = players.rows;
    const summary = {
      runId,
      totalActive: rows.length,
      inLatestRun: rows.filter((r) => r.in_latest_run).length,
      withHistory: rows.filter((r) => Number(r.history_matches) > 0).length,
      withNews7d: rows.filter((r) => Number(r.news_7d) > 0).length,
      withSetPiece: rows.filter((r) => r.set_piece).length,
      zeroHistory: rows.filter((r) => Number(r.history_matches) === 0).length,
    };
    return { summary, players: rows };
  });

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
