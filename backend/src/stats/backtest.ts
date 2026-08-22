/**
 * A4 (v1.4.5) — the walk-forward backtest & calibration harness (fixes
 * audit S11: model_errors shipped in 0004 and the loop was never built).
 *
 * Replays imported history through the SAME pure functions the live engine
 * uses (fitTeamStrength → predictFromLambdas → computePlayerFeatures →
 * predictMinutes → composeXpts), strictly as-of each historical event's
 * first kickoff — the L0 leakage rule enforced by construction. Errors land
 * in model_errors under a kind='backtest' run; aggregates live on the run
 * row. refitConstants() grid-searches decayXi × kAtt on a subsample and
 * writes IMPROVED constants as new config versions — the engine refits as
 * data, never as code edits.
 *
 * Statistical only. No AI anywhere near this module.
 */
import type { Knex } from 'knex';
import { fitTeamStrength, fixtureLambdas, predictFromLambdas, baselineLambda, type StrengthMatch } from './l1-team-strength.js';
import { computePlayerFeatures, type MatchRow } from './l0-features.js';
import { predictMinutes, type MinutesConfig } from './l3-minutes.js';
import { composeXpts, type ScoringRules, type BonusProfiles } from './l9-composer.js';
import { getConfig, setConfig } from '../core/model-config.js';
import { log } from '../core/logger.js';

export interface BacktestOptions {
  seasons?: string[]; // default: every imported season with ≥ 100 fixtures
  eventFrom?: number; // default 8 — enough same-season history to fit
  eventStep?: number; // default 1; 3 for the quick refit subsample
  maxPlayersPerEvent?: number; // by minutes played that event (default 250)
  decayXi?: number; // override ⚙ for grid search
  kAtt?: number; // override ⚙ for grid search
  writeErrors?: boolean; // default true — persist per-player rows
  triggeredBy?: number | null;
}

export interface BacktestMetrics {
  runId: number | null;
  seasons: string[];
  events: number;
  samples: number;
  maeXpts: number;
  rmseXpts: number;
  maeByPosition: Record<string, number>;
  minutesMae: number;
  fixtureBrier: number; // 1X2 Brier score (lower = better; 0.667 = uniform)
  fixtures: number;
}

interface HistRow {
  player_uid: string;
  fixture_uid: string;
  season: string;
  event: number | null;
  kickoff: Date;
  minutes: number;
  starts: boolean;
  goals: number;
  assists: number;
  saves: number;
  conceded: number;
  cbit: number;
  cbirt: number;
  xg: number | null;
  npxg: number | null;
  xa: number | null;
  fpl_points: number;
  yc: number;
  rc: number;
  was_home: boolean | null;
  cs: boolean;
}

