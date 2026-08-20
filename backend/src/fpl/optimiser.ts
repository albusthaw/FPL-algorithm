/**
 * Squad optimiser (fpl-project.md §8): ILP via javascript-lp-solver with a
 * documented greedy+swap fallback. Objective: maximise Σ expected points
 * (configurable horizon) + bench weighting, subject to the rules model.
 * Candidate pool pre-filtering keeps the ILP small (§6.2 note).
 */
// @ts-expect-error — javascript-lp-solver ships no types
import solver from 'javascript-lp-solver';
import { validateSquad, pickStartingXi, type SquadPlayer, type SquadRules, type StartingXi } from './rules.js';

export interface OptimiserCandidate extends SquadPlayer {
  xpts: number; // objective value over the chosen horizon
  pStart: number;
}

export interface SquadSolution {
  squad: SquadPlayer[];
  xi: StartingXi;
  totalCost: number;
  objective: number;
  method: 'ilp' | 'greedy';
}

export interface OptimiseOptions {
  budget?: number; // tenths
  locked?: string[]; // uids that MUST be in the squad
  banned?: string[]; // uids that must NOT be
  benchWeight?: number; // objective weight for bench slots (default 0.15)
  poolPerPosition?: number;
}

export function optimiseSquad(
  candidates: OptimiserCandidate[],
  rules: SquadRules,
  opts: OptimiseOptions = {},
): SquadSolution {
  const budget = opts.budget ?? rules.budget;
  const banned = new Set(opts.banned ?? []);
  const locked = new Set(opts.locked ?? []);
  const benchWeight = opts.benchWeight ?? 0.15;

  // candidate pool: locked + top-N per position by xpts and by value
  const poolN = opts.poolPerPosition ?? 18;
  const pool: OptimiserCandidate[] = [];
  const seen = new Set<string>();
  for (const pos of Object.keys(rules.positions)) {
    const posCands = candidates.filter((c) => c.position === pos && !banned.has(c.uid));
    const byXpts = [...posCands].sort((a, b) => b.xpts - a.xpts).slice(0, poolN);
    const byValue = [...posCands].sort((a, b) => b.xpts / Math.max(38, b.price) - a.xpts / Math.max(38, a.price)).slice(0, 10);
    const cheap = [...posCands].sort((a, b) => a.price - b.price).slice(0, 4); // enable budget benches
    for (const c of [...byXpts, ...byValue, ...cheap]) {
      if (!seen.has(c.uid)) {
        seen.add(c.uid);
        pool.push(c);
      }
    }
  }
  for (const uid of locked) {
    if (!seen.has(uid)) {
      const c = candidates.find((x) => x.uid === uid);
      if (c) {
        pool.push(c);
        seen.add(uid);
      }
    }
  }

  const ilp = tryIlp(pool, rules, budget, locked, benchWeight);
  if (ilp) return ilp;
  return greedySquad(pool, rules, budget, locked, benchWeight);
}

function objectiveValue(c: OptimiserCandidate, benchWeight: number): number {
  // squad-slot objective: starters carry full xpts; a player's likelihood of
  // starting proxies their share of full vs bench value
  return c.xpts * (benchWeight + (1 - benchWeight) * Math.min(1, Math.max(0.2, c.pStart + 0.35)));
}

function tryIlp(
  pool: OptimiserCandidate[],
  rules: SquadRules,
  budget: number,
  locked: Set<string>,
  benchWeight: number,
): SquadSolution | null {
  const model: Record<string, unknown> = {
    optimize: 'obj',
    opType: 'max',
    constraints: {
      cost: { max: budget },
      squad: { equal: rules.squad_size },
    } as Record<string, unknown>,
    variables: {} as Record<string, Record<string, number>>,
    ints: {} as Record<string, number>,
  };
  const constraints = model.constraints as Record<string, unknown>;
  const variables = model.variables as Record<string, Record<string, number>>;
  const ints = model.ints as Record<string, number>;

  for (const [pos, n] of Object.entries(rules.positions)) constraints[`pos_${pos}`] = { equal: n };
  const clubs = new Set(pool.map((c) => c.club));
  for (const club of clubs) constraints[`club_${club}`] = { max: rules.max_per_club };
  for (const uid of locked) constraints[`lock_${uid}`] = { equal: 1 };

  for (const c of pool) {
    const v: Record<string, number> = {
      obj: objectiveValue(c, benchWeight),
      cost: c.price,
      squad: 1,
      [`pos_${c.position}`]: 1,
      [`club_${c.club}`]: 1,
    };
    if (locked.has(c.uid)) v[`lock_${c.uid}`] = 1;
    variables[c.uid] = v;
    ints[c.uid] = 1;
  }

  const result = solver.Solve(model) as Record<string, unknown> & { feasible: boolean };
  if (!result.feasible) return null;
  const chosen = pool.filter((c) => Number(result[c.uid] ?? 0) >= 0.99);
  if (chosen.length !== rules.squad_size) return null;
  const validation = validateSquad(chosen, rules, budget);
  if (!validation.valid) return null;
  const xi = pickStartingXi(chosen, rules);
  return {
    squad: chosen,
    xi,
    totalCost: chosen.reduce((s, c) => s + c.price, 0),
    objective: chosen.reduce((s, c) => s + objectiveValue(c as OptimiserCandidate, benchWeight), 0),
    method: 'ilp',
  };
}

