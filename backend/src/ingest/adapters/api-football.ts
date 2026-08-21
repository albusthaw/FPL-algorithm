/**
 * API-Football v3 adapter (integration plan §2.2 — the highest-confidence
 * dossier). THE trap: errors arrive INSIDE HTTP 200. assertOk: error iff
 * `errors` is non-empty; empty `response` with empty `errors` is EMPTY_OK.
 * Coverage flags are NOT entitlement — entitlement is learned from denials.
 */
import { z } from 'zod';
import type { Knex } from 'knex';
import { config } from '../../core/config.js';
import { fetchWithSnapshot, logPull, type FetchFn } from '../http.js';
import { PullError } from '../errors.js';
import { resolveIdentity } from '../../players/resolver.js';

const BASE = 'https://v3.football.api-sports.io';
const EPL_LEAGUE_ID = 39; // league names are globally non-unique — id is config, never looked up by name

const EnvelopeSchema = z
  .object({
    errors: z.union([z.array(z.unknown()), z.record(z.unknown())]),
    results: z.number().optional(),
    response: z.array(z.unknown()),
    paging: z.object({ current: z.number(), total: z.number() }).optional(),
  })
  .passthrough();

/** assertOk per dossier: inspect the body BEFORE parsing anything as data. */
export function assertOk(body: unknown): { response: unknown[] } {
  const parsed = EnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new PullError('SCHEMA_DRIFT', 'api-football envelope shape drifted', parsed.error.issues.slice(0, 5));
  const errors = parsed.data.errors;
  const errorEntries = Array.isArray(errors) ? errors : Object.entries(errors);
  if (errorEntries.length > 0) {
    const errObj = Array.isArray(errors) ? {} : (errors as Record<string, unknown>);
    if ('plan' in errObj) throw new PullError('PLAN_DENIED', String(errObj.plan));
    if ('rateLimit' in errObj || 'ratelimit' in errObj) throw new PullError('RATE_LIMITED', JSON.stringify(errObj));
    if ('requests' in errObj) throw new PullError('QUOTA_EXHAUSTED', String(errObj.requests));
    if ('token' in errObj || 'Token' in errObj) throw new PullError('AUTH', JSON.stringify(errObj));
    // "access" carries account-level denials (e.g. "Your account is suspended")
    if ('access' in errObj) throw new PullError('AUTH', String(errObj.access));
    throw new PullError('SCHEMA_DRIFT', `api-football in-200 error: ${JSON.stringify(errors).slice(0, 300)}`);
  }
  if (parsed.data.response.length === 0) throw new PullError('EMPTY_OK', 'empty response with empty errors');
  return { response: parsed.data.response };
}

function headers(): Record<string, string> {
  // direct mode only (dashboard.api-football.com) — the RapidAPI resale is a
  // different host+header; mixing the two is a classic misconfiguration
  return { 'x-apisports-key': config.keys.apiFootball };
}

