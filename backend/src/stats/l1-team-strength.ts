/**
 * L1 — Team strength: Dixon-Coles with xG blend (fpl-engines-plan.md §4.2).
 * Pure functions over an in-memory match list; fitting is weighted Poisson
 * MLE by gradient ascent (concave without ρ), then a 1-D grid search for the
 * DC low-score dependence ρ. Time-decayed likelihood w = exp(−ξ·Δdays).
 */

export interface StrengthMatch {
  homeKey: string;
  awayKey: string;
  homeGoals: number; // pseudo-goals: 0.6·xG + 0.4·goals when xG available
  awayGoals: number;
  daysAgo: number;
}

export interface TeamStrengthParams {
  attack: Record<string, number>; // α, Σ = 0
  defence: Record<string, number>; // β, Σ = 0
  mu: number;
  homeAdv: number;
  rho: number;
  xi: number;
  teams: string[];
}

export interface FixturePredictionOut {
  lambdaHome: number;
  lambdaAway: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  pCsHome: number; // P(away scores 0)
  pCsAway: number;
  concessionHome: number[]; // P(GA_home = 0,1,2,...)
  concessionAway: number[];
  eConcedePtsHome: number; // E[−⌊GA/2⌋] for home GK/DEF
  eConcedePtsAway: number;
}

const MAX_GOALS = 10;

export function fitTeamStrength(
  matches: StrengthMatch[],
  opts: {
    xi?: number;
    priorTeams?: Record<string, { attack: number; defence: number }>; // promoted-team priors
    iterations?: number;
    learningRate?: number;
  } = {},
): TeamStrengthParams {
  const xi = opts.xi ?? 0.0035;
  const teams = [...new Set(matches.flatMap((m) => [m.homeKey, m.awayKey]))];
  for (const t of Object.keys(opts.priorTeams ?? {})) if (!teams.includes(t)) teams.push(t);

  const attack: Record<string, number> = {};
  const defence: Record<string, number> = {};
  for (const t of teams) {
    attack[t] = opts.priorTeams?.[t]?.attack ?? 0;
    defence[t] = opts.priorTeams?.[t]?.defence ?? 0;
  }
  let mu = Math.log(1.35);
  let homeAdv = 0.25;

  const weights = matches.map((m) => Math.exp(-xi * m.daysAgo));
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.06;

  // effective (decay-weighted) match count per team; teams with little data
  // shrink toward their prior/zero
  const effCount: Record<string, number> = {};
  for (const t of teams) effCount[t] = 0;
  matches.forEach((m, i) => {
    effCount[m.homeKey] = (effCount[m.homeKey] ?? 0) + weights[i]!;
    effCount[m.awayKey] = (effCount[m.awayKey] ?? 0) + weights[i]!;
  });

  for (let iter = 0; iter < iterations; iter++) {
    const gradA: Record<string, number> = {};
    const gradB: Record<string, number> = {};
    for (const t of teams) {
      gradA[t] = 0;
      gradB[t] = 0;
    }
    let gradMu = 0;
    let gradHome = 0;
    let totalW = 0;

    matches.forEach((m, i) => {
      const w = weights[i]!;
      totalW += w;
      const lamH = Math.exp(mu + attack[m.homeKey]! - defence[m.awayKey]! + homeAdv);
      const lamA = Math.exp(mu + attack[m.awayKey]! - defence[m.homeKey]!);
      // ∂ll/∂λ · ∂λ/∂θ for Poisson: (g − λ)
      const dH = w * (m.homeGoals - lamH);
      const dA = w * (m.awayGoals - lamA);
      gradA[m.homeKey]! += dH;
      gradB[m.awayKey]! -= dH;
      gradA[m.awayKey]! += dA;
      gradB[m.homeKey]! -= dA;
      gradMu += dH + dA;
      gradHome += dH;
    });

    const scale = lr / Math.max(1, totalW / matches.length);
    for (const t of teams) {
      const n = effCount[t] ?? 0;
      // ridge toward prior for thin data (promoted teams keep their prior)
      const priorA = opts.priorTeams?.[t]?.attack ?? 0;
      const priorB = opts.priorTeams?.[t]?.defence ?? 0;
      const ridge = 2.0; // effective prior matches
      attack[t] = attack[t]! + scale * (gradA[t]! / Math.max(1, n)) - scale * ((ridge / (n + ridge)) * (attack[t]! - priorA)) * 0.1;
      defence[t] = defence[t]! + scale * (gradB[t]! / Math.max(1, n)) - scale * ((ridge / (n + ridge)) * (defence[t]! - priorB)) * 0.1;
    }
    mu += scale * (gradMu / Math.max(1, matches.length));
    homeAdv += scale * (gradHome / Math.max(1, matches.length));

    // identifiability: Σα = Σβ = 0
    const meanA = teams.reduce((s, t) => s + attack[t]!, 0) / teams.length;
    const meanB = teams.reduce((s, t) => s + defence[t]!, 0) / teams.length;
    for (const t of teams) {
      attack[t] = attack[t]! - meanA;
      defence[t] = defence[t]! - meanB;
    }
    mu += meanA - meanB;
  }

  // ρ grid search on the DC-corrected likelihood (integer-goal matches only)
  let bestRho = 0;
  let bestLl = -Infinity;
  for (let rho = -0.2; rho <= 0.05; rho += 0.01) {
    let ll = 0;
    matches.forEach((m, i) => {
      const lamH = Math.exp(mu + attack[m.homeKey]! - defence[m.awayKey]! + homeAdv);
      const lamA = Math.exp(mu + attack[m.awayKey]! - defence[m.homeKey]!);
      const gh = Math.round(m.homeGoals);
      const ga = Math.round(m.awayGoals);
      const tau = dcTau(gh, ga, lamH, lamA, rho);
      if (tau <= 0) {
        ll += weights[i]! * -50;
        return;
      }
      ll += weights[i]! * (Math.log(tau) + gh * Math.log(lamH) - lamH + ga * Math.log(lamA) - lamA);
    });
    if (ll > bestLl) {
      bestLl = ll;
      bestRho = rho;
    }
  }

  return {
    attack,
    defence,
    mu,
    homeAdv,
    rho: Number(bestRho.toFixed(3)),
    xi,
    teams,
  };
}

