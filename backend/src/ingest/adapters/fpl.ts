import { z } from 'zod';
import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { config } from '../../core/config.js';
import { fetchWithSnapshot, logPull, type FetchFn } from '../http.js';
import { PullError } from '../errors.js';
import { normaliseName } from '../../players/resolver.js';
import { log } from '../../core/logger.js';

const FPL_BASE = 'https://fantasy.premierleague.com/api';

/**
 * Zod schemas: .passthrough() tolerates unknown ADDITIONS (schema drift is
 * seasonal — log new keys, don't fail); missing/retyped KNOWN fields hard-fail.
 * element_type tolerates unknown values (the 24/25 type-5 AM experiment).
 */
const ElementSchema = z
  .object({
    id: z.number(),
    code: z.number(),
    first_name: z.string(),
    second_name: z.string(),
    web_name: z.string(),
    team: z.number(),
    team_code: z.number(),
    element_type: z.number(),
    status: z.string(),
    chance_of_playing_this_round: z.number().nullable(),
    chance_of_playing_next_round: z.number().nullable(),
    news: z.string(),
    news_added: z.string().nullable(),
    now_cost: z.number(),
    cost_change_event: z.number(),
    selected_by_percent: z.string(),
    transfers_in_event: z.number(),
    transfers_out_event: z.number(),
    total_points: z.number(),
    event_points: z.number(),
    minutes: z.number(),
    starts: z.number(),
    goals_scored: z.number(),
    assists: z.number(),
    clean_sheets: z.number(),
    goals_conceded: z.number(),
    own_goals: z.number(),
    penalties_saved: z.number(),
    penalties_missed: z.number(),
    yellow_cards: z.number(),
    red_cards: z.number(),
    saves: z.number(),
    bonus: z.number(),
    bps: z.number(),
    form: z.string(),
    points_per_game: z.string(),
    ep_this: z.string().nullable(),
    ep_next: z.string().nullable(),
    expected_goals: z.string(),
    expected_assists: z.string(),
    expected_goal_involvements: z.string(),
    expected_goals_conceded: z.string(),
    influence: z.string(),
    creativity: z.string(),
    threat: z.string(),
    ict_index: z.string(),
    defensive_contribution: z.number().optional().default(0),
    clearances_blocks_interceptions: z.number().optional().default(0),
    recoveries: z.number().optional().default(0),
    tackles: z.number().optional().default(0),
    penalties_order: z.number().nullable().optional(),
    direct_freekicks_order: z.number().nullable().optional(),
    corners_and_indirect_freekicks_order: z.number().nullable().optional(),
    squad_number: z.number().nullable().optional(),
    birth_date: z.string().nullable().optional(),
  })
  .passthrough();

const TeamSchema = z
  .object({
    id: z.number(),
    code: z.number(),
    name: z.string(),
    short_name: z.string(),
    strength_overall_home: z.number().nullable().optional(),
    strength_overall_away: z.number().nullable().optional(),
    strength_attack_home: z.number().nullable().optional(),
    strength_attack_away: z.number().nullable().optional(),
    strength_defence_home: z.number().nullable().optional(),
    strength_defence_away: z.number().nullable().optional(),
  })
  .passthrough();

const EventSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    deadline_time: z.string(),
    finished: z.boolean(),
    data_checked: z.boolean(),
    is_current: z.boolean(),
    is_next: z.boolean(),
    average_entry_score: z.number().nullable(),
  })
  .passthrough();

const BootstrapSchema = z
  .object({
    events: z.array(EventSchema),
    teams: z.array(TeamSchema),
    elements: z.array(ElementSchema),
  })
  .passthrough();

const FixtureSchema = z
  .object({
    id: z.number(),
    code: z.number(),
    event: z.number().nullable(),
    team_h: z.number(),
    team_a: z.number(),
    kickoff_time: z.string().nullable(),
    started: z.boolean().nullable(),
    finished: z.boolean(),
    finished_provisional: z.boolean().optional(),
    team_h_score: z.number().nullable(),
    team_a_score: z.number().nullable(),
    team_h_difficulty: z.number(),
    team_a_difficulty: z.number(),
    stats: z.array(z.object({ identifier: z.string(), h: z.array(z.any()), a: z.array(z.any()) }).passthrough()).optional().default([]),
  })
  .passthrough();

