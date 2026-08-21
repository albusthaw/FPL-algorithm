/**
 * Sportmonks (§2.3), football-data.org (§2.4), TheSportsDB (§2.6) and
 * Understat (§2.7) adapters. Each implements its dossier's assertOk and
 * type-coercion rules; Understat ships DISABLED (feature kernel).
 */
import { z } from 'zod';
import type { Knex } from 'knex';
import { config } from '../../core/config.js';
import { fetchWithSnapshot, logPull, type FetchFn } from '../http.js';
import { PullError } from '../errors.js';
import { resolveIdentity } from '../../players/resolver.js';

// ─────────────────────────────────────────────────────────── Sportmonks ──

const SPORTMONKS_BASE = 'https://api.sportmonks.com/v3/football'; // verified live; docs page's /api/v3 404s

const SidelinedSchema = z
  .object({
    id: z.number(),
    player_id: z.number(), // NOT the include-row `id` — the #1 documented v3 mis-mapping
    type_id: z.number().nullable().optional(),
    category: z.string().nullable().optional(),
    team_id: z.number().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    games_missed: z.number().nullable().optional(),
    completed: z.boolean().nullable().optional(),
  })
  .passthrough();

export async function pullSportmonksSidelined(db: Knex, fetchFn?: FetchFn): Promise<{ records: number; resolved: number }> {
  if (!config.keys.sportmonks) throw new PullError('AUTH', 'SPORTMONKS_TOKEN not configured');
  // sidelined is a TEAM include in v3 (probed live 2026-08: it does not exist
  // on Player, and /sidelined is not an endpoint). The nested .player include
  // carries the name; identity resolves on player_id (never the relation id).
  let resolved = 0;
  let records = 0;
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    // per_page is refused alongside cursor (live-probed) — first page only
    const url = `${SPORTMONKS_BASE}/teams?include=sidelined.player${cursor ? `&cursor=${cursor}` : '&per_page=50'}`;
    const snap = await fetchWithSnapshot(db, {
      provider: 'sportmonks',
      endpoint: 'teams-sidelined',
      url: `${url}&api_token=${config.keys.sportmonks}`,
      fetchFn,
    });
    const body = snap.body as {
      data?: unknown[];
      pagination?: { has_more?: boolean; next_cursor?: string | null };
    } | null;
    if (!body || !('data' in body)) throw new PullError('SCHEMA_DRIFT', 'sportmonks envelope missing data');
    for (const raw of body.data ?? []) {
      const team = raw as { id: number; name?: string; sidelined?: unknown[] };
      for (const sRaw of team.sidelined ?? []) {
        const parsed = SidelinedSchema.safeParse(sRaw);
        if (!parsed.success) continue;
        const s = parsed.data;
        const nested = (sRaw as { player?: { display_name?: string; name?: string } }).player;
        records++;
        const outcome = await resolveIdentity(db, {
          provider: 'sportmonks',
          providerId: String(s.player_id),
          name: nested?.display_name ?? nested?.name ?? '',
        });
        if (outcome.kind !== 'cached' && outcome.kind !== 'code' && outcome.kind !== 'exact' && outcome.kind !== 'seed') continue;
        resolved++;
        const kind = (s.category ?? '').includes('susp') ? 'suspension' : 'injury';
        await db.transaction(async (trx) => {
          const existing = await trx('injuries')
            .where({ player_uid: outcome.playerUid, kind, is_active: !s.completed, source: 'sportmonks' })
            .first();
          if (!existing) {
            await trx('injuries').insert({
              player_uid: outcome.playerUid,
              source: 'sportmonks',
              kind,
              reason: s.category ?? '',
              start_date: s.start_date ?? null,
              expected_return_date: s.end_date ?? null,
              is_active: !s.completed,
              confidence: 0.85,
            });
          }
        });
      }
    }
    if (!body.pagination?.has_more || !body.pagination.next_cursor) break;
    // next_cursor is a FULL URL (observed live) — extract the bare token
    try {
      cursor = new URL(body.pagination.next_cursor).searchParams.get('cursor') ?? '';
    } catch {
      cursor = body.pagination.next_cursor;
    }
    if (!cursor) break;
  }
  await logPull(db, { provider: 'sportmonks', capability: 'injuries', endpoint: 'teams-sidelined', records, status: 'ok' });
  return { records, resolved };
}

// ─────────────────────────────────────────────── football-data.org (v4) ──

