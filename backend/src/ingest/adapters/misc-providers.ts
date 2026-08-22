/**
 * Sportmonks (§2.3), football-data.org (§2.4), TheSportsDB (§2.6) and
 * Understat (§2.7) adapters. Each implements its dossier's assertOk and
 * type-coercion rules; Understat ships DISABLED (feature kernel).
 */
import { z } from 'zod';
import { ulid } from 'ulid';
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

/** football-data.org team names ("Manchester City FC") → FPL registered names. */
const FD_ALIASES: Record<string, string> = {
  'manchester city': 'man city',
  'manchester united': 'man utd',
  'tottenham hotspur': 'spurs',
  'nottingham forest': "nott'm forest",
  'wolverhampton wanderers': 'wolves',
  'west ham united': 'west ham',
  'newcastle united': 'newcastle',
  'leeds united': 'leeds',
  'brighton & hove albion': 'brighton',
  'brighton and hove albion': 'brighton',
  'afc bournemouth': 'bournemouth',
  'leicester city': 'leicester',
  'luton town': 'luton',
  'ipswich town': 'ipswich',
  'sheffield united': 'sheffield utd',
};

const normClub = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\b(afc|fc)\b/g, '')
    .replace(/[^a-z'& ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * P1 (v1.4.2) backfill executor: one PAST season of PL results via
 * ?season=YYYY — a paid-tier scope on football-data.org (the free tier's
 * refusal is learned as PLAN_DENIED by guardedPull and never re-hammered).
 * Stores finished matches as fixtures rows (no FPL ids for past seasons);
 * skips a season the vaastav importer already covered.
 */
export async function backfillFootballDataSeason(
  db: Knex,
  startYear: number,
  fetchFn?: FetchFn,
): Promise<{ matches: number; stored: number; skippedTeams: number; note?: string }> {
  if (!config.keys.footballData) throw new PullError('AUTH', 'FOOTBALL_DATA_TOKEN not configured');
  const seasonLabel = `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
  const already = await db('fixtures').where('season', seasonLabel).first('fixture_uid');
  if (already) return { matches: 0, stored: 0, skippedTeams: 0, note: `season ${seasonLabel} already imported (vaastav)` };

  const snap = await fetchWithSnapshot(db, {
    provider: 'football_data',
    endpoint: 'pl-matches-season',
    url: `https://api.football-data.org/v4/competitions/PL/matches?season=${startYear}`,
    headers: { 'X-Auth-Token': config.keys.footballData },
    paramsHash: `season-${startYear}`,
    fetchFn,
  });
  const body = snap.body as { matches?: unknown[] } | null;
  const matches = body?.matches ?? [];
  const ourTeams = (await db('teams').select('uid', 'name')) as { uid: string; name: string }[];
  const uidByNorm = new Map(ourTeams.map((t) => [normClub(t.name), t.uid]));
  const resolveTeam = (name: string | null): string | null => {
    if (!name) return null;
    const n = normClub(name);
    return uidByNorm.get(n) ?? uidByNorm.get(FD_ALIASES[n] ?? '') ?? null;
  };

  let stored = 0;
  let skippedTeams = 0;
  await db.transaction(async (trx) => {
    for (const raw of matches) {
      const parsed = FdMatchSchema.safeParse(raw);
      if (!parsed.success) continue;
      const m = parsed.data;
      if (m.status !== 'FINISHED' || m.score.fullTime.home == null) continue;
      const homeUid = resolveTeam(m.homeTeam.name);
      const awayUid = resolveTeam(m.awayTeam.name);
      if (!homeUid || !awayUid) {
        skippedTeams++; // relegated club with no row of ours — never mint teams here
        continue;
      }
      const dupe = await trx('fixtures').where({ season: seasonLabel, home_team_uid: homeUid, away_team_uid: awayUid }).first('fixture_uid');
      if (dupe) continue;
      await trx('fixtures').insert({
        fixture_uid: `fx_${ulid()}`,
        season: seasonLabel,
        fpl_fixture_id: null,
        event: m.matchday,
        home_team_uid: homeUid,
        away_team_uid: awayUid,
        kickoff_utc: m.utcDate,
        state: 'checked',
        home_score: m.score.fullTime.home,
        away_score: m.score.fullTime.away,
        stats: JSON.stringify({ source: 'football_data', fd_id: m.id }),
      });
      stored++;
    }
  });
  await logPull(db, { provider: 'football_data', capability: 'fixtures', endpoint: 'pl-matches-season', records: stored, latencyMs: snap.latencyMs, status: 'ok' });
  return { matches: matches.length, stored, skippedTeams };
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

export async function pullUnderstatLeague(db: Knex, startYear: number, fetchFn?: FetchFn): Promise<{ players: number; resolved: number; seasonRows: number }> {
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
  let seasonRows = 0;
  const seasonLabel = `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
  for (const p of parsed.data) {
    const outcome = await resolveIdentity(db, {
      provider: 'understat',
      providerId: p.id,
      name: p.player_name,
    });
    if (outcome.kind !== 'cached' && outcome.kind !== 'code' && outcome.kind !== 'exact') continue;
    resolved++;
    // P1 (v1.4.2): store the per-season xG aggregates. The (player_uid,
    // season) row is SHARED with fpl_history_past — merge into stats.understat
    // instead of clobbering the FPL career numbers.
    const agg = JSON.stringify({
      games: Number(p.games),
      minutes: Number(p.time),
      xg: Number(p.xG),
      xa: Number(p.xA),
      npxg: Number(p.npxG),
      xg_chain: Number(p.xGChain),
      xg_buildup: Number(p.xGBuildup),
      team: p.team_title,
    });
    await db.raw(
      `INSERT INTO player_season_history (player_uid, season, source, stats, as_of)
       VALUES (?, ?, 'understat', jsonb_build_object('understat', ?::jsonb), now())
       ON CONFLICT (player_uid, season)
       DO UPDATE SET stats = player_season_history.stats || jsonb_build_object('understat', ?::jsonb), as_of = now()`,
      [outcome.playerUid, seasonLabel, agg, agg],
    );
    seasonRows++;
  }
  await logPull(db, { provider: 'understat', capability: 'stats', endpoint: 'league', records: parsed.data.length, latencyMs: snap.latencyMs, status: 'ok' });
  return { players: parsed.data.length, resolved, seasonRows };
}

/**
 * B4 (v1.4.5): venue + thumbnail per next-event fixture from TheSportsDB's
 * eventsround endpoint — pure display metadata into fixtures.stats.
 */
export async function pullTheSportsDbFixtureMeta(db: Knex, fetchFn?: FetchFn): Promise<{ updated: number }> {
  const key = config.keys.thesportsdb || '3';
  const gw = await db('gameweeks').where('is_next', true).first('id');
  if (!gw) return { updated: 0 };
  const event = Number(gw.id);
  const season = (await db('fixtures').where('event', event).whereNotNull('fpl_fixture_id').first('season'))?.season as string | undefined;
  if (!season) return { updated: 0 };
  const tsdbSeason = season.replace('/', '-20'); // '2026/27' → '2026-2027'
  const snap = await fetchWithSnapshot(db, {
    provider: 'thesportsdb',
    endpoint: 'eventsround',
    url: `https://www.thesportsdb.com/api/v1/json/${key}/eventsround.php?id=4328&r=${event}&s=${tsdbSeason}`,
    paramsHash: `round-${event}`,
    fetchFn,
  });
  if (snap.body == null && snap.bodyText.length > 0) throw new PullError('RATE_LIMITED', 'thesportsdb served non-JSON');
  const body = snap.body as { events?: { strHomeTeam?: string; strAwayTeam?: string; strVenue?: string; strThumb?: string }[] } | null;
  const ourTeams = (await db('teams').whereNotNull('fpl_id').select('uid', 'name')) as { uid: string; name: string }[];
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  const uidByName = (name: string | undefined): string | null => {
    if (!name) return null;
    const n = norm(name);
    const hit = ourTeams.find((t) => {
      const fpl = norm(t.name);
      return fpl === n || FPL_TO_TSDB[fpl] === n;
    });
    return hit?.uid ?? null;
  };
  let updated = 0;
  for (const ev of body?.events ?? []) {
    const home = uidByName(ev.strHomeTeam);
    const away = uidByName(ev.strAwayTeam);
    if (!home || !away || (!ev.strVenue && !ev.strThumb)) continue;
    updated += await db('fixtures')
      .where({ event, home_team_uid: home, away_team_uid: away })
      .whereNotNull('fpl_fixture_id')
      .update({ stats: db.raw(`stats || ?::jsonb`, [JSON.stringify({ venue: ev.strVenue ?? null, thumb: ev.strThumb ?? null })]) });
  }
  await logPull(db, { provider: 'thesportsdb', capability: 'media', endpoint: 'eventsround', records: updated, latencyMs: snap.latencyMs, status: 'ok' });
  return { updated };
}

