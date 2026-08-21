/**
 * Historical-depth backfill (v1.4.0). Answers two demands:
 *  - the launch Run reports how far back each provider CAN reach, and
 *  - configured depth (⚙ history_depth, default: last 7 days — i.e. live
 *    pulls only) is actually pulled, up to 20 years where a source allows.
 *
 * Depth truth table (researched + live-probed 2026-08):
 *   fpl (official)   — per-GW: current season; history_past: every season of
 *                      a player's FPL career (veterans reach ~20 years). Free.
 *   vaastav dataset  — per-GW match rows 2016-17 → current (10 seasons). Free.
 *   understat        — league xG data 2014 → current (12 seasons). Free,
 *                      names need manual resolution — surfaced, not auto-pulled.
 *   football_data    — free tier: current season only. Paid: multi-season.
 *   api_football     — free plan: 3 recent seasons (entitlements learned from
 *                      denials). Paid: 15+ years.
 *   newsdata         — latest 48 h on free; archive 6 mo / 2 y / 5 y on paid.
 *   sportmonks       — plan-scoped leagues + seasons.
 *   thesportsdb      — media/badges; full event history is paid.
 *
 * All work here is statistical ingestion — no AI. Backfills are resumable:
 * every (provider, scope) is ledgered in history_pulls.
 */
import type { Knex } from 'knex';
import { log } from '../core/logger.js';
import { importHistoricalSeason } from './historical.js';
import type { FetchFn } from './http.js';

export interface HistoryDepthConfig {
  mode: 'days' | 'seasons';
  days: number; // mode=days: live pulls only (news/injury windows)
  seasons: number; // mode=seasons: per-GW seasons to import from vaastav
  career_aggregates: boolean; // FPL history_past sweep (up to ~20y)
  max_seasons: number; // hard cap on vaastav depth (dataset starts 2016-17)
}

export const DEFAULT_HISTORY_DEPTH: HistoryDepthConfig = {
  mode: 'days',
  days: 7,
  seasons: 1,
  career_aggregates: false,
  max_seasons: 10,
};

export interface ProviderCoverage {
  provider: string;
  granularity: string;
  allowed: string; // how far back the source can reach (plan-aware text)
  configured: string; // what the current ⚙ config will pull
  imported: string; // what is actually in the database
}

const VAASTAV_FIRST_SEASON = 2016; // dataset starts 2016-17

