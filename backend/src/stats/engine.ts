/**
 * Statistical Engine orchestration — runs L0→L12 for a run_id and writes the
 * run-stamped derived snapshots (fixture_predictions, player_fixture_predictions,
 * player_matrix). Reads canonical tables as-of run start; NEVER mutates them.
 */
import type { Knex } from 'knex';
import { getConfig, getConfigVersion, DEFAULT_CONFIG } from '../core/model-config.js';
import {
  fitTeamStrength,
  fixtureLambdas,
  predictFromLambdas,
  baselineLambda,
  type StrengthMatch,
  type TeamStrengthParams,
} from './l1-team-strength.js';
import { deMargin1x2, solveMarketLambdas, blendLambdas } from './l2-odds.js';
import { computePlayerFeatures, computePositionPriors, type MatchRow, type PlayerFeatures } from './l0-features.js';
import { predictMinutes, type MinutesConfig } from './l3-minutes.js';
import { thresholdFor, type PriceModelConfig } from './prices.js';
import { composeXpts, type ScoringRules, type BonusProfiles, type XptsBreakdown } from './l9-composer.js';
import { log } from '../core/logger.js';

export interface StatsEngineResult {
  playersScored: number;
  fixturesPredicted: number;
  eventsCovered: number[];
  configVersion: number;
}

interface UpcomingFixture {
  fixtureUid: string;
  event: number;
  homeTeamUid: string;
  awayTeamUid: string;
  kickoff: Date | null;
  volatility: boolean;
}

