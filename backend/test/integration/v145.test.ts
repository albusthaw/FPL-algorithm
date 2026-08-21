/**
 * v1.4.5 — A4 walk-forward backtest into model_errors, A5 team-style DEFCON
 * multipliers, A7 distribution quantiles + GK save rate, chip-baseline
 * plumbing sanity.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { seedProviders } from '../../src/ingest/registry.js';
import { walkForwardBacktest } from '../../src/stats/backtest.js';
import { writeTeamStyleStats, loadTeamStyleMults } from '../../src/stats/team-style.js';
import { simulateQuantiles, mulberry32 } from '../../src/match/engine.js';
import { computePlayerFeatures, type MatchRow } from '../../src/stats/l0-features.js';

let db: Knex;

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedProviders(db);
});

/** Synthetic league: 10 teams, 20 events × 5 fixtures, deterministic scores
 *  (T0/T1 strong), one MID + one GK per team with per-GW rows. */
async function seedSyntheticSeason(): Promise<void> {
  const season = '2024/25';
  const start = new Date('2024-08-10T14:00:00Z').getTime();
  const teams = Array.from({ length: 10 }, (_, i) => ({ uid: `team_S${i}`, fpl_code: 100 + i, fpl_id: i + 1, name: `Club ${i}`, short_name: `C${i}`, strength: '{}' }));
  await db('teams').insert(teams);
  const players: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    players.push(
      { uid: `plr_M${i}`, fpl_code: 500 + i, fpl_id: 500 + i, web_name: `Mid${i}`, position: 'MID', team_uid: `team_S${i}`, now_cost: 70 },
      { uid: `plr_G${i}`, fpl_code: 600 + i, fpl_id: 600 + i, web_name: `Gk${i}`, position: 'GK', team_uid: `team_S${i}`, now_cost: 45 },
    );
  }
  await db('players').insert(players);

  const strength = (i: number): number => (i <= 1 ? 2 : i <= 5 ? 1 : 0.6);
  const fxRows: Record<string, unknown>[] = [];
  const pmsRows: Record<string, unknown>[] = [];
  let fplId = 1;
  for (let ev = 1; ev <= 20; ev++) {
    const kickoff = new Date(start + (ev - 1) * 7 * 86_400_000);
    for (let k = 0; k < 5; k++) {
      const home = (k * 2 + ev) % 10;
      const away = (k * 2 + 1 + ev) % 10;
      if (home === away) continue;
      const hs = Math.round(strength(home)) + (ev % 3 === 0 ? 1 : 0);
      const as = Math.round(strength(away) * 0.8);
      const fixtureUid = `fx_S${ev}_${k}`;
      fxRows.push({
        fixture_uid: fixtureUid,
        season,
        fpl_fixture_id: fplId++,
        event: ev,
        home_team_uid: `team_S${home}`,
        away_team_uid: `team_S${away}`,
        kickoff_utc: kickoff,
        state: 'checked',
        home_score: hs,
        away_score: as,
        stats: '{}',
      });
      for (const [idx, isHome] of [[home, true], [away, false]] as [number, boolean][]) {
        const gf = isHome ? hs : as;
        const ga = isHome ? as : hs;
        const goals = Math.min(2, gf);
        pmsRows.push({
          player_uid: `plr_M${idx}`,
          fixture_uid: fixtureUid,
          event: ev,
          season,
          was_home: isHome,
          kickoff_utc: kickoff,
          minutes: 90,
          starts: true,
          goals,
          assists: 0,
          saves: 0,
          conceded: 0,
          cs: ga === 0,
          cbit: 2,
          cbirt: 6 + (idx % 3) * 2,
          xg: goals * 0.7 + 0.2,
          xa: 0.1,
          fpl_points: 2 + goals * 5 + (ga === 0 ? 1 : 0),
          yc: 0,
          rc: 0,
        });
        pmsRows.push({
          player_uid: `plr_G${idx}`,
          fixture_uid: fixtureUid,
          event: ev,
          season,
          was_home: isHome,
          kickoff_utc: kickoff,
          minutes: 90,
          starts: true,
          goals: 0,
          assists: 0,
          saves: 3,
          conceded: ga,
          cs: ga === 0,
          cbit: 8,
          cbirt: 9,
          xg: 0,
          xa: 0,
          fpl_points: 2 + (ga === 0 ? 4 : 0) + 1 - Math.floor(ga / 2),
          yc: 0,
          rc: 0,
        });
      }
    }
  }
  await db('fixtures').insert(fxRows);
  for (let i = 0; i < pmsRows.length; i += 300) await db('player_match_stats').insert(pmsRows.slice(i, i + 300));
}