/** Greedy + swap fallback: fill by value density, then improve by 1-swaps. */
function greedySquad(
  pool: OptimiserCandidate[],
  rules: SquadRules,
  budget: number,
  locked: Set<string>,
  benchWeight: number,
): SquadSolution {
  const chosen: OptimiserCandidate[] = [];
  const posLeft: Record<string, number> = { ...rules.positions };
  const clubCount: Record<string, number> = {};
  let costLeft = budget;

  const canTake = (c: OptimiserCandidate): boolean =>
    (posLeft[c.position] ?? 0) > 0 &&
    (clubCount[c.club] ?? 0) < rules.max_per_club &&
    c.price <= costLeft &&
    !chosen.some((x) => x.uid === c.uid);

  const take = (c: OptimiserCandidate): void => {
    chosen.push(c);
    posLeft[c.position] = (posLeft[c.position] ?? 0) - 1;
    clubCount[c.club] = (clubCount[c.club] ?? 0) + 1;
    costLeft -= c.price;
  };

  for (const uid of locked) {
    const c = pool.find((x) => x.uid === uid);
    if (c && canTake(c)) take(c);
  }
  // fill cheapest-first for the last bench slots, best-value-first otherwise
  const byDensity = [...pool].sort(
    (a, b) => objectiveValue(b, benchWeight) / Math.max(38, b.price) - objectiveValue(a, benchWeight) / Math.max(38, a.price),
  );
  let guard = 0;
  while (chosen.length < rules.squad_size && guard++ < 1000) {
    // reserve budget for remaining slots at min price
    const slotsLeft = rules.squad_size - chosen.length;
    const cheapestFill = byDensity.filter(canTake).sort((a, b) => a.price - b.price);
    if (cheapestFill.length === 0) break;
    const minFill = cheapestFill.slice(0, slotsLeft).reduce((s, c) => s + c.price, 0);
    const pick = byDensity.find((c) => canTake(c) && c.price <= costLeft - (minFill - Math.min(...cheapestFill.map((x) => x.price))));
    take(pick ?? cheapestFill[0]!);
  }

  // 1-swap improvement passes
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let i = 0; i < chosen.length; i++) {
      const out = chosen[i]!;
      for (const cand of pool) {
        if (chosen.some((x) => x.uid === cand.uid)) continue;
        if (cand.position !== out.position) continue;
        if (locked.has(out.uid)) continue;
        const clubOk =
          cand.club === out.club || (clubCount[cand.club] ?? 0) < rules.max_per_club;
        const costOk = cand.price - out.price <= costLeft;
        if (!clubOk || !costOk) continue;
        if (objectiveValue(cand, benchWeight) > objectiveValue(out, benchWeight)) {
          clubCount[out.club]!--;
          clubCount[cand.club] = (clubCount[cand.club] ?? 0) + 1;
          costLeft -= cand.price - out.price;
          chosen[i] = cand;
          improved = true;
          break; // `out` is stale after a swap — restart this slot on the next pass
        }
      }
    }
    if (!improved) break;
  }

  const xi = pickStartingXi(chosen, rules);
  return {
    squad: chosen,
    xi,
    totalCost: chosen.reduce((s, c) => s + c.price, 0),
    objective: chosen.reduce((s, c) => s + objectiveValue(c, benchWeight), 0),
    method: 'greedy',
  };
}