export async function runStatsEngine(db: Knex, runId: number, asOf: Date): Promise<StatsEngineResult> {
  const rules = await getConfig<ScoringRules>(db, 'scoring_rules');
  const bonusProfiles = await getConfig<BonusProfiles>(db, 'bonus_profiles');
  const dcCfg = await getConfig<Record<string, number>>(db, 'dixon_coles');
  const oddsCfg = await getConfig<{ w_mkt_fresh: number; fresh_hours: number }>(db, 'odds_blend');
  const minutesCfg = await getConfig<MinutesConfig>(db, 'minutes_model');
  const ffCfg = await getConfig<Record<string, unknown>>(db, 'feature_factory');
  const weightsCfg = await getConfig<Record<string, number>>(db, 'stat_score_weights');
  const capsCfg = await getConfig<{ unavailable: number; doubtful: number }>(db, 'stat_score_caps');
  const attackingCfg = await getConfig<{ finishing_clip: [number, number]; finishing_min_minutes: number; assist_conv?: number }>(db, 'attacking');
  // statengineexpansion.md ⚙ keys (X1–X5) — tolerate absence on old configs
  const minutesRealism = await getConfig<{ started_min_shrink_k: number; e_min_start_cap: Record<string, number>; top_start_share_p: number; horizon_target_mult?: number }>(db, 'minutes_realism').catch(() => null);
  const pricePrior = await getConfig<import('./l0-features.js').PricePriorConfig>(db, 'price_prior').catch(() => null);
  const spCfg = await getConfig<{ team_pens_per_match: number; taker_share: Record<string, number>; pen_conversion: number; pen_xg_deduction: number; corner_dfk_xa_bump: number }>(db, 'set_piece_ev').catch(() => null);
  const bonusCfg = await getConfig<{ fwd_mid: { base: number; slope: number; cap: number }; def: { base: number; slope: number; cs_term: number; cap: number }; gk: { base: number; cs_term: number; saves_norm: number; cap: number } }>(db, 'bonus_model').catch(() => null);
  const featureDecay = await getConfig<{ rate_xi_per_day: number }>(db, 'feature_decay').catch(() => null);
  const humanCfg = await getConfig<{
    ownership_momentum_weight: number;
    suspension_tightrope: { yellows: number; haircut_next3: number; haircut_next6: number };
    news_signals?: import('../news/signals.js').NewsSignalsConfig;
  }>(db, 'human_factors').catch(() => null);
  const priceModel = await getConfig<PriceModelConfig>(db, 'price_model').catch(() => null);
  const configVersion = await getConfigVersion(db, 'stat_score_weights');

  // ── events: the next 8 upcoming events as-of now
  const gameweeks = await db('gameweeks').orderBy('id');
  const upcomingEvents: number[] = gameweeks
    .filter((g) => !g.finished && new Date(g.deadline_time).getTime() > asOf.getTime() - 36 * 3600_000)
    .map((g) => g.id)
    .slice(0, 8);
  if (upcomingEvents.length === 0) throw new Error('no upcoming events — season over or gameweeks not synced');

  // ── L1 fit: matches from finished fixtures (current + previous season), xG-blended
  const finished = await db('fixtures')
    .whereIn('state', ['finished', 'checked'])
    .whereNotNull('home_score')
    .whereNotNull('kickoff_utc')
    .select('fixture_uid', 'home_team_uid', 'away_team_uid', 'home_score', 'away_score', 'kickoff_utc');

  // summed player xG per fixture side (fallback team xG source per §4.2)
  const xgRows = (await db('player_match_stats')
    .select('fixture_uid', 'was_home')
    .sum({ xg: 'xg' })
    .groupBy('fixture_uid', 'was_home')) as { fixture_uid: string; was_home: boolean; xg: unknown }[];
  const teamXg = new Map<string, number>();
  for (const r of xgRows) teamXg.set(`${r.fixture_uid}|${r.was_home}`, Number(r.xg ?? 0));

  const xgBlend = dcCfg.xg_blend_weight ?? 0.6;
  const matches: StrengthMatch[] = finished.map((f) => {
    const daysAgo = Math.max(0, (asOf.getTime() - new Date(f.kickoff_utc).getTime()) / 86_400_000);
    const hXg = teamXg.get(`${f.fixture_uid}|true`);
    const aXg = teamXg.get(`${f.fixture_uid}|false`);
    return {
      homeKey: f.home_team_uid,
      awayKey: f.away_team_uid,
      homeGoals: hXg != null && hXg > 0 ? xgBlend * hXg + (1 - xgBlend) * f.home_score : f.home_score,
      awayGoals: aXg != null && aXg > 0 ? xgBlend * aXg + (1 - xgBlend) * f.away_score : f.away_score,
      daysAgo,
    };
  });

  // upcoming fixtures for the window
  const upcoming: UpcomingFixture[] = (
    await db('fixtures')
      .whereIn('event', upcomingEvents)
      .whereIn('state', ['scheduled', 'live'])
      .select('fixture_uid', 'event', 'home_team_uid', 'away_team_uid', 'kickoff_utc')
  ).map((f) => ({
    fixtureUid: f.fixture_uid,
    event: f.event,
    homeTeamUid: f.home_team_uid,
    awayTeamUid: f.away_team_uid,
    kickoff: f.kickoff_utc ? new Date(f.kickoff_utc) : null,
    volatility: false,
  }));

  // volatility: events with postponed/unscheduled fixtures affecting a team
  const unscheduled = await db('fixtures').where('state', 'postponed').select('home_team_uid', 'away_team_uid');
  const volatileTeams = new Set(unscheduled.flatMap((f) => [f.home_team_uid, f.away_team_uid]));
  for (const f of upcoming) {
    f.volatility = volatileTeams.has(f.homeTeamUid) || volatileTeams.has(f.awayTeamUid);
  }

  // promoted-team priors: current-season teams with no fitted matches
  const fittedTeams = new Set(matches.flatMap((m) => [m.homeKey, m.awayKey]));
  const priorTeams: Record<string, { attack: number; defence: number }> = {};
  for (const f of upcoming) {
    for (const t of [f.homeTeamUid, f.awayTeamUid]) {
      if (!fittedTeams.has(t)) priorTeams[t] = { attack: dcCfg.promoted_attack ?? -0.25, defence: dcCfg.promoted_defence ?? -0.15 };
    }
  }

  const params: TeamStrengthParams = fitTeamStrength(matches, {
    xi: dcCfg.xi_decay_per_day ?? 0.0035,
    priorTeams,
  });

  await db('model_runs').insert({
    run_id: runId,
    layer: 'L1_team_strength',
    model_version: 'dixon_coles_xg_v1',
    config_version: configVersion,
    fitted_params: JSON.stringify({ mu: params.mu, homeAdv: params.homeAdv, rho: params.rho, xi: params.xi, teams: params.teams.length }),
    metrics: JSON.stringify({ matches: matches.length }),
  });

  // current-season team set for baselines
  const currentTeams = [...new Set(upcoming.flatMap((f) => [f.homeTeamUid, f.awayTeamUid]))];
  const baselines = new Map<string, number>();
  for (const t of currentTeams) baselines.set(t, baselineLambda(params, t, currentTeams));

  // ── L2: latest odds per fixture (if any provider supplied them)
  const oddsRows = await db('odds_snapshots')
    .whereIn('fixture_uid', upcoming.map((f) => f.fixtureUid))
    .where('market', '1x2')
    .orderBy('taken_at', 'desc');
  const latestOdds = new Map<string, { prices: { home: number; draw: number; away: number }; takenAt: Date }>();
  for (const o of oddsRows) {
    if (!latestOdds.has(o.fixture_uid)) latestOdds.set(o.fixture_uid, { prices: o.prices, takenAt: new Date(o.taken_at) });
  }

  // ── fixture predictions
  interface FxPred {
    fixture: UpcomingFixture;
    lambdaHome: number;
    lambdaAway: number;
    blendHome: number;
    blendAway: number;
    pred: ReturnType<typeof predictFromLambdas>;
    oddsUsed: boolean;
    attRatioHome: number;
    attRatioAway: number;
  }
  const fxPreds: FxPred[] = [];
  for (const f of upcoming) {
    const dc = fixtureLambdas(params, f.homeTeamUid, f.awayTeamUid);
    let market: { lambdaHome: number; lambdaAway: number } | null = null;
    let oddsAge: number | null = null;
    const odds = latestOdds.get(f.fixtureUid);
    if (odds?.prices?.home && odds.prices.draw && odds.prices.away) {
      const dm = deMargin1x2({ home: odds.prices.home, draw: odds.prices.draw, away: odds.prices.away, takenAt: odds.takenAt });
      market = solveMarketLambdas(dm, params.rho);
      oddsAge = (asOf.getTime() - odds.takenAt.getTime()) / 3600_000;
    }
    const blend = blendLambdas(dc, market, oddsAge, oddsCfg.w_mkt_fresh, oddsCfg.fresh_hours);
    const pred = predictFromLambdas(blend.lambdaHome, blend.lambdaAway, params.rho);
    fxPreds.push({
      fixture: f,
      lambdaHome: dc.lambdaHome,
      lambdaAway: dc.lambdaAway,
      blendHome: blend.lambdaHome,
      blendAway: blend.lambdaAway,
      pred,
      oddsUsed: blend.wMkt > 0,
      attRatioHome: fin(blend.lambdaHome / (baselines.get(f.homeTeamUid) ?? blend.lambdaHome), 1),
      attRatioAway: fin(blend.lambdaAway / (baselines.get(f.awayTeamUid) ?? blend.lambdaAway), 1),
    });
  }

  // FDR percentiles over the window (side-specific, 0–10)
  const attRatios = fxPreds.flatMap((p) => [p.attRatioHome, p.attRatioAway]).sort((a, b) => a - b);
  const csProbs = fxPreds.flatMap((p) => [p.pred.pCsHome, p.pred.pCsAway]).sort((a, b) => a - b);
  const pct = (sorted: number[], v: number): number => {
    if (sorted.length === 0) return 0.5;
    let below = 0;
    for (const s of sorted) if (s < v) below++;
    return below / sorted.length;
  };
  const fdr = new Map<string, { attHome: number; attAway: number; defHome: number; defAway: number }>();
  for (const p of fxPreds) {
    fdr.set(p.fixture.fixtureUid, {
      attHome: 10 * pct(attRatios, p.attRatioHome),
      attAway: 10 * pct(attRatios, p.attRatioAway),
      defHome: 10 * pct(csProbs, p.pred.pCsHome),
      defAway: 10 * pct(csProbs, p.pred.pCsAway),
    });
  }

  // persist fixture predictions
  for (const p of fxPreds) {
    const f = fdr.get(p.fixture.fixtureUid)!;
    await db('fixture_predictions')
      .insert({
        run_id: runId,
        fixture_uid: p.fixture.fixtureUid,
        event: p.fixture.event,
        lambda_home: p.lambdaHome.toFixed(3),
        lambda_away: p.lambdaAway.toFixed(3),
        lambda_home_blend: p.blendHome.toFixed(3),
        lambda_away_blend: p.blendAway.toFixed(3),
        p_home: p.pred.pHome.toFixed(4),
        p_draw: p.pred.pDraw.toFixed(4),
        p_away: p.pred.pAway.toFixed(4),
        p_cs_home: p.pred.pCsHome.toFixed(4),
        p_cs_away: p.pred.pCsAway.toFixed(4),
        concession_home: JSON.stringify(p.pred.concessionHome.map((x) => Number(x.toFixed(5)))),
        concession_away: JSON.stringify(p.pred.concessionAway.map((x) => Number(x.toFixed(5)))),
        fdr_att_home: f.attHome.toFixed(2),
        fdr_att_away: f.attAway.toFixed(2),
        fdr_def_home: f.defHome.toFixed(2),
        fdr_def_away: f.defAway.toFixed(2),
        odds_used: p.oddsUsed,
      })
      .onConflict(['run_id', 'fixture_uid'])
      .merge();
  }

  // ── L0: all match rows grouped per player (single query)
  const allStats = await db('player_match_stats')
    .whereNotNull('kickoff_utc')
    .where('kickoff_utc', '<', asOf)
    .select('player_uid', 'kickoff_utc', 'minutes', 'starts', 'goals', 'assists', 'saves', 'cbit', 'cbirt', 'defcon_count', 'xg', 'npxg', 'xa', 'fpl_points', 'yc', 'rc', 'was_home');
  const rowsByPlayer = new Map<string, MatchRow[]>();
  for (const r of allStats) {
    const row: MatchRow = {
      kickoff: new Date(r.kickoff_utc),
      minutes: r.minutes,
      starts: r.starts,
      goals: r.goals,
      assists: r.assists,
      saves: r.saves,
      cbit: r.cbit,
      cbirt: r.cbirt,
      defconCount: r.defcon_count,
      xg: r.xg != null ? Number(r.xg) : null,
      npxg: r.npxg != null ? Number(r.npxg) : null,
      xa: r.xa != null ? Number(r.xa) : null,
      fplPoints: r.fpl_points,
      yc: r.yc,
      rc: r.rc,
      wasHome: r.was_home, // A6: venue splits
    };
    const list = rowsByPlayer.get(r.player_uid);
    if (list) list.push(row);
    else rowsByPlayer.set(r.player_uid, [row]);
  }

  const players = await db('players').select('*');
  // priors recomputed from history, per position × price-band (§4.1)
  const priors = computePositionPriors(
    players
      .filter((p) => rowsByPlayer.has(p.uid))
      .map((p) => ({ position: p.position, price: p.now_cost, rows: rowsByPlayer.get(p.uid)! })),
  );

  // X1: realism config rides inside the minutes config
  const minutesCfgFull = { ...minutesCfg, realism: minutesRealism ?? undefined };

  // X2: set-piece roles (pens/corners/DFK orders) — FPL bootstrap truth
  const setPieceRows = await db('set_piece_roles').select('player_uid', 'pens_order', 'dfk_order', 'corners_order');
  const setPieceByPlayer = new Map(setPieceRows.map((r) => [r.player_uid, r]));

  // v1.4.0 human factors: news-signal categories per player (keyword
  // classified in the indexer — statistical, no AI), corroboration-gated.
  // Falls back to the compiled default when an upgraded DB's human_factors
  // row predates the sub-key (belt to migration 0010's braces).
  const signalCfg =
    humanCfg?.news_signals ??
    ((DEFAULT_CONFIG.human_factors as { news_signals?: import('../news/signals.js').NewsSignalsConfig }).news_signals ?? null);
  let signalRowsByPlayer = new Map<string, { category: string; tier: number }[]>();
  if (signalCfg) {
    try {
      const { playerSignalRows } = await import('../news/indexer.js');
      signalRowsByPlayer = await playerSignalRows(db, signalCfg.window_days);
    } catch (err) {
      log.warn({ err: String(err) }, 'news-signal load failed — running without human-factor news signals');
      signalRowsByPlayer = new Map();
    }
  }
  log.info({ players: signalRowsByPlayer.size }, 'news signals loaded');

  // X5: current-season yellows for the suspension tightrope
  const seasonStart = new Date(Date.UTC(asOf.getUTCMonth() >= 7 ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1, 7, 1));
  const ycRows = (await db('player_match_stats')
    .where('kickoff_utc', '>=', seasonStart)
    .select('player_uid')
    .sum({ yc: 'yc' })
    .groupBy('player_uid')) as { player_uid: string; yc: unknown }[];
  const seasonYellows = new Map(ycRows.map((r) => [r.player_uid, Number(r.yc ?? 0)]));

  // injuries + confirmed lineups
  const activeInjuries = await db('injuries').where('is_active', true).select('player_uid', 'kind', 'expected_return_date');
  const injuryByPlayer = new Map<string, { kind: string; expectedReturn: Date | null }>();
  for (const i of activeInjuries) {
    injuryByPlayer.set(i.player_uid, { kind: i.kind, expectedReturn: i.expected_return_date ? new Date(i.expected_return_date) : null });
  }
  const confirmedLineups = await db('lineups')
    .whereIn('fixture_uid', upcoming.map((f) => f.fixtureUid))
    .where('kind', 'confirmed');
  const lineupByFixtureTeam = new Map<string, { starters: string[]; bench: string[] }>();
  for (const l of confirmedLineups) {
    lineupByFixtureTeam.set(`${l.fixture_uid}|${l.team_uid}`, { starters: l.starters ?? [], bench: l.bench ?? [] });
  }

  // A3 (v1.4.4): reconciled availability per (player, fixture) — the merged
  // FPL-flags + injuries + news truth caps the chance the minutes model sees
  const availRows = (await db('availability_state')
    .whereIn('fixture_uid', upcoming.map((f) => f.fixtureUid))
    .select('player_uid', 'fixture_uid', 'p_available', 'state')) as {
    player_uid: string;
    fixture_uid: string;
    p_available: string;
    state: string;
  }[];
  const availBy = new Map(availRows.map((r) => [`${r.player_uid}|${r.fixture_uid}`, r]));

  // congestion: per team, fixture density
  const fixturesByTeam = new Map<string, UpcomingFixture[]>();
  for (const f of upcoming) {
    (fixturesByTeam.get(f.homeTeamUid) ?? fixturesByTeam.set(f.homeTeamUid, []).get(f.homeTeamUid)!).push(f);
    (fixturesByTeam.get(f.awayTeamUid) ?? fixturesByTeam.set(f.awayTeamUid, []).get(f.awayTeamUid)!).push(f);
  }

  const fxPredByUid = new Map(fxPreds.map((p) => [p.fixture.fixtureUid, p]));
  const nextEvent = upcomingEvents[0]!;
  const currentSeasonStarted = gameweeks.some((g) => g.finished);

  interface PlayerScore {
    uid: string;
    position: string;
    price: number;
    features: PlayerFeatures;
    xptsPerEvent: Map<number, number>;
    xptsN1: number;
    xptsN3: number;
    xptsN6: number;
    humanSignals: Record<string, unknown> | null;
    pStartNext: number;
    pAppearanceNext: number;
    xcsNext: number;
    fdrN1: number | null;
    fdrN3: number | null;
    fdrN6: number | null;
    injuryStatus: string;
    injuryDetail: string;
    varianceN1: number;
    componentsNext: XptsBreakdown | null;
    selectedBy: number;
    transfersNet: number;
    formEwma: number;
    minutesEwma: number;
    ict: number; // A6 (v1.4.3): FPL's ICT index — orthogonal eye-test term
  }

  const scored: PlayerScore[] = [];
  const pfpBatch: Record<string, unknown>[] = [];

  for (const p of players) {
    if (!p.team_uid) continue;
    const rows = rowsByPlayer.get(p.uid) ?? [];
    const features = computePlayerFeatures(rows, asOf, p.position, {
      priors,
      price: p.now_cost,
      pricePrior: pricePrior ?? undefined,
      shrinkageK: Number(ffCfg.shrinkage_k ?? 6),
      shrinkageKAttacking: Number(ffCfg.shrinkage_k_attacking ?? ffCfg.shrinkage_k ?? 6),
      // X4: gentler in-season decay — a title-season sample keeps its weight
      decayXi: featureDecay?.rate_xi_per_day ?? Number(ffCfg.decay_xi_player ?? 0.01),
    });

    // finishing-skill multiplier (bounded, proven finishers only)
    let finishingMult = 1;
    if (features.minutesTotal >= attackingCfg.finishing_min_minutes && features.rawXg90 > 0.05) {
      const careerGoals = rows.reduce((s, r) => s + r.goals, 0);
      const careerXg = rows.reduce((s, r) => s + (r.xg ?? 0), 0);
      if (careerXg > 3) {
        finishingMult = Math.min(attackingCfg.finishing_clip[1], Math.max(attackingCfg.finishing_clip[0], careerGoals / careerXg));
      }
    }

    const teamFixtures = (fixturesByTeam.get(p.team_uid) ?? []).sort(
      (a, b) => (a.kickoff?.getTime() ?? Infinity) - (b.kickoff?.getTime() ?? Infinity),
    );
    const injury = injuryByPlayer.get(p.uid) ?? null;
    // "new signing" only means anything when we HAVE history for the league:
    // on a fresh install with no imported history, nobody is a new signing —
    // otherwise every player gets the ×0.70 penalty and loses the
    // undroppable floor (the everyone-at-6% bug)
    const historyExists = rowsByPlayer.size > 50;
    const newSigning = historyExists && (currentSeasonStarted ? features.matchesUsed < 2 : rows.length === 0);
    // v1: closed-injury lookback lands with the reconciliation pass; the FPL
    // chance flags already carry most of the return-ramp signal
    const returnedFromInjury = false;

    const xptsPerEvent = new Map<number, number>();
    let pStartNext = 0;
    let pAppearanceNext = 0;
    let xcsNext = 0;
    let varianceN1 = 0;
    let componentsNext: XptsBreakdown | null = null;
    const fdrByEventAtt: Map<number, number[]> = new Map();
    const fdrByEventDef: Map<number, number[]> = new Map();

    let fixtureIdx = 0;
    for (const f of teamFixtures) {
      fixtureIdx++;
      const fp = fxPredByUid.get(f.fixtureUid);
      if (!fp) continue;
      const isHome = f.homeTeamUid === p.team_uid;
      const lineupKey = `${f.fixtureUid}|${p.team_uid}`;
      const lineup = lineupByFixtureTeam.get(lineupKey);
      const confirmedLineup = lineup
        ? lineup.starters.includes(p.uid)
          ? ('xi' as const)
          : lineup.bench.includes(p.uid)
            ? ('bench' as const)
            : ('absent' as const)
        : null;

      // congestion: another club fixture within 4 days
      const congested = teamFixtures.some(
        (other) =>
          other !== f &&
          other.kickoff != null &&
          f.kickoff != null &&
          Math.abs(other.kickoff.getTime() - f.kickoff.getTime()) < 4 * 86_400_000,
      );

      // A3: the reconciled availability row (if any) caps the FPL chance flag
      const avail = availBy.get(`${p.uid}|${f.fixtureUid}`);
      const availCap = avail ? Math.round(Number(avail.p_available) * 100) : null;
      const minutes = predictMinutes(
        {
          status: p.status,
          chanceNext: availCap != null ? Math.min(p.chance_next ?? 100, availCap) : p.chance_next,
          activeInjury: injury,
          confirmedLineup,
          position: p.position,
          selectedByPct: Number(p.selected_by_percent),
          startShare5: features.startShare5,
          startShareLong: features.startShareLong,
          minutesEwma: features.minutesEwma,
          startedMinutesAvg: features.startedMinutesAvg,
          startedLast: features.startedLast,
          daysSinceLastMatch: features.daysSinceLastMatch,
          congested,
          newSigning,
          returnedFromInjury,
          fixturesAhead: fixtureIdx,
        },
        minutesCfgFull,
      );

      // a non-finite probability would silently poison everything downstream
      for (const key of ['pStart', 'p60', 'pAny', 'eMin'] as const) {
        if (!Number.isFinite(minutes[key])) minutes[key] = 0;
      }

      const breakdown = composeXpts(
        {
          position: p.position,
          pStart: minutes.pStart,
          p60: minutes.p60,
          pAny: minutes.pAny,
          eMin: minutes.eMin,
          xg90: features.xg90,
          npxg90: features.npxg90,
          xa90: features.xa90,
          saves90: features.saves90,
          yc90: features.yc90,
          rc90: features.rc90,
          defconHitRate: features.defconHitRate,
          finishingMult,
          // A6 (v1.4.3): the player's own venue split scales the fixture's
          // team-level attack ratio (both bounded — a home specialist at
          // home nudges up, thin samples stay neutral)
          fixtureMultAtt: (isHome ? fp.attRatioHome : fp.attRatioAway) * (isHome ? features.venueAttMultHome : features.venueAttMultAway),
          pCsTeam: isHome ? fp.pred.pCsHome : fp.pred.pCsAway,
          eConcedePts: isHome ? fp.pred.eConcedePtsHome : fp.pred.eConcedePtsAway,
          lambdaOpponent: isHome ? fp.blendAway : fp.blendHome,
          // X2/X3: set-piece EV + returns-driven bonus + xA→assist conversion
          pensOrder: setPieceByPlayer.get(p.uid)?.pens_order ?? null,
          cornerDfkOrder:
            (setPieceByPlayer.get(p.uid)?.corners_order ?? 99) === 1 || (setPieceByPlayer.get(p.uid)?.dfk_order ?? 99) === 1 ? 1 : null,
          spCfg: spCfg ?? undefined,
          assistConv: attackingCfg.assist_conv ?? 1.05,
          bonusCfg: bonusCfg ?? undefined,
        },
        rules,
        bonusProfiles,
      );

      // NaN must never reach the database — sanitize every numeric component
      for (const key of Object.keys(breakdown) as (keyof XptsBreakdown)[]) {
        const v = breakdown[key];
        if (typeof v === 'number' && !Number.isFinite(v)) (breakdown as unknown as Record<string, unknown>)[key] = 0;
      }

      xptsPerEvent.set(f.event, (xptsPerEvent.get(f.event) ?? 0) + breakdown.total);
      const fdrRow = fdr.get(f.fixtureUid)!;
      (fdrByEventAtt.get(f.event) ?? fdrByEventAtt.set(f.event, []).get(f.event)!).push(isHome ? fdrRow.attHome : fdrRow.attAway);
      (fdrByEventDef.get(f.event) ?? fdrByEventDef.set(f.event, []).get(f.event)!).push(isHome ? fdrRow.defHome : fdrRow.defAway);

      if (f.event === nextEvent && componentsNext === null) {
        pStartNext = minutes.pStart;
        pAppearanceNext = minutes.p60;
        xcsNext = isHome ? fp.pred.pCsHome : fp.pred.pCsAway;
        varianceN1 = breakdown.variance;
        componentsNext = breakdown;
      }

      pfpBatch.push({
        run_id: runId,
        player_uid: p.uid,
        fixture_uid: f.fixtureUid,
        event: f.event,
        p_start: minutes.pStart.toFixed(4),
        p60: minutes.p60.toFixed(4),
        p_any: minutes.pAny.toFixed(4),
        e_min: minutes.eMin.toFixed(2),
        e_goals: breakdown.eGoals.toFixed(4),
        e_assists: breakdown.eAssists.toFixed(4),
        p_cs: (isHome ? fp.pred.pCsHome : fp.pred.pCsAway).toFixed(4),
        p_defcon: breakdown.pDefcon.toFixed(4),
        e_saves: breakdown.eSaves.toFixed(3),
        e_bonus: breakdown.bonus.toFixed(3),
        xpts: breakdown.total.toFixed(3),
        variance: breakdown.variance.toFixed(4),
        components: JSON.stringify({
          appearance: r3(breakdown.appearance),
          goals: r3(breakdown.goals),
          assists: r3(breakdown.assists),
          cleanSheet: r3(breakdown.cleanSheet),
          defcon: r3(breakdown.defcon),
          saves: r3(breakdown.saves),
          bonus: r3(breakdown.bonus),
          concededPenalty: r3(breakdown.concededPenalty),
          cards: r3(breakdown.cards),
        }),
      });
    }

    const sumEvents = (n: number): number => {
      let sum = 0;
      for (const ev of upcomingEvents.slice(0, n)) sum += xptsPerEvent.get(ev) ?? 0;
      return sum;
    };
    const meanFdr = (map: Map<number, number[]>, n: number): number | null => {
      const vals: number[] = [];
      for (const ev of upcomingEvents.slice(0, n)) for (const v of map.get(ev) ?? []) vals.push(v);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const fdrMap = p.position === 'GK' || p.position === 'DEF' ? fdrByEventDef : fdrByEventAtt;

    // X5 suspension tightrope: one booking from a ban shaves the horizons
    let tightrope3 = 1;
    let tightrope6 = 1;
    if (humanCfg && (seasonYellows.get(p.uid) ?? 0) >= humanCfg.suspension_tightrope.yellows) {
      tightrope3 = humanCfg.suspension_tightrope.haircut_next3;
      tightrope6 = humanCfg.suspension_tightrope.haircut_next6;
    }

    // v1.4.0 news-driven human factors: bounded multipliers from corroborated
    // signal categories (discipline, unprofessionalism, transfer/contract
    // noise, personal events, morale, managerial churn)
    let signalMult = { n1: 1, n3: 1, n6: 1 };
    let humanSignals: Record<string, unknown> | null = null;
    if (signalCfg) {
      const rows = signalRowsByPlayer.get(p.uid) ?? [];
      if (rows.length > 0) {
        const { corroboratedCategories, signalMultipliers } = await import('../news/signals.js');
        const cats = corroboratedCategories(rows as { category: import('../news/signals.js').SignalCategory; tier: number }[], signalCfg);
        if (cats.length > 0) {
          signalMult = signalMultipliers(cats, signalCfg);
          humanSignals = { categories: cats, items: rows.length, mult: signalMult };
        }
      }
    }

    scored.push({
      uid: p.uid,
      position: p.position,
      price: p.now_cost,
      features,
      xptsPerEvent,
      humanSignals,
      xptsN1: sumEvents(1) * signalMult.n1,
      xptsN3: sumEvents(3) * tightrope3 * signalMult.n3,
      xptsN6: sumEvents(6) * tightrope6 * signalMult.n6,
      pStartNext,
      pAppearanceNext,
      xcsNext,
      fdrN1: meanFdr(fdrMap, 1),
      fdrN3: meanFdr(fdrMap, 3),
      fdrN6: meanFdr(fdrMap, 6),
      injuryStatus: injuryStatusOf(p.status, p.chance_next),
      injuryDetail: p.news ?? '',
      varianceN1,
      componentsNext,
      selectedBy: Number(p.selected_by_percent),
      transfersNet: p.transfers_in_event - p.transfers_out_event,
      formEwma: features.formEwma,
      minutesEwma: features.minutesEwma,
      ict: Number((p.season_stats as { ict_index?: unknown } | null)?.ict_index ?? 0) || 0,
    });
  }

  // batch insert player_fixture_predictions
  for (let i = 0; i < pfpBatch.length; i += 500) {
    await db('player_fixture_predictions')
      .insert(pfpBatch.slice(i, i + 500))
      .onConflict(['run_id', 'player_uid', 'fixture_uid'])
      .merge();
  }

  // ── L12: stat_score — position-wise z + percentile map → uniform 0–100
  const byPos = new Map<string, PlayerScore[]>();
  for (const s of scored) (byPos.get(s.position) ?? byPos.set(s.position, []).get(s.position)!).push(s);

  const statScores = new Map<string, number>();
  for (const [, group] of byPos) {
    const z = (get: (s: PlayerScore) => number): Map<string, number> => {
      const vals = group.map(get);
      const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length)) || 1;
      return new Map(group.map((s) => [s.uid, (get(s) - mean) / sd]));
    };
    const zX3 = z((s) => s.xptsN3);
    const zX1 = z((s) => s.xptsN1);
    const zForm = z((s) => s.formEwma);
    const zValue = z((s) => (s.price > 0 ? s.xptsN3 / (s.price / 10) : 0));
    const zFdr = z((s) => s.fdrN3 ?? 5);
    // X5 crowd wisdom: ten million managers moving toward a player is
    // information — bounded (⚙ w7) so it can never dominate the model
    // A2/S9 (v1.4.4): momentum scaled by the price model's OWNERSHIP-AWARE
    // threshold — 100k net on a 40%-owned player is routine, on a 2% punt it
    // is a stampede; the raw within-GW counter treated them the same
    const zMomentum = z((s) => {
      const theta = priceModel ? thresholdFor(priceModel, s.selectedBy) : 100_000;
      return Math.sign(s.transfersNet) * Math.min(2, Math.abs(s.transfersNet) / Math.max(1, theta));
    });
    const w7 = humanCfg?.ownership_momentum_weight ?? 0;
    // A6 (v1.4.3, audit S5): ICT was ingested every 6 h and read by nothing —
    // a small ⚙ w8 z-term folds FPL's own influence/creativity/threat index
    // in as an orthogonal "eye test" signal
    const zIct = z((s) => s.ict);
    const w8 = weightsCfg.w8 ?? 0.05;

    const raw = new Map<string, number>();
    for (const s of group) {
      raw.set(
        s.uid,
        (weightsCfg.w1 ?? 0.4) * (zX3.get(s.uid) ?? 0) +
          (weightsCfg.w2 ?? 0.15) * (zX1.get(s.uid) ?? 0) +
          (weightsCfg.w3 ?? 0.1) * (zForm.get(s.uid) ?? 0) +
          (weightsCfg.w4 ?? 0.15) * s.pStartNext +
          (weightsCfg.w5 ?? 0.12) * (zValue.get(s.uid) ?? 0) +
          (weightsCfg.w6 ?? 0.08) * (zFdr.get(s.uid) ?? 0) +
          w7 * (zMomentum.get(s.uid) ?? 0) +
          w8 * (zIct.get(s.uid) ?? 0),
      );
    }
    // percentile map within position
    const sortedRaw = [...raw.values()].sort((a, b) => a - b);
    for (const s of group) {
      const v = raw.get(s.uid)!;
      let below = 0;
      for (const x of sortedRaw) if (x < v) below++;
      let score = (100 * below) / Math.max(1, sortedRaw.length - 1);
      // availability hard caps
      if (['out_injured', 'suspended', 'unavailable', 'ineligible'].includes(s.injuryStatus)) {
        score = Math.min(score, capsCfg.unavailable);
      } else if (s.injuryStatus.startsWith('doubt')) {
        score = Math.min(score, capsCfg.doubtful);
      }
      statScores.set(s.uid, score);
    }
  }

  // write matrix rows (AI fields defaulted; the orchestrator merges verdicts and re-ranks)
  const matrixBatch = scored.map((s) => ({
    run_id: runId,
    player_uid: s.uid,
    gameweek: nextEvent,
    p_start_xi: s.pStartNext.toFixed(4),
    p_appearance: s.pAppearanceNext.toFixed(4),
    injury_status: s.injuryStatus,
    injury_detail: s.injuryDetail.slice(0, 500),
    xg_per90: s.features.xg90.toFixed(3),
    xa_per90: s.features.xa90.toFixed(3),
    xgi_per90: (s.features.xg90 + s.features.xa90).toFixed(3),
    npxg_per90: s.features.npxg90.toFixed(3),
    xcs: s.xcsNext.toFixed(4),
    saves_per90: s.features.saves90.toFixed(3),
    defcon_per90: (s.position === 'GK' || s.position === 'DEF' ? s.features.cbit90 : s.features.cbirt90).toFixed(3),
    price: s.price,
    selected_by_pct: s.selectedBy.toFixed(2),
    transfers_in_net: s.transfersNet,
    form_ewma: s.formEwma.toFixed(3),
    minutes_trend: s.minutesEwma.toFixed(2),
    fdr_next1: s.fdrN1?.toFixed(2) ?? null,
    fdr_next3: s.fdrN3?.toFixed(2) ?? null,
    fdr_next6: s.fdrN6?.toFixed(2) ?? null,
    xpts_next1: s.xptsN1.toFixed(3),
    xpts_next3: s.xptsN3.toFixed(3),
    xpts_next6: s.xptsN6.toFixed(3),
    xpts_per_event: JSON.stringify(upcomingEvents.map((ev) => ({ event: ev, xpts: r3(s.xptsPerEvent.get(ev) ?? 0) }))),
    human_signals: s.humanSignals ? JSON.stringify(s.humanSignals) : null,
    stat_score: (statScores.get(s.uid) ?? 0).toFixed(2),
    ai_adjustment: 0,
    ai_rationale: '',
    ai_stale: true,
    overall_score: (statScores.get(s.uid) ?? 0).toFixed(2),
  }));
  for (let i = 0; i < matrixBatch.length; i += 500) {
    await db('player_matrix')
      .insert(matrixBatch.slice(i, i + 500))
      .onConflict(['run_id', 'player_uid'])
      .merge();
  }

  await db('model_runs').insert({
    run_id: runId,
    layer: 'L12_stat_score',
    model_version: 'v1',
    config_version: configVersion,
    metrics: JSON.stringify({ players: scored.length, fixtures: fxPreds.length }),
  });

  log.info({ runId, players: scored.length, fixtures: fxPreds.length }, 'stats engine complete');
  return {
    playersScored: scored.length,
    fixturesPredicted: fxPreds.length,
    eventsCovered: upcomingEvents,
    configVersion,
  };
}

