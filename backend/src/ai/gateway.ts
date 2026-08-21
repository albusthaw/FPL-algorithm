/**
 * AI Gateway (fpl-ai-engine-plan.md §2): Selector (max-1 alive) →
 * BudgetGuard → BatchPlanner → PromptBuilder → ProviderAdapter → Validator
 * (single repair retry) → Accountant → VerdictWriter.
 *
 * HARD RULE: every entry point requires an AIInvocation with a human user.
 * The scheduler module never imports this file (architectural test walks
 * the dependency graph to prove it).
 */
import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { config } from '../core/config.js';
import { getConfig, getConfigVersion } from '../core/model-config.js';
import { DEFAULT_CAPABILITIES, type CapabilityConfig, type ModelCapabilities } from '../core/ai-capabilities.js';
import { applyTokens, InsufficientTokensError } from '../tokens/ledger.js';
import type { AIInvocation, AIProviderAdapter, AIVerdict, PlayerNewsBundle, ProviderResult } from './types.js';
import { SYSTEM_BLOCK, buildRunContext, buildBatchBlock, buildMatrixLine } from './prompt.js';
import { validateVerdicts, ParsedTeamSchema, extractJson } from './validator.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OllamaAdapter } from './providers/ollama.js';
import { OpenAICompatibleAdapter } from './providers/openai-compatible.js';
import { MockProvider } from './providers/mock.js';
import { log } from '../core/logger.js';

export class NoAliveProviderError extends Error {
  constructor() {
    super('no AI provider is alive — activate one in the admin panel');
    this.name = 'NoAliveProviderError';
  }
}

interface AiPricing {
  credit_usd: number;
  providers: Record<string, { in: number; out: number; cached: number }>;
}

interface AiSettings {
  prompt_version: number;
  batch_size: number;
  max_news_per_player: number;
  news_snippet_chars: number;
  verdict_cache_hours: number;
  exclusion_bottom_pct: number;
  estimate_margin_pct: number;
}

export interface BuildAdapterOpts {
  capabilityConfig?: CapabilityConfig;
  /** persisted param facts learned from live 400s (ai_providers.config.capabilities) */
  learned?: Partial<ModelCapabilities> | null;
  onLearned?: (patch: Partial<ModelCapabilities>) => void | Promise<void>;
}

export function buildAdapter(
  key: string,
  providerConfig: Record<string, unknown> = {},
  opts: BuildAdapterOpts = {},
): AIProviderAdapter {
  const model = typeof providerConfig.model === 'string' ? providerConfig.model : undefined;
  const visionModel = typeof providerConfig.vision_model === 'string' ? providerConfig.vision_model : undefined;
  const capabilityConfig = opts.capabilityConfig ?? DEFAULT_CAPABILITIES;
  const common = { capabilityConfig, learned: opts.learned ?? null, onLearned: opts.onLearned };
  switch (key) {
    case 'anthropic':
      return new AnthropicAdapter({ apiKey: config.keys.anthropic, model, visionModel, capabilityConfig });
    case 'gemini':
      return new GeminiAdapter({ apiKey: config.keys.gemini, model, capabilityConfig });
    case 'openai':
      return new OpenAICompatibleAdapter({
        key: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: config.keys.openai,
        model: model ?? 'gpt-4o-mini',
        visionModel,
        ...common,
      });
    case 'deepseek':
      return new OpenAICompatibleAdapter({
        key: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: config.keys.deepseek,
        model: model ?? 'deepseek-v4-flash', // verified live 2026-08: deepseek-chat is gone
        visionModel, // e.g. deepseek-v4-flash-vision-exp — per-MODEL vision (P4)
        ...common,
        timeoutMs: 120_000, // dynamic rate limiting holds requests open
        maxTokens: 8192, // v4-flash spends completion tokens reasoning before the JSON
      });
    case 'kimi':
      return new OpenAICompatibleAdapter({
        key: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: config.keys.kimi,
        model: model ?? 'kimi-k2-0711-preview',
        visionModel,
        ...common,
      });
    case 'ollama':
      return new OllamaAdapter({
        url: config.keys.ollamaUrl,
        model,
        visionModel,
        allowRemote: config.keys.ollamaAllowRemote,
      });
    case 'modal':
      return new OpenAICompatibleAdapter({
        key: 'modal',
        baseUrl: config.keys.modalUrl.replace(/\/$/, '') + '/v1',
        apiKey: 'modal',
        model: model ?? 'default',
        visionModel,
        ...common,
        // legacy per-provider flag honoured as a learned override
        learned: {
          ...(opts.learned ?? {}),
          ...(providerConfig.supports_vision ? { vision: true } : {}),
        },
        extraHeaders: {
          ...(config.keys.modalKey ? { 'Modal-Key': config.keys.modalKey } : {}),
          ...(config.keys.modalSecret ? { 'Modal-Secret': config.keys.modalSecret } : {}),
        },
        timeoutMs: 180_000, // cold starts are real
      });
    case 'mock': {
      const roster = Array.isArray(providerConfig.roster)
        ? (providerConfig.roster as ConstructorParameters<typeof MockProvider>[1])
        : undefined;
      return new MockProvider({}, roster);
    }
    default:
      throw new Error(`unknown AI provider: ${key}`);
  }
}