/** "2025-26"-style label for the season starting `startYear`. */
export function seasonDirLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Current season's start year (football seasons start in August). */
export function currentSeasonStartYear(now = new Date()): number {
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/** vaastav season dirs the configured depth wants, newest first, excluding
 * the current season (live FPL sync owns it). */
export function targetVaastavSeasons(cfg: HistoryDepthConfig, now = new Date()): string[] {
  if (cfg.mode !== 'seasons') return [seasonDirLabel(currentSeasonStartYear(now) - 1)]; // days-mode floor: last season
  const n = Math.min(Math.max(1, cfg.seasons), cfg.max_seasons);
  const cur = currentSeasonStartYear(now);
  const out: string[] = [];
  for (let y = cur - 1; y >= Math.max(VAASTAV_FIRST_SEASON, cur - n); y--) out.push(seasonDirLabel(y));
  return out;
}

/** Per-provider coverage rows for the launch-run display and the admin tab. */
export async function historyCoverage(db: Knex, cfg: HistoryDepthConfig): Promise<ProviderCoverage[]> {
  const seasonsInDb = (await db('player_match_stats').distinct('season').orderBy('season')) as { season: string }[];
  const seasonList = seasonsInDb.map((s) => s.season).join(', ') || 'none';
  const careerRows = (await db('player_season_history').where('source', 'fpl_history_past').count('* as c')) as { c: string }[];
  const careerCount = Number(careerRows[0]?.c ?? 0);
  const careerSpan = careerCount
    ? ((await db('player_season_history').where('source', 'fpl_history_past').min('season as lo').max('season as hi')) as {
        lo: string;
        hi: string;
      }[])[0]
    : null;

  const configuredSeasons =
    cfg.mode === 'seasons' ? `last ${Math.min(cfg.seasons, cfg.max_seasons)} season(s) per-GW` : `last ${cfg.days} days (live pulls) + previous season floor`;

  return [
    {
      provider: 'fpl',
      granularity: 'per-GW (current) + per-season career aggregates',
      allowed: 'career aggregates back to each player’s FPL debut — up to ~20 years for veterans (free)',
      configured: cfg.career_aggregates ? configuredSeasons + ' + career aggregates sweep' : configuredSeasons,
      imported: careerCount ? `${careerCount} season rows (${careerSpan?.lo ?? '?'} → ${careerSpan?.hi ?? '?'})` : 'no career aggregates yet',
    },
    {
      provider: 'vaastav',
      granularity: 'per-GW match rows',
      allowed: `seasons ${seasonDirLabel(VAASTAV_FIRST_SEASON)} → previous (10 seasons, free dataset)`,
      configured: configuredSeasons,
      imported: seasonList,
    },
    {
      provider: 'understat',
      granularity: 'per-season xG (league pages)',
      allowed: 'seasons 2014 → current (12 years, free; names need review-queue resolution)',
      configured: 'current season live pulls only',
      imported: 'current-season pulls only',
    },
    {
      provider: 'football_data',
      granularity: 'fixtures/results',
      allowed: 'free tier: current season only; multi-season on paid tiers',
      configured: 'current season',
      imported: 'current season',
    },
    {
      provider: 'api_football',
      granularity: 'injuries/fixtures',
      allowed: 'free plan: 3 recent seasons (learned from live denials); paid: 15+ years',
      configured: 'current-season injuries when entitled',
      imported: 'entitlement-gated',
    },
    {
      provider: 'newsdata',
      granularity: 'news articles',
      allowed: 'free: latest 48 h only; paid archive: 6 months / 2 years / 5 years by plan',
      configured: `rolling ${cfg.days}-day news window`,
      imported: 'rolling window',
    },
  ];
}

async function ledger(db: Knex, provider: string, scope: string): Promise<'pending' | 'running' | 'complete' | 'failed'> {
  const row = await db('history_pulls').where({ provider, scope }).first('status');
  return (row?.status as 'complete') ?? 'pending';
}

async function markLedger(
  db: Knex,
  provider: string,
  scope: string,
  patch: { status: string; records?: number; detail?: string },
): Promise<void> {
  await db('history_pulls')
    .insert({
      provider,
      scope,
      status: patch.status,
      records: patch.records ?? 0,
      detail: patch.detail ?? null,
      started_at: db.fn.now(),
      finished_at: patch.status === 'complete' || patch.status === 'failed' ? db.fn.now() : null,
    })
    .onConflict(['provider', 'scope'])
    .merge(['status', 'records', 'detail', 'finished_at']);
}

const FPL_BASE = 'https://fantasy.premierleague.com/api';

/**
 * FPL element-summary sweep: one request per active player, upserting every
 * history_past season row. ~600 requests, throttled; resumable — players
 * already holding rows are skipped unless force.
 */
export async function backfillCareerAggregates(
  db: Knex,
  opts: { fetchFn?: FetchFn; throttleMs?: number; force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ players: number; seasonRows: number; skipped: number; failures: number }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const throttleMs = opts.throttleMs ?? 120;
  const players = (await db('players').whereNotNull('fpl_id').select('uid', 'fpl_id')) as { uid: string; fpl_id: number }[];
  const already = new Set(
    opts.force
      ? []
      : (
          (await db('player_season_history').where('source', 'fpl_history_past').distinct('player_uid')) as { player_uid: string }[]
        ).map((r) => r.player_uid),
  );
  let done = 0;
  let seasonRows = 0;
  let failures = 0;
  let skipped = 0;
  for (const p of players) {
    done++;
    if (already.has(p.uid)) {
      skipped++;
      continue;
    }
    try {
      const res = await fetchFn(`${FPL_BASE}/element-summary/${p.fpl_id}/`, { headers: { 'user-agent': 'fpl-algorithm/1.4' } });
      if (!res.ok) {
        failures++;
        continue;
      }
      const body = (await res.json()) as { history_past?: Record<string, unknown>[] };
      const past = body.history_past ?? [];
      if (past.length === 0) continue;
      const rows = past
        .filter((s) => s.season_name)
        .map((s) => ({
          player_uid: p.uid,
          season: String(s.season_name),
          source: 'fpl_history_past',
          stats: JSON.stringify({
            minutes: Number(s.minutes ?? 0),
            total_points: Number(s.total_points ?? 0),
            goals: Number(s.goals_scored ?? 0),
            assists: Number(s.assists ?? 0),
            clean_sheets: Number(s.clean_sheets ?? 0),
            saves: Number(s.saves ?? 0),
            yellow_cards: Number(s.yellow_cards ?? 0),
            red_cards: Number(s.red_cards ?? 0),
            bonus: Number(s.bonus ?? 0),
            xg: s.expected_goals != null && s.expected_goals !== '' ? Number(s.expected_goals) : null,
            xa: s.expected_assists != null && s.expected_assists !== '' ? Number(s.expected_assists) : null,
            start_cost: s.start_cost != null ? Number(s.start_cost) : null,
            end_cost: s.end_cost != null ? Number(s.end_cost) : null,
          }),
          as_of: new Date(),
        }));
      for (let i = 0; i < rows.length; i += 200) {
        await db('player_season_history')
          .insert(rows.slice(i, i + 200))
          .onConflict(['player_uid', 'season'])
          .merge(['stats', 'source', 'as_of']);
      }
      seasonRows += rows.length;
    } catch {
      failures++;
    }
    opts.onProgress?.(done, players.length);
    if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
  }
  return { players: players.length - skipped, seasonRows, skipped, failures };
}

/**
 * Bring the database up to the configured depth. Idempotent + resumable:
 * completed scopes are skipped via the history_pulls ledger. Returns
 * human-readable lines for the run report.
 */
export async function ensureHistoryDepth(
  db: Knex,
  cfg: HistoryDepthConfig,
  opts: { fetchFn?: FetchFn; onProgress?: (msg: string) => void } = {},
): Promise<string[]> {
  const notes: string[] = [];
  const say = (m: string): void => {
    notes.push(m);
    opts.onProgress?.(m);
  };

  // 1. vaastav per-GW seasons
  for (const seasonDir of targetVaastavSeasons(cfg)) {
    const status = await ledger(db, 'vaastav', seasonDir);
    if (status === 'complete') continue;
    // days-mode floor only fires on an empty history (fresh install)
    if (cfg.mode === 'days') {
      const c = (await db('player_match_stats').count('* as c')) as { c: string }[];
      if (Number(c[0]?.c ?? 0) > 0) break;
    }
    await markLedger(db, 'vaastav', seasonDir, { status: 'running' });
    try {
      say(`importing season ${seasonDir} (vaastav per-GW rows)…`);
      const r = await importHistoricalSeason(db, seasonDir, opts.fetchFn ?? fetch);
      await markLedger(db, 'vaastav', seasonDir, {
        status: 'complete',
        records: r.playerRows,
        detail: `${r.fixtures} fixtures, ${r.unmappedPlayers} unmapped players`,
      });
      say(`season ${seasonDir}: ${r.playerRows} match rows imported`);
    } catch (err) {
      await markLedger(db, 'vaastav', seasonDir, { status: 'failed', detail: String(err).slice(0, 300) });
      say(`season ${seasonDir} import failed (${String(err).slice(0, 100)}) — will retry next run`);
      break; // older seasons will fail the same way (network) — stop here
    }
  }

  // 2. FPL career aggregates (up to ~20 years for veterans)
  if (cfg.career_aggregates) {
    const status = await ledger(db, 'fpl', 'history_past');
    if (status !== 'complete') {
      await markLedger(db, 'fpl', 'history_past', { status: 'running' });
      try {
        say('sweeping FPL element-summary for career season aggregates…');
        const r = await backfillCareerAggregates(db, { fetchFn: opts.fetchFn });
        await markLedger(db, 'fpl', 'history_past', {
          status: 'complete',
          records: r.seasonRows,
          detail: `${r.players} players swept, ${r.skipped} already present, ${r.failures} failures`,
        });
        say(`career aggregates: ${r.seasonRows} season rows across ${r.players} players`);
      } catch (err) {
        await markLedger(db, 'fpl', 'history_past', { status: 'failed', detail: String(err).slice(0, 300) });
        say(`career-aggregate sweep failed (${String(err).slice(0, 100)}) — will retry next run`);
      }
    }
  }

  if (notes.length > 0) log.info({ notes }, 'history backfill pass');
  return notes;
}
