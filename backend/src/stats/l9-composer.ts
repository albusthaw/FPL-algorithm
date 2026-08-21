/**
 * L4–L9 — Production models + xPts composer (fpl-engines-plan.md §4.5–4.10).
 * Pure functions over L0 features, L1/L2 fixture predictions, L3 minutes.
 * Componentised: the UI/AI must be able to explain every number.
 * pointsFromStats() must reproduce FPL's official arithmetic exactly
 * (property-tested against two seasons of history — the E6 gate).
 */

export interface ScoringRules {
  appearance: { under60: number; from60: number };
  goal: Record<string, number>;
  assist: number;
  clean_sheet: Record<string, number>;
  saves_per_point: number;
  penalty_save: number;
  goals_conceded_per_minus1: number;
  defcon: Record<string, { threshold: number; metric: 'cbit' | 'cbirt'; points: number }>;
  penalty_miss: number;
  yellow: number;
  red: number;
  own_goal: number;
}

export interface BonusProfiles {
  scored: Record<string, number>;
  scored_and_cs: Record<string, number>;
  assisted: Record<string, number>;
  cs_and_defcon: Record<string, number>;
  high_saves: Record<string, number>;
  nothing: Record<string, number>;
}

export interface ComposeInput {
  position: string; // GK DEF MID FWD
  pStart: number;
  p60: number;
  pAny: number;
  eMin: number;
  // L0 shrunk rates
  xg90: number;
  npxg90?: number; // non-penalty rate — replaces the crude deduction for takers
  xa90: number;
  saves90: number;
  saveRate?: number; // A7 (v1.4.5): the keeper's own shrunk save rate
  yc90: number;
  rc90: number;
  defconHitRate: number; // per played match at full exposure
  finishingMult?: number; // clip(career goals/xG, 0.85, 1.15) for proven finishers only
  // L1/L2 fixture context (for the player's team)
  fixtureMultAtt: number; // λ_blend(this fixture) / λ_baseline(team)
  pCsTeam: number;
  eConcedePts: number; // E[−⌊GA/2⌋] from the concession distribution
  lambdaOpponent: number; // for GK saves model
  defconOppMult?: number; // opponent-style multiplier ∈ [0.8, 1.25]
  // X2 set-piece roles (statengineexpansion.md) — from set_piece_roles
  pensOrder?: number | null; // 1 = first-choice taker
  cornerDfkOrder?: number | null; // 1 = takes corners or direct FKs
  spCfg?: {
    team_pens_per_match: number;
    taker_share: Record<string, number>;
    pen_conversion: number;
    pen_xg_deduction: number;
    corner_dfk_xa_bump: number;
  };
  assistConv?: number; // ⚙ xA → FPL-assist conversion (FPL assists are broader)
  bonusCfg?: {
    fwd_mid: { base: number; slope: number; cap: number };
    def: { base: number; slope: number; cs_term: number; cap: number };
    gk: { base: number; cs_term: number; saves_norm: number; cap: number };
  };
}

export interface XptsBreakdown {
  appearance: number;
  goals: number;
  assists: number;
  cleanSheet: number;
  defcon: number;
  saves: number;
  bonus: number;
  concededPenalty: number;
  cards: number;
  ownGoalAndPenMiss: number;
  total: number;
  variance: number;
  eGoals: number;
  eAssists: number;
  pDefcon: number;
  eSaves: number;
}

/** League SOT-per-xG conversion for the GK saves model (L6). */
const SOT_PER_XG = 3.1;
const BIG_SAVE_RATE = 0.7; // league mean save rate on SOT faced

function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p = (p * lambda) / i;
  return p;
}

/** E[⌊saves/3⌋] on the Poisson distribution — NOT ⌊E[saves]/3⌋ (Jensen). */
export function expectedSavePoints(eSaves: number, savesPerPoint: number): number {
  if (eSaves <= 0) return 0;
  let e = 0;
  for (let k = 0; k <= 20; k++) {
    e += poissonPmf(eSaves, k) * Math.floor(k / savesPerPoint);
  }
  return e;
}