/** Load the ⚙ capability registry (falls back to the compiled default). */
export async function loadCapabilityConfig(db: Knex): Promise<CapabilityConfig> {
  return getConfig<CapabilityConfig>(db, 'ai_model_capabilities').catch(() => DEFAULT_CAPABILITIES);
}

export async function getAliveProvider(db: Knex): Promise<{ key: string; adapter: AIProviderAdapter; row: Record<string, unknown> }> {
  const row = await db('ai_providers').where('alive', true).first();
  if (!row) throw new NoAliveProviderError();
  const capabilityConfig = await loadCapabilityConfig(db);
  const providerConfig = (row.config ?? {}) as Record<string, unknown>;
  const learned = (providerConfig.capabilities ?? null) as Partial<ModelCapabilities> | null;
  const adapter = buildAdapter(row.key, providerConfig, {
    capabilityConfig,
    learned,
    // a live 400 teaches permanently — the AI-side entitlement learning
    onLearned: async (patch) => {
      const cfg = { ...providerConfig, capabilities: { ...(learned ?? {}), ...patch } };
      await db('ai_providers').where({ key: row.key }).update({ config: JSON.stringify(cfg), updated_at: db.fn.now() });
      log.warn({ provider: row.key, patch }, 'learned model capability from live 400');
    },
  });
  return { key: row.key, adapter, row };
}

/** Max-1 gate: activating one provider atomically deactivates the incumbent. */
export async function setAliveProvider(db: Knex, key: string): Promise<void> {
  await db.transaction(async (trx) => {
    const rows = await trx('ai_providers').forUpdate().select('key');
    if (!rows.some((r) => r.key === key)) throw new Error(`unknown AI provider: ${key}`);
    await trx('ai_providers').update({ alive: false, updated_at: trx.fn.now() });
    await trx('ai_providers').where({ key }).update({ alive: true, updated_at: trx.fn.now() });
  });
}

export function computeCredits(
  pricing: AiPricing,
  provider: string,
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number },
): number {
  const p = pricing.providers[provider] ?? { in: 1, out: 5, cached: 0.1 };
  const usd =
    ((usage.promptTokens - usage.cachedPromptTokens) / 1e6) * p.in +
    (usage.cachedPromptTokens / 1e6) * p.cached +
    (usage.completionTokens / 1e6) * p.out;
  return Math.ceil(usd / pricing.credit_usd);
}

async function recordCall(
  db: Knex,
  inv: AIInvocation,
  provider: string,
  kind: 'analyse' | 'vision' | 'probe' | 'repair',
  result: ProviderResult | null,
  opts: { batchSize?: number; latencyMs: number; status?: string; error?: string; pricingVersion: number; credits: number },
): Promise<number> {
  const [row] = await db('ai_calls')
    .insert({
      user_id: inv.triggeredByUserId,
      run_id: inv.runId ?? null,
      provider,
      model: result?.model ?? '',
      kind,
      trigger_kind: inv.triggerKind,
      batch_size: opts.batchSize ?? 0,
      prompt_tokens: result?.usage.promptTokens ?? 0,
      completion_tokens: result?.usage.completionTokens ?? 0,
      cached_tokens: result?.usage.cachedPromptTokens ?? 0,
      credits: opts.credits,
      pricing_version: opts.pricingVersion,
      latency_ms: opts.latencyMs,
      finish_reason: result?.finishReason ?? 'complete',
      status: opts.status ?? 'ok',
      error: opts.error?.slice(0, 1000) ?? null,
    })
    .returning('id');
  return Number(row.id ?? row);
}

export interface AnalyseOutcome {
  verdicts: AIVerdict[];
  analysed: number;
  skippedExcluded: number;
  skippedNoNews: number;
  cacheHits: number;
  batches: number;
  failedBatches: number;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; credits: number };
  warnings: string[];
}