function injuryStatusOf(status: string, chanceNext: number | null): string {
  switch (status) {
    case 'i':
      return 'out_injured';
    case 's':
      return 'suspended';
    case 'u':
      return 'unavailable';
    case 'n':
      return 'ineligible';
    case 'd':
      return chanceNext != null ? `doubt_${100 - chanceNext}` : 'doubt_50';
    default:
      return chanceNext != null && chanceNext < 100 ? `doubt_${100 - chanceNext}` : 'fit';
  }
}

function r3(x: number): number {
  return Number(x.toFixed(3));
}

/** Finite or fallback — Postgres numeric happily stores NaN; we never do. */
function fin(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Re-rank a run's matrix after AI adjustments (dense ranks, overall + per position). */
export async function rerankMatrix(db: Knex, runId: number): Promise<void> {
  await db.raw(
    `UPDATE player_matrix pm SET overall_score = LEAST(100, GREATEST(0, pm.stat_score + pm.ai_adjustment))
     WHERE pm.run_id = ?`,
    [runId],
  );
  await db.raw(
    `WITH ranked AS (
       SELECT pm.id,
              DENSE_RANK() OVER (ORDER BY pm.overall_score DESC, pm.xpts_next3 DESC, pm.xpts_next1 DESC) AS r_overall,
              DENSE_RANK() OVER (PARTITION BY p.position ORDER BY pm.overall_score DESC, pm.xpts_next3 DESC, pm.xpts_next1 DESC) AS r_position
       FROM player_matrix pm JOIN players p ON p.uid = pm.player_uid
       WHERE pm.run_id = ?
     )
     UPDATE player_matrix pm SET rank_overall = ranked.r_overall, rank_position = ranked.r_position
     FROM ranked WHERE pm.id = ranked.id`,
    [runId],
  );
}