export function composeXpts(input: ComposeInput, rules: ScoringRules, bonusProfiles: BonusProfiles): XptsBreakdown {
  const pos = input.position in rules.goal ? input.position : 'MID';

  // appearance: p_any·1 + p_60·1  (≥60 earns the second point)
  const appearance = input.pAny * rules.appearance.under60 + input.p60 * (rules.appearance.from60 - rules.appearance.under60);

  // L4 attacking: per-90 rates × exposure × fixture adjustment
  const exposure = input.eMin / 90;
  const finishing = input.finishingMult ?? 1;

  // X2 penalties: explicit expected value for designated takers, with the
  // taker's historical xG deducted so pens aren't counted twice
  let penGoals = 0;
  let xg90 = input.xg90;
  let xa90 = input.xa90;
  if (input.spCfg && input.pensOrder != null && input.pensOrder >= 1 && input.pensOrder <= 2) {
    const share = input.spCfg.taker_share[String(input.pensOrder)] ?? 0;
    penGoals =
      input.spCfg.team_pens_per_match * input.fixtureMultAtt * share * input.spCfg.pen_conversion * (input.p60 > 0 ? Math.min(1, exposure / 0.8) : 0);
    if (input.pensOrder === 1) {
      // historical xG already contains the pens this taker took — the
      // non-penalty rate removes them exactly; the flat deduction is only
      // the fallback when npxg was never imported
      xg90 = input.npxg90 != null ? input.npxg90 : Math.max(0, xg90 - input.spCfg.pen_xg_deduction);
    }
  }
  // X2 dead-ball assist stream for corner/direct-FK first takers
  if (input.spCfg && input.cornerDfkOrder === 1) {
    xa90 += input.spCfg.corner_dfk_xa_bump;
  }

  const eGoals = xg90 * exposure * input.fixtureMultAtt * finishing + penGoals;
  const eAssists = xa90 * exposure * input.fixtureMultAtt * (input.assistConv ?? 1);
  const goals = eGoals * (rules.goal[pos] ?? 5);
  const assists = eAssists * rules.assist;

  // clean sheet requires ≥60 minutes
  const csPts = rules.clean_sheet[pos] ?? 0;
  const cleanSheet = input.p60 * input.pCsTeam * csPts;

  // L5 DEFCON: empirical hit rate scaled by exposure and opponent style
  const defconRule = rules.defcon[pos] ?? { threshold: 12, metric: 'cbirt' as const, points: 2 };
  const pDefcon = Math.max(0, Math.min(1, input.defconHitRate * Math.min(1, exposure / 0.85) * (input.defconOppMult ?? 1)));
  const defcon = pDefcon * defconRule.points;

  // L6 GK saves: E[SOT faced] from opponent λ; E[saves] via save rate
  let eSaves = 0;
  let saves = 0;
  if (pos === 'GK') {
    const eSotFaced = input.lambdaOpponent * SOT_PER_XG;
    // A7 (v1.4.5, audit S12): the old `saves90 > 0 ? 1 : 1` no-op froze every
    // keeper at the league mean — the shrunk personal rate differentiates now
    const saveRate = Math.min(0.85, Math.max(0.55, input.saveRate ?? BIG_SAVE_RATE));
    eSaves = Math.min(9, eSotFaced * saveRate * (input.eMin / 90));
    saves = expectedSavePoints(eSaves, rules.saves_per_point) + /* pen save EV */ 0.02 * rules.penalty_save * (input.eMin / 90);
  }

  // L7 bonus. X3 (statengineexpansion.md): bonus rides RETURNS — a brace is
  // almost always 3, a returning premium ~1.2-1.5 — so E[bonus] scales with
  // E[goal involvement] instead of sitting on flat profile means. The
  // legacy profile lookup remains the fallback when the config is absent.
  const pCsOn = input.p60 * input.pCsTeam;
  let bonus: number;
  if (input.bonusCfg) {
    const eReturns = eGoals + eAssists;
    if (pos === 'GK') {
      const c = input.bonusCfg.gk;
      bonus = Math.min(c.cap, c.base + c.cs_term * pCsOn * Math.min(1, input.saves90 / c.saves_norm));
    } else if (pos === 'DEF') {
      const c = input.bonusCfg.def;
      bonus = Math.min(c.cap, c.base + c.slope * eReturns + c.cs_term * pCsOn * (0.4 + pDefcon));
    } else {
      const c = input.bonusCfg.fwd_mid;
      bonus = Math.min(c.cap, c.base + c.slope * eReturns);
    }
    bonus *= input.pAny;
  } else {
    const bp = (profile: Record<string, number>): number => profile[pos] ?? 0;
    const pScore = 1 - Math.exp(-eGoals);
    const pAssist = 1 - Math.exp(-eAssists);
    const pHighSaves = pos === 'GK' ? Math.max(0, 1 - poissonPmf(eSaves, 0) - poissonPmf(eSaves, 1) - poissonPmf(eSaves, 2) - poissonPmf(eSaves, 3) - poissonPmf(eSaves, 4)) : 0;
    const pNothing = Math.max(0, 1 - pScore - pAssist * 0.7 - pCsOn * 0.5 - pHighSaves);
    bonus =
      input.pAny *
      (pScore * (pCsOn > 0.3 ? bp(bonusProfiles.scored_and_cs) : bp(bonusProfiles.scored)) +
        pAssist * (1 - pScore) * bp(bonusProfiles.assisted) +
        pCsOn * pDefcon * bp(bonusProfiles.cs_and_defcon) +
        pHighSaves * bp(bonusProfiles.high_saves) +
        pNothing * bp(bonusProfiles.nothing));
  }

  // L8 negatives
  const concededPenalty = pos === 'GK' || pos === 'DEF' ? input.p60 * input.eConcedePts : 0;
  const eYc = input.yc90 * exposure;
  const eRc = input.rc90 * exposure;
  const cards = eYc * rules.yellow + eRc * rules.red;
  const eOg = 0.004 * exposure; // league base rate
  const ownGoalAndPenMiss = eOg * rules.own_goal;

  const total =
    appearance + goals + assists + cleanSheet + defcon + saves + bonus + concededPenalty + cards + ownGoalAndPenMiss;

  // independent-term variance approximation (v1 — documented shortfall)
  const goalPts = rules.goal[pos] ?? 5;
  const variance =
    eGoals * goalPts * goalPts +
    eAssists * 9 +
    input.p60 * input.pCsTeam * (1 - input.p60 * input.pCsTeam) * csPts * csPts +
    pDefcon * (1 - pDefcon) * 4 +
    input.pAny * (1 - input.pAny) * 4 +
    eSaves * 0.11;

  return {
    appearance,
    goals,
    assists,
    cleanSheet,
    defcon,
    saves,
    bonus,
    concededPenalty,
    cards,
    ownGoalAndPenMiss,
    total: Math.max(0, total),
    variance,
    eGoals,
    eAssists,
    pDefcon,
    eSaves,
  };
}