const FdMatchSchema = z
  .object({
    id: z.number(),
    utcDate: z.string(),
    status: z.string(),
    matchday: z.number().nullable(),
    homeTeam: z.object({ id: z.number(), name: z.string().nullable() }).passthrough(),
    awayTeam: z.object({ id: z.number(), name: z.string().nullable() }).passthrough(),
    score: z
      .object({
        winner: z.string().nullable(),
        fullTime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Fixtures/results FALLBACK only. Trap: matchday ≠ FPL gameweek after
 * postponements — fixtures map to FPL events via kickoff-window + team pair
 * matching only. This pull cross-checks; it never overwrites S1 fixtures.
 */
export async function pullFootballDataMatches(db: Knex, fetchFn?: FetchFn): Promise<{ records: number; disagreements: number }> {
  if (!config.keys.footballData) throw new PullError('AUTH', 'FOOTBALL_DATA_TOKEN not configured');
  const snap = await fetchWithSnapshot(db, {
    provider: 'football_data',
    endpoint: 'pl-matches',
    url: 'https://api.football-data.org/v4/competitions/PL/matches',
    headers: { 'X-Auth-Token': config.keys.footballData },
    fetchFn,
  });
  const body = snap.body as { matches?: unknown[] } | null;
  const matches = body?.matches ?? [];
  let disagreements = 0;
  let records = 0;
  for (const raw of matches) {
    const parsed = FdMatchSchema.safeParse(raw);
    if (!parsed.success) continue;
    records++;
    const m = parsed.data;
    if (m.status !== 'FINISHED') continue;
    // cross-check: find our fixture by kickoff window (±1 day) — flag score disagreement
    const kickoff = new Date(m.utcDate);
    const ours = await db('fixtures')
      .whereBetween('kickoff_utc', [new Date(kickoff.getTime() - 86_400_000), new Date(kickoff.getTime() + 86_400_000)])
      .whereIn('state', ['finished', 'checked'])
      .select('fixture_uid', 'home_score', 'away_score');
    if (ours.length > 0 && m.score.fullTime.home != null) {
      const anyMatch = ours.some((o) => o.home_score === m.score.fullTime.home && o.away_score === m.score.fullTime.away);
      if (!anyMatch && ours.length === 1) disagreements++;
    }
  }
  await logPull(db, { provider: 'football_data', capability: 'fixtures', endpoint: 'pl-matches', records, latencyMs: snap.latencyMs, status: 'ok' });
  return { records, disagreements };
}

// ───────────────────────────────────────────────────────── TheSportsDB ──

/**
 * Metadata/media ONLY — never a stats or availability source. Everything is
 * strings; may serve HTML on rate-limit (treated as RATE_LIMITED).
 */
/** FPL's short club names → TheSportsDB's registered names (live-probed). */
const FPL_TO_TSDB: Record<string, string> = {
  'man city': 'manchester city',
  'man utd': 'manchester united',
  spurs: 'tottenham hotspur',
  "nott'm forest": 'nottingham forest',
  newcastle: 'newcastle united',
  leeds: 'leeds united',
  brighton: 'brighton and hove albion',
  bournemouth: 'afc bournemouth',
  wolves: 'wolverhampton wanderers',
  'west ham': 'west ham united',
};

export async function pullTheSportsDbBadges(db: Knex, fetchFn?: FetchFn): Promise<{ teams: number }> {
  const key = config.keys.thesportsdb || '3'; // '3' = free demo key (throttled, not production)
  // search_all_teams by league NAME: lookup_all_teams.php?id=4328 serves a
  // different (lower-league) roster on the demo key — live-probed 2026-08
  const snap = await fetchWithSnapshot(db, {
    provider: 'thesportsdb',
    endpoint: 'search-league-teams',
    url: `https://www.thesportsdb.com/api/v1/json/${key}/search_all_teams.php?l=${encodeURIComponent('English Premier League')}`,
    fetchFn,
  });
  type SportsDbBody = { teams?: { strTeam?: string; strBadge?: string; strTeamBadge?: string }[] } | null;
  const body = snap.body as SportsDbBody;
  if (snap.body == null && snap.bodyText.length > 0) {
    throw new PullError('RATE_LIMITED', 'thesportsdb served non-JSON (HTML rate-limit page)');
  }
  if (!body || !('teams' in body)) throw new PullError('SCHEMA_DRIFT', 'thesportsdb missing expected top-level key');
  const ourTeams = await db('teams').whereNotNull('fpl_id').select('uid', 'name');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  const matched = new Set<string>();
  let count = 0;
  const applyBadge = async (uid: string, badge: string): Promise<void> => {
    await db('teams')
      .where('uid', uid)
      .update({ strength: db.raw(`strength || ?::jsonb`, [JSON.stringify({ badge_url: badge })]) });
    matched.add(uid);
    count++;
  };
  for (const t of body.teams ?? []) {
    if (!t.strTeam) continue;
    const tsdbName = norm(t.strTeam);
    const match = ourTeams.find((x) => {
      const fplName = norm(x.name);
      return fplName === tsdbName || FPL_TO_TSDB[fplName] === tsdbName;
    });
    if (!match || matched.has(match.uid)) continue;
    const badge = t.strBadge ?? t.strTeamBadge;
    if (!badge) continue;
    await applyBadge(match.uid, badge);
  }
  // free keys cap search_all_teams at 10 rows (live-probed 2026-08) — backfill
  // the remaining clubs one-by-one via searchteams.php, tolerating throttles
  for (const club of ourTeams.filter((x) => !matched.has(x.uid))) {
    const fplName = norm(club.name);
    const query = FPL_TO_TSDB[fplName] ?? fplName;
    try {
      const one = await fetchWithSnapshot(db, {
        provider: 'thesportsdb',
        endpoint: 'search-team',
        url: `https://www.thesportsdb.com/api/v1/json/${key}/searchteams.php?t=${encodeURIComponent(query)}`,
        fetchFn,
        retry: false,
      });
      const oneBody = one.body as SportsDbBody;
      const hit = (oneBody?.teams ?? []).find((t) => t.strTeam && norm(t.strTeam) === query);
      const badge = hit?.strBadge ?? hit?.strTeamBadge;
      if (badge) await applyBadge(club.uid, badge);
    } catch {
      break; // throttled or down — keep what we have, next pull resumes
    }
  }
  await logPull(db, { provider: 'thesportsdb', capability: 'media', endpoint: 'search-league-teams', records: count, latencyMs: snap.latencyMs, status: 'ok' });
  return { teams: count };
}

// ─────────────────────────────────────────────── Understat (scraper) ──

/**
 * No official API: extract hex-escaped JSON from <script> vars. Ships
 * DISABLED; any layout change → SCHEMA_DRIFT quarantine and automatic
 * fallback to FPL's own xG fields (engines plan §4.16).
 */
export function extractUnderstatVar(html: string, varName: string): unknown {
  const re = new RegExp(`${varName}\\s*=\\s*JSON\\.parse\\('([^']+)'\\)`);
  const match = html.match(re);
  if (!match) throw new PullError('SCHEMA_DRIFT', `understat var ${varName} not found — layout changed`);
  const decoded = match[1]!.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return JSON.parse(decoded);
}

const UnderstatPlayerSchema = z
  .object({
    id: z.string(),
    player_name: z.string(),
    games: z.string(),
    time: z.string(),
    xG: z.string(), // all numerics as strings (law #3)
    xA: z.string(),
    npxG: z.string(),
    xGChain: z.string(),
    xGBuildup: z.string(),
    team_title: z.string(),
  })
  .passthrough();

export async function pullUnderstatLeague(db: Knex, startYear: number, fetchFn?: FetchFn): Promise<{ players: number; resolved: number }> {
  // The league page stopped embedding playersData in 2026 (client-side
  // loading now) — the site's own ajax endpoint serves the same shape as
  // JSON. Fallback to the legacy script extraction if the endpoint drifts.
  let playersData: unknown;
  const snap = await fetchWithSnapshot(db, {
    provider: 'understat',
    endpoint: 'players-stats',
    url: 'https://understat.com/main/getPlayersStats/',
    method: 'POST',
    requestBody: `league=EPL&season=${startYear}`,
    headers: {
      'User-Agent': config.fplUserAgent,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    paramsHash: `EPL-${startYear}`,
    fetchFn,
  });
  const ajax = snap.body as { success?: boolean; players?: unknown } | null;
  if (ajax?.success && Array.isArray(ajax.players)) {
    playersData = ajax.players;
  } else {
    const legacy = await fetchWithSnapshot(db, {
      provider: 'understat',
      endpoint: 'league',
      url: `https://understat.com/league/EPL/${startYear}`,
      headers: { 'User-Agent': config.fplUserAgent },
      fetchFn,
    });
    playersData = extractUnderstatVar(legacy.bodyText, 'playersData');
  }
  const parsed = z.array(UnderstatPlayerSchema).safeParse(playersData);
  if (!parsed.success) throw new PullError('SCHEMA_DRIFT', 'understat playersData shape drifted', parsed.error.issues.slice(0, 5));
  let resolved = 0;
  for (const p of parsed.data) {
    const outcome = await resolveIdentity(db, {
      provider: 'understat',
      providerId: p.id,
      name: p.player_name,
    });
    if (outcome.kind === 'cached' || outcome.kind === 'code' || outcome.kind === 'exact') resolved++;
  }
  await logPull(db, { provider: 'understat', capability: 'stats', endpoint: 'league', records: parsed.data.length, latencyMs: snap.latencyMs, status: 'ok' });
  return { players: parsed.data.length, resolved };
}
