/**
 * L0 — Feature factory (fpl-engines-plan.md §4.1).
 * Leakage rule: every feature is computed strictly as-of a timestamp t —
 * only match rows with kickoff < t enter. The same code serves live runs
 * and backtests. Empirical-Bayes shrinkage toward positional priors guards
 * against small-sample per-90 lies.
 */

export interface MatchRow {
  kickoff: Date;
  minutes: number;
  starts: boolean;
  goals: number;
  assists: number;
  saves: number;
  cbit: number;
  cbirt: number;
  defconCount: number;
  xg: number | null;
  xa: number | null;
  fplPoints: number;
  yc: number;
  rc: number;
  shots?: number | null;
  keyPasses?: number | null;
}

export interface PlayerFeatures {
  matchesUsed: number;
  minutesTotal: number;
  xg90: number; // shrunk
  xa90: number;
  saves90: number;
  cbit90: number;
  cbirt90: number;
  yc90: number;
  rc90: number;
  formEwma: number; // decay-weighted mean FPL points per played match
  minutesEwma: number;
  startShare5: number; // decay-weighted start share, last 5 club matches he was in squad-window
  startedLast: boolean;
  defconHitRate: number; // empirical share of played matches hitting the DEFCON threshold
  rawXg90: number; // pre-shrinkage, for diagnostics
  rawXa90: number;
  daysSinceLastMatch: number | null;
}

export interface PositionPriors {
  xg90: number;
  xa90: number;
  saves90: number;
  cbit90: number;
  cbirt90: number;
  yc90: number;
  rc90: number;
  defconHitRate: number;
}

export const DEFAULT_PRIORS: Record<string, PositionPriors> = {
  GK: { xg90: 0.005, xa90: 0.005, saves90: 3.0, cbit90: 1.0, cbirt90: 3.0, yc90: 0.04, rc90: 0.002, defconHitRate: 0.0 },
  DEF: { xg90: 0.08, xa90: 0.08, saves90: 0, cbit90: 7.0, cbirt90: 12.0, yc90: 0.18, rc90: 0.006, defconHitRate: 0.22 },
  MID: { xg90: 0.18, xa90: 0.15, saves90: 0, cbit90: 3.5, cbirt90: 8.0, yc90: 0.15, rc90: 0.004, defconHitRate: 0.08 },
  FWD: { xg90: 0.35, xa90: 0.12, saves90: 0, cbit90: 1.5, cbirt90: 4.5, yc90: 0.12, rc90: 0.003, defconHitRate: 0.01 },
  UNK: { xg90: 0.15, xa90: 0.1, saves90: 0, cbit90: 3, cbirt90: 7, yc90: 0.14, rc90: 0.004, defconHitRate: 0.06 },
};

function shrink(rate: number, effectiveMatches: number, prior: number, k: number): number {
  return (effectiveMatches * rate + k * prior) / (effectiveMatches + k);
}

