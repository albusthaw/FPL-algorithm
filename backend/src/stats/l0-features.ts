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
  npxg?: number | null; // non-penalty xG — kills pen double-counting for takers
  xa: number | null;
  fplPoints: number;
  yc: number;
  rc: number;
  shots?: number | null;
  keyPasses?: number | null;
  wasHome?: boolean | null; // A6 (v1.4.3): venue splits
  conceded?: number; // A7 (v1.4.5): GK save-rate = saves/(saves+conceded)
}

export interface PlayerFeatures {
  matchesUsed: number;
  minutesTotal: number;
  xg90: number; // shrunk
  npxg90: number; // shrunk non-penalty xG rate (== xg90 when npxg data absent)
  xa90: number;
  saves90: number;
  cbit90: number;
  cbirt90: number;
  yc90: number;
  rc90: number;
  formEwma: number; // decay-weighted mean FPL points per played match
  minutesEwma: number;
  startedMinutesAvg: number; // decay-weighted mean minutes in STARTED matches (0 = no starts)
  startShare5: number; // decay-weighted start share, last 5 club matches he was in squad-window
  startShareLong: number; // undecayed starts/matches over the full window — rotation history
  startedLast: boolean;
  defconHitRate: number; // empirical share of played matches hitting the DEFCON threshold
  rawXg90: number; // pre-shrinkage, for diagnostics
  rawXa90: number;
  daysSinceLastMatch: number | null;
  // A6 (v1.4.3): attacking-output venue ratios (xGI/90 at venue ÷ overall),
  // shrunk toward 1.0 and bounded — a real home specialist nudges up at
  // home, small samples stay neutral
  venueAttMultHome: number;
  venueAttMultAway: number;
  // A7 (v1.4.5, audit S12): the keeper's OWN save rate saves/(saves+conceded),
  // shrunk toward the league's ~0.70 — keeper quality is a persistent skill
  saveRate: number;
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

/**
 * Price-continuous attacking prior (statengineexpansion.md X7). FPL prices
 * ARE the market's published expected-returns prior — a £6.0 forward and a
 * £15.5 forward must not shrink toward the same target. Attacking rates
 * only; defensive volume stats keep the position×band priors.
 */
export interface PricePriorConfig {
  elasticity: number;
  mult_range: [number, number];
  ref_price: Record<string, number>; // tenths
  xg90_at_ref: Record<string, number>;
  xa90_at_ref: Record<string, number>;
}

export function pricePriorRates(cfg: PricePriorConfig, position: string, price: number): { xg90: number; xa90: number } | null {
  const ref = cfg.ref_price[position];
  const xgAtRef = cfg.xg90_at_ref[position];
  const xaAtRef = cfg.xa90_at_ref[position];
  if (!ref || ref <= 0 || price <= 0 || xgAtRef == null || xaAtRef == null) return null;
  const mult = Math.min(cfg.mult_range[1], Math.max(cfg.mult_range[0], Math.pow(price / ref, cfg.elasticity)));
  return { xg90: xgAtRef * mult, xa90: xaAtRef * mult };
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
    pricePrior?: PricePriorConfig; // X7 — continuous attacking prior from price
    shrinkageK?: number; // ⚙ effective matches
    shrinkageKAttacking?: number; // ⚙ xG/xA stabilise slower — separate k
    decayXi?: number; // ⚙ per day
    minutesEwmaHalflife?: number; // ⚙ club matches
    defconThreshold?: number;
    defconMetric?: 'cbit' | 'cbirt';
  } = {},
): PlayerFeatures {
  const bandPriors = priorFor(opts.priors ?? DEFAULT_PRIORS, position, opts.price ?? 55);
  const priceRates = opts.pricePrior ? pricePriorRates(opts.pricePrior, position, opts.price ?? 55) : null;
  const priors: PositionPriors = priceRates ? { ...bandPriors, xg90: priceRates.xg90, xa90: priceRates.xa90 } : bandPriors;
  const k = opts.shrinkageK ?? 6;
  const kAtt = opts.shrinkageKAttacking ?? k;
  const xi = opts.decayXi ?? 0.01;
  const past = rows
    .filter((r) => r.kickoff.getTime() < asOf.getTime())
    .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());

  if (past.length === 0) {
    return {
      matchesUsed: 0,
      minutesTotal: 0,
      xg90: priors.xg90,
      npxg90: priors.xg90,
      xa90: priors.xa90,
      saves90: priors.saves90,
      cbit90: priors.cbit90,
      cbirt90: priors.cbirt90,
      yc90: priors.yc90,
      rc90: priors.rc90,
      formEwma: 0,
      minutesEwma: 0,
      startedMinutesAvg: 0,
      startShare5: 0,
      startShareLong: 0,
      startedLast: false,
      defconHitRate: priors.defconHitRate,
      rawXg90: 0,
      rawXa90: 0,
      daysSinceLastMatch: null,
      venueAttMultHome: 1,
      venueAttMultAway: 1,
      saveRate: 0.7,
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
  let wNpxg = 0;
  let sawNpxg = false;
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
    if (r.npxg != null) sawNpxg = true;
    wNpxg += w * (r.npxg ?? r.xg ?? 0); // rows without npxg fall back to xg
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

  // minutes when STARTED (decay-weighted): rests and sub cameos must not
  // poison a nailed starter's expected minutes (statengineexpansion.md X1)
  let smNum = 0;
  let smDen = 0;
  for (const r of window) {
    if (!r.starts) continue;
    const days = (anchorTime - r.kickoff.getTime()) / 86_400_000;
    const w = Math.exp(-xi * days);
    smNum += w * r.minutes;
    smDen += w;
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
  // long-run rotation history (X8): a cameo player on a two-match starting
  // streak is NOT a season-long starter — the horizon target needs the base
  // rate, not the streak
  const startShareLong = share(window);

  // DEFCON hit rate over played matches, last ⚙15
  const metric = opts.defconMetric ?? (position === 'DEF' || position === 'GK' ? 'cbit' : 'cbirt');
  const threshold = opts.defconThreshold ?? (metric === 'cbit' ? 10 : 12);
  const playedRecent = past.filter((r) => r.minutes >= 45).slice(-15);
  const defconHitsRaw =
    playedRecent.length > 0
      ? playedRecent.filter((r) => (metric === 'cbit' ? r.cbit : r.cbirt) >= threshold).length / playedRecent.length
      : priors.defconHitRate;

  const lastMatch = past[past.length - 1]!;

  // A6 (v1.4.3): venue splits — attacking output (xGI/90, goals+assists
  // fallback) at each venue relative to overall, shrunk toward neutral by
  // venue minutes so a 3-match "home specialist" stays ~1.0
  const xgi90Of = (rows: MatchRow[]): { rate: number; matches: number } => {
    const min = rows.reduce((s, r) => s + r.minutes, 0);
    const val = rows.reduce((s, r) => s + (r.xg ?? r.goals) + (r.xa ?? r.assists), 0);
    return { rate: min > 0 ? (90 * val) / min : 0, matches: min / 90 };
  };
  const overallXgi = xgi90Of(window);
  const K_VENUE = 8; // effective matches toward neutral
  const venueMult = (wantHome: boolean): number => {
    if (overallXgi.rate <= 0.02) return 1; // keepers / no output — neutral
    const rows = window.filter((r) => r.wasHome === wantHome);
    const v = xgi90Of(rows);
    if (v.matches < 1) return 1;
    const raw = v.rate / overallXgi.rate;
    const shrunk = (v.matches * raw + K_VENUE * 1) / (v.matches + K_VENUE);
    return Math.min(1.15, Math.max(0.85, shrunk));
  };

  // A7 (v1.4.5): save rate saves/(saves+conceded), shrunk toward 0.70 by
  // shots faced (a 5-shot sample says nothing; 100 shots is a real skill)
  const totSaves = window.reduce((s, r) => s + r.saves, 0);
  const totConceded = window.reduce((s, r) => s + (r.conceded ?? 0), 0);
  const shotsFaced = totSaves + totConceded;
  const K_SAVE_SHOTS = 40;
  const rawSaveRate = shotsFaced > 0 ? totSaves / shotsFaced : 0.7;
  const saveRate = Math.min(0.85, Math.max(0.55, (shotsFaced * rawSaveRate + K_SAVE_SHOTS * 0.7) / (shotsFaced + K_SAVE_SHOTS)));

  return {
    saveRate,
    venueAttMultHome: venueMult(true),
    venueAttMultAway: venueMult(false),
    matchesUsed: window.length,
    minutesTotal: past.reduce((s, r) => s + r.minutes, 0),
    xg90: shrink(rawXg90, effMatches, priors.xg90, kAtt),
    // shrunk toward the same prior — the prior's small pen share only matters
    // for thin samples, and thin samples are rarely designated takers
    npxg90: sawNpxg ? shrink(rate90(wNpxg), effMatches, priors.xg90, kAtt) : shrink(rawXg90, effMatches, priors.xg90, kAtt),
    xa90: shrink(rawXa90, effMatches, priors.xa90, kAtt),
    saves90: shrink(rate90(wSaves), effMatches, priors.saves90, k),
    cbit90: shrink(rate90(wCbit), effMatches, priors.cbit90, k),
    cbirt90: shrink(rate90(wCbirt), effMatches, priors.cbirt90, k),
    yc90: shrink(rate90(wYc), effMatches, priors.yc90, k),
    rc90: shrink(rate90(wRc), effMatches, priors.rc90, k),
    formEwma: formDen > 0 ? formNum / formDen : 0,
    minutesEwma: mDen > 0 ? mNum / mDen : 0,
    startedMinutesAvg: smDen > 0 ? smNum / smDen : 0,
    startShare5,
    startShareLong,
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