export async function walkForwardBacktest(db: Knex, opts: BacktestOptions = {}): Promise<BacktestMetrics> {
  const scoring = await getConfig<ScoringRules>(db, 'scoring_rules');
  const bonusProfiles = await getConfig<BonusProfiles>(db, 'bonus_profiles');
  const minutesCfg = await getConfig<MinutesConfig>(db, 'minutes_model');
  const ffCfg = await getConfig<Record<string, unknown>>(db, 'feature_factory');
  const featureDecay = await getConfig<{ rate_xi_per_day: number }>(db, 'feature_decay').catch(() => null);
  const decayXi = opts.decayXi ?? featureDecay?.rate_xi_per_day ?? Number(ffCfg.decay_xi_player ?? 0.01);
  const kAtt = opts.kAtt ?? Number(ffCfg.shrinkage_k_attacking ?? ffCfg.shrinkage_k ?? 6);

  // history: every per-GW row with a kickoff, plus fixture facts
  const rows = (await db('player_match_stats as pms')
    .join('fixtures as f', 'f.fixture_uid', 'pms.fixture_uid')
    .whereNotNull('pms.kickoff_utc')
    .select(
      'pms.player_uid', 'pms.fixture_uid', 'pms.season', 'pms.event', 'pms.kickoff_utc as kickoff',
      'pms.minutes', 'pms.starts', 'pms.goals', 'pms.assists', 'pms.saves', 'pms.conceded',
      'pms.cbit', 'pms.cbirt', 'pms.xg', 'pms.npxg', 'pms.xa', 'pms.fpl_points', 'pms.yc', 'pms.rc', 'pms.was_home', 'pms.cs',
    )) as unknown as HistRow[];
  const fixtures = (await db('fixtures')
    .whereNotNull('home_score')
    .whereIn('state', ['finished', 'checked'])
    .select('fixture_uid', 'season', 'event', 'kickoff_utc', 'home_team_uid', 'away_team_uid', 'home_score', 'away_score')) as {
    fixture_uid: string;
    season: string;
    event: number | null;
    kickoff_utc: Date;
    home_team_uid: string;
    away_team_uid: string;
    home_score: number;
    away_score: number;
  }[];
  const positions = new Map<string, string>(
    ((await db('players').select('uid', 'position', 'now_cost')) as { uid: string; position: string; now_cost: number }[]).map((p) => [p.uid, p.position]),
  );

  const seasonCounts = new Map<string, number>();
  for (const f of fixtures) seasonCounts.set(f.season, (seasonCounts.get(f.season) ?? 0) + 1);
  const seasons =
    opts.seasons ?? [...seasonCounts.entries()].filter(([, c]) => c >= 100).map(([s]) => s).sort();
  if (seasons.length === 0) {
    return { runId: null, seasons: [], events: 0, samples: 0, maeXpts: 0, rmseXpts: 0, maeByPosition: {}, minutesMae: 0, fixtureBrier: 0, fixtures: 0 };
  }

  const rowsByPlayer = new Map<string, HistRow[]>();
  for (const r of rows) (rowsByPlayer.get(r.player_uid) ?? rowsByPlayer.set(r.player_uid, []).get(r.player_uid)!).push(r);

  const eventFrom = opts.eventFrom ?? 8;
  const eventStep = opts.eventStep ?? 1;
  const maxPlayers = opts.maxPlayersPerEvent ?? 250;

  let sumAbs = 0;
  let sumSq = 0;
  let samples = 0;
  let minutesAbs = 0;
  const posAbs = new Map<string, { abs: number; n: number }>();
  let brierSum = 0;
  let fixtureCount = 0;
  let eventsTested = 0;
  const errorRows: Record<string, unknown>[] = [];

  for (const season of seasons) {
    const seasonFixtures = fixtures.filter((f) => f.season === season && f.event != null);
    const events = [...new Set(seasonFixtures.map((f) => f.event as number))].sort((a, b) => a - b);
    for (const ev of events) {
      if (ev < eventFrom || (ev - eventFrom) % eventStep !== 0) continue;
      const evFixtures = seasonFixtures.filter((f) => f.event === ev);
      if (evFixtures.length === 0) continue;
      const asOf = new Date(Math.min(...evFixtures.map((f) => new Date(f.kickoff_utc).getTime())) - 3600_000);

      // L1 as-of: every finished fixture before the deadline (all seasons)
      const strengthMatches: StrengthMatch[] = fixtures
        .filter((f) => new Date(f.kickoff_utc).getTime() < asOf.getTime())
        .map((f) => ({
          homeKey: f.home_team_uid,
          awayKey: f.away_team_uid,
          homeGoals: f.home_score,
          awayGoals: f.away_score,
          daysAgo: (asOf.getTime() - new Date(f.kickoff_utc).getTime()) / 86_400_000,
        }));
      if (strengthMatches.length < 50) continue;
      const params = fitTeamStrength(strengthMatches, { iterations: 60 });
      eventsTested++;

      // fixture-level: 1X2 Brier vs what actually happened
      const evPred = new Map<string, ReturnType<typeof predictFromLambdas> & { home: string; away: string }>();
      for (const f of evFixtures) {
        const { lambdaHome, lambdaAway } = fixtureLambdas(params, f.home_team_uid, f.away_team_uid);
        const pred = predictFromLambdas(lambdaHome, lambdaAway, params.rho);
        evPred.set(f.fixture_uid, { ...pred, home: f.home_team_uid, away: f.away_team_uid });
        const oh = f.home_score > f.away_score ? 1 : 0;
        const od = f.home_score === f.away_score ? 1 : 0;
        const oa = f.home_score < f.away_score ? 1 : 0;
        brierSum += (pred.pHome - oh) ** 2 + (pred.pDraw - od) ** 2 + (pred.pAway - oa) ** 2;
        fixtureCount++;
      }

      // player-level: predict the event's xPts for those who actually played,
      // capped by minutes for speed — features strictly as-of the deadline
      const played = rows
        .filter((r) => r.season === season && r.event === ev && r.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, maxPlayers);
      const teamOpponents = new Map<string, string[]>();
      for (const t of params.teams) teamOpponents.set(t, params.teams.filter((x) => x !== t));

      for (const actual of played) {
        const fx = evPred.get(actual.fixture_uid);
        if (!fx) continue;
        const isHome = actual.was_home === true;
        const teamUid = isHome ? fx.home : fx.away;
        const history = (rowsByPlayer.get(actual.player_uid) ?? []).map(
          (r): MatchRow => ({
            kickoff: new Date(r.kickoff),
            minutes: r.minutes,
            starts: r.starts,
            goals: r.goals,
            assists: r.assists,
            saves: r.saves,
            conceded: r.conceded,
            cbit: r.cbit,
            cbirt: r.cbirt,
            defconCount: 0,
            xg: r.xg != null ? Number(r.xg) : null,
            npxg: r.npxg != null ? Number(r.npxg) : null,
            xa: r.xa != null ? Number(r.xa) : null,
            fplPoints: r.fpl_points,
            yc: r.yc,
            rc: r.rc,
            wasHome: r.was_home,
          }),
        );
        const position = positions.get(actual.player_uid) ?? 'MID';
        const features = computePlayerFeatures(history, asOf, position, { decayXi, shrinkageKAttacking: kAtt });
        if (features.matchesUsed < 3) continue; // cold starts measure priors, not the model
        const minutes = predictMinutes(
          {
            status: 'a',
            chanceNext: null,
            activeInjury: null,
            confirmedLineup: null,
            position,
            selectedByPct: 10,
            startShare5: features.startShare5,
            startShareLong: features.startShareLong,
            minutesEwma: features.minutesEwma,
            startedMinutesAvg: features.startedMinutesAvg,
            startedLast: features.startedLast,
            daysSinceLastMatch: features.daysSinceLastMatch,
            congested: false,
            newSigning: false,
            returnedFromInjury: false,
            fixturesAhead: 1,
          },
          minutesCfg,
        );
        const lambda = isHome ? fx.lambdaHome : fx.lambdaAway;
        const base = baselineLambda(params, teamUid, teamOpponents.get(teamUid) ?? []);
        const breakdown = composeXpts(
          {
            position,
            pStart: minutes.pStart,
            p60: minutes.p60,
            pAny: minutes.pAny,
            eMin: minutes.eMin,
            xg90: features.xg90,
            npxg90: features.npxg90,
            xa90: features.xa90,
            saves90: features.saves90,
            saveRate: features.saveRate,
            yc90: features.yc90,
            rc90: features.rc90,
            defconHitRate: features.defconHitRate,
            fixtureMultAtt: base > 0 ? Math.min(2, Math.max(0.5, lambda / base)) : 1,
            pCsTeam: isHome ? fx.pCsHome : fx.pCsAway,
            eConcedePts: isHome ? fx.eConcedePtsHome : fx.eConcedePtsAway,
            lambdaOpponent: isHome ? fx.lambdaAway : fx.lambdaHome,
          },
          scoring,
          bonusProfiles,
        );
        const pred = Number.isFinite(breakdown.total) ? breakdown.total : 0;
        const err = pred - actual.fpl_points;
        sumAbs += Math.abs(err);
        sumSq += err * err;
        samples++;
        minutesAbs += Math.abs(minutes.eMin - actual.minutes);
        const pa = posAbs.get(position) ?? { abs: 0, n: 0 };
        pa.abs += Math.abs(err);
        pa.n++;
        posAbs.set(position, pa);
        if (opts.writeErrors !== false && errorRows.length < 20_000) {
          errorRows.push({
            player_uid: actual.player_uid,
            gameweek: ev,
            xpts_pred: pred.toFixed(3),
            points_actual: actual.fpl_points,
            minutes_pred: minutes.eMin.toFixed(2),
            minutes_actual: actual.minutes,
            cs_prob: (isHome ? fx.pCsHome : fx.pCsAway).toFixed(4),
            cs_actual: actual.cs,
            details: JSON.stringify({ season, fixture: actual.fixture_uid, decay_xi: decayXi, k_att: kAtt }),
          });
        }
      }
    }
  }

  const metrics: BacktestMetrics = {
    runId: null,
    seasons,
    events: eventsTested,
    samples,
    maeXpts: samples > 0 ? Number((sumAbs / samples).toFixed(4)) : 0,
    rmseXpts: samples > 0 ? Number(Math.sqrt(sumSq / samples).toFixed(4)) : 0,
    maeByPosition: Object.fromEntries([...posAbs.entries()].map(([p, a]) => [p, Number((a.abs / Math.max(1, a.n)).toFixed(4))])),
    minutesMae: samples > 0 ? Number((minutesAbs / samples).toFixed(2)) : 0,
    fixtureBrier: fixtureCount > 0 ? Number((brierSum / fixtureCount).toFixed(4)) : 0,
    fixtures: fixtureCount,
  };

  // persist under a kind='backtest' run (model_errors requires a run id)
  if (opts.writeErrors !== false && samples > 0) {
    const [runRow] = await db('runs')
      .insert({
        kind: 'backtest',
        status: 'complete',
        triggered_by: opts.triggeredBy ?? null,
        ai_skipped: true,
        stages: JSON.stringify(metrics),
        finished_at: db.fn.now(),
      })
      .returning('id');
    const runId = Number(runRow.id ?? runRow);
    metrics.runId = runId;
    for (let i = 0; i < errorRows.length; i += 500) {
      await db('model_errors').insert(errorRows.slice(i, i + 500).map((r) => ({ ...r, run_id: runId })));
    }
  }

  log.info({ ...metrics, errorRows: errorRows.length }, 'walk-forward backtest complete');
  return metrics;
}