/**
 * The full analyse pipeline for a Run. `candidates` carries every player
 * eligible for AI (news already mapped); the planner applies exclusions,
 * no-news skip, verdict cache and batching.
 */
export async function analysePlayers(
  db: Knex,
  inv: AIInvocation,
  candidates: PlayerNewsBundle[],
  opts: { gameweek: number; deadlineIso: string; excludedUids: Set<string> },
): Promise<AnalyseOutcome> {
  const { adapter, key } = await getAliveProvider(db);
  const settings = await getConfig<AiSettings>(db, 'ai');
  const pricing = await getConfig<AiPricing>(db, 'ai_pricing');
  const pricingVersion = await getConfigVersion(db, 'ai_pricing');

  const outcome: AnalyseOutcome = {
    verdicts: [],
    analysed: 0,
    skippedExcluded: 0,
    skippedNoNews: 0,
    cacheHits: 0,
    batches: 0,
    failedBatches: 0,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0 },
    warnings: [],
  };

  // ── BatchPlanner filters (ordered, each logged with counts)
  const afterExclusion = candidates.filter((c) => {
    if (opts.excludedUids.has(c.playerUid)) {
      outcome.skippedExcluded++;
      return false;
    }
    return true;
  });
  const withNews = afterExclusion.filter((c) => {
    if (c.news.length === 0) {
      outcome.skippedNoNews++;
      return false;
    }
    return true;
  });

  // verdict cache: (player, sorted news ids, matrix line 1dp, prompt version)
  const toAnalyse: PlayerNewsBundle[] = [];
  const cacheKeyOf = (c: PlayerNewsBundle): string =>
    crypto
      .createHash('sha256')
      .update([c.playerUid, c.news.map((n) => n.id).sort().join(','), c.matrixLine, settings.prompt_version].join('~'))
      .digest('hex');
  for (const c of withNews) {
    const cacheKey = cacheKeyOf(c);
    const hit = await db('ai_verdict_cache').where({ cache_key: cacheKey }).where('expires_at', '>', db.fn.now()).first();
    if (hit) {
      outcome.cacheHits++;
      outcome.verdicts.push(hit.verdict as AIVerdict);
    } else {
      toAnalyse.push(c);
    }
  }

  // news trim: max N items, snippet cap, source-tier order (already sorted by caller)
  for (const c of toAnalyse) {
    c.news = c.news.slice(0, settings.max_news_per_player).map((n) => ({ ...n, snippet: n.snippet.slice(0, settings.news_snippet_chars) }));
  }

  // batching, grouped by club where possible
  toAnalyse.sort((a, b) => a.club.localeCompare(b.club));
  const batches: PlayerNewsBundle[][] = [];
  for (let i = 0; i < toAnalyse.length; i += settings.batch_size) {
    batches.push(toAnalyse.slice(i, i + settings.batch_size));
  }

  const runContext = buildRunContext(opts.gameweek, opts.deadlineIso, '');

  // queue-based so a length-truncated batch can split in two and requeue —
  // the ONLY auto-split (§7); halves are marked and never split again
  const queue: { items: PlayerNewsBundle[]; isSplit: boolean }[] = batches.map((b) => ({ items: b, isSplit: false }));
  while (queue.length > 0) {
    const { items: batch, isSplit } = queue.shift()!;
    outcome.batches++;
    const batchBlock = buildBatchBlock(batch);
    const expectedUids = new Set(batch.map((b) => b.playerUid));
    const started = Date.now();
    let result: ProviderResult;
    try {
      result = await adapter.analyse(SYSTEM_BLOCK, runContext, batchBlock, inv);
    } catch (err) {
      outcome.failedBatches++;
      outcome.warnings.push(`batch failed: ${String(err).slice(0, 200)}`);
      await recordCall(db, inv, key, 'analyse', null, {
        batchSize: batch.length,
        latencyMs: Date.now() - started,
        status: 'failed',
        error: String(err),
        pricingVersion,
        credits: 0,
      });
      continue;
    }

    let credits = computeCredits(pricing, key, result.usage);
    await accumulate(outcome, result, credits);
    await recordCall(db, inv, key, 'analyse', result, {
      batchSize: batch.length,
      latencyMs: Date.now() - started,
      status: result.finishReason === 'filtered' ? 'filtered' : 'ok',
      pricingVersion,
      credits,
    });

    if (result.finishReason === 'filtered' || result.finishReason === 'refused') {
      outcome.failedBatches++;
      outcome.warnings.push(`batch ${result.finishReason} by provider — players keep previous adjustments`);
      continue;
    }

    // truncated output cannot be repaired — split in two and retry once each
    if (result.finishReason === 'length' && batch.length > 1 && !isSplit) {
      const mid = Math.ceil(batch.length / 2);
      queue.push({ items: batch.slice(0, mid), isSplit: true });
      queue.push({ items: batch.slice(mid), isSplit: true });
      outcome.warnings.push(`batch of ${batch.length} hit the output limit — split in two and retried`);
      continue;
    }

    let validation = validateVerdicts(result.text, expectedUids);
    if (!validation.ok) {
      // SINGLE repair retry, ever
      const repairStart = Date.now();
      try {
        const repaired = await adapter.repair(result, validation.errors.join('; '), inv);
        credits = computeCredits(pricing, key, repaired.usage);
        await accumulate(outcome, repaired, credits);
        await recordCall(db, inv, key, 'repair', repaired, {
          batchSize: batch.length,
          latencyMs: Date.now() - repairStart,
          pricingVersion,
          credits,
        });
        validation = validateVerdicts(repaired.text, expectedUids);
      } catch (err) {
        outcome.warnings.push(`repair failed: ${String(err).slice(0, 200)}`);
      }
    }
    if (!validation.ok) {
      outcome.failedBatches++;
      outcome.warnings.push(`batch failed validation after repair — ${batch.length} players stale`);
      continue;
    }

    outcome.warnings.push(...validation.warnings);
    outcome.analysed += validation.verdicts.length;
    outcome.verdicts.push(...validation.verdicts);

    // cache the verdicts
    const byUid = new Map(validation.verdicts.map((v) => [v.player_uid, v]));
    for (const c of batch) {
      const v = byUid.get(c.playerUid);
      if (!v) continue;
      await db('ai_verdict_cache')
        .insert({
          cache_key: cacheKeyOf(c),
          player_uid: c.playerUid,
          verdict: JSON.stringify(v),
          prompt_version: settings.prompt_version,
          expires_at: new Date(Date.now() + settings.verdict_cache_hours * 3600_000),
        })
        .onConflict('cache_key')
        .ignore();
    }
  }

  // debit the launching user (admins: recorded, not charged — ledger handles it)
  if (outcome.usage.credits > 0) {
    await applyTokens(db, {
      userId: inv.triggeredByUserId,
      delta: -outcome.usage.credits,
      reason: inv.triggerKind === 'image_parse' ? 'vision' : 'run',
      runId: inv.runId ?? null,
    });
  }

  log.info(
    { provider: key, analysed: outcome.analysed, cacheHits: outcome.cacheHits, batches: outcome.batches, credits: outcome.usage.credits },
    'AI analyse complete',
  );
  return outcome;
}

