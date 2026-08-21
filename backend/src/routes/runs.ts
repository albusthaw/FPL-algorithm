import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';
import { startRun, getLiveRun, runEvents, type RunProgress } from '../run/orchestrator.js';
import { buildNewsBundles } from '../ai/bundles.js';
import { estimateRun, NoAliveProviderError } from '../ai/gateway.js';
import { getConfig } from '../core/model-config.js';
import { latestCompleteRunId } from './players.js';
import { InsufficientTokensError } from '../tokens/ledger.js';

export async function runRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  // pre-run info: exclusion checklist + token estimate
  app.get('/api/runs/prepare', async (req) => {
    requireAuth(req);
    const runId = await latestCompleteRunId(db);
    const aiCfg = await getConfig<{ exclusion_bottom_pct: number }>(db, 'ai');
    let candidates: { uid: string; web_name: string; position: string; rank: number | null; preChecked: boolean; newsCount: number }[] = [];
    if (runId) {
      const matrix = await db('player_matrix as pm')
        .join('players as p', 'p.uid', 'pm.player_uid')
        .where('pm.run_id', runId)
        .orderBy('pm.rank_overall', 'asc')
        .select('pm.player_uid as uid', 'p.web_name', 'p.position', 'pm.rank_overall as rank');
      const cutoffRank = Math.floor(matrix.length * (1 - aiCfg.exclusion_bottom_pct / 100));
      const newsCounts = new Map<string, number>(
        ((
          await db('news_player_map as m')
            .join('news_items as n', 'n.id', 'm.news_id')
            .where('n.fetched_at', '>', new Date(Date.now() - 7 * 86_400_000))
            .select('m.player_uid')
            .count({ c: '*' })
            .groupBy('m.player_uid')
        ) as { player_uid: string; c: unknown }[]).map((r) => [r.player_uid, Number(r.c)]),
      );
      candidates = matrix.map((m, idx) => ({
        uid: m.uid,
        web_name: m.web_name,
        position: m.position,
        rank: m.rank,
        preChecked: idx >= cutoffRank, // bottom-X pre-checked as "skip AI"
        newsCount: newsCounts.get(m.uid) ?? 0,
      }));
    }
    // saved manual exclusions
    const saved = await db('ai_exclusions').where('user_id', req.user.id).pluck('player_uid');
    const aiProvider = await db('ai_providers').where('alive', true).first('key', 'supports_vision');
    // why the AI pass may have little/nothing to read — shown BEFORE launch
    const enabled = await db('api_providers').where('enabled', true).select('key', 'capabilities');
    const newsProviderEnabled = enabled.some((p) => (p.capabilities ?? []).includes('news'));
    const recentNews = await db('news_items').where('fetched_at', '>', new Date(Date.now() - 7 * 86_400_000)).count('* as c');
    // launch-run data window: how far back each provider CAN reach, what the
    // configured ⚙ history_depth will pull, and what is already imported
    const { historyCoverage, depthSelectorOptions, DEFAULT_HISTORY_DEPTH } = await import('../ingest/backfill.js');
    const { DEFAULT_PROVIDER_PLANS } = await import('../ingest/plans.js');
    const depthCfg = await getConfig<typeof DEFAULT_HISTORY_DEPTH>(db, 'history_depth').catch(() => DEFAULT_HISTORY_DEPTH);
    const coverage = await historyCoverage(db, depthCfg ?? DEFAULT_HISTORY_DEPTH);
    // P1 (v1.4.2): selector column options = subscription plan ∩ entitlements
    const plans = (await getConfig<typeof DEFAULT_PROVIDER_PLANS>(db, 'provider_plans').catch(() => null)) ?? DEFAULT_PROVIDER_PLANS;
    const depthOptions = await depthSelectorOptions(db, depthCfg ?? DEFAULT_HISTORY_DEPTH, plans);
    return {
      runId,
      candidates,
      savedExclusions: saved,
      aiProvider: aiProvider ?? null,
      balance: req.user.token_balance,
      newsProviderEnabled,
      recentNewsCount: Number((recentNews[0] as { c: unknown }).c ?? 0),
      historyDepth: depthCfg ?? DEFAULT_HISTORY_DEPTH,
      historyCoverage: coverage,
      depthOptions,
      isAdmin: req.user.role === 'admin',
    };
  });

  const EstimateSchema = z.object({ excluded: z.array(z.string()).default([]) });

  app.post('/api/runs/estimate', async (req, reply) => {
    requireAuth(req);
    const parsed = EstimateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const runId = await latestCompleteRunId(db);
    if (!runId) return { tokens: 0, credits: 0, players: 0, provider: null, note: 'first run is statistical only until a matrix exists' };
    try {
      const bundles = await buildNewsBundles(db, runId);
      const gw = await db('gameweeks').where('is_next', true).first();
      const estimate = await estimateRun(db, bundles, {
        gameweek: gw?.id ?? 1,
        deadlineIso: gw?.deadline_time ? new Date(gw.deadline_time).toISOString() : '',
        excludedUids: new Set(parsed.data.excluded),
      });
      return { ...estimate, balance: req.user.token_balance, affordable: req.user.role === 'admin' || estimate.credits <= req.user.token_balance };
    } catch (err) {
      if (err instanceof NoAliveProviderError) {
        return { tokens: 0, credits: 0, players: 0, provider: null, note: 'no AI provider alive — run will be statistical only' };
      }
      throw err;
    }
  });

  const StartSchema = z.object({
    excluded: z.array(z.string()).default([]),
    skipAi: z.boolean().default(false),
  });

  app.post('/api/runs', async (req, reply) => {
    requireAuth(req);
    const parsed = StartSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });

    // persist the manual exclusion list
    await db('ai_exclusions').where('user_id', req.user.id).del();
    if (parsed.data.excluded.length > 0) {
      await db('ai_exclusions')
        .insert(parsed.data.excluded.map((uid) => ({ user_id: req.user.id, player_uid: uid })))
        .onConflict(['user_id', 'player_uid'])
        .ignore();
    }

    const aiAlive = await db('ai_providers').where('alive', true).first('key');
    const useAi = !parsed.data.skipAi && !!aiAlive;

    // BudgetGuard: refuse before step 1 when the estimate exceeds the balance
    if (useAi && req.user.role !== 'admin') {
      const runId = await latestCompleteRunId(db);
      if (runId) {
        try {
          const bundles = await buildNewsBundles(db, runId);
          const gw = await db('gameweeks').where('is_next', true).first();
          const estimate = await estimateRun(db, bundles, {
            gameweek: gw?.id ?? 1,
            deadlineIso: gw?.deadline_time ? new Date(gw.deadline_time).toISOString() : '',
            excludedUids: new Set(parsed.data.excluded),
          });
          if (estimate.credits > req.user.token_balance) {
            return reply.code(402).send({
              error: `You're out of credits for this run (estimated ${estimate.credits}, balance ${req.user.token_balance}). Contact your admin to top up.`,
              estimate,
            });
          }
        } catch (err) {
          if (!(err instanceof NoAliveProviderError)) throw err;
        }
      }
    }

    try {
      const result = await startRun(db, {
        kind: 'full',
        triggeredBy: req.user.id,
        ai: useAi
          ? {
              invocation: { triggeredByUserId: req.user.id, triggerKind: 'run_button' },
              excludedUids: new Set(parsed.data.excluded),
            }
          : null,
      });
      return result;
    } catch (err) {
      if (err instanceof InsufficientTokensError) {
        return reply.code(402).send({ error: "You're out of credits. Contact your admin to top up." });
      }
      throw err;
    }
  });

  // SSE progress stream
  app.get('/api/runs/:id/stream', async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    const runId = Number(id);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (progress: RunProgress): void => {
      reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);
      if (progress.done) {
        cleanup();
        reply.raw.end();
      }
    };
    const cleanup = (): void => {
      runEvents.removeListener(`run:${runId}`, send);
      clearInterval(heartbeat);
    };
    runEvents.on(`run:${runId}`, send);
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 15_000);
    req.raw.on('close', cleanup);

    // if the run already finished, replay its terminal state immediately
    const run = await db('runs').where('id', runId).first();
    if (run && run.status !== 'running') {
      send({
        runId,
        stage: run.status,
        pct: 100,
        done: true,
        error: run.error ? String((run.error as { message?: string }).message ?? '') : undefined,
        report: run.status === 'complete' ? { stages: run.stages, tokens: { prompt: Number(run.tokens_prompt), completion: Number(run.tokens_completion), cached: Number(run.tokens_cached), credits: Number(run.credits) } } : undefined,
      });
    }
  });

  app.get('/api/runs/live', async (req) => {
    requireAuth(req);
    return { live: await getLiveRun(db) };
  });

  app.get('/api/runs', async (req) => {
    requireAuth(req);
    const runs = await db('runs as r')
      .leftJoin('users as u', 'u.id', 'r.triggered_by')
      .orderBy('r.id', 'desc')
      .limit(30)
      .select('r.id', 'r.kind', 'r.status', 'r.gameweek', 'u.name as triggered_by_name', 'r.ai_provider', 'r.tokens_prompt', 'r.tokens_completion', 'r.tokens_cached', 'r.credits', 'r.players_analysed', 'r.players_skipped', 'r.stages', 'r.degradations', 'r.started_at', 'r.finished_at');
    return { runs };
  });
}
