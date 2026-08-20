/**
 * L2 — Odds blend (fpl-engines-plan.md §4.3, §2.3).
 * De-margin 1X2 via Shin's method (multiplicative normalisation fallback),
 * solve for market-implied (λ_h*, λ_a*) on a Poisson grid, blend with DC.
 */
import { predictFromLambdas } from './l1-team-strength.js';

export interface Odds1x2 {
  home: number; // decimal odds
  draw: number;
  away: number;
  over25?: number;
  under25?: number;
  takenAt: Date;
}

/** Shin's method for removing overround (accounts for favourite–longshot bias). */
export function deMargin1x2(odds: Odds1x2): { pHome: number; pDraw: number; pAway: number; method: 'shin' | 'multiplicative' } {
  const raw = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const booksum = raw.reduce((a, b) => a + b, 0);
  if (booksum <= 1.0001) {
    const s = raw.map((p) => p / booksum);
    return { pHome: s[0]!, pDraw: s[1]!, pAway: s[2]!, method: 'multiplicative' };
  }
  // Shin: solve for z (insider-trading proportion) by bisection
  const shinP = (z: number): number[] =>
    raw.map((pi) => (Math.sqrt(z * z + 4 * (1 - z) * ((pi * pi) / booksum)) - z) / (2 * (1 - z)));
  let lo = 0;
  let hi = 0.2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const sum = shinP(mid).reduce((a, b) => a + b, 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const p = shinP((lo + hi) / 2);
  const norm = p.reduce((a, b) => a + b, 0);
  return { pHome: p[0]! / norm, pDraw: p[1]! / norm, pAway: p[2]! / norm, method: 'shin' };
}

/**
 * Find (λ_h, λ_a) minimising squared error to the de-margined market
 * {P(H), P(D), P(A), P(>2.5)?} on the DC grid. Coarse-to-fine grid search —
 * robust, no derivatives, ~milliseconds.
 */
export function solveMarketLambdas(
  target: { pHome: number; pDraw: number; pAway: number; pOver25?: number },
  rho: number,
): { lambdaHome: number; lambdaAway: number } {
  let best = { lambdaHome: 1.3, lambdaAway: 1.1 };
  let bestErr = Infinity;
  const evalErr = (lh: number, la: number): number => {
    const pred = predictFromLambdas(lh, la, rho);
    let err =
      (pred.pHome - target.pHome) ** 2 + (pred.pDraw - target.pDraw) ** 2 + (pred.pAway - target.pAway) ** 2;
    if (target.pOver25 != null) {
      let pOver = 0;
      for (let h = 0; h < pred.concessionAway.length; h++) {
        for (let a = 0; a < pred.concessionHome.length; a++) {
          if (h + a > 2.5) pOver += 0; // computed below from grid probabilities
        }
      }
      // approximate with total-goals Poisson: P(N>2.5), N ~ Poisson(lh+la)
      const lam = lh + la;
      const p0 = Math.exp(-lam);
      const p1 = p0 * lam;
      const p2 = (p1 * lam) / 2;
      pOver = 1 - (p0 + p1 + p2);
      err += 0.5 * (pOver - target.pOver25) ** 2;
    }
    return err;
  };
  for (const [step, span] of [
    [0.2, 2.0],
    [0.05, 0.4],
    [0.01, 0.1],
  ] as const) {
    const center = { ...best };
    for (let lh = Math.max(0.2, center.lambdaHome - span); lh <= center.lambdaHome + span; lh += step) {
      for (let la = Math.max(0.2, center.lambdaAway - span); la <= center.lambdaAway + span; la += step) {
        const err = evalErr(lh, la);
        if (err < bestErr) {
          bestErr = err;
          best = { lambdaHome: lh, lambdaAway: la };
        }
      }
    }
  }
  return best;
}

/** Blend market λ with DC λ; weight decays with odds staleness. */
export function blendLambdas(
  dc: { lambdaHome: number; lambdaAway: number },
  market: { lambdaHome: number; lambdaAway: number } | null,
  oddsAgeHours: number | null,
  wMktFresh: number,
  freshHours: number,
): { lambdaHome: number; lambdaAway: number; wMkt: number } {
  if (!market || oddsAgeHours == null || oddsAgeHours > freshHours * 2) {
    return { ...dc, wMkt: 0 };
  }
  const w = oddsAgeHours <= freshHours ? wMktFresh : wMktFresh * (1 - (oddsAgeHours - freshHours) / freshHours);
  const wMkt = Math.max(0, Math.min(1, w));
  return {
    lambdaHome: wMkt * market.lambdaHome + (1 - wMkt) * dc.lambdaHome,
    lambdaAway: wMkt * market.lambdaAway + (1 - wMkt) * dc.lambdaAway,
    wMkt,
  };
}
