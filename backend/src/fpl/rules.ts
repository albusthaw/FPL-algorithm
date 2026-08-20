/**
 * FPL rules model (fpl-project.md §8): pure, unit-tested functions with
 * season-versioned rule configs. Squad 15 (2 GK / 5 DEF / 5 MID / 3 FWD),
 * ≤3 per club, budget, valid formations, chips (2026/27 two-set system).
 */

export interface SquadRules {
  squad_size: number;
  positions: Record<string, number>;
  max_per_club: number;
  budget: number; // in FPL tenths (£100.0m = 1000)
  valid_formations: number[][]; // [GK, DEF, MID, FWD]
}

export interface SquadPlayer {
  uid: string;
  position: string;
  club: string;
  price: number; // tenths
  xpts?: number;
}

export interface SquadValidation {
  valid: boolean;
  errors: string[];
}

export function validateSquad(players: SquadPlayer[], rules: SquadRules, budget?: number): SquadValidation {
  const errors: string[] = [];
  if (players.length !== rules.squad_size) {
    errors.push(`squad must have ${rules.squad_size} players, has ${players.length}`);
  }
  const uids = new Set(players.map((p) => p.uid));
  if (uids.size !== players.length) errors.push('duplicate players in squad');

  const posCounts: Record<string, number> = {};
  for (const p of players) posCounts[p.position] = (posCounts[p.position] ?? 0) + 1;
  for (const [pos, required] of Object.entries(rules.positions)) {
    if ((posCounts[pos] ?? 0) !== required) {
      errors.push(`position ${pos}: need ${required}, have ${posCounts[pos] ?? 0}`);
    }
  }

  const clubCounts: Record<string, number> = {};
  for (const p of players) clubCounts[p.club] = (clubCounts[p.club] ?? 0) + 1;
  for (const [club, n] of Object.entries(clubCounts)) {
    if (n > rules.max_per_club) errors.push(`more than ${rules.max_per_club} players from club ${club} (${n})`);
  }

  const totalCost = players.reduce((s, p) => s + p.price, 0);
  const cap = budget ?? rules.budget;
  if (totalCost > cap) errors.push(`squad cost ${totalCost / 10} exceeds budget ${cap / 10}`);

  return { valid: errors.length === 0, errors };
}

export interface StartingXi {
  starters: SquadPlayer[];
  bench: SquadPlayer[]; // bench order: [GK, out1, out2, out3]
  formation: number[];
  captain: string;
  vice: string;
  xptsTotal: number;
}

/** Pick the best valid starting XI + bench order + captaincy from a 15-man squad. */
export function pickStartingXi(players: SquadPlayer[], rules: SquadRules): StartingXi {
  const byPos = (pos: string): SquadPlayer[] =>
    players.filter((p) => p.position === pos).sort((a, b) => (b.xpts ?? 0) - (a.xpts ?? 0));
  const gks = byPos('GK');
  const defs = byPos('DEF');
  const mids = byPos('MID');
  const fwds = byPos('FWD');

  let best: { starters: SquadPlayer[]; formation: number[]; total: number } | null = null;
  for (const [gk, d, m, f] of rules.valid_formations) {
    if (gks.length < gk! || defs.length < d! || mids.length < m! || fwds.length < f!) continue;
    const starters = [...gks.slice(0, gk!), ...defs.slice(0, d!), ...mids.slice(0, m!), ...fwds.slice(0, f!)];
    const total = starters.reduce((s, p) => s + (p.xpts ?? 0), 0);
    if (!best || total > best.total) best = { starters, formation: [gk!, d!, m!, f!], total };
  }
  if (!best) throw new Error('no valid formation for squad');

  const starterUids = new Set(best.starters.map((p) => p.uid));
  const benchOutfield = players
    .filter((p) => !starterUids.has(p.uid) && p.position !== 'GK')
    .sort((a, b) => (b.xpts ?? 0) - (a.xpts ?? 0));
  const benchGk = players.filter((p) => !starterUids.has(p.uid) && p.position === 'GK');
  const sortedByXpts = [...best.starters].sort((a, b) => (b.xpts ?? 0) - (a.xpts ?? 0));

  return {
    starters: best.starters,
    bench: [...benchGk, ...benchOutfield],
    formation: best.formation,
    captain: sortedByXpts[0]?.uid ?? '',
    vice: sortedByXpts[1]?.uid ?? '',
    xptsTotal: best.total + (sortedByXpts[0]?.xpts ?? 0), // captain doubles
  };
}

export interface ChipSetRules {
  sets: { set: number; start_event: number; stop_event: number; chips: string[] }[];
  free_transfers_per_gw: number;
  max_banked_transfers: number;
  hit_cost: number;
}

/** Which chip set (1|2) is a chip playable from at a given event — null if none. */
export function chipSetForEvent(rules: ChipSetRules, chip: string, event: number, chipsUsed: { chip: string; set: number }[]): number | null {
  for (const set of rules.sets) {
    if (event < set.start_event || event > set.stop_event) continue;
    if (!set.chips.includes(chip)) continue;
    if (chipsUsed.some((u) => u.chip === chip && u.set === set.set)) continue;
    return set.set;
  }
  return null;
}

/** Free transfers roll: 1 free/GW, bankable to max. */
export function rollFreeTransfers(current: number, rules: ChipSetRules): number {
  return Math.min(rules.max_banked_transfers, current + rules.free_transfers_per_gw);
}

export function transferHitCost(transfers: number, freeTransfers: number, rules: ChipSetRules): number {
  return Math.max(0, transfers - freeTransfers) * rules.hit_cost;
}