export function computePlayerFeatures(
  rows: MatchRow[],
  asOf: Date,
  position: string,
  opts: {
    priors?: Record<string, PositionPriors>;
    price?: number; // tenths — selects the position×price-band prior
    shrinkageK?: number; // ⚙ effective matches
    decayXi?: number; // ⚙ per day
    minutesEwmaHalflife?: number; // ⚙ club matches
    defconThreshold?: number;
    defconMetric?: 'cbit' | 'cbirt';
  } = {},
): PlayerFeatures {
  const priors = priorFor(opts.priors ?? DEFAULT_PRIORS, position, opts.price ?? 55);
  const k = opts.shrinkageK ?? 6;
  const xi = opts.decayXi ?? 0.01;
  const past = rows
    .filter((r) => r.kickoff.getTime() < asOf.getTime())
    .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());

  if (past.length === 0) {
    return {
      matchesUsed: 0,
      minutesTotal: 0,
      xg90: priors.xg90,
      xa90: priors.xa90,
      saves90: priors.saves90,
      cbit90: priors.cbit90,
      cbirt90: priors.cbirt90,
      yc90: priors.yc90,
      rc90: priors.rc90,
      formEwma: 0,
      minutesEwma: 0,
      startShare5: 0,
      startedLast: false,
      defconHitRate: priors.defconHitRate,
      rawXg90: 0,
      rawXa90: 0,
      daysSinceLastMatch: null,
    };
  }

  // decay-weighted per-90 rates over the last 38 matches. Decay runs in
  // FOOTBALL TIME — days relative to the player's most recent match — so the
  // summer break doesn't crush last season's rates for everyone (the §4.1
  // new-season blend is carried by the shrinkage priors, not by wall-clock
  // decay of the whole population).
  const window = past.slice(-38);
  const anchorTime = past[past.length - 1]!.kickoff.getTime();
  let wMin = 0;
  let wXg = 0;
  let wXa = 0;
  let wSaves = 0;
  let wCbit = 0;
  let wCbirt = 0;
  let wYc = 0;
  let wRc = 0;
  for (const r of window) {
    const days = (anchorTime - r.kickoff.getTime()) / 86_400_000;
    const w = Math.exp(-xi * days);
    wMin += w * r.minutes;
    wXg += w * (r.xg ?? 0);
    wXa += w * (r.xa ?? 0);
    wSaves += w * r.saves;
    wCbit += w * r.cbit;
    wCbirt += w * r.cbirt;
    wYc += w * r.yc;
    wRc += w * r.rc;
  }
  // effective sample size for shrinkage: UNDECAYED minutes (a 30-match
  // sample deserves a 30-match sample's trust; decay shapes the rate, not
  // the confidence)
  const effMatches = window.reduce((s, r) => s + r.minutes, 0) / 90;
  const rate90 = (num: number): number => (wMin > 0 ? (90 * num) / wMin : 0);
  const rawXg90 = rate90(wXg);
  const rawXa90 = rate90(wXa);

  // form EWMA over played matches (decay-weighted mean of FPL points)
  let formNum = 0;
  let formDen = 0;
  for (const r of window) {
    if (r.minutes === 0) continue;
    const days = (anchorTime - r.kickoff.getTime()) / 86_400_000;
    const w = Math.exp(-xi * days);
    formNum += w * r.fplPoints;
    formDen += w;
  }

  // minutes EWMA over the last club matches (half-life in matches)
  const halflife = opts.minutesEwmaHalflife ?? 4;
  const lambdaM = Math.log(2) / halflife;
  let mNum = 0;
  let mDen = 0;
  const recent = past.slice(-10);
  recent.forEach((r, idx) => {
    const age = recent.length - 1 - idx;
    const w = Math.exp(-lambdaM * age);
    mNum += w * r.minutes;
    mDen += w;
  });

  // start share: last 5 blended with last 15 (0.65/0.35) — pure last-5 picks
  // up end-of-season rotation noise at the start of a new season
  const last5 = past.slice(-5);
  const last15 = past.slice(-15);
  const share = (rows: MatchRow[]): number => (rows.length > 0 ? rows.filter((r) => r.starts).length / rows.length : 0);
  const startShare5 = last5.length > 0 ? 0.65 * share(last5) + 0.35 * share(last15) : 0;

  // DEFCON hit rate over played matches, last ⚙15
  const metric = opts.defconMetric ?? (position === 'DEF' || position === 'GK' ? 'cbit' : 'cbirt');
  const threshold = opts.defconThreshold ?? (metric === 'cbit' ? 10 : 12);
  const playedRecent = past.filter((r) => r.minutes >= 45).slice(-15);
  const defconHitsRaw =
    playedRecent.length > 0
      ? playedRecent.filter((r) => (metric === 'cbit' ? r.cbit : r.cbirt) >= threshold).length / playedRecent.length
      : priors.defconHitRate;

  const lastMatch = past[past.length - 1]!;

  return {
    matchesUsed: window.length,
    minutesTotal: past.reduce((s, r) => s + r.minutes, 0),
    xg90: shrink(rawXg90, effMatches, priors.xg90, k),
    xa90: shrink(rawXa90, effMatches, priors.xa90, k),
    saves90: shrink(rate90(wSaves), effMatches, priors.saves90, k),
    cbit90: shrink(rate90(wCbit), effMatches, priors.cbit90, k),
    cbirt90: shrink(rate90(wCbirt), effMatches, priors.cbirt90, k),
    yc90: shrink(rate90(wYc), effMatches, priors.yc90, k),
    rc90: shrink(rate90(wRc), effMatches, priors.rc90, k),
    formEwma: formDen > 0 ? formNum / formDen : 0,
    minutesEwma: mDen > 0 ? mNum / mDen : 0,
    startShare5,
    startedLast: lastMatch.starts,
    defconHitRate: shrink(defconHitsRaw, Math.min(playedRecent.length, 15) / 3, priors.defconHitRate, 2),
    rawXg90,
    rawXa90,
    daysSinceLastMatch: (asOf.getTime() - lastMatch.kickoff.getTime()) / 86_400_000,
  };
}