function dcTau(x: number, y: number, lamH: number, lamA: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lamH * lamA * rho;
  if (x === 0 && y === 1) return 1 + lamH * rho;
  if (x === 1 && y === 0) return 1 + lamA * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p = (p * lambda) / i;
  return p;
}

export function fixtureLambdas(
  params: TeamStrengthParams,
  homeKey: string,
  awayKey: string,
): { lambdaHome: number; lambdaAway: number } {
  const a = (t: string): number => params.attack[t] ?? 0;
  const d = (t: string): number => params.defence[t] ?? 0;
  return {
    lambdaHome: Math.exp(params.mu + a(homeKey) - d(awayKey) + params.homeAdv),
    lambdaAway: Math.exp(params.mu + a(awayKey) - d(homeKey)),
  };
}

export function predictFromLambdas(lambdaHome: number, lambdaAway: number, rho: number): FixturePredictionOut {
  // τ-adjusted scoreline grid
  const grid: number[][] = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    grid[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poissonPmf(lambdaHome, h) * poissonPmf(lambdaAway, a) * dcTau(h, a, lambdaHome, lambdaAway, rho);
      grid[h]![a] = Math.max(0, p);
      total += grid[h]![a]!;
    }
  }
  for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) grid[h]![a] = grid[h]![a]! / total;

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  const concessionHome = new Array(MAX_GOALS + 1).fill(0) as number[]; // GA of home team = away goals
  const concessionAway = new Array(MAX_GOALS + 1).fill(0) as number[];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = grid[h]![a]!;
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      concessionHome[a] = concessionHome[a]! + p;
      concessionAway[h] = concessionAway[h]! + p;
    }
  }
  const eConcede = (dist: number[]): number => dist.reduce((s, p, ga) => s + p * -Math.floor(ga / 2), 0);
  return {
    lambdaHome,
    lambdaAway,
    pHome,
    pDraw,
    pAway,
    pCsHome: concessionHome[0]!,
    pCsAway: concessionAway[0]!,
    concessionHome,
    concessionAway,
    eConcedePtsHome: eConcede(concessionHome),
    eConcedePtsAway: eConcede(concessionAway),
  };
}

/** Neutral-schedule baseline λ for a team (mean over opponents, half home/away). */
export function baselineLambda(params: TeamStrengthParams, teamKey: string, opponents: string[]): number {
  if (opponents.length === 0) return Math.exp(params.mu + params.homeAdv / 2);
  let sum = 0;
  for (const opp of opponents) {
    if (opp === teamKey) continue;
    const home = fixtureLambdas(params, teamKey, opp).lambdaHome;
    const away = fixtureLambdas(params, opp, teamKey).lambdaAway;
    sum += (home + away) / 2;
  }
  return sum / Math.max(1, opponents.length - (opponents.includes(teamKey) ? 1 : 0));
}
