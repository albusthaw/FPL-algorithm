/**
 * A5 (v1.4.5) — opponent-style DEFCON multiplier (fixes audit S4: the
 * composer input and the team_style_stats table both existed with nothing
 * feeding them).
 *
 * Teams differ in how many defensive contributions they INDUCE in their
 * opponents: possession/cross-heavy sides let opposing defenders rack up
 * clearances-blocks-interceptions-tackles. Per team, over the last ⚙
 * defcon.window_matches finished matches: mean opposing-player CBIRT per
 * match, normalised by the league mean, clamped to ⚙ defcon.mult_range —
 * written to team_style_stats and consumed by composeXpts as defconOppMult.
 */
import type { Knex } from 'knex';
import { getConfig } from '../core/model-config.js';
import { log } from '../core/logger.js';

export interface TeamStyleRow {
  team_uid: string;
  defcon_induced_mult: number;
  sample_matches: number;
}

export async function writeTeamStyleStats(db: Knex): Promise<{ teams: number }> {
  const cfg = (await getConfig<{ window_matches: number; mult_range: [number, number] }>(db, 'defcon').catch(() => null)) ?? {
    window_matches: 15,
    mult_range: [0.8, 1.25] as [number, number],
  };

  // per (fixture, defending side): total CBIRT the OTHER side's players logged
  const rows = (await db.raw(
    `SELECT f.fixture_uid, f.kickoff_utc,
            CASE WHEN pms.was_home THEN f.away_team_uid ELSE f.home_team_uid END AS inducing_team,
            SUM(pms.cbirt) AS cbirt
     FROM player_match_stats pms
     JOIN fixtures f ON f.fixture_uid = pms.fixture_uid
     WHERE pms.was_home IS NOT NULL AND pms.minutes > 0
     GROUP BY f.fixture_uid, f.kickoff_utc, inducing_team`,
  )) as { rows: { fixture_uid: string; kickoff_utc: Date; inducing_team: string; cbirt: string }[] };

  // last N matches per inducing team
  const byTeam = new Map<string, { kickoff: number; cbirt: number }[]>();
  for (const r of rows.rows) {
    (byTeam.get(r.inducing_team) ?? byTeam.set(r.inducing_team, []).get(r.inducing_team)!).push({
      kickoff: new Date(r.kickoff_utc).getTime(),
      cbirt: Number(r.cbirt),
    });
  }
  const perTeam = new Map<string, { mean: number; n: number }>();
  for (const [team, list] of byTeam) {
    const recent = list.sort((a, b) => b.kickoff - a.kickoff).slice(0, cfg.window_matches);
    if (recent.length < 3) continue;
    perTeam.set(team, { mean: recent.reduce((s, x) => s + x.cbirt, 0) / recent.length, n: recent.length });
  }
  if (perTeam.size === 0) return { teams: 0 };
  const leagueMean = [...perTeam.values()].reduce((s, x) => s + x.mean, 0) / perTeam.size;

  // only CURRENT teams (fpl_id set) get rows — historical clubs stay out
  const current = new Set((await db('teams').whereNotNull('fpl_id').pluck('uid')) as string[]);
  let written = 0;
  const [lo, hi] = cfg.mult_range;
  for (const [team, agg] of perTeam) {
    if (!current.has(team)) continue;
    const mult = Math.min(hi, Math.max(lo, leagueMean > 0 ? agg.mean / leagueMean : 1));
    await db.raw(
      `INSERT INTO team_style_stats (team_uid, stat_window, stats, as_of)
       VALUES (?, ?, ?, now())
       ON CONFLICT (team_uid, stat_window) DO UPDATE SET stats = excluded.stats, as_of = now()`,
      [
        team,
        `defcon_${cfg.window_matches}`,
        JSON.stringify({ defcon_induced_mult: Number(mult.toFixed(3)), cbirt_per_match: Number(agg.mean.toFixed(2)), league_mean: Number(leagueMean.toFixed(2)), sample_matches: agg.n }),
      ],
    );
    written++;
  }
  log.info({ teams: written, leagueMean: Number(leagueMean.toFixed(1)) }, 'team style pass (defcon induced)');
  return { teams: written };
}

/** Read the multipliers back for the engine: teamUid → defcon_induced_mult. */
export async function loadTeamStyleMults(db: Knex): Promise<Map<string, number>> {
  const rows = (await db('team_style_stats').where('stat_window', 'like', 'defcon\\_%').select('team_uid', 'stats')) as {
    team_uid: string;
    stats: { defcon_induced_mult?: number };
  }[];
  return new Map(rows.map((r) => [r.team_uid, Number(r.stats?.defcon_induced_mult ?? 1) || 1]));
}
