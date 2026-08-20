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
  const url = `${SPORTMONKS_BASE}/players?include=sidelined&filters=playerHasSidelined&per_page=50`;
  const snap = await fetchWithSnapshot(db, {
    provider: 'sportmonks',
    endpoint: 'players-sidelined',
    url: `${url}&api_token=${config.keys.sportmonks}`,
  });
  const body = snap.body as { data?: unknown[]; rate_limit?: unknown; subscription?: unknown } | null;
  if (!body || !('data' in body)) throw new PullError('SCHEMA_DRIFT', 'sportmonks envelope missing data');
  let resolved = 0;
  let records = 0;
  for (const raw of body.data ?? []) {
    const player = raw as { id: number; display_name?: string; name?: string; sidelined?: unknown[] };
    for (const sRaw of player.sidelined ?? []) {
      const parsed = SidelinedSchema.safeParse(sRaw);
      if (!parsed.success) continue;
      const s = parsed.data;
      records++;
      const outcome = await resolveIdentity(db, {
        provider: 'sportmonks',
        providerId: String(s.player_id),
        name: player.display_name ?? player.name ?? '',
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
  await logPull(db, { provider: 'sportmonks', capability: 'injuries', endpoint: 'players-sidelined', records, latencyMs: snap.latencyMs, status: 'ok' });
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
export async function pullTheSportsDbBadges(db: Knex, fetchFn?: FetchFn): Promise<{ teams: number }> {
  const key = config.keys.thesportsdb || '3'; // '3' = free demo key (throttled, not production)
  const snap = await fetchWithSnapshot(db, {
    provider: 'thesportsdb',
    endpoint: 'lookup-league-teams',
    url: `https://www.thesportsdb.com/api/v1/json/${key}/lookup_all_teams.php?id=4328`,
    fetchFn,
  });
  type SportsDbBody = { teams?: { strTeam?: string; strBadge?: string; strTeamBadge?: string }[] } | null;
  const body = snap.body as SportsDbBody;
  if (snap.body == null && snap.bodyText.length > 0) {
    throw new PullError('RATE_LIMITED', 'thesportsdb served non-JSON (HTML rate-limit page)');
  }
  if (!body || !('teams' in body)) throw new PullError('SCHEMA_DRIFT', 'thesportsdb missing expected top-level key');
  const ourTeams = await db('teams').whereNotNull('fpl_id').select('uid', 'name');
  let count = 0;
  for (const t of body.teams ?? []) {
    if (!t.strTeam) continue;
    const match = ourTeams.find((x) => x.name.toLowerCase().replace(/[^a-z]/g, '') === t.strTeam!.toLowerCase().replace(/[^a-z]/g, ''));
    if (!match) continue;
    const badge = t.strBadge ?? t.strTeamBadge;
    if (!badge) continue;
    await db('teams')
      .where('uid', match.uid)
      .update({ strength: db.raw(`strength || ?::jsonb`, [JSON.stringify({ badge_url: badge })]) });
    count++;
  }
  await logPull(db, { provider: 'thesportsdb', capability: 'media', endpoint: 'lookup-league-teams', records: count, latencyMs: snap.latencyMs, status: 'ok' });
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
  const snap = await fetchWithSnapshot(db, {
    provider: 'understat',
    endpoint: 'league',
    url: `https://understat.com/league/EPL/${startYear}`,
    headers: { 'User-Agent': config.fplUserAgent },
    fetchFn,
  });
  const playersData = extractUnderstatVar(snap.bodyText, 'playersData');
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
