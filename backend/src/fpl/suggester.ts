/**
 * Transfer suggester + team valuation (fpl-project.md §8, §8.3).
 * Enumerates 0/1/2-transfer moves (and hit variants), scores by Δ expected
 * points over the horizon minus hit cost, with reasoning from the matrix.
 */
import { validateSquad, pickStartingXi, transferHitCost, type SquadPlayer, type SquadRules, type ChipSetRules } from './rules.js';
import type { OptimiserCandidate } from './optimiser.js';

export interface TransferMove {
  out: string[];
  in: string[];
  deltaXpts: number;
  hitCost: number;
  netGain: number;
  bankAfter: number;
  reasons: Record<string, unknown>;
}

export interface SuggestInput {
  squad: OptimiserCandidate[]; // current 15 with xpts over horizon
  bank: number; // tenths
  freeTransfers: number;
  candidates: OptimiserCandidate[]; // full market
  rules: SquadRules;
  chipRules: ChipSetRules;
  maxSuggestions?: number;
}

export function suggestTransfers(input: SuggestInput): { best0: TransferMove; singles: TransferMove[]; doubles: TransferMove[] } {
  const { squad, bank, freeTransfers, candidates, rules, chipRules } = input;
  const squadUids = new Set(squad.map((p) => p.uid));
  const clubCount: Record<string, number> = {};
  for (const p of squad) clubCount[p.club] = (clubCount[p.club] ?? 0) + 1;

  const baseXi = pickStartingXi(squad, rules);
  const best0: TransferMove = {
    out: [],
    in: [],
    deltaXpts: 0,
    hitCost: 0,
    netGain: 0,
    bankAfter: bank,
    reasons: { kind: 'no_transfer', captain: baseXi.captain, formation: baseXi.formation.join('-') },
  };

  // single transfers: for each squad player, best same-position replacements
  const singles: TransferMove[] = [];
  for (const out of squad) {
    const budget = bank + out.price;
    const replacements = candidates
      .filter(
        (c) =>
          c.position === out.position &&
          !squadUids.has(c.uid) &&
          c.price <= budget &&
          (c.club === out.club || (clubCount[c.club] ?? 0) < rules.max_per_club),
      )
      .sort((a, b) => b.xpts - a.xpts)
      .slice(0, 3);
    for (const rep of replacements) {
      const newSquad = squad.map((p) => (p.uid === out.uid ? rep : p));
      const validation = validateSquad(newSquad, rules, squad.reduce((s, p) => s + p.price, 0) + bank);
      if (!validation.valid) continue;
      const newXi = pickStartingXi(newSquad, rules);
      const deltaXpts = newXi.xptsTotal - baseXi.xptsTotal;
      if (deltaXpts <= 0.05) continue;
      const hitCost = transferHitCost(1, freeTransfers, chipRules);
      singles.push({
        out: [out.uid],
        in: [rep.uid],
        deltaXpts,
        hitCost,
        netGain: deltaXpts - hitCost,
        bankAfter: bank + out.price - rep.price,
        reasons: {
          out_xpts: r2(out.xpts),
          in_xpts: r2(rep.xpts),
          out_p_start: r2(out.pStart),
          in_p_start: r2(rep.pStart),
        },
      });
    }
  }
  singles.sort((a, b) => b.netGain - a.netGain);

  // double transfers: compose from the top singles, validate jointly
  const doubles: TransferMove[] = [];
  const topSingles = singles.slice(0, 8);
  for (let i = 0; i < topSingles.length; i++) {
    for (let j = i + 1; j < topSingles.length; j++) {
      const a = topSingles[i]!;
      const b = topSingles[j]!;
      if (a.out[0] === b.out[0] || a.in[0] === b.in[0]) continue;
      const outUids = new Set([...a.out, ...b.out]);
      const inPlayers = [...a.in, ...b.in].map((uid) => candidates.find((c) => c.uid === uid)!);
      const newSquad = [...squad.filter((p) => !outUids.has(p.uid)), ...inPlayers];
      const totalBudget = squad.reduce((s, p) => s + p.price, 0) + bank;
      const validation = validateSquad(newSquad, rules, totalBudget);
      if (!validation.valid) continue;
      const newXi = pickStartingXi(newSquad, rules);
      const deltaXpts = newXi.xptsTotal - baseXi.xptsTotal;
      const hitCost = transferHitCost(2, freeTransfers, chipRules);
      const netGain = deltaXpts - hitCost;
      if (netGain <= 0.1) continue;
      doubles.push({
        out: [...outUids],
        in: inPlayers.map((p) => p.uid),
        deltaXpts,
        hitCost,
        netGain,
        bankAfter: totalBudget - newSquad.reduce((s, p) => s + p.price, 0),
        reasons: { composed_of: [a.reasons, b.reasons] },
      });
    }
  }
  doubles.sort((a, b) => b.netGain - a.netGain);

  const cap = input.maxSuggestions ?? 5;
  return { best0, singles: singles.slice(0, cap), doubles: doubles.slice(0, cap) };
}

export interface TeamValuation {
  score: number; // 0–100
  pointsPotential: number;
  benchStrength: number;
  captaincyQuality: number;
  budgetEfficiency: number;
  detail: Record<string, number>;
}

/** Rate any 15-man squad 0–100 vs the market's best achievable squad. */
export function valuateTeam(
  squad: OptimiserCandidate[],
  benchmarkXpts: number, // optimal squad's XI xpts over the same horizon
  rules: SquadRules,
): TeamValuation {
  const xi = pickStartingXi(squad, rules);
  const starterUids = new Set(xi.starters.map((p) => p.uid));
  const benchXpts = squad.filter((p) => !starterUids.has(p.uid)).reduce((s, p) => s + p.xpts, 0);
  const captainXpts = Math.max(...squad.map((p) => p.xpts));
  const cost = squad.reduce((s, p) => s + p.price, 0);

  const pointsPotential = benchmarkXpts > 0 ? Math.min(1, xi.xptsTotal / benchmarkXpts) : 0.5;
  const benchStrength = Math.min(1, benchXpts / 12);
  const captaincyQuality = Math.min(1, captainXpts / 8);
  const budgetEfficiency = cost > 0 ? Math.min(1, (xi.xptsTotal / (cost / 10)) / 0.75) : 0;

  const score = 100 * (0.55 * pointsPotential + 0.15 * benchStrength + 0.15 * captaincyQuality + 0.15 * budgetEfficiency);
  return {
    score: Number(score.toFixed(1)),
    pointsPotential: r2(pointsPotential * 100),
    benchStrength: r2(benchStrength * 100),
    captaincyQuality: r2(captaincyQuality * 100),
    budgetEfficiency: r2(budgetEfficiency * 100),
    detail: { xi_xpts: r2(xi.xptsTotal), bench_xpts: r2(benchXpts), benchmark_xpts: r2(benchmarkXpts), cost },
  };
}

function r2(x: number): number {
  return Number(x.toFixed(2));
}