describe('A4 — walk-forward backtest', () => {
  it('replays history as-of each deadline, writes model_errors under a backtest run', async () => {
    await seedSyntheticSeason();
    const m = await walkForwardBacktest(db, { eventFrom: 14, maxPlayersPerEvent: 40 });
    expect(m.samples).toBeGreaterThan(50);
    expect(m.events).toBeGreaterThanOrEqual(5);
    expect(m.fixtures).toBeGreaterThan(20);
    expect(m.maeXpts).toBeGreaterThan(0);
    expect(m.maeXpts).toBeLessThan(6); // sanity: it predicts points, not noise
    expect(m.fixtureBrier).toBeLessThan(0.667); // beats the uniform guess
    expect(m.runId).not.toBeNull();
    const run = await db('runs').where('id', m.runId!).first();
    expect(run.kind).toBe('backtest');
    expect(run.status).toBe('complete');
    const errCount = Number((await db('model_errors').where('run_id', m.runId!).count('* as c').first())!.c);
    expect(errCount).toBe(m.samples);
  }, 120_000);
});

describe('A5 — opponent-style DEFCON multipliers', () => {
  it('teams inducing more opponent CBIRT get a higher multiplier, clamped', async () => {
    await seedSyntheticSeason();
    // make team_S9's OPPONENTS log huge CBIRT (S9 induces defensive work)
    await db.raw(
      `UPDATE player_match_stats pms SET cbirt = 30
       FROM fixtures f
       WHERE f.fixture_uid = pms.fixture_uid
         AND ((pms.was_home = true AND f.away_team_uid = 'team_S9') OR (pms.was_home = false AND f.home_team_uid = 'team_S9'))`,
    );
    const r = await writeTeamStyleStats(db);
    expect(r.teams).toBeGreaterThan(5);
    const mults = await loadTeamStyleMults(db);
    const s9 = mults.get('team_S9')!;
    const others = [...mults.entries()].filter(([k]) => k !== 'team_S9').map(([, v]) => v);
    expect(s9).toBeGreaterThan(Math.max(...others));
    expect(s9).toBeLessThanOrEqual(1.25); // ⚙ clamp
  });
});

describe('A7 — distribution quantiles + GK save rate', () => {
  it('simulateQuantiles: p10 ≤ p50 ≤ p90, and a nailed scorer has a real ceiling', () => {
    const rng = mulberry32(42);
    const q = simulateQuantiles(
      [{ p60: 0.95, p_any: 0.99, e_goals: 0.6, e_assists: 0.3, p_cs: 0.3, p_defcon: 0.05, e_saves: 0, e_bonus: 0.8 }],
      'FWD',
      { goal: { FWD: 4 }, clean_sheet: { FWD: 0 }, assist: 3, saves_per_point: 3 },
      rng,
    );
    expect(q.p10).toBeLessThanOrEqual(q.p50);
    expect(q.p50).toBeLessThanOrEqual(q.p90);
    expect(q.p90).toBeGreaterThanOrEqual(8); // a goal + bonus day exists
    expect(q.p10).toBeLessThanOrEqual(2); // a blank day exists
  });

  it('L0 save rate: a high-save keeper beats the league mean, small samples stay ~0.70', () => {
    const mk = (saves: number, conceded: number, i: number): MatchRow => ({
      kickoff: new Date(Date.now() - (i * 7 + 1) * 86_400_000),
      minutes: 90,
      starts: true,
      goals: 0,
      assists: 0,
      saves,
      conceded,
      cbit: 5,
      cbirt: 6,
      defconCount: 0,
      xg: 0,
      xa: 0,
      fplPoints: 3,
      yc: 0,
      rc: 0,
      wasHome: i % 2 === 0,
    });
    const eliteRows = Array.from({ length: 20 }, (_, i) => mk(5, 1, i)); // 100 shots, .833 raw
    const elite = computePlayerFeatures(eliteRows, new Date(), 'GK');
    expect(elite.saveRate).toBeGreaterThan(0.75);
    expect(elite.saveRate).toBeLessThanOrEqual(0.85);
    const thin = computePlayerFeatures([mk(4, 0, 0)], new Date(), 'GK');
    expect(Math.abs(thin.saveRate - 0.7)).toBeLessThan(0.03);
  });
});