async function accumulate(outcome: AnalyseOutcome, result: ProviderResult, credits: number): Promise<void> {
  outcome.usage.promptTokens += result.usage.promptTokens;
  outcome.usage.completionTokens += result.usage.completionTokens;
  outcome.usage.cachedTokens += result.usage.cachedPromptTokens;
  outcome.usage.credits += credits;
}

/** Pre-run estimate (§8.3): exact where the provider offers a counter. */
export async function estimateRun(
  db: Knex,
  candidates: PlayerNewsBundle[],
  opts: { gameweek: number; deadlineIso: string; excludedUids: Set<string> },
): Promise<{ tokens: number; credits: number; players: number; provider: string; marginPct: number }> {
  const { adapter, key } = await getAliveProvider(db);
  const settings = await getConfig<AiSettings>(db, 'ai');
  const pricing = await getConfig<AiPricing>(db, 'ai_pricing');
  const eligible = candidates.filter((c) => !opts.excludedUids.has(c.playerUid) && c.news.length > 0);
  const runContext = buildRunContext(opts.gameweek, opts.deadlineIso, '');
  let tokens = 0;
  for (let i = 0; i < eligible.length; i += settings.batch_size) {
    const block = buildBatchBlock(eligible.slice(i, i + settings.batch_size));
    tokens += await adapter.estimateTokens(i === 0 ? SYSTEM_BLOCK : '', runContext, block);
    tokens += eligible.slice(i, i + settings.batch_size).length * 45; // completion estimate
  }
  tokens = Math.ceil(tokens * (1 + settings.estimate_margin_pct / 100));
  const credits = computeCredits(pricing, key, { promptTokens: tokens, completionTokens: Math.ceil(tokens * 0.12), cachedPromptTokens: 0 });
  return { tokens, credits, players: eligible.length, provider: key, marginPct: settings.estimate_margin_pct };
}

