/**
 * Run Orchestrator (fpl-project.md §7.4, fpl-engines-plan.md Part 6).
 * One run at a time system-wide (pg advisory lock); SSE progress streaming;
 * every stage timed + logged; a failed run stays invisible (the previous
 * completed run stays live). The AI pass happens ONLY here, only with a
 * human AIInvocation. Fast paths and scheduled runs call runPipeline with
 * ai=null — they cannot reach the AI gateway.
 */
import { EventEmitter } from 'node:events';
import type { Knex } from 'knex';
import { runStatsEngine, rerankMatrix } from '../stats/engine.js';
import { runMatchEngine } from '../match/engine.js';
import { syncFplBootstrap, syncFplFixtures } from '../ingest/adapters/fpl.js';
import { routeCapability, guardedPull } from '../ingest/gateway.js';
import { log } from '../core/logger.js';
import type { AIInvocation } from '../ai/types.js';

export const runEvents = new EventEmitter();
runEvents.setMaxListeners(200);

export interface RunProgress {
  runId: number;
  stage: string;
  detail?: string;
  pct: number;
  done?: boolean;
  error?: string;
  report?: Record<string, unknown>;
}

function emit(progress: RunProgress): void {
  runEvents.emit('progress', progress);
  runEvents.emit(`run:${progress.runId}`, progress);
}

const RUN_LOCK_KEY = 774411;

export async function getLiveRun(db: Knex): Promise<{ id: number } | null> {
  const row = await db('runs').where('status', 'running').orderBy('id', 'desc').first('id');
  return row ? { id: row.id } : null;
}

export interface RunOptions {
  kind: 'full' | 'mini_lineup' | 'micro_nightly';
  triggeredBy?: number | null;
  /**
   * AI pass context. null ⇒ the AI layer is NEVER touched (scheduled and
   * fast-path runs). Only routes construct a non-null value, from a session.
   */
  ai: {
    invocation: AIInvocation;
    excludedUids: Set<string>;
  } | null;
}

export async function startRun(db: Knex, opts: RunOptions): Promise<{ runId: number; attached: boolean }> {
  // one run at a time: advisory lock; a second click attaches to the live run
  const lock = await db.raw('SELECT pg_try_advisory_lock(?) AS ok', [RUN_LOCK_KEY]);
  if (!lock.rows[0].ok) {
    const live = await getLiveRun(db);
    if (live) return { runId: live.id, attached: true };
    await db.raw('SELECT pg_advisory_unlock_all()');
    const retry = await db.raw('SELECT pg_try_advisory_lock(?) AS ok', [RUN_LOCK_KEY]);
    if (!retry.rows[0].ok) throw new Error('another run is starting — retry in a moment');
  }

  const [row] = await db('runs')
    .insert({
      kind: opts.kind,
      status: 'running',
      triggered_by: opts.triggeredBy ?? null,
      ai_skipped: opts.ai == null,
    })
    .returning('id');
  const runId = Number(row.id ?? row);

  // run the pipeline in the background; progress flows via SSE
  void runPipeline(db, runId, opts)
    .catch(async (err) => {
      log.error({ runId, err: err instanceof Error ? err.stack : String(err) }, 'run failed');
      await db('runs')
        .where('id', runId)
        .update({ status: 'failed', error: JSON.stringify({ message: String(err) }), finished_at: db.fn.now() });
      emit({ runId, stage: 'failed', pct: 100, done: true, error: String(err) });
    })
    .finally(async () => {
      await db.raw('SELECT pg_advisory_unlock(?)', [RUN_LOCK_KEY]);
    });

  return { runId, attached: false };
}