const HistoryRowSchema = z
  .object({
    element: z.number(),
    fixture: z.number(),
    opponent_team: z.number(),
    was_home: z.boolean(),
    round: z.number(),
    minutes: z.number(),
    starts: z.number().optional().default(0),
    goals_scored: z.number(),
    assists: z.number(),
    clean_sheets: z.number(),
    goals_conceded: z.number(),
    own_goals: z.number(),
    penalties_saved: z.number(),
    penalties_missed: z.number(),
    yellow_cards: z.number(),
    red_cards: z.number(),
    saves: z.number(),
    bonus: z.number(),
    bps: z.number(),
    total_points: z.number(),
    value: z.number(),
    expected_goals: z.string().optional(),
    expected_assists: z.string().optional(),
    expected_goal_involvements: z.string().optional(),
    expected_goals_conceded: z.string().optional(),
    defensive_contribution: z.number().optional().default(0),
    clearances_blocks_interceptions: z.number().optional().default(0),
    recoveries: z.number().optional().default(0),
    tackles: z.number().optional().default(0),
    kickoff_time: z.string().nullable().optional(),
  })
  .passthrough();

const ElementSummarySchema = z
  .object({
    history: z.array(HistoryRowSchema),
    history_past: z.array(z.object({ season_name: z.string() }).passthrough()),
  })
  .passthrough();

export const POSITION_BY_TYPE: Record<number, string> = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };

function fplHeaders(): Record<string, string> {
  return { 'User-Agent': config.fplUserAgent, Accept: 'application/json' };
}