const InjurySchema = z
  .object({
    player: z.object({ id: z.number().nullable(), name: z.string() }).passthrough(),
    team: z.object({ id: z.number(), name: z.string().optional() }).passthrough(),
    fixture: z.object({ id: z.number(), date: z.string().optional() }).passthrough(),
    type: z.string().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

export async function pullInjuries(
  db: Knex,
  season: number,
  fetchFn?: FetchFn,
): Promise<{ records: number; resolved: number; queued: number }> {
  if (!config.keys.apiFootball) throw new PullError('AUTH', 'API_FOOTBALL_KEY not configured');
  const url = `${BASE}/injuries?league=${EPL_LEAGUE_ID}&season=${season}`;
  const snap = await fetchWithSnapshot(db, { provider: 'api_football', endpoint: 'injuries', url, headers: headers(), fetchFn });
  // persist all four quota headers (daily counter is NOT monotonic — advisory only)
  const quotaHeaders = Object.fromEntries(
    Object.entries(snap.headers).filter(([k]) => k.startsWith('x-ratelimit')),
  );
  const { response } = assertOk(snap.body);

  let resolved = 0;
  let queued = 0;
  let teamMap = await apiFootballTeamMap(db);
  // without team context every row falls to manual review (§1.5 flood) —
  // seed the 20-row team map lazily if the pre-season sprint hasn't run
  if (teamMap.size === 0) {
    try {
      await seedTeamMap(db, season, fetchFn);
      teamMap = await apiFootballTeamMap(db);
    } catch {
      /* plan-denied or offline: resolver still works, just queues more */
    }
  }

  for (const raw of response) {
    const parsed = InjurySchema.safeParse(raw);
    if (!parsed.success) {
      await db('quarantine_rows').insert({
        provider: 'api_football',
        endpoint: 'injuries',
        raw_payload_id: snap.rawPayloadId,
        row: JSON.stringify(raw),
        errors: JSON.stringify(parsed.error.issues.slice(0, 5)),
      });
      continue;
    }
    const inj = parsed.data;
    if (inj.player.id == null) continue; // null ids happen on team sheets — never invent an id
    const outcome = await resolveIdentity(db, {
      provider: 'api_football',
      providerId: String(inj.player.id),
      name: inj.player.name,
      teamUid: teamMap.get(inj.team.id) ?? null,
    });
    if (outcome.kind === 'queued' || outcome.kind === 'unmatched') {
      queued++;
      continue;
    }
    if (outcome.kind === 'ignored') continue;
    resolved++;
    const kind = (inj.reason ?? '').toLowerCase().includes('suspend') || (inj.type ?? '').toLowerCase().includes('suspend') ? 'suspension' : 'injury';
    // fixture-scoped absence (who misses THIS match) — one active row per
    // player+kind; check-then-insert (partial-unique trap, §1.4)
    await db.transaction(async (trx) => {
      const existing = await trx('injuries')
        .where({ player_uid: outcome.playerUid, kind, is_active: true, source: 'api_football' })
        .first();
      if (existing) {
        await trx('injuries')
          .where('id', existing.id)
          .update({
            reason: inj.reason ?? existing.reason,
            fixture_scope: trx.raw('array_append(array_remove(fixture_scope, ?::int), ?::int)', [inj.fixture.id, inj.fixture.id]),
            as_of: trx.fn.now(),
          });
      } else {
        await trx('injuries').insert({
          player_uid: outcome.playerUid,
          source: 'api_football',
          kind,
          reason: inj.reason ?? inj.type ?? '',
          start_date: inj.fixture.date ? inj.fixture.date.slice(0, 10) : null,
          fixture_scope: [inj.fixture.id],
          confidence: 0.85,
          is_active: true,
        });
      }
    });
  }

  await logPull(db, {
    provider: 'api_football',
    capability: 'injuries',
    endpoint: 'injuries',
    records: response.length,
    latencyMs: snap.latencyMs,
    status: 'ok',
    quotaHeaders,
  });
  return { records: response.length, resolved, queued };
}

const LineupSchema = z
  .object({
    team: z.object({ id: z.number() }).passthrough(),
    formation: z.string().nullable(),
    startXI: z.array(z.object({ player: z.object({ id: z.number().nullable(), name: z.string(), pos: z.string().nullable().optional() }).passthrough() })),
    substitutes: z.array(z.object({ player: z.object({ id: z.number().nullable(), name: z.string() }).passthrough() })),
  })
  .passthrough();

export async function pullLineups(
  db: Knex,
  fplFixtureUid: string,
  apiFootballFixtureId: number,
  fetchFn?: FetchFn,
): Promise<{ confirmed: boolean }> {
  const url = `${BASE}/fixtures/lineups?fixture=${apiFootballFixtureId}`;
  const snap = await fetchWithSnapshot(db, { provider: 'api_football', endpoint: 'lineups', url, headers: headers(), fetchFn });
  let response: unknown[];
  try {
    ({ response } = assertOk(snap.body));
  } catch (err) {
    if (err instanceof PullError && err.errorClass === 'EMPTY_OK') {
      // the sheet lands complete between T−29 and T−18 — before that: EMPTY_OK
      await logPull(db, { provider: 'api_football', capability: 'lineups', endpoint: 'lineups', status: 'empty_ok', latencyMs: snap.latencyMs });
      return { confirmed: false };
    }
    throw err;
  }

  const teamMap = await apiFootballTeamMap(db);
  for (const raw of response) {
    const parsed = LineupSchema.safeParse(raw);
    if (!parsed.success) continue;
    const lu = parsed.data;
    const teamUid = teamMap.get(lu.team.id);
    if (!teamUid) continue;
    // resolve lineup slots via id, never via the ABBREVIATED name; null-id
    // slots are dropped from resolution (picked up post-match)
    const resolveSlot = async (playerId: number | null): Promise<string | null> => {
      if (playerId == null) return null;
      const identity = await db('player_identities')
        .where({ provider: 'api_football', provider_id: String(playerId) })
        .whereNull('tombstoned_at')
        .first('player_uid');
      return identity?.player_uid ?? null;
    };
    const starters = (await Promise.all(lu.startXI.map((s) => resolveSlot(s.player.id)))).filter((u): u is string => !!u);
    const bench = (await Promise.all(lu.substitutes.map((s) => resolveSlot(s.player.id)))).filter((u): u is string => !!u);
    await db.raw(
      `INSERT INTO lineups (fixture_uid, team_uid, kind, formation, starters, bench, as_of)
       VALUES (?, ?, 'confirmed', ?, ?, ?, now())
       ON CONFLICT (fixture_uid, team_uid, kind) DO UPDATE
         SET formation = excluded.formation, starters = excluded.starters,
             bench = excluded.bench, as_of = now()`,
      [fplFixtureUid, teamUid, lu.formation, JSON.stringify(starters), JSON.stringify(bench)],
    );
  }
  await logPull(db, { provider: 'api_football', capability: 'lineups', endpoint: 'lineups', records: response.length, latencyMs: snap.latencyMs, status: 'ok' });
  return { confirmed: true };
}

const OddsSchema = z
  .object({
    fixture: z.object({ id: z.number() }).passthrough(),
    bookmakers: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        bets: z.array(z.object({ id: z.number(), name: z.string(), values: z.array(z.object({ value: z.union([z.string(), z.number()]), odd: z.string() })) })),
      }).passthrough(),
    ),
  })
  .passthrough();