/**
 * Small grid refit over decayXi × kAtt on a fast subsample. An improvement
 * beyond `minGain` (relative MAE) writes the winners as NEW config versions.
 * Every later engine change can re-run this as the non-regression gate.
 */
export async function refitConstants(
  db: Knex,
  opts: { triggeredBy?: number | null; minGain?: number } = {},
): Promise<{ baseline: number; best: number; decayXi: number; kAtt: number; applied: boolean; grid: { decayXi: number; kAtt: number; mae: number }[] }> {
  const ffCfg = await getConfig<Record<string, unknown>>(db, 'feature_factory');
  const featureDecay = await getConfig<{ rate_xi_per_day: number }>(db, 'feature_decay').catch(() => null);
  const curXi = featureDecay?.rate_xi_per_day ?? Number(ffCfg.decay_xi_player ?? 0.01);
  const curK = Number(ffCfg.shrinkage_k_attacking ?? ffCfg.shrinkage_k ?? 6);

  const sample = { eventStep: 3, maxPlayersPerEvent: 120, writeErrors: false as const };
  const xis = [...new Set([curXi * 0.5, curXi, curXi * 2])];
  const ks = [...new Set([Math.max(2, curK - 3), curK, curK + 4])];
  const grid: { decayXi: number; kAtt: number; mae: number }[] = [];
  let baseline = Infinity;
  for (const decayXi of xis) {
    for (const kAtt of ks) {
      const m = await walkForwardBacktest(db, { ...sample, decayXi, kAtt });
      if (m.samples === 0) return { baseline: 0, best: 0, decayXi: curXi, kAtt: curK, applied: false, grid: [] };
      grid.push({ decayXi, kAtt, mae: m.maeXpts });
      if (decayXi === curXi && kAtt === curK) baseline = m.maeXpts;
    }
  }
  const best = grid.reduce((a, b) => (b.mae < a.mae ? b : a));
  const minGain = opts.minGain ?? 0.01;
  const applied = Number.isFinite(baseline) && best.mae < baseline * (1 - minGain);
  if (applied) {
    await setConfig(db, 'feature_decay', { ...(featureDecay ?? {}), rate_xi_per_day: best.decayXi });
    await setConfig(db, 'feature_factory', { ...ffCfg, shrinkage_k_attacking: best.kAtt });
    log.info({ from: { curXi, curK }, to: best, baseline }, 'constants refit — new config versions written');
  } else {
    log.info({ baseline, best }, 'constants refit: no improvement beyond the gate — keeping current config');
  }
  return { baseline: Number.isFinite(baseline) ? baseline : 0, best: best.mae, decayXi: best.decayXi, kAtt: best.kAtt, applied, grid };
}
