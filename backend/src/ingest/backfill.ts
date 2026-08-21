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
import { guardedPull } from './gateway.js';
import { DEFAULT_PROVIDER_PLANS, tierFor, type ProviderPlansConfig } from './plans.js';
import type { FetchFn } from './http.js';

/** P1 (v1.4.2): one Run-screen depth selection for one source. */
export interface ProviderDepthSelection {
  unit: 'days' | 'months' | 'seasons' | 'career';
  value: number;
}

export interface HistoryDepthConfig {
  mode: 'days' | 'seasons';
  days: number; // mode=days: live pulls only (news/injury windows)
  seasons: number; // mode=seasons: per-GW seasons to import from vaastav
  career_aggregates: boolean; // FPL history_past sweep (up to ~20y)
  max_seasons: number; // hard cap on vaastav depth (dataset starts 2016-17)
  // P1 (v1.4.2): per-source selections from the Run screen's selector column
  per_provider?: Record<string, ProviderDepthSelection>;
}

export const DEFAULT_HISTORY_DEPTH: HistoryDepthConfig = {
  mode: 'days',
  days: 7,
  seasons: 1,
  career_aggregates: false,
  max_seasons: 10,
  per_provider: {},
};

/** vaastav/fpl selections fold into the legacy fields so every older reader
 *  (targetVaastavSeasons, coverage text) keeps working unchanged. */
