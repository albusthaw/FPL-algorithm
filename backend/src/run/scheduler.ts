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

/** C2 (v1.4.3): where are we in the matchday cycle? Decides pull cadence. */
export type MatchdayPhase = 'in_play' | 'ko_window' | 'deadline_24h' | 'quiet';

export async function matchdayPhase(db: Knex, now = new Date()): Promise<MatchdayPhase> {
  const t = now.getTime();
  // in-play: any fixture live, or kicked off within the last 2 h
  const live = await db('fixtures')
    .where((q) => q.where('state', 'live').orWhereBetween('kickoff_utc', [new Date(t - 2 * 3600_000), new Date(t)]))
    .first('fixture_uid');
  if (live) return 'in_play';
  // KO window: a kickoff inside the next 90 min (pressers → confirmed XIs)
  const soon = await db('fixtures').whereBetween('kickoff_utc', [new Date(t), new Date(t + 90 * 60_000)]).first('fixture_uid');
  if (soon) return 'ko_window';
  const next = await db('gameweeks').where('is_next', true).first('deadline_time');
  if (next) {
    const ms = new Date(next.deadline_time).getTime() - t;
    if (ms > 0 && ms < 24 * 3600_000) return 'deadline_24h';
  }
  return 'quiet';
}

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

  // C2 (v1.4.3): matchday-aware news cadence — one 15-min tick decides per
  // phase (⚙ news_scheduler) whether the RSS anchor and the NewsData poll
  // are due. Everything here is statistical ingestion + indexing; the AI
  // layer stays structurally unreachable.
  const lastPull = { rss: 0, newsdata: 0 };
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { getConfig } = await import('../core/model-config.js');
      const phases = await getConfig<{ rss_minutes: Record<string, number>; newsdata_minutes: Record<string, number> }>(db, 'news_scheduler').catch(
        () => ({ rss_minutes: { in_play: 15, ko_window: 15, deadline_24h: 30, quiet: 120 }, newsdata_minutes: { in_play: 60, ko_window: 90, deadline_24h: 120, quiet: 360 } }),
      );
      const phase = await matchdayPhase(db);
      const now = Date.now();
      let pulled = false;

      if (now - lastPull.rss >= (phases.rss_minutes[phase] ?? 120) * 60_000) {
        const { pullRssFeeds, DEFAULT_RSS_FEEDS } = await import('../ingest/adapters/rss.js');
        const rssCfg = (await getConfig<typeof DEFAULT_RSS_FEEDS>(db, 'rss_feeds').catch(() => null)) ?? DEFAULT_RSS_FEEDS;
        const r = await pullRssFeeds(db, rssCfg);
        lastPull.rss = now;
        pulled = true;
        if (r.inserted > 0) log.info({ phase, ...r }, 'scheduled rss pull');
      }

      if (now - lastPull.newsdata >= (phases.newsdata_minutes[phase] ?? 360) * 60_000) {
        const enabled = await db('api_providers').where({ key: 'newsdata', enabled: true }).first('key');
        if (enabled) {
          const { guardedPull } = await import('../ingest/gateway.js');
          const r = await guardedPull(db, 'newsdata', 'latest', 'poll', async () => {
            const { pullNews } = await import('../ingest/adapters/newsdata.js');
            const pullCfg = await getConfig<Record<string, number>>(db, 'news_pull').catch(() => null);
            return pullNews(db, { pull: pullCfg ?? undefined }); // rotating-club poll budget
          });
          if (r) pulled = true;
        }
        lastPull.newsdata = now; // even when disabled/refused — don't re-check every tick
      }

      if (pulled) {
        const { indexNews } = await import('../news/indexer.js');
        const r = await indexNews(db);
        if (r.scanned > 0) log.info({ phase, ...r }, 'scheduled news index');
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'news cadence tick failed');
    }
  });

  // C2 (v1.4.3): price-watch 02:15 UTC — FPL price changes land ~01:30–02:30;
  // a bootstrap sync here catches them before the 03:30 micro-run re-ranks
  cron.schedule('15 2 * * *', async () => {
    try {
      await syncFplBootstrap(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'price-watch bootstrap sync failed');
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

  // B3 (v1.4.4): live poll every 2 min while matches are in play — persists
  // live_event_stats + projected bonus and pushes the SSE data channel.
  // Statistical only; failures wait for the next tick.
  cron.schedule('*/2 * * * *', async () => {
    try {
      if ((await matchdayPhase(db)) !== 'in_play') return;
      const { pollLiveOnce } = await import('../match/live.js');
      await pollLiveOnce(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'live poll failed');
    }
  });

  // B2 (v1.4.4): KO-window job — confirmed team sheets land T−60→T−20.
  // Behind entitlements (free plans learn the denial once); a landed sheet
  // triggers ONE mini_lineup fast-path run (ai: null by construction).
  const lineupPulled = new Set<string>();
  cron.schedule('*/10 * * * *', async () => {
    try {
      if ((await matchdayPhase(db)) !== 'ko_window') return;
      const enabled = await db('api_providers').where({ key: 'api_football', enabled: true }).first('key');
      if (!enabled) return;
      const soon = (await db('fixtures')
        .whereBetween('kickoff_utc', [new Date(), new Date(Date.now() + 90 * 60_000)])
        .select('fixture_uid', 'stats')) as { fixture_uid: string; stats: { af_id?: number } | null }[];
      let confirmedAny = false;
      for (const fx of soon) {
        const afId = fx.stats?.af_id;
        if (!afId || lineupPulled.has(fx.fixture_uid)) continue;
        const { guardedPull } = await import('../ingest/gateway.js');
        const r = await guardedPull(db, 'api_football', 'lineups', fx.fixture_uid, async () => {
          const { pullLineups } = await import('../ingest/adapters/api-football.js');
          return pullLineups(db, fx.fixture_uid, afId);
        });
        if (r?.confirmed) {
          lineupPulled.add(fx.fixture_uid);
          confirmedAny = true;
        }
      }
      if (confirmedAny && !(await getLiveRun(db))) {
        await startRun(db, { kind: 'mini_lineup', triggeredBy: null, ai: null });
        log.info('confirmed team sheets landed — mini_lineup fast-path run started');
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'KO-window lineup job failed');
    }
  });

  // B2 (v1.4.4): daily fixture-id mapping for the KO-window jobs (paid scope
  // on the free plan — guardedPull learns the denial once, never hammers)
  cron.schedule('30 5 * * *', async () => {
    try {
      const enabled = await db('api_providers').where({ key: 'api_football', enabled: true }).first('key');
      if (!enabled) return;
      const { guardedPull } = await import('../ingest/gateway.js');
      const season = new Date().getUTCMonth() >= 7 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
      await guardedPull(db, 'api_football', 'fixtures-map', `map-${season}`, async () => {
        const { mapApiFootballFixtures } = await import('../ingest/adapters/api-football.js');
        return mapApiFootballFixtures(db, season);
      });
      // A1 (v1.4.5): odds snapshots for the next event's mapped fixtures —
      // one request per fixture, entitlement-gated (paid scope on free)
      const nextGw = await db('gameweeks').where('is_next', true).first('id');
      if (nextGw) {
        const fxs = (await db('fixtures')
          .where('event', Number(nextGw.id))
          .whereNotNull('fpl_fixture_id')
          .select('fixture_uid', 'stats')) as { fixture_uid: string; stats: { af_id?: number } | null }[];
        const { pullOdds } = await import('../ingest/adapters/api-football.js');
        for (const fx of fxs) {
          if (!fx.stats?.af_id) continue;
          const r = await guardedPull(db, 'api_football', 'odds', fx.fixture_uid, () => pullOdds(db, fx.fixture_uid, fx.stats!.af_id!));
          if (r === null) break; // refused/learned — stop the sweep
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'fixture-id mapping failed');
    }
  });

  // A2 (v1.4.4): price intelligence — predictions at 22:30 UTC for tonight's
  // change window, calibration against actual price_events after the 02:15
  // bootstrap sync has recorded them
  cron.schedule('30 22 * * *', async () => {
    try {
      const { predictPriceMoves } = await import('../stats/prices.js');
      await predictPriceMoves(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'price prediction pass failed');
    }
  });
  cron.schedule('45 2 * * *', async () => {
    try {
      const { calibratePriceModel } = await import('../stats/prices.js');
      await calibratePriceModel(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'price calibration failed');
    }
  });

  // A3 (v1.4.4): availability reconciliation after each bootstrap sync window
  cron.schedule('20 */6 * * *', async () => {
    try {
      const { writeAvailabilityState } = await import('../stats/availability.js');
      await writeAvailabilityState(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'availability reconciliation failed');
    }
  });

  // C5 (v1.4.3): daily player-photo cache pass (DATA_DIR/media, served
  // same-origin — the SPA's CSP blocks external image hosts by design)
  cron.schedule('0 5 * * *', async () => {
    try {
      const { cachePlayerPhotos } = await import('../ingest/media.js');
      await cachePlayerPhotos(db);
    } catch (err) {
      log.warn({ err: String(err) }, 'photo cache pass failed');
    }
    // B4 (v1.4.5): TSDB context — venue/thumb per next-event fixture +
    // all-competitions team calendars (external congestion, S8/M6)
    try {
      const enabled = await db('api_providers').where({ key: 'thesportsdb', enabled: true }).first('key');
      if (enabled) {
        const { guardedPull } = await import('../ingest/gateway.js');
        const { pullTheSportsDbFixtureMeta, pullTheSportsDbTeamCalendars } = await import('../ingest/adapters/misc-providers.js');
        await guardedPull(db, 'thesportsdb', 'eventsround', 'daily', () => pullTheSportsDbFixtureMeta(db));
        await guardedPull(db, 'thesportsdb', 'eventsnext', 'daily', () => pullTheSportsDbTeamCalendars(db));
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'TSDB context pass failed');
    }
  });

  log.info('scheduler started (statistical only — no AI access by construction)');
}
