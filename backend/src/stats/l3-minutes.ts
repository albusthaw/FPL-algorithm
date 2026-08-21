/**
 * L3 — Minutes model v1 (fpl-engines-plan.md §4.4): calibrated hierarchical
 * heuristic. The highest-leverage model in the system. Outputs genuine
 * probabilities: p_start, p_60, p_any, E[min].
 */

export interface AvailabilityInput {
  status: string; // FPL: a d i s u n
  chanceNext: number | null; // null|0|25|50|75|100 (null ⇒ 100)
  activeInjury: { kind: string; expectedReturn: Date | null } | null;
  confirmedLineup: 'xi' | 'bench' | 'absent' | null;
}

export interface MinutesModelInput extends AvailabilityInput {
  position: string;
  selectedByPct?: number; // ownership — proxy for "undroppable"
  startShare5: number;
  minutesEwma: number;
  startedLast: boolean;
  daysSinceLastMatch: number | null;
  congested: boolean; // club fixture within ±4 days
  newSigning: boolean; // < 4 club matches in our data
  returnedFromInjury: boolean; // played < 2 matches since an injury ended
  fixturesAhead: number; // 1 = next fixture, 2+ = later (horizon regression)
}

export interface MinutesPrediction {
  pStart: number;
  p60: number;
  pAny: number;
  eMin: number;
  availabilityState: string;
  evidence: Record<string, unknown>;
}

export interface MinutesConfig {
  start_share_table: { min_share: number; ewma_min: number; p_start: number }[];
  undroppable_floors?: { own: number; p: number }[];
  congestion_mult: number;
  returned_injury_mult: number;
  new_signing_mult: number;
  e_min_start: Record<string, number>;
  p_sub: Record<string, number>;
  e_min_sub: Record<string, number>;
  horizon_regression: number;
}

const P60_GIVEN_START: Record<string, number> = { GK: 0.99, DEF: 0.93, MID: 0.82, FWD: 0.78, UNK: 0.85 };
const POSITIONAL_BASE_PSTART: Record<string, number> = { GK: 0.5, DEF: 0.45, MID: 0.42, FWD: 0.45, UNK: 0.4 };

export function predictMinutes(input: MinutesModelInput, cfg: MinutesConfig): MinutesPrediction {
  const evidence: Record<string, unknown> = {};
  const pos = input.position in P60_GIVEN_START ? input.position : 'UNK';

  // hard unavailability
  if (['i', 's', 'u', 'n'].includes(input.status) || input.chanceNext === 0) {
    return { pStart: 0, p60: 0, pAny: 0, eMin: 0, availabilityState: statusName(input.status), evidence: { rule: 'status_out', status: input.status } };
  }

  // confirmed lineup override (fast path §6.5) — only for the NEXT fixture
  if (input.confirmedLineup && input.fixturesAhead <= 1) {
    const pStart = input.confirmedLineup === 'xi' ? 0.99 : input.confirmedLineup === 'bench' ? 0.02 : 0.01;
    const pSub = input.confirmedLineup === 'bench' ? 0.55 : 0.05;
    const p60 = pStart * (P60_GIVEN_START[pos] ?? 0.85);
    const pAny = Math.min(1, pStart + (1 - pStart) * pSub);
    const eMin = pStart * (cfg.e_min_start[pos] ?? 82) + (1 - pStart) * pSub * (cfg.e_min_sub[pos] ?? 22);
    return { pStart, p60, pAny, eMin, availabilityState: `confirmed_${input.confirmedLineup}`, evidence: { rule: 'confirmed_lineup' } };
  }

  // base from the ⚙ start-share table
  let base = 0.05;
  for (const row of cfg.start_share_table) {
    if (input.startShare5 >= row.min_share && input.minutesEwma >= row.ewma_min) {
      base = row.p_start;
      break;
    }
  }
  // cold start (no match history at all — fresh install, pre-season, or a
  // brand-new player): ownership is the community's revealed start
  // expectation, the strongest signal available without minutes data
  if (input.startShare5 === 0 && input.minutesEwma === 0) {
    const own = Math.max(0, Math.min(100, input.selectedByPct ?? 0));
    const ownershipPrior = Math.min(0.92, 0.15 + 0.9 * Math.sqrt(own / 100));
    if (ownershipPrior > base) {
      base = ownershipPrior;
      evidence.coldStartOwnershipPrior = Number(ownershipPrior.toFixed(3));
    }
  }
  evidence.base = base;
  evidence.startShare5 = input.startShare5;
  evidence.minutesEwma = Math.round(input.minutesEwma);

  // FPL doubt flags scale multiplicatively
  let pStart = base;
  let state = 'fit';
  if (input.chanceNext != null && input.chanceNext < 100) {
    pStart = base * (input.chanceNext / 100);
    state = `doubt_${100 - input.chanceNext}`;
    evidence.chance = input.chanceNext;
  } else if (input.status === 'd') {
    pStart = base * 0.5;
    state = 'doubt_50';
  }

  // modifiers (multiplicative, capped)
  if (input.congested) {
    pStart *= cfg.congestion_mult;
    evidence.congested = true;
  }
  if (input.returnedFromInjury) {
    pStart *= cfg.returned_injury_mult;
    evidence.returnedFromInjury = true;
  }
  if (input.newSigning) {
    pStart *= cfg.new_signing_mult;
    evidence.newSigning = true;
  }

  // "undroppable" floor: heavily-owned, fully-fit players are start locks
  // regardless of end-of-last-season rotation noise (⚙ floors)
  if (input.status === 'a' && input.chanceNext == null && !input.returnedFromInjury && !input.newSigning) {
    for (const floor of cfg.undroppable_floors ?? []) {
      if ((input.selectedByPct ?? 0) >= floor.own && pStart < floor.p) {
        pStart = floor.p;
        evidence.undroppableFloor = floor.p;
        break;
      }
    }
  }

  // horizon regression toward the positional base rate for fixture k ahead
  if (input.fixturesAhead > 1) {
    const w = Math.pow(cfg.horizon_regression, input.fixturesAhead - 1);
    pStart = w * pStart + (1 - w) * (POSITIONAL_BASE_PSTART[pos] ?? 0.4) * (state.startsWith('doubt') ? 0.7 : 1);
  }

  pStart = Math.max(0, Math.min(0.99, pStart));
  const pSub = (cfg.p_sub[pos] ?? 0.3) * (1 - pStart);
  const p60 = pStart * (P60_GIVEN_START[pos] ?? 0.85);
  const pAny = Math.min(1, pStart + pSub);
  const eMinStart = cfg.e_min_start[pos] ?? 82;
  const scaledEminStart = Math.min(eMinStart, Math.max(60, input.minutesEwma > 0 ? 0.5 * eMinStart + 0.5 * Math.min(95, input.minutesEwma + 10) : eMinStart));
  const eMin = pStart * scaledEminStart + pSub * (cfg.e_min_sub[pos] ?? 22);

  return { pStart, p60, pAny, eMin, availabilityState: state, evidence };
}

function statusName(status: string): string {
  switch (status) {
    case 'i':
      return 'out_injured';
    case 's':
      return 'suspended';
    case 'u':
      return 'unavailable';
    case 'n':
      return 'ineligible';
    default:
      return 'out';
  }
}
