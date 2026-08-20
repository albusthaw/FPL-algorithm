import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { log } from '../core/logger.js';
import type { FetchFn } from './http.js';

/**
 * S7 historical bootstrap import (fpl-engines-plan.md §1.3): one-time import
 * of per-GW player rows from the vaastav dataset, aligned by FPL `code`.
 * Lands in the SAME canonical tables flagged source='historical_import' so
 * the feature factory works uniformly over history and live data.
 */

const VAASTAV_BASE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const toInt = (s: string | undefined): number => {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};
const toDec = (s: string | undefined): number | null => {
  if (s == null || s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

export async function importHistoricalSeason(
  db: Knex,
  seasonDir: string, // e.g. "2025-26"
  fetchFn: FetchFn = fetch,
): Promise<{ fixtures: number; playerRows: number; unmappedPlayers: number; teams: number }> {
  const seasonLabelStr = seasonDir.replace('-', '/'); // 2025-26 -> 2025/26

  const [teamsCsv, playersCsv, gwsCsv] = await Promise.all([
    fetchFn(`${VAASTAV_BASE}/${seasonDir}/teams.csv`).then((r) => r.text()),
    fetchFn(`${VAASTAV_BASE}/${seasonDir}/players_raw.csv`).then((r) => r.text()),
    fetchFn(`${VAASTAV_BASE}/${seasonDir}/gws/merged_gw.csv`).then((r) => r.text()),
  ]);

  const teamsRows = parseCsv(teamsCsv);
  const playersRows = parseCsv(playersCsv);
  const gwRows = parseCsv(gwsCsv);

  // ── teams: codes are stable cross-season; mint rows for teams we don't have
  const teamUidBySeasonId = new Map<number, string>();
  let teamCount = 0;
  for (const t of teamsRows) {
    const code = toInt(t.code);
    const id = toInt(t.id);
    if (!code || !id) continue;
    let existing = await db('teams').where('fpl_code', code).first('uid');
    if (!existing) {
      const uid = `team_${ulid()}`;
      await db('teams').insert({
        uid,
        fpl_code: code,
        fpl_id: null, // not a current-season team
        name: t.name ?? `team-${code}`,
        short_name: t.short_name ?? String(code),
        strength: JSON.stringify({}),
      });
      existing = { uid };
      teamCount++;
    }
    teamUidBySeasonId.set(id, existing.uid);
  }

  // ── players: map per-season element id -> code -> our uid (only players FPL currently has)
  const playerUidBySeasonId = new Map<number, string>();
  let unmapped = 0;
  const codeToUid = new Map<number, string>(
    (await db('players').select('uid', 'fpl_code')).map((p) => [p.fpl_code, p.uid]),
  );
  for (const p of playersRows) {
    const code = toInt(p.code);
    const id = toInt(p.id);
    if (!code || !id) continue;
    const uid = codeToUid.get(code);
    if (uid) playerUidBySeasonId.set(id, uid);
    else unmapped++;
  }

  // ── fixtures: reconstruct from gw rows (fixture id + scores + kickoff + teams)
  // Each fixture appears once per participating player; collapse to unique.
  interface FxAgg { fplId: number; round: number; kickoff: string; homeId: number; awayId: number; hScore: number; aScore: number }
  const fxMap = new Map<number, FxAgg>();
  const teamIdByName = new Map<string, number>(teamsRows.map((t) => [t.name!, toInt(t.id)]));
  for (const r of gwRows) {
    const fplId = toInt(r.fixture);
    if (!fplId || fxMap.has(fplId)) continue;
    const wasHome = r.was_home === 'True' || r.was_home === 'true';
    const ownTeamId = teamIdByName.get(r.team ?? '') ?? 0;
    const oppId = toInt(r.opponent_team);
    if (!ownTeamId || !oppId) continue;
    fxMap.set(fplId, {
      fplId,
      round: toInt(r.round || r.GW),
      kickoff: r.kickoff_time ?? '',
      homeId: wasHome ? ownTeamId : oppId,
      awayId: wasHome ? oppId : ownTeamId,
      hScore: toInt(r.team_h_score),
      aScore: toInt(r.team_a_score),
    });
  }

  const fxUidByFplId = new Map<number, string>();
  let fxCount = 0;
  await db.transaction(async (trx) => {
    for (const fx of fxMap.values()) {
      const homeUid = teamUidBySeasonId.get(fx.homeId);
      const awayUid = teamUidBySeasonId.get(fx.awayId);
      if (!homeUid || !awayUid) continue;
      const existing = await trx('fixtures')
        .where({ season: seasonLabelStr, fpl_fixture_id: fx.fplId })
        .first('fixture_uid');
      const uid = existing?.fixture_uid ?? `fx_${ulid()}`;
      fxUidByFplId.set(fx.fplId, uid);
      if (!existing) {
        await trx('fixtures').insert({
          fixture_uid: uid,
          season: seasonLabelStr,
          fpl_fixture_id: fx.fplId,
          event: fx.round,
          home_team_uid: homeUid,
          away_team_uid: awayUid,
          kickoff_utc: fx.kickoff || null,
          state: 'checked',
          home_score: fx.hScore,
          away_score: fx.aScore,
          stats: JSON.stringify({ source: 'historical_import' }),
        });
        fxCount++;
      }
    }
  });

  // ── player match rows → player_match_stats (batch insert)
  let rowCount = 0;
  const batch: Record<string, unknown>[] = [];
  for (const r of gwRows) {
    const seasonId = toInt(r.element);
    const playerUid = playerUidBySeasonId.get(seasonId);
    const fixtureUid = fxUidByFplId.get(toInt(r.fixture));
    if (!playerUid || !fixtureUid) continue;
    const cbi = toInt(r.clearances_blocks_interceptions);
    const tackles = toInt(r.tackles);
    const recoveries = toInt(r.recoveries);
    batch.push({
      player_uid: playerUid,
      fixture_uid: fixtureUid,
      event: toInt(r.round || r.GW),
      season: seasonLabelStr,
      opponent_uid: teamUidBySeasonId.get(toInt(r.opponent_team)) ?? null,
      was_home: r.was_home === 'True' || r.was_home === 'true',
      minutes: toInt(r.minutes),
      starts: toInt(r.starts) > 0,
      goals: toInt(r.goals_scored),
      assists: toInt(r.assists),
      cs: toInt(r.clean_sheets) > 0,
      conceded: toInt(r.goals_conceded),
      og: toInt(r.own_goals),
      pen_saved: toInt(r.penalties_saved),
      pen_missed: toInt(r.penalties_missed),
      yc: toInt(r.yellow_cards),
      rc: toInt(r.red_cards),
      saves: toInt(r.saves),
      bonus: toInt(r.bonus),
      bps: toInt(r.bps),
      defcon_count: toInt(r.defensive_contribution),
      cbit: cbi + tackles,
      cbirt: cbi + tackles + recoveries,
      recoveries,
      tackles,
      xg: toDec(r.expected_goals),
      xa: toDec(r.expected_assists),
      xgi: toDec(r.expected_goal_involvements),
      xgc: toDec(r.expected_goals_conceded),
      fpl_points: toInt(r.total_points),
      price_at_gw: toInt(r.value),
      kickoff_utc: r.kickoff_time || null,
      provenance: JSON.stringify({ source: 'historical_import', dataset: 'vaastav', season: seasonDir, position: r.position ?? null }),
    });
    rowCount++;
  }
  // dedupe within the batch (the dataset can re-emit modified rows; a second
  // occurrence of the same (player, fixture) key wins — it is the newer row)
  const dedup = new Map<string, Record<string, unknown>>();
  for (const row of batch) dedup.set(`${row.player_uid}|${row.fixture_uid}`, row);
  const deduped = [...dedup.values()];
  rowCount = deduped.length;
  // chunked upsert, ≤500 rows per transaction (integration plan §1.4)
  for (let i = 0; i < deduped.length; i += 500) {
    const chunk = deduped.slice(i, i + 500);
    await db('player_match_stats')
      .insert(chunk)
      .onConflict(['player_uid', 'fixture_uid'])
      .merge();
  }

  log.info({ season: seasonDir, fixtures: fxCount, playerRows: rowCount, unmappedPlayers: unmapped, newTeams: teamCount }, 'historical import complete');
  return { fixtures: fxCount, playerRows: rowCount, unmappedPlayers: unmapped, teams: teamCount };
}