export function seasonLabel(firstDeadline: string): string {
  const year = new Date(firstDeadline).getUTCFullYear();
  const month = new Date(firstDeadline).getUTCMonth();
  const startYear = month >= 6 ? year : year - 1;
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export async function syncFplBootstrap(
  db: Knex,
  fetchFn?: FetchFn,
): Promise<{ players: number; teams: number; events: number; newPlayers: number; priceChanges: number }> {
  const snap = await fetchWithSnapshot(db, {
    provider: 'fpl',
    endpoint: 'bootstrap-static',
    url: `${FPL_BASE}/bootstrap-static/`,
    headers: fplHeaders(),
    fetchFn,
  });

  const parsed = BootstrapSchema.safeParse(snap.body);
  if (!parsed.success) {
    await db('quarantine_rows').insert({
      provider: 'fpl',
      endpoint: 'bootstrap-static',
      raw_payload_id: snap.rawPayloadId,
      row: JSON.stringify({ note: 'bootstrap failed schema validation' }),
      errors: JSON.stringify(parsed.error.issues.slice(0, 50)),
    });
    await logPull(db, { provider: 'fpl', capability: 'stats', endpoint: 'bootstrap-static', status: 'failed', errorClass: 'SCHEMA_DRIFT', errorDetail: parsed.error.message.slice(0, 500) });
    throw new PullError('SCHEMA_DRIFT', 'FPL bootstrap-static failed schema validation', parsed.error.issues.slice(0, 10));
  }
  const boot = parsed.data;

  let newPlayers = 0;
  let priceChanges = 0;

  await db.transaction(async (trx) => {
    // gameweeks
    for (const ev of boot.events) {
      await trx.raw(
        `INSERT INTO gameweeks (id, name, deadline_time, finished, data_checked, is_current, is_next, average_entry_score, as_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, deadline_time = excluded.deadline_time,
           finished = excluded.finished, data_checked = excluded.data_checked,
           is_current = excluded.is_current, is_next = excluded.is_next,
           average_entry_score = excluded.average_entry_score, as_of = now()`,
        [ev.id, ev.name, ev.deadline_time, ev.finished, ev.data_checked, ev.is_current, ev.is_next, ev.average_entry_score],
      );
    }

    // teams — keyed by stable code
    const teamUidByFplId = new Map<number, string>();
    for (const t of boot.teams) {
      const existing = await trx('teams').where('fpl_code', t.code).first('uid');
      const uid = existing?.uid ?? `team_${ulid()}`;
      teamUidByFplId.set(t.id, uid);
      const strength = {
        overall_home: t.strength_overall_home,
        overall_away: t.strength_overall_away,
        attack_home: t.strength_attack_home,
        attack_away: t.strength_attack_away,
        defence_home: t.strength_defence_home,
        defence_away: t.strength_defence_away,
      };
      await trx.raw(
        `INSERT INTO teams (uid, fpl_code, fpl_id, name, short_name, strength, as_of)
         VALUES (?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (fpl_code) DO UPDATE SET
           fpl_id = excluded.fpl_id, name = excluded.name,
           short_name = excluded.short_name, strength = excluded.strength, as_of = now()`,
        [uid, t.code, t.id, t.name, t.short_name, JSON.stringify(strength)],
      );
    }

    // players — UID lifecycle: minted only here, from new FPL codes
    for (const el of boot.elements) {
      const position = POSITION_BY_TYPE[el.element_type] ?? 'UNK';
      const teamUid = teamUidByFplId.get(el.team) ?? null;
      const fullName = `${el.first_name} ${el.second_name}`.trim();
      const seasonStats = {
        total_points: el.total_points,
        event_points: el.event_points,
        minutes: el.minutes,
        starts: el.starts,
        goals_scored: el.goals_scored,
        assists: el.assists,
        clean_sheets: el.clean_sheets,
        goals_conceded: el.goals_conceded,
        saves: el.saves,
        bonus: el.bonus,
        bps: el.bps,
        form: el.form,
        points_per_game: el.points_per_game,
        ep_next: el.ep_next, // benchmark only — never a model input
        expected_goals: el.expected_goals,
        expected_assists: el.expected_assists,
        expected_goal_involvements: el.expected_goal_involvements,
        expected_goals_conceded: el.expected_goals_conceded,
        defensive_contribution: el.defensive_contribution,
        cbi: el.clearances_blocks_interceptions,
        recoveries: el.recoveries,
        tackles: el.tackles,
        ict_index: el.ict_index,
        yellow_cards: el.yellow_cards,
        red_cards: el.red_cards,
        own_goals: el.own_goals,
        penalties_saved: el.penalties_saved,
        penalties_missed: el.penalties_missed,
      };

      const existing = await trx('players').where('fpl_code', el.code).first('uid', 'now_cost', 'element_type');
      let uid: string;
      if (!existing) {
        uid = `plr_${ulid()}`;
        newPlayers++;
        await trx('players').insert({
          uid,
          fpl_code: el.code,
          fpl_id: el.id,
          web_name: el.web_name,
          first_name: el.first_name,
          second_name: el.second_name,
          full_name: fullName,
          position,
          element_type: el.element_type,
          team_uid: teamUid,
          shirt: el.squad_number ?? null,
          birthdate: el.birth_date ?? null,
          status: el.status,
          news: el.news,
          news_added: el.news_added,
          chance_this: el.chance_of_playing_this_round,
          chance_next: el.chance_of_playing_next_round,
          now_cost: el.now_cost,
          selected_by_percent: el.selected_by_percent,
          transfers_in_event: el.transfers_in_event,
          transfers_out_event: el.transfers_out_event,
          season_stats: JSON.stringify(seasonStats),
        });
        await trx.raw(
          `INSERT INTO player_identities (player_uid, provider, provider_id, provider_name, confidence, matched_by)
           VALUES (?, 'fpl', ?, ?, 1.0, 'code') ON CONFLICT (provider, provider_id) DO NOTHING`,
          [uid, String(el.code), fullName],
        );
        await trx('player_position_history').insert({ player_uid: uid, position, element_type: el.element_type });
      } else {
        uid = existing.uid;
        if (existing.now_cost !== el.now_cost && existing.now_cost > 0) {
          priceChanges++;
          await trx('price_events').insert({
            player_uid: uid,
            event_date: new Date().toISOString().slice(0, 10),
            old_cost: existing.now_cost,
            new_cost: el.now_cost,
          });
        }
        if (existing.element_type !== el.element_type) {
          await trx('player_position_history').insert({ player_uid: uid, position, element_type: el.element_type });
        }
        await trx('players').where('uid', uid).update({
          fpl_id: el.id,
          web_name: el.web_name,
          first_name: el.first_name,
          second_name: el.second_name,
          full_name: fullName,
          position,
          element_type: el.element_type,
          team_uid: teamUid,
          shirt: el.squad_number ?? null,
          birthdate: el.birth_date ?? null,
          status: el.status,
          news: el.news,
          news_added: el.news_added,
          chance_this: el.chance_of_playing_this_round,
          chance_next: el.chance_of_playing_next_round,
          now_cost: el.now_cost,
          selected_by_percent: el.selected_by_percent,
          transfers_in_event: el.transfers_in_event,
          transfers_out_event: el.transfers_out_event,
          season_stats: JSON.stringify(seasonStats),
          as_of: trx.fn.now(),
        });
      }

      // alias seeding: web_name + full name (normalised)
      for (const alias of new Set([normaliseName(el.web_name), normaliseName(fullName)])) {
        if (!alias) continue;
        await trx.raw(
          `INSERT INTO player_aliases (player_uid, alias, source) VALUES (?, ?, 'fpl')
           ON CONFLICT (player_uid, alias) DO NOTHING`,
          [uid, alias],
        );
      }

      // set-piece roles (fpl source never overwrites an admin override)
      if (el.penalties_order != null || el.direct_freekicks_order != null || el.corners_and_indirect_freekicks_order != null) {
        await trx.raw(
          `INSERT INTO set_piece_roles (player_uid, pens_order, dfk_order, corners_order, source, as_of)
           VALUES (?, ?, ?, ?, 'fpl', now())
           ON CONFLICT (player_uid) DO UPDATE SET
             pens_order = excluded.pens_order, dfk_order = excluded.dfk_order,
             corners_order = excluded.corners_order, as_of = now()
           WHERE set_piece_roles.source = 'fpl'`,
          [uid, el.penalties_order ?? null, el.direct_freekicks_order ?? null, el.corners_and_indirect_freekicks_order ?? null],
        );
      }
    }
  });

  await logPull(db, {
    provider: 'fpl',
    capability: 'stats',
    endpoint: 'bootstrap-static',
    records: boot.elements.length,
    latencyMs: snap.latencyMs,
    status: 'ok',
  });

  return { players: boot.elements.length, teams: boot.teams.length, events: boot.events.length, newPlayers, priceChanges };
}

export async function syncFplFixtures(db: Knex, fetchFn?: FetchFn): Promise<{ fixtures: number }> {
  const snap = await fetchWithSnapshot(db, {
    provider: 'fpl',
    endpoint: 'fixtures',
    url: `${FPL_BASE}/fixtures/`,
    headers: fplHeaders(),
    fetchFn,
  });
  const parsed = z.array(FixtureSchema).safeParse(snap.body);
  if (!parsed.success) {
    await logPull(db, { provider: 'fpl', capability: 'fixtures', endpoint: 'fixtures', status: 'failed', errorClass: 'SCHEMA_DRIFT' });
    throw new PullError('SCHEMA_DRIFT', 'FPL fixtures failed schema validation', parsed.error.issues.slice(0, 10));
  }

  const teams = await db('teams').select('uid', 'fpl_id');
  const teamUidByFplId = new Map<number, string>(teams.map((t) => [t.fpl_id, t.uid]));
  const firstGw = await db('gameweeks').orderBy('id').first('deadline_time');
  const season = firstGw ? seasonLabel(firstGw.deadline_time) : '';

  let count = 0;
  await db.transaction(async (trx) => {
    for (const fx of parsed.data) {
      const homeUid = teamUidByFplId.get(fx.team_h);
      const awayUid = teamUidByFplId.get(fx.team_a);
      if (!homeUid || !awayUid) {
        log.warn({ fixture: fx.id }, 'fixture references unknown team — skipped');
        continue;
      }
      const state = fx.finished
        ? 'finished'
        : fx.started
          ? 'live'
          : fx.event === null
            ? 'postponed' // unscheduled — pending rearrangement, never dropped
            : 'scheduled';
      const existing = await trx('fixtures')
        .where({ season, fpl_fixture_id: fx.id })
        .first('fixture_uid', 'state');
      const uid = existing?.fixture_uid ?? `fx_${ulid()}`;
      const finalState = existing?.state === 'checked' && state === 'finished' ? 'checked' : state;
      await trx.raw(
        `INSERT INTO fixtures (fixture_uid, season, fpl_fixture_id, fpl_code, event, home_team_uid, away_team_uid,
                               kickoff_utc, state, home_score, away_score, fpl_fdr_h, fpl_fdr_a, stats, as_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (season, fpl_fixture_id) DO UPDATE SET
           event = excluded.event, kickoff_utc = excluded.kickoff_utc, state = excluded.state,
           home_score = excluded.home_score, away_score = excluded.away_score,
           fpl_fdr_h = excluded.fpl_fdr_h, fpl_fdr_a = excluded.fpl_fdr_a,
           stats = excluded.stats, as_of = now()`,
        [uid, season, fx.id, fx.code, fx.event, homeUid, awayUid, fx.kickoff_time, finalState,
          fx.team_h_score, fx.team_a_score, fx.team_h_difficulty, fx.team_a_difficulty,
          JSON.stringify(fx.stats ?? [])],
      );
      count++;
    }
  });

  await logPull(db, { provider: 'fpl', capability: 'fixtures', endpoint: 'fixtures', records: count, latencyMs: snap.latencyMs, status: 'ok' });
  return { fixtures: count };
}

/**
 * Per-player match history from element-summary — the per-match stats
 * backbone. Sequential with pacing on sweeps (≤5 rps), never fan-out ×700.
 */
export async function syncElementSummary(
  db: Knex,
  playerUid: string,
  fetchFn?: FetchFn,
): Promise<{ rows: number }> {
  const player = await db('players').where('uid', playerUid).first('fpl_id', 'team_uid');
  if (!player?.fpl_id) return { rows: 0 };
  const snap = await fetchWithSnapshot(db, {
    provider: 'fpl',
    endpoint: `element-summary/${player.fpl_id}`,
    url: `${FPL_BASE}/element-summary/${player.fpl_id}/`,
    headers: fplHeaders(),
    fetchFn,
  });
  const parsed = ElementSummarySchema.safeParse(snap.body);
  if (!parsed.success) {
    throw new PullError('SCHEMA_DRIFT', `element-summary/${player.fpl_id} failed validation`, parsed.error.issues.slice(0, 5));
  }

  const events = await db('gameweeks').orderBy('id').first('deadline_time');
  const season = events ? seasonLabel(events.deadline_time) : '';
  const fixtures = await db('fixtures').where({ season }).select('fixture_uid', 'fpl_fixture_id', 'event', 'kickoff_utc');
  const fxByFplId = new Map<number, { fixture_uid: string; event: number | null; kickoff_utc: string | null }>(
    fixtures.map((f) => [f.fpl_fixture_id, f]),
  );
  const teams = await db('teams').select('uid', 'fpl_id');
  const teamUidByFplId = new Map<number, string>(teams.map((t) => [t.fpl_id, t.uid]));

  let rows = 0;
  await db.transaction(async (trx) => {
    for (const h of parsed.data.history) {
      const fx = fxByFplId.get(h.fixture);
      if (!fx) continue;
      await trx.raw(
        `INSERT INTO player_match_stats (
           player_uid, fixture_uid, event, season, opponent_uid, was_home, minutes, starts,
           goals, assists, cs, conceded, og, pen_saved, pen_missed, yc, rc, saves, bonus, bps,
           defcon_count, cbit, cbirt, recoveries, tackles, xg, xa, xgi, xgc,
           fpl_points, price_at_gw, kickoff_utc, provenance, as_of)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now())
         ON CONFLICT (player_uid, fixture_uid) DO UPDATE SET
           minutes = excluded.minutes, starts = excluded.starts, goals = excluded.goals,
           assists = excluded.assists, cs = excluded.cs, conceded = excluded.conceded,
           og = excluded.og, pen_saved = excluded.pen_saved, pen_missed = excluded.pen_missed,
           yc = excluded.yc, rc = excluded.rc, saves = excluded.saves, bonus = excluded.bonus,
           bps = excluded.bps, defcon_count = excluded.defcon_count, cbit = excluded.cbit,
           cbirt = excluded.cbirt, recoveries = excluded.recoveries, tackles = excluded.tackles,
           xg = excluded.xg, xa = excluded.xa, xgi = excluded.xgi, xgc = excluded.xgc,
           fpl_points = excluded.fpl_points, price_at_gw = excluded.price_at_gw,
           provenance = excluded.provenance, as_of = now()
         WHERE excluded.as_of > player_match_stats.as_of OR player_match_stats.provenance->>'source' != 'fpl_final'`,
        [
          playerUid, fx.fixture_uid, h.round, season,
          teamUidByFplId.get(h.opponent_team) ?? null, h.was_home, h.minutes, h.starts > 0 || (h.minutes >= 60),
          h.goals_scored, h.assists, h.clean_sheets > 0, h.goals_conceded, h.own_goals,
          h.penalties_saved, h.penalties_missed, h.yellow_cards, h.red_cards, h.saves, h.bonus, h.bps,
          h.defensive_contribution,
          h.clearances_blocks_interceptions + h.tackles, // CBIT
          h.clearances_blocks_interceptions + h.tackles + h.recoveries, // CBIRT
          h.recoveries, h.tackles,
          h.expected_goals ?? null, h.expected_assists ?? null,
          h.expected_goal_involvements ?? null, h.expected_goals_conceded ?? null,
          h.total_points, h.value, h.kickoff_time ?? fx.kickoff_utc,
          JSON.stringify({ source: 'fpl_element_summary' }),
        ],
      );
      rows++;
    }
  });
  await logPull(db, { provider: 'fpl', capability: 'stats', endpoint: 'element-summary', records: rows, latencyMs: snap.latencyMs, status: 'ok' });
  return { rows };
}