export function effectiveDepth(cfg: HistoryDepthConfig): HistoryDepthConfig {
  const pp = cfg.per_provider ?? {};
  const eff: HistoryDepthConfig = { ...cfg, per_provider: pp };
  if (pp.vaastav?.unit === 'seasons' && pp.vaastav.value > 0) {
    eff.mode = 'seasons';
    eff.seasons = pp.vaastav.value;
  }
  if (pp.fpl?.unit === 'career') eff.career_aggregates = pp.fpl.value > 0;
  return eff;
}

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
export async function historyCoverage(db: Knex, rawCfg: HistoryDepthConfig): Promise<ProviderCoverage[]> {
  const cfg = effectiveDepth(rawCfg);
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

// ─────────────────── P1 (v1.4.2): Run-screen depth selector options ──
// options per provider = the selected plan's reach ∩ learned entitlements.
// Refused options stay VISIBLE with the reason, so "why can't I select
// 5 years on NewsData free" is answered inline.

export interface DepthOption {
  unit: 'days' | 'months' | 'seasons' | 'career';
  value: number;
  label: string;
  allowed: boolean;
  reason?: string;
}

export interface ProviderDepthSelector {
  provider: string;
  plan: string;
  planLabel: string;
  options: DepthOption[];
  selected: ProviderDepthSelection | null;
}

export async function depthSelectorOptions(
  db: Knex,
  cfg: HistoryDepthConfig,
  plans?: ProviderPlansConfig,
): Promise<ProviderDepthSelector[]> {
  const planCfg = plans ?? DEFAULT_PROVIDER_PLANS;
  const pp = cfg.per_provider ?? {};
  const cur = currentSeasonStartYear();
  const denied = (await db('provider_entitlements')
    .where('allowed', false)
    .select('provider', 'endpoint', 'params_key')) as { provider: string; endpoint: string; params_key: string }[];
  const isDenied = (provider: string, endpoint: string, key: string): boolean =>
    denied.some((d) => d.provider === provider && d.endpoint === endpoint && d.params_key === key);

  const planOf = (provider: string): { id: string; label: string; depth: { days?: number; months?: number; seasons?: number; career?: boolean } } => {
    const sel = planCfg[provider] ?? { plan: 'free', depth: {}, rate: {} };
    const tier = tierFor(provider, sel.plan);
    return { id: sel.plan, label: tier?.label ?? sel.plan, depth: sel.depth ?? tier?.depth ?? {} };
  };

  const rows: ProviderDepthSelector[] = [];

  // fpl — career aggregates on/off (always free)
  {
    const p = planOf('fpl');
    rows.push({
      provider: 'fpl',
      plan: p.id,
      planLabel: p.label,
      options: [
        { unit: 'career', value: 0, label: 'current season only', allowed: true },
        { unit: 'career', value: 1, label: 'career aggregates (~20y)', allowed: true },
      ],
      selected: pp.fpl ?? { unit: 'career', value: cfg.career_aggregates ? 1 : 0 },
    });
  }

  // vaastav — per-GW seasons 1..10 (free dataset)
  {
    const p = planOf('vaastav');
    rows.push({
      provider: 'vaastav',
      plan: p.id,
      planLabel: p.label,
      options: [1, 2, 3, 5, 10].map((n) => ({
        unit: 'seasons' as const,
        value: n,
        label: `last ${n} season${n > 1 ? 's' : ''} per-GW`,
        allowed: n <= cfg.max_seasons,
        reason: n <= cfg.max_seasons ? undefined : `capped at ${cfg.max_seasons} (dataset starts 2016-17)`,
      })),
      selected: pp.vaastav ?? { unit: 'seasons', value: cfg.mode === 'seasons' ? cfg.seasons : 1 },
    });
  }

  // football_data — past seasons are a paid scope (and entitlement-learned)
  {
    const p = planOf('football_data');
    const maxSeasons = p.depth.seasons ?? 1;
    const firstPastDenied = isDenied('football_data', 'pl-matches-season', `season-${cur - 1}`);
    rows.push({
      provider: 'football_data',
      plan: p.id,
      planLabel: p.label,
      options: [1, 2, 3, 5].map((n) => {
        const planOk = n <= maxSeasons;
        const entOk = n === 1 || !firstPastDenied;
        return {
          unit: 'seasons' as const,
          value: n,
          label: n === 1 ? 'current season' : `last ${n} seasons`,
          allowed: planOk && entOk,
          reason: !planOk
            ? `${p.label}: current season only — Standard unlocks past seasons`
            : !entOk
              ? 'past seasons refused by the API (learned)'
              : undefined,
        };
      }),
      selected: pp.football_data ?? { unit: 'seasons', value: 1 },
    });
  }

  // api_football — free plan is a FIXED 2022–2024 window, paid is relative
  {
    const p = planOf('api_football');
    const free = p.id === 'free';
    const reachable = (n: number): boolean => {
      for (let y = cur - 1; y >= cur - (n - 1); y--) {
        if (free ? y >= 2022 && y <= 2024 : y >= cur - ((p.depth.seasons ?? 3) - 1)) return true;
      }
      return false;
    };
    rows.push({
      provider: 'api_football',
      plan: p.id,
      planLabel: p.label,
      options: [1, 2, 3, 5].map((n) => ({
        unit: 'seasons' as const,
        value: n,
        label: n === 1 ? 'live pulls only' : `last ${n} seasons (fixtures + injuries)`,
        allowed: n === 1 || reachable(n),
        reason:
          n === 1 || reachable(n)
            ? free && n > 1
              ? 'free window serves 2022–2024 only; other years are refused'
              : undefined
            : `${p.label}: no requested season inside the plan window`,
      })),
      selected: pp.api_football ?? { unit: 'seasons', value: 1 },
    });
  }

  // newsdata — live window is 48 h on free; archive months are paid tiers
  {
    const p = planOf('newsdata');
    const months = p.depth.months ?? 0;
    rows.push({
      provider: 'newsdata',
      plan: p.id,
      planLabel: p.label,
      options: [
        { unit: 'days' as const, value: 2, label: 'latest 48 h (live)', allowed: true },
        ...[6, 24, 60].map((m) => ({
          unit: 'months' as const,
          value: m,
          label: `archive ${m >= 12 ? `${m / 12} year${m > 12 ? 's' : ''}` : `${m} months`}`,
          allowed: m <= months && !isDenied('newsdata', 'archive', `archive-${m}m`),
          reason:
            m <= months
              ? isDenied('newsdata', 'archive', `archive-${m}m`)
                ? 'archive refused by the API (learned)'
                : undefined
              : `${p.label}: archive needs a paid plan (Basic 6 mo / Professional 2 y / Corporate 5 y)`,
        })),
      ],
      selected: pp.newsdata ?? { unit: 'days', value: 2 },
    });
  }

  // understat — public site back to 2014, per-season aggregates
  {
    const p = planOf('understat');
    const maxBack = Math.min(p.depth.seasons ?? 12, cur - 2014);
    rows.push({
      provider: 'understat',
      plan: p.id,
      planLabel: p.label,
      options: [1, 3, 5, 12].map((n) => ({
        unit: 'seasons' as const,
        value: n,
        label: n === 1 ? 'current season (live)' : `last ${n} seasons (xG aggregates)`,
        allowed: n === 1 || n <= maxBack + 1,
        reason: n === 1 || n <= maxBack + 1 ? undefined : 'understat data starts 2014',
      })),
      selected: pp.understat ?? { unit: 'seasons', value: 1 },
    });
  }

  return rows;
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
  rawCfg: HistoryDepthConfig,
  opts: { fetchFn?: FetchFn; onProgress?: (msg: string) => void; plans?: ProviderPlansConfig } = {},
): Promise<string[]> {
  const cfg = effectiveDepth(rawCfg);
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

  // 3. P1 (v1.4.2) per-provider selections — each scope is ledgered and each
  //    plan-gated pull runs through guardedPull so refusals are LEARNED, not
  //    hammered. Refusals become report lines, answering "why not deeper?".
  const pp = cfg.per_provider ?? {};
  const plans = opts.plans ?? DEFAULT_PROVIDER_PLANS;
  const cur = currentSeasonStartYear();
  const planOf = (provider: string): { id: string; depth: { days?: number; months?: number; seasons?: number } } => {
    const sel = plans[provider];
    return sel ? { id: sel.plan, depth: sel.depth ?? {} } : { id: 'free', depth: {} };
  };

  // football-data past seasons (paid scope; ?season=YYYY)
  if (pp.football_data?.unit === 'seasons' && pp.football_data.value > 1) {
    const plan = planOf('football_data');
    const want = pp.football_data.value;
    const allowed = plan.depth.seasons ?? 1;
    if (want > allowed) {
      say(`football-data: ${want} seasons requested — plan '${plan.id}' serves ${allowed === 1 ? 'the current season only' : `${allowed} seasons`} (Standard unlocks past seasons)`);
    }
    const { backfillFootballDataSeason } = await import('./adapters/misc-providers.js');
    for (let y = cur - 1; y >= cur - (Math.min(want, allowed) - 1); y--) {
      const scope = `season-${y}`;
      if ((await ledger(db, 'football_data', scope)) === 'complete') continue;
      await markLedger(db, 'football_data', scope, { status: 'running' });
      const r = await guardedPull(db, 'football_data', 'pl-matches-season', scope, () => backfillFootballDataSeason(db, y, opts.fetchFn));
      if (r) {
        await markLedger(db, 'football_data', scope, { status: 'complete', records: r.stored, detail: r.note ?? `${r.skippedTeams} unmapped teams` });
        say(`football-data season ${y}: ${r.note ?? `${r.stored} results stored`}`);
      } else {
        await markLedger(db, 'football_data', scope, { status: 'failed', detail: 'refused or failed (see entitlements/pull log)' });
        say(`football-data season ${y}: refused by the API — learned, will not retry`);
        break; // older seasons refuse the same way
      }
    }
  }

  // API-Football past seasons (free window 2022–2024; fixtures + injuries)
  if (pp.api_football?.unit === 'seasons' && pp.api_football.value > 1) {
    const plan = planOf('api_football');
    const want = pp.api_football.value;
    const inWindow = (y: number): boolean => (plan.id === 'free' ? y >= 2022 && y <= 2024 : y >= cur - ((plan.depth.seasons ?? 3) - 1));
    const { backfillApiFootballSeason } = await import('./adapters/api-football.js');
    for (let y = cur - 1; y >= cur - (want - 1); y--) {
      const scope = `season-${y}`;
      if (!inWindow(y)) {
        say(`api-football season ${y}: outside the '${plan.id}' plan window${plan.id === 'free' ? ' (free serves 2022–2024 only)' : ''} — skipped`);
        continue;
      }
      if ((await ledger(db, 'api_football', scope)) === 'complete') continue;
      await markLedger(db, 'api_football', scope, { status: 'running' });
      const r = await guardedPull(db, 'api_football', 'fixtures-season', scope, () => backfillApiFootballSeason(db, y, opts.fetchFn));
      if (r) {
        await markLedger(db, 'api_football', scope, { status: 'complete', records: r.stored, detail: r.note ?? `${r.injuries} injury rows` });
        say(`api-football season ${y}: ${r.note ?? `${r.stored} results + ${r.injuries} injury rows`}`);
      } else {
        await markLedger(db, 'api_football', scope, { status: 'failed', detail: 'refused or failed (see entitlements/pull log)' });
        say(`api-football season ${y}: refused by the API — learned, will not retry`);
      }
    }
  }

  // NewsData archive (paid tiers only)
  if (pp.newsdata?.unit === 'months' && pp.newsdata.value > 0) {
    const plan = planOf('newsdata');
    const months = pp.newsdata.value;
    const allowedMonths = plan.depth.months ?? 0;
    if (months > allowedMonths) {
      say(`newsdata: ${months}-month archive requested — plan '${plan.id}' has ${allowedMonths ? `${allowedMonths} months` : 'no archive access'} (Basic 6 mo / Professional 2 y / Corporate 5 y)`);
    } else {
      const scope = `archive-${months}m`;
      if ((await ledger(db, 'newsdata', scope)) !== 'complete') {
        await markLedger(db, 'newsdata', scope, { status: 'running' });
        const { pullNewsArchive } = await import('./adapters/newsdata.js');
        const r = await guardedPull(db, 'newsdata', 'archive', scope, () => pullNewsArchive(db, { months, fetchFn: opts.fetchFn }));
        if (r) {
          await markLedger(db, 'newsdata', scope, { status: 'complete', records: r.inserted, detail: `${r.requests} requests` });
          say(`newsdata archive ${months} mo: ${r.inserted} articles stored (${r.requests} requests)`);
        } else {
          await markLedger(db, 'newsdata', scope, { status: 'failed', detail: 'refused or failed (see entitlements/pull log)' });
          say('newsdata archive: refused by the API — learned, will not retry');
        }
      }
    }
  }

  // Understat per-season xG aggregates (free public site, back to 2014)
  if (pp.understat?.unit === 'seasons' && pp.understat.value > 1) {
    const want = Math.min(pp.understat.value, cur - 2014 + 1);
    const { pullUnderstatLeague } = await import('./adapters/misc-providers.js');
    for (let y = cur - 1; y >= cur - (want - 1); y--) {
      const scope = `season-${y}`;
      if ((await ledger(db, 'understat', scope)) === 'complete') continue;
      await markLedger(db, 'understat', scope, { status: 'running' });
      const r = await guardedPull(db, 'understat', 'league-season', scope, () => pullUnderstatLeague(db, y, opts.fetchFn));
      if (r) {
        await markLedger(db, 'understat', scope, { status: 'complete', records: r.seasonRows, detail: `${r.resolved}/${r.players} resolved` });
        say(`understat season ${y}: ${r.seasonRows} aggregate rows (${r.resolved}/${r.players} names resolved)`);
      } else {
        await markLedger(db, 'understat', scope, { status: 'failed', detail: 'fetch failed — will retry next run' });
        say(`understat season ${y}: fetch failed — will retry next run`);
        break;
      }
    }
  }

  if (notes.length > 0) log.info({ notes }, 'history backfill pass');
  return notes;
}