export interface ActualStats {
  position: string;
  minutes: number;
  goals: number;
  assists: number;
  cs: boolean;
  conceded: number;
  og: number;
  penSaved: number;
  penMissed: number;
  yc: number;
  rc: number;
  saves: number;
  bonus: number;
  cbit: number;
  cbirt: number;
  defconCount?: number; // FPL's own defensive_contribution stat when present
}

/**
 * The game's own arithmetic. Property test: this must equal FPL's official
 * points on every historical row (fpl-engines-plan.md §1.2.4, §3.5).
 */
export function pointsFromStats(s: ActualStats, rules: ScoringRules): number {
  const pos = s.position in rules.goal ? s.position : 'MID';
  let pts = 0;
  if (s.minutes > 0) pts += s.minutes >= 60 ? rules.appearance.from60 : rules.appearance.under60;
  pts += s.goals * (rules.goal[pos] ?? 5);
  pts += s.assists * rules.assist;
  if (s.minutes >= 60 && s.cs) pts += rules.clean_sheet[pos] ?? 0;
  if (pos === 'GK') {
    pts += Math.floor(s.saves / rules.saves_per_point);
    pts += s.penSaved * rules.penalty_save;
  }
  if ((pos === 'GK' || pos === 'DEF') && s.minutes > 0) {
    pts -= Math.floor(s.conceded / rules.goals_conceded_per_minus1);
  }
  const defconRule = rules.defcon[pos];
  if (defconRule && s.minutes > 0) {
    const count = defconRule.metric === 'cbit' ? s.cbit : s.cbirt;
    if (count >= defconRule.threshold) pts += defconRule.points;
  }
  pts += s.penMissed * rules.penalty_miss;
  pts += s.yc * rules.yellow;
  pts += s.rc * rules.red;
  pts += s.og * rules.own_goal;
  pts += s.bonus;
  return pts;
}