/** X3 (v1.4.1): BudgetGuard BEFORE any vision/OCR provider call — the old
 *  after-call debit burned real provider spend then threw on the debit. */
async function assertVisionBudget(db: Knex, inv: AIInvocation): Promise<void> {
  const user = await db('users').where('id', inv.triggeredByUserId).first('role', 'token_balance');
  if (!user || user.role === 'admin') return;
  const settings = await getConfig<AiSettings & { vision_estimate_credits?: number }>(db, 'ai');
  const estimate = settings.vision_estimate_credits ?? 4;
  if (Number(user.token_balance) < estimate) {
    throw Object.assign(new Error(`You're out of credits for an image parse (needs ≈${estimate}). Contact your admin to top up.`), {
      statusCode: 402,
    });
  }
}

/** Vision pipeline entry (archived plan §9.2) — same gate, same accounting. */
export async function parseTeamImage(
  db: Knex,
  inv: AIInvocation,
  imageBase64: string,
  mimeType: string,
): Promise<{ players: unknown[]; aiCallId: number; credits: number; provider: string }> {
  const { adapter, key } = await getAliveProvider(db);
  const pricing = await getConfig<AiPricing>(db, 'ai_pricing');
  const pricingVersion = await getConfigVersion(db, 'ai_pricing');
  if (!adapter.supportsVision) {
    const visionCapable = await db('ai_providers').where('supports_vision', true).pluck('key');
    throw Object.assign(new Error(`the alive provider (${key}) does not support vision — vision-capable: ${visionCapable.join(', ')}`), {
      statusCode: 422,
    });
  }
  await assertVisionBudget(db, inv);
  const started = Date.now();
  const result = await adapter.parseTeamImage(imageBase64, mimeType, inv);
  const credits = computeCredits(pricing, key, result.usage);
  const aiCallId = await recordCall(db, inv, key, 'vision', result, {
    latencyMs: Date.now() - started,
    pricingVersion,
    credits,
  });
  if (credits > 0) {
    await applyTokens(db, { userId: inv.triggeredByUserId, delta: -credits, reason: 'vision', runId: inv.runId ?? null });
  }
  if (result.finishReason === 'length') {
    await db('ai_calls').where('id', aiCallId).update({ status: 'truncated' });
    throw Object.assign(new Error('the vision reply was truncated — try a smaller or clearer screenshot'), { statusCode: 422 });
  }
  const parsed = ParsedTeamSchema.safeParse(JSON.parse(extractJson(result.text)));
  if (!parsed.success) {
    await db('ai_calls').where('id', aiCallId).update({ status: 'failed_validation' });
    throw Object.assign(new Error('the AI could not produce a valid team parse — try a clearer screenshot'), { statusCode: 422 });
  }
  return { players: parsed.data, aiCallId, credits, provider: key };
}

/**
 * P3 (v1.4.1): OCR-text reformat entry — the token-cheap path. Works on
 * EVERY provider (no vision capability required); same human gate, same
 * accounting, single repair via schema re-parse tolerance.
 */
export async function parseTeamOcrText(
  db: Knex,
  inv: AIInvocation,
  ocrText: string,
): Promise<{ players: unknown[]; aiCallId: number; credits: number; provider: string } | null> {
  const { adapter, key } = await getAliveProvider(db);
  if (!adapter.parseTeamText) return null; // provider cannot reformat text
  const pricing = await getConfig<AiPricing>(db, 'ai_pricing');
  const pricingVersion = await getConfigVersion(db, 'ai_pricing');
  await assertVisionBudget(db, inv);
  const started = Date.now();
  const result = await adapter.parseTeamText(ocrText, inv);
  const credits = computeCredits(pricing, key, result.usage);
  const aiCallId = await recordCall(db, inv, key, 'vision', result, {
    latencyMs: Date.now() - started,
    pricingVersion,
    credits,
  });
  if (credits > 0) {
    await applyTokens(db, { userId: inv.triggeredByUserId, delta: -credits, reason: 'vision', runId: inv.runId ?? null });
  }
  let parsed: ReturnType<typeof ParsedTeamSchema.safeParse>;
  try {
    parsed = ParsedTeamSchema.safeParse(JSON.parse(extractJson(result.text)));
  } catch {
    parsed = ParsedTeamSchema.safeParse(null);
  }
  if (!parsed.success) {
    await db('ai_calls').where('id', aiCallId).update({ status: 'failed_validation' });
    return null; // caller decides: vision fallback or a clear error
  }
  return { players: parsed.data, aiCallId, credits, provider: key };
}

export { InsufficientTokensError };
