/**
 * Scheduler — STATISTICAL ONLY (fpl-project.md §7.0, engines plan §6.5).
 *
 * ARCHITECTURAL INVARIANT: this module (and anything it imports) MUST NOT
 * import the AI gateway. Scheduled work runs the pipeline with ai=null, so
 * scheduled code structurally cannot invoke AI. An architectural test walks
 * this file's import graph and fails the build if '../ai/' ever appears.
 */
import cron from 'node-cron';
import type { Knex } from 'knex';
import { syncFplBootstrap, syncFplFixtures } from '../ingest/adapters/fpl.js';
import { startRun, getLiveRun } from './orchestrator.js';
import { log } from '../core/logger.js';

export function startScheduler(db: Knex): void {
  // bootstrap poll: every 6 h baseline (deadline-window tightening handled
  // by the hourly check below)
  cron.schedule('15 */6 * * *', async () => {
    try {
      await syncFplBootstrap(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'scheduled bootstrap poll failed');
    }
  });

  // fixtures: daily 06:00 UTC
  cron.schedule('0 6 * * *', async () => {
    try {
      await syncFplFixtures(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'scheduled fixtures poll failed');
    }
  });

  // deadline window: every 30 min within 24 h of the next deadline
  cron.schedule('*/30 * * * *', async () => {
    try {
      const next = await db('gameweeks').where('is_next', true).first('deadline_time');
      if (!next) return;
      const msToDeadline = new Date(next.deadline_time).getTime() - Date.now();
      if (msToDeadline > 0 && msToDeadline < 24 * 3600_000) {
        await syncFplBootstrap(db);
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'deadline-window poll failed');
    }
  });

  // nightly micro-run 03:30 UTC (after price changes): stats-only re-rank.
  // ai: null — the AI layer is structurally unreachable from here.
  cron.schedule('30 3 * * *', async () => {
    try {
      if (await getLiveRun(db)) return; // never stack runs
      await startRun(db, { kind: 'micro_nightly', triggeredBy: null, ai: null });
    } catch (err) {
      log.warn({ err: String(err) }, 'nightly micro-run failed to start');
    }
  });

  log.info('scheduler started (statistical only — no AI access by construction)');
}