/**
 * B4 (v1.4.5, fixes S8/M6): EXTERNAL congestion — UCL/Europa/cup midweeks
 * are invisible to the PL-only fixture list. TheSportsDB's per-team
 * next-events feed covers all competitions: non-PL dates in the next ~3
 * weeks land in teams.strength.ext_fixtures for the engine's congestion
 * and volatility checks. Team ids resolve once into team_identities.
 */
export async function pullTheSportsDbTeamCalendars(db: Knex, fetchFn?: FetchFn): Promise<{ teams: number; extFixtures: number }> {
  const key = config.keys.thesportsdb || '3';
  const ourTeams = (await db('teams').whereNotNull('fpl_id').select('uid', 'name')) as { uid: string; name: string }[];
  const identities = (await db('team_identities').where('provider', 'thesportsdb').select('team_uid', 'provider_id')) as {
    team_uid: string;
    provider_id: string;
  }[];
  const idByTeam = new Map(identities.map((i) => [i.team_uid, i.provider_id]));
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z' ]/g, '').trim();

  let teamsDone = 0;
  let extFixtures = 0;
  for (const t of ourTeams) {
    try {
      let tsdbId = idByTeam.get(t.uid);
      if (!tsdbId) {
        const fplName = norm(t.name);
        const query = FPL_TO_TSDB[fplName] ?? fplName;
        const search = await fetchWithSnapshot(db, {
          provider: 'thesportsdb',
          endpoint: 'search-team',
          url: `https://www.thesportsdb.com/api/v1/json/${key}/searchteams.php?t=${encodeURIComponent(query)}`,
          paramsHash: `cal-search-${fplName}`,
          fetchFn,
          retry: false,
        });
        const sBody = search.body as { teams?: { idTeam?: string; strTeam?: string; strSport?: string }[] } | null;
        const hit = (sBody?.teams ?? []).find((x) => x.strSport === 'Soccer' && x.strTeam && norm(x.strTeam) === query && x.idTeam);
        if (!hit?.idTeam) continue;
        tsdbId = hit.idTeam;
        await db.raw(
          `INSERT INTO team_identities (team_uid, provider, provider_id, provider_name, confidence, matched_by)
           VALUES (?, 'thesportsdb', ?, ?, 1.0, 'seed') ON CONFLICT (provider, provider_id) DO NOTHING`,
          [t.uid, tsdbId, hit.strTeam ?? t.name],
        );
      }
      const next = await fetchWithSnapshot(db, {
        provider: 'thesportsdb',
        endpoint: 'eventsnext',
        url: `https://www.thesportsdb.com/api/v1/json/${key}/eventsnext.php?id=${tsdbId}`,
        paramsHash: `cal-${tsdbId}`,
        fetchFn,
        retry: false,
      });
      const nBody = next.body as { events?: { strLeague?: string; dateEvent?: string }[] } | null;
      const ext = (nBody?.events ?? [])
        .filter((e) => e.dateEvent && e.strLeague && e.strLeague !== 'English Premier League')
        .map((e) => e.dateEvent!)
        .slice(0, 10);
      await db('teams')
        .where('uid', t.uid)
        .update({ strength: db.raw(`strength || ?::jsonb`, [JSON.stringify({ ext_fixtures: ext })]) });
      extFixtures += ext.length;
      teamsDone++;
    } catch {
      break; // throttled — resume on the next daily pass
    }
  }
  await logPull(db, { provider: 'thesportsdb', capability: 'media', endpoint: 'eventsnext', records: extFixtures, status: 'ok' });
  return { teams: teamsDone, extFixtures };
}