export async function pullOdds(db: Knex, fplFixtureUid: string, apiFootballFixtureId: number, fetchFn?: FetchFn): Promise<{ markets: number }> {
  const url = `${BASE}/odds?fixture=${apiFootballFixtureId}`;
  const snap = await fetchWithSnapshot(db, { provider: 'api_football', endpoint: 'odds', url, headers: headers(), fetchFn });
  let response: unknown[];
  try {
    ({ response } = assertOk(snap.body));
  } catch (err) {
    if (err instanceof PullError && err.errorClass === 'EMPTY_OK') return { markets: 0 };
    throw err;
  }
  let markets = 0;
  for (const raw of response) {
    const parsed = OddsSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const bookmaker of parsed.data.bookmakers.slice(0, 1)) {
      const matchWinner = bookmaker.bets.find((b) => b.name === 'Match Winner');
      if (matchWinner) {
        const get = (v: string): number | null => {
          const row = matchWinner.values.find((x) => String(x.value) === v);
          return row ? parseFloat(row.odd) : null; // odds are STRINGS (law #3)
        };
        const home = get('Home');
        const draw = get('Draw');
        const away = get('Away');
        if (home && draw && away) {
          await db('odds_snapshots').insert({
            fixture_uid: fplFixtureUid,
            bookmaker: bookmaker.name,
            market: '1x2',
            prices: JSON.stringify({ home, draw, away }),
          });
          markets++;
        }
      }
    }
  }
  await logPull(db, { provider: 'api_football', capability: 'odds', endpoint: 'odds', records: markets, latencyMs: snap.latencyMs, status: 'ok' });
  return { markets };
}

/** Team id map seeded via the 20-row pre-season sprint; falls back to name match. */
async function apiFootballTeamMap(db: Knex): Promise<Map<number, string>> {
  const identities = await db('team_identities').where('provider', 'api_football').select('provider_id', 'team_uid');
  const map = new Map<number, string>();
  for (const row of identities) map.set(Number(row.provider_id), row.team_uid);
  return map;
}

/** Pre-season sprint: map API-Football team ids by (verified) name match. */
export async function seedTeamMap(db: Knex, season: number, fetchFn?: FetchFn): Promise<{ mapped: number }> {
  const url = `${BASE}/teams?league=${EPL_LEAGUE_ID}&season=${season}`;
  const snap = await fetchWithSnapshot(db, { provider: 'api_football', endpoint: 'teams', url, headers: headers(), fetchFn });
  const { response } = assertOk(snap.body);
  const teams = await db('teams').whereNotNull('fpl_id').select('uid', 'name', 'short_name');
  let mapped = 0;
  for (const raw of response) {
    const t = (raw as { team?: { id: number; name: string } }).team;
    if (!t) continue;
    const match = teams.find((x) => namesRoughlyEqual(x.name, t.name));
    if (!match) continue;
    await db.raw(
      `INSERT INTO team_identities (team_uid, provider, provider_id, provider_name, confidence, matched_by)
       VALUES (?, 'api_football', ?, ?, 1.0, 'seed') ON CONFLICT (provider, provider_id) DO NOTHING`,
      [match.uid, String(t.id), t.name],
    );
    mapped++;
  }
  return { mapped };
}

// FPL's short club names → the full names providers register (live-probed)
const FPL_CLUB_FULL: Record<string, string> = {
  mancity: 'manchestercity',
  manutd: 'manchesterunited',
  spurs: 'tottenhamhotspur',
  nottmforest: 'nottinghamforest',
  newcastle: 'newcastleunited',
  leeds: 'leedsunited',
  brighton: 'brightonhovealbion', // post-clean form ('and' is stripped)
  bournemouth: 'afcbournemouth',
  wolves: 'wolverhamptonwanderers',
  westham: 'westhamunited',
};

function namesRoughlyEqual(a: string, b: string): boolean {
  const clean = (s: string): string => s.toLowerCase().replace(/\b(fc|afc|and)\b/g, '').replace(/[^a-z]/g, '');
  const ca = FPL_CLUB_FULL[clean(a)] ?? clean(a);
  const cb = FPL_CLUB_FULL[clean(b)] ?? clean(b);
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}