export type PriceBand = 'budget' | 'mid' | 'premium';

/** Price-band for a player within their position (tenths). ⚙ cutoffs. */
export function priceBandOf(position: string, price: number): PriceBand {
  const cutoffs: Record<string, [number, number]> = {
    GK: [45, 52],
    DEF: [45, 55],
    MID: [55, 75],
    FWD: [55, 75],
  };
  const [lo, hi] = cutoffs[position] ?? [50, 70];
  return price <= lo ? 'budget' : price <= hi ? 'mid' : 'premium';
}

/**
 * Recompute priors per position × price-band from a historical population
 * (fpl-engines-plan.md §4.1: "priors per position×price-band recomputed each
 * season"). Falls back to position-level, then defaults.
 */
export function computePositionPriors(
  players: { position: string; price: number; rows: MatchRow[] }[],
): Record<string, PositionPriors> {
  const out: Record<string, PositionPriors> = { ...DEFAULT_PRIORS };
  const groups = new Map<string, MatchRow[]>();
  for (const p of players) {
    const band = priceBandOf(p.position, p.price);
    for (const key of [p.position, `${p.position}:${band}`]) {
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(...p.rows);
    }
  }
  for (const [key, rows] of groups) {
    const minutes = rows.reduce((s, r) => s + r.minutes, 0);
    if (minutes < 12_000) continue; // not enough data to override defaults
    const pos = key.split(':')[0]!;
    const per90 = (f: (r: MatchRow) => number): number => (90 * rows.reduce((s, r) => s + f(r), 0)) / minutes;
    const played = rows.filter((r) => r.minutes >= 45);
    const metric = pos === 'DEF' || pos === 'GK' ? 'cbit' : 'cbirt';
    const threshold = metric === 'cbit' ? 10 : 12;
    out[key] = {
      xg90: per90((r) => r.xg ?? 0),
      xa90: per90((r) => r.xa ?? 0),
      saves90: per90((r) => r.saves),
      cbit90: per90((r) => r.cbit),
      cbirt90: per90((r) => r.cbirt),
      yc90: per90((r) => r.yc),
      rc90: per90((r) => r.rc),
      defconHitRate:
        played.length > 0
          ? played.filter((r) => (metric === 'cbit' ? r.cbit : r.cbirt) >= threshold).length / played.length
          : (DEFAULT_PRIORS[pos]?.defconHitRate ?? 0.05),
    };
  }
  return out;
}

/** Resolve the most specific prior available for a player. */
export function priorFor(
  priors: Record<string, PositionPriors>,
  position: string,
  price: number,
): PositionPriors {
  return priors[`${position}:${priceBandOf(position, price)}`] ?? priors[position] ?? DEFAULT_PRIORS.UNK!;
}