async function runPipeline(db: Knex, runId: number, opts: RunOptions): Promise<void> {
  const stages: Record<string, number> = {};
  const degradations: string[] = [];
  const timed = async <T>(name: string, pct: number, fn: () => Promise<T>): Promise<T> => {
    emit({ runId, stage: name, pct });
    const started = Date.now();
    const result = await fn();
    stages[name] = Date.now() - started;
    return result;
  };
  const asOf = new Date();

  // 1. NEWS PULL — ≤2 enabled providers via capability routing (skippable)
  await timed('news_pull', 5, async () => {
    // C1 (v1.4.3): the keyless RSS anchor pulls on every run — zero credits,
    // conditional GETs make repeats near-free; failures never block the run
    try {
      const { pullRssFeeds, DEFAULT_RSS_FEEDS } = await import('../ingest/adapters/rss.js');
      const { getConfig } = await import('../core/model-config.js');
      const rssCfg = (await getConfig<typeof DEFAULT_RSS_FEEDS>(db, 'rss_feeds').catch(() => null)) ?? DEFAULT_RSS_FEEDS;
      const rss = await pullRssFeeds(db, rssCfg);
      if (rss.inserted > 0) log.info({ ...rss }, 'rss pull');
    } catch (err) {
      degradations.push(`rss pull degraded (${String(err).slice(0, 100)})`);
    }
    const newsProvider = await routeCapability(db, 'news');
    if (newsProvider) {
      const result = await guardedPull(db, newsProvider.key, 'latest', 'run', async () => {
        const { pullNews } = await import('../ingest/adapters/newsdata.js');
        const { getConfig } = await import('../core/model-config.js');
        const pullCfg = await getConfig<Record<string, number>>(db, 'news_pull').catch(() => null);
        // a human-triggered Run sweeps every club with the run credit budget
        return pullNews(db, { sweep: true, pull: pullCfg ?? undefined });
      });
      if (!result) degradations.push('news pull degraded — continuing with existing news');
    } else {
      degradations.push('no news provider enabled — AI pass will see existing news only');
    }
    const injuryProvider = await routeCapability(db, 'injuries');
    if (injuryProvider?.key === 'api_football') {
      const season = new Date().getUTCFullYear();
      const result = await guardedPull(db, 'api_football', 'injuries', String(season), async () => {
        const { pullInjuries } = await import('../ingest/adapters/api-football.js');
        return pullInjuries(db, season);
      });
      if (!result) degradations.push('injury pull degraded — using FPL flags only');
    }
  });

  // 1b. NEWS INDEX — systematic entity linking + signal classification +
  // story clustering over everything pulled (statistical, no AI)
  await timed('news_index', 8, async () => {
    try {
      const { indexNews } = await import('../news/indexer.js');
      const r = await indexNews(db);
      if (r.scanned > 0) {
        log.info({ ...r }, 'news index pass');
      }
    } catch (err) {
      degradations.push(`news index failed (${String(err).slice(0, 120)}) — AI pass sees pull-time links only`);
    }
  });

  // 2. INGEST — refresh the FPL anchor (never fatal if the last sync is fresh)
  await timed('ingest', 15, async () => {
    try {
      await syncFplBootstrap(db);
      await syncFplFixtures(db);
    } catch (err) {
      degradations.push(`FPL sync degraded (${String(err).slice(0, 120)}) — using last snapshot`);
    }
    // historical depth (v1.4.0): bring the DB up to the configured ⚙
    // history_depth — the previous-season floor on a fresh install (the old
    // behaviour), deeper vaastav seasons and the FPL career-aggregate sweep
    // when an admin raised the depth. Resumable via the history_pulls ledger;
    // statistical data only — no AI involved.
    try {
      const { getConfig } = await import('../core/model-config.js');
      const { ensureHistoryDepth, DEFAULT_HISTORY_DEPTH } = await import('../ingest/backfill.js');
      const { DEFAULT_PROVIDER_PLANS } = await import('../ingest/plans.js');
      const depthCfg = await getConfig<typeof DEFAULT_HISTORY_DEPTH>(db, 'history_depth').catch(() => DEFAULT_HISTORY_DEPTH);
      const plans = (await getConfig<typeof DEFAULT_PROVIDER_PLANS>(db, 'provider_plans').catch(() => null)) ?? DEFAULT_PROVIDER_PLANS;
      const notes = await ensureHistoryDepth(db, depthCfg ?? DEFAULT_HISTORY_DEPTH, {
        plans,
        onProgress: (msg) => emit({ runId, stage: 'ingest', detail: msg, pct: 15 }),
      });
      degradations.push(...notes.filter((n) => n.includes('failed')));
    } catch (err) {
      degradations.push(`history import unavailable (${String(err).slice(0, 120)}) — predictions use season-start estimates`);
    }
  });

  // 3. STATS — the statistical engine recomputes the full matrix
  const statsResult = await timed('stats', 35, () => runStatsEngine(db, runId, asOf));

  // 4. MATCH — match engine insights (matrix still publishes if this fails)
  await timed('match', 55, async () => {
    try {
      return await runMatchEngine(db, runId);
    } catch (err) {
      degradations.push(`match engine failed (${String(err).slice(0, 120)}) — insights unavailable this run`);
      return null;
    }
  });

  // 5. AI PASS — human-gated; statistical outputs never blocked by AI
  let aiReport: Record<string, unknown> = { skipped: true };
  if (opts.ai) {
    aiReport = await timed('ai_pass', 75, async () => {
      try {
        const { analysePlayers } = await import('../ai/gateway.js');
        const { buildNewsBundles } = await import('../ai/bundles.js');
        const bundles = await buildNewsBundles(db, runId);
        const gw = await db('gameweeks').where('is_next', true).orderBy('id').first();
        const outcome = await analysePlayers(db, { ...opts.ai!.invocation, runId }, bundles, {
          gameweek: gw?.id ?? statsResult.eventsCovered[0] ?? 1,
          deadlineIso: gw?.deadline_time ? new Date(gw.deadline_time).toISOString() : '',
          excludedUids: opts.ai!.excludedUids,
        });
        // write fresh verdicts into this run's matrix
        for (const v of outcome.verdicts) {
          await db('player_matrix')
            .where({ run_id: runId, player_uid: v.player_uid })
            .update({ ai_adjustment: v.adjustment, ai_rationale: v.rationale, ai_stale: false });
        }
        await db('runs').where('id', runId).update({
          ai_provider: (await db('ai_providers').where('alive', true).first('key'))?.key ?? null,
          tokens_prompt: outcome.usage.promptTokens,
          tokens_completion: outcome.usage.completionTokens,
          tokens_cached: outcome.usage.cachedTokens,
          credits: outcome.usage.credits,
          players_analysed: outcome.analysed,
          players_skipped: outcome.skippedExcluded + outcome.skippedNoNews,
        });
        return {
          analysed: outcome.analysed,
          skipped_excluded: outcome.skippedExcluded,
          skipped_no_news: outcome.skippedNoNews,
          cache_hits: outcome.cacheHits,
          batches: outcome.batches,
          failed_batches: outcome.failedBatches,
          tokens: outcome.usage,
          warnings: outcome.warnings.slice(0, 20),
        };
      } catch (err) {
        degradations.push(`AI pass failed (${String(err).slice(0, 150)}) — adjustments carried forward, flagged stale`);
        return { skipped: false, failed: true, error: String(err).slice(0, 300) };
      }
    });
  }

  // carry forward last analysed adjustments for stale players
  await timed('carry_forward', 85, async () => {
    await db.raw(
      `WITH prev AS (
         SELECT DISTINCT ON (p2.player_uid) p2.player_uid, p2.ai_adjustment, p2.ai_rationale
         FROM player_matrix p2 JOIN runs r2 ON r2.id = p2.run_id
         WHERE p2.run_id < ? AND r2.status = 'complete' AND p2.ai_stale = false
         ORDER BY p2.player_uid, p2.run_id DESC
       )
       UPDATE player_matrix pm
       SET ai_adjustment = prev.ai_adjustment, ai_rationale = prev.ai_rationale, ai_stale = true
       FROM prev
       WHERE pm.run_id = ? AND pm.player_uid = prev.player_uid AND pm.ai_stale = true`,
      [runId, runId],
    );
  });

  // 6. RE-RANK — overall_score + dense ranks
  await timed('rerank', 92, () => rerankMatrix(db, runId));

  // 7. REPORT
  const runRow = await db('runs').where('id', runId).first();
  const report = {
    runId,
    kind: opts.kind,
    players: statsResult.playersScored,
    fixtures: statsResult.fixturesPredicted,
    events: statsResult.eventsCovered,
    ai: aiReport,
    tokens: {
      prompt: Number(runRow.tokens_prompt),
      completion: Number(runRow.tokens_completion),
      cached: Number(runRow.tokens_cached),
      credits: Number(runRow.credits),
    },
    degradations,
    stages,
  };
  await db('runs').where('id', runId).update({
    status: 'complete',
    stages: JSON.stringify(stages),
    degradations: JSON.stringify(degradations),
    finished_at: db.fn.now(),
  });
  emit({ runId, stage: 'complete', pct: 100, done: true, report });
  log.info({ runId, stages }, 'run complete');
}
