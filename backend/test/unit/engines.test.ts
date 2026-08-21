import { describe, it, expect } from 'vitest';
import { fitTeamStrength, predictFromLambdas, fixtureLambdas, type StrengthMatch } from '../../src/stats/l1-team-strength.js';
import { deMargin1x2, solveMarketLambdas, blendLambdas } from '../../src/stats/l2-odds.js';
import { computePlayerFeatures, type MatchRow } from '../../src/stats/l0-features.js';
import { predictMinutes, type MinutesConfig } from '../../src/stats/l3-minutes.js';
import { composeXpts, pointsFromStats, expectedSavePoints, type ScoringRules, type BonusProfiles, type ComposeInput } from '../../src/stats/l9-composer.js';
import { normaliseName, trigramSimilarity } from '../../src/players/resolver.js';
import { optimiseSquad, type OptimiserCandidate } from '../../src/fpl/optimiser.js';
import { DEFAULT_CONFIG } from '../../src/core/model-config.js';
import type { SquadRules } from '../../src/fpl/rules.js';

const rules = DEFAULT_CONFIG.scoring_rules as ScoringRules;
const bonusProfiles = DEFAULT_CONFIG.bonus_profiles as BonusProfiles;
const minutesCfg = DEFAULT_CONFIG.minutes_model as MinutesConfig;

describe('L1 Dixon-Coles', () => {
  function synthMatches(): StrengthMatch[] {
    // strong team beats weak team consistently; 3 teams round-robin ×8
    const teams = { strong: 2.2, mid: 1.3, weak: 0.7 };
    const matches: StrengthMatch[] = [];
    const names = Object.keys(teams) as (keyof typeof teams)[];
    let day = 300;
    for (let round = 0; round < 8; round++) {
      for (const h of names) {
        for (const a of names) {
          if (h === a) continue;
          matches.push({
            homeKey: h,
            awayKey: a,
            homeGoals: Math.round(teams[h] * 1.15 + (round % 3) * 0.3),
            awayGoals: Math.round(teams[a] * 0.85),
            daysAgo: (day -= 3),
          });
        }
      }
    }
    return matches;
  }

  it('recovers relative strengths from synthetic data', () => {
    const params = fitTeamStrength(synthMatches());
    expect(params.attack.strong!).toBeGreaterThan(params.attack.mid!);
    expect(params.attack.mid!).toBeGreaterThan(params.attack.weak!);
    expect(params.homeAdv).toBeGreaterThan(0);
    // identifiability: Σα = Σβ = 0
    const sumA = Object.values(params.attack).reduce((s, x) => s + x, 0);
    expect(Math.abs(sumA)).toBeLessThan(1e-6);
  });

  it('score grid probabilities are a distribution and CS matches concession[0]', () => {
    const pred = predictFromLambdas(1.6, 1.1, -0.08);
    expect(pred.pHome + pred.pDraw + pred.pAway).toBeCloseTo(1, 6);
    const sumConcH = pred.concessionHome.reduce((a, b) => a + b, 0);
    expect(sumConcH).toBeCloseTo(1, 6);
    expect(pred.pCsHome).toBeCloseTo(pred.concessionHome[0]!, 10);
    expect(pred.eConcedePtsHome).toBeLessThanOrEqual(0);
  });

  it('stronger side gets higher win probability, home advantage counts', () => {
    const params = fitTeamStrength(synthMatches());
    const { lambdaHome, lambdaAway } = fixtureLambdas(params, 'strong', 'weak');
    expect(lambdaHome).toBeGreaterThan(lambdaAway);
    const pred = predictFromLambdas(lambdaHome, lambdaAway, params.rho);
    expect(pred.pHome).toBeGreaterThan(0.5);
  });

  it('promoted-team priors hold with zero matches', () => {
    const params = fitTeamStrength(synthMatches(), { priorTeams: { promoted: { attack: -0.25, defence: -0.15 } } });
    expect(params.attack.promoted).toBeDefined();
    const pred = predictFromLambdas(...(Object.values(fixtureLambdas(params, 'strong', 'promoted')) as [number, number]), params.rho);
    expect(pred.pHome).toBeGreaterThan(0.4);
  });
});

describe('L2 odds', () => {
  it('Shin de-margin removes overround and preserves order', () => {
    const dm = deMargin1x2({ home: 1.8, draw: 3.6, away: 4.5, takenAt: new Date() });
    expect(dm.pHome + dm.pDraw + dm.pAway).toBeCloseTo(1, 6);
    expect(dm.pHome).toBeGreaterThan(dm.pDraw);
    expect(dm.pDraw).toBeGreaterThan(dm.pAway);
    expect(dm.method).toBe('shin');
  });

  it('market λ solve reproduces the target probabilities', () => {
    const target = predictFromLambdas(1.7, 1.0, -0.08);
    const solved = solveMarketLambdas({ pHome: target.pHome, pDraw: target.pDraw, pAway: target.pAway }, -0.08);
    expect(solved.lambdaHome).toBeCloseTo(1.7, 0);
    expect(solved.lambdaAway).toBeCloseTo(1.0, 0);
  });

  it('blend weight decays with staleness and zeroes without odds', () => {
    const dc = { lambdaHome: 1.5, lambdaAway: 1.2 };
    const mkt = { lambdaHome: 1.9, lambdaAway: 1.0 };
    expect(blendLambdas(dc, mkt, 2, 0.65, 48).wMkt).toBeCloseTo(0.65, 5);
    expect(blendLambdas(dc, mkt, 72, 0.65, 48).wMkt).toBeLessThan(0.65);
    expect(blendLambdas(dc, null, null, 0.65, 48).wMkt).toBe(0);
  });
});

describe('L0 feature factory', () => {
  const mkRow = (daysAgo: number, over: Partial<MatchRow> = {}): MatchRow => ({
    kickoff: new Date(Date.now() - daysAgo * 86_400_000),
    minutes: 90,
    starts: true,
    goals: 0,
    assists: 0,
    saves: 0,
    cbit: 8,
    cbirt: 12,
    defconCount: 0,
    xg: 0.3,
    xa: 0.2,
    fplPoints: 5,
    yc: 0,
    rc: 0,
    ...over,
  });

  it('leakage rule: rows at/after asOf never enter', () => {
    const asOf = new Date();
    const rows = [mkRow(10), mkRow(-1, { goals: 99, xg: 99 })]; // future row
    const f = computePlayerFeatures(rows, asOf, 'MID');
    expect(f.matchesUsed).toBe(1);
    expect(f.rawXg90).toBeLessThan(1);
  });

  it('shrinkage pulls thin samples toward the prior', () => {
    const oneHot = [mkRow(5, { xg: 1.5, minutes: 90 })]; // 1.5 xg in one match
    const f = computePlayerFeatures(oneHot, new Date(), 'MID');
    expect(f.rawXg90).toBeCloseTo(1.5, 1);
    expect(f.xg90).toBeLessThan(0.5); // shrunk hard toward the MID prior
  });

  it('empty history returns positional priors', () => {
    const f = computePlayerFeatures([], new Date(), 'FWD');
    expect(f.xg90).toBeGreaterThan(0.2);
    expect(f.matchesUsed).toBe(0);
  });
});

describe('L3 minutes model', () => {
  const base = {
    status: 'a',
    chanceNext: null,
    activeInjury: null,
    confirmedLineup: null,
    position: 'MID',
    startShare5: 1,
    minutesEwma: 88,
    startedLast: true,
    daysSinceLastMatch: 5,
    congested: false,
    newSigning: false,
    returnedFromInjury: false,
    fixturesAhead: 1,
  } as const;

  it('nailed starter gets high p_start', () => {
    const p = predictMinutes({ ...base }, minutesCfg);
    expect(p.pStart).toBeGreaterThan(0.85);
    expect(p.pAny).toBeGreaterThanOrEqual(p.pStart);
    expect(p.p60).toBeLessThanOrEqual(p.pStart);
  });

  it('status i/s/u/n → zero everywhere', () => {
    for (const status of ['i', 's', 'u', 'n']) {
      const p = predictMinutes({ ...base, status }, minutesCfg);
      expect(p.pStart).toBe(0);
      expect(p.eMin).toBe(0);
    }
  });

  it('chance flags scale multiplicatively', () => {
    const p75 = predictMinutes({ ...base, chanceNext: 75 }, minutesCfg);
    const p25 = predictMinutes({ ...base, chanceNext: 25 }, minutesCfg);
    expect(p75.pStart).toBeGreaterThan(p25.pStart);
    expect(p25.pStart).toBeLessThan(0.3);
  });

  it('confirmed lineup overrides for the next fixture only', () => {
    const inXi = predictMinutes({ ...base, startShare5: 0, minutesEwma: 0, confirmedLineup: 'xi' }, minutesCfg);
    expect(inXi.pStart).toBe(0.99);
    const later = predictMinutes({ ...base, startShare5: 0, minutesEwma: 0, confirmedLineup: 'xi', fixturesAhead: 2 }, minutesCfg);
    expect(later.pStart).toBeLessThan(0.99);
    const benched = predictMinutes({ ...base, confirmedLineup: 'bench' }, minutesCfg);
    expect(benched.pStart).toBe(0.02);
    expect(benched.pAny).toBeGreaterThan(0.3);
  });

  it('probabilities always in [0,1]', () => {
    for (let i = 0; i < 100; i++) {
      const p = predictMinutes(
        {
          ...base,
          startShare5: (i % 6) / 5,
          minutesEwma: (i * 7) % 95,
          congested: i % 2 === 0,
          newSigning: i % 3 === 0,
          fixturesAhead: (i % 6) + 1,
          chanceNext: [null, 25, 50, 75, 100][i % 5]!,
        },
        minutesCfg,
      );
      for (const v of [p.pStart, p.p60, p.pAny]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('L9 composer', () => {
  it('Jensen: expected save points computed on the distribution, not the mean', () => {
    // E[saves]=2.9 → ⌊2.9/3⌋=0 naively, but the distribution pays
    expect(expectedSavePoints(2.9, 3)).toBeGreaterThan(0.3);
    expect(expectedSavePoints(0, 3)).toBe(0);
  });

  it('xPts bounded sane and componentised', () => {
    const b = composeXpts(
      {
        position: 'FWD',
        pStart: 0.95,
        p60: 0.8,
        pAny: 0.98,
        eMin: 84,
        xg90: 0.7,
        xa90: 0.15,
        saves90: 0,
        yc90: 0.1,
        rc90: 0.003,
        defconHitRate: 0.01,
        fixtureMultAtt: 1.2,
        pCsTeam: 0.3,
        eConcedePts: -0.5,
        lambdaOpponent: 1.1,
      },
      rules,
      bonusProfiles,
    );
    expect(b.total).toBeGreaterThan(2);
    expect(b.total).toBeLessThan(25);
    const sum =
      b.appearance + b.goals + b.assists + b.cleanSheet + b.defcon + b.saves + b.bonus + b.concededPenalty + b.cards + b.ownGoalAndPenMiss;
    expect(b.total).toBeCloseTo(Math.max(0, sum), 6);
  });

  it('GK gets save points, FWD does not; DEF gets CS 4, MID 1', () => {
    const mk = (position: string) =>
      composeXpts(
        {
          position,
          pStart: 0.95,
          p60: 0.9,
          pAny: 0.97,
          eMin: 88,
          xg90: 0.05,
          xa90: 0.05,
          saves90: 3,
          yc90: 0.1,
          rc90: 0.003,
          defconHitRate: 0.2,
          fixtureMultAtt: 1,
          pCsTeam: 0.4,
          eConcedePts: -0.4,
          lambdaOpponent: 1.3,
        },
        rules,
        bonusProfiles,
      );
    expect(mk('GK').saves).toBeGreaterThan(0.5);
    expect(mk('FWD').saves).toBe(0);
    expect(mk('DEF').cleanSheet).toBeCloseTo(mk('MID').cleanSheet * 4, 1);
  });

  it('pointsFromStats reproduces known FPL scorelines', () => {
    // MID: 90 min, 1 goal, 1 assist, CS, 2 bonus = 2+5+3+1+2 = 13
    expect(
      pointsFromStats(
        { position: 'MID', minutes: 90, goals: 1, assists: 1, cs: true, conceded: 0, og: 0, penSaved: 0, penMissed: 0, yc: 0, rc: 0, saves: 0, bonus: 2, cbit: 4, cbirt: 8 },
        rules,
      ),
    ).toBe(13);
    // DEF: 90 min, CS, 10 CBIT (DEFCON hit), 0 bonus = 2+4+2 = 8
    expect(
      pointsFromStats(
        { position: 'DEF', minutes: 90, goals: 0, assists: 0, cs: true, conceded: 0, og: 0, penSaved: 0, penMissed: 0, yc: 0, rc: 0, saves: 0, bonus: 0, cbit: 10, cbirt: 14 },
        rules,
      ),
    ).toBe(8);
    // DEFCON threshold not doubled: 20 CBIT still +2
    expect(
      pointsFromStats(
        { position: 'DEF', minutes: 90, goals: 0, assists: 0, cs: false, conceded: 1, og: 0, penSaved: 0, penMissed: 0, yc: 0, rc: 0, saves: 0, bonus: 0, cbit: 20, cbirt: 25 },
        rules,
      ),
    ).toBe(4); // 2 appearance + 2 defcon − 0 concession (1 goal < 2)
    // GK: 58 min, 7 saves, pen save, conceded 4 = 1 + 2 + 5 − 2 = 6
    expect(
      pointsFromStats(
        { position: 'GK', minutes: 58, goals: 0, assists: 0, cs: false, conceded: 4, og: 0, penSaved: 1, penMissed: 0, yc: 0, rc: 0, saves: 7, bonus: 0, cbit: 0, cbirt: 0 },
        rules,
      ),
    ).toBe(6);
    // 0 minutes = 0 points regardless
    expect(
      pointsFromStats(
        { position: 'FWD', minutes: 0, goals: 0, assists: 0, cs: true, conceded: 0, og: 0, penSaved: 0, penMissed: 0, yc: 0, rc: 0, saves: 0, bonus: 0, cbit: 0, cbirt: 15 },
        rules,
      ),
    ).toBe(0);
  });
});

describe('resolver name traps (§1.5.1)', () => {
  it('diacritics', () => {
    expect(normaliseName('Ødegaard')).toBe(normaliseName('Odegaard'));
    expect(normaliseName('Sávio')).toBe(normaliseName('Savio'));
    expect(normaliseName('Šeško')).toBe(normaliseName('Sesko'));
  });
  it('token order', () => {
    expect(normaliseName('Son Heung-min')).toBe(normaliseName('Heung-Min Son'));
  });
  it('hyphens and apostrophes stripped without splitting identity', () => {
    expect(normaliseName("N'Golo Kanté")).toBe(normaliseName('NGolo Kante'));
    expect(normaliseName('Calvert-Lewin')).toBe(normaliseName('Calvert Lewin'));
    expect(normaliseName("O'Brien")).toBe(normaliseName('OBrien'));
  });
  it('trigram similarity ranks close names high', () => {
    expect(trigramSimilarity(normaliseName('Salah'), normaliseName('M.Salah'))).toBeGreaterThan(0.5);
    expect(trigramSimilarity(normaliseName('Haaland'), normaliseName('Watkins'))).toBeLessThan(0.3);
  });
});

describe('optimiser', () => {
  function market(): OptimiserCandidate[] {
    const out: OptimiserCandidate[] = [];
    let i = 0;
    const add = (pos: string, n: number, priceBase: number): void => {
      for (let k = 0; k < n; k++) {
        out.push({
          uid: `${pos}${k}`,
          position: pos,
          club: `club${i++ % 10}`,
          price: priceBase + (k % 7) * 5,
          xpts: 3 + ((k * 13) % 11) * 0.6,
          pStart: 0.6 + ((k * 7) % 4) * 0.1,
        });
      }
    };
    add('GK', 20, 40);
    add('DEF', 50, 40);
    add('MID', 60, 45);
    add('FWD', 30, 45);
    return out;
  }

  const squadRules = DEFAULT_CONFIG.squad_rules as SquadRules;

  it('produces a valid squad under all constraints', () => {
    const sol = optimiseSquad(market(), squadRules);
    expect(sol.squad).toHaveLength(15);
    expect(sol.totalCost).toBeLessThanOrEqual(1000);
    const posCounts: Record<string, number> = {};
    for (const p of sol.squad) posCounts[p.position] = (posCounts[p.position] ?? 0) + 1;
    expect(posCounts).toEqual({ GK: 2, DEF: 5, MID: 5, FWD: 3 });
    const clubCounts: Record<string, number> = {};
    for (const p of sol.squad) clubCounts[p.club] = (clubCounts[p.club] ?? 0) + 1;
    expect(Math.max(...Object.values(clubCounts))).toBeLessThanOrEqual(3);
  });

  it('respects locks and bans', () => {
    const m = market();
    const sol = optimiseSquad(m, squadRules, { locked: ['FWD0'], banned: ['MID0'] });
    expect(sol.squad.some((p) => p.uid === 'FWD0')).toBe(true);
    expect(sol.squad.some((p) => p.uid === 'MID0')).toBe(false);
  });

  it('respects a tighter budget', () => {
    const sol = optimiseSquad(market(), squadRules, { budget: 800 });
    expect(sol.totalCost).toBeLessThanOrEqual(800);
    expect(sol.squad).toHaveLength(15);
  });

  it('property: 25 random markets never violate constraints', () => {
    for (let seed = 0; seed < 25; seed++) {
      const m = market().map((c, i) => ({ ...c, xpts: ((i * seed * 17) % 90) / 10, price: 38 + ((i * seed * 7) % 100) }));
      const sol = optimiseSquad(m, squadRules);
      expect(sol.squad).toHaveLength(15);
      expect(sol.totalCost).toBeLessThanOrEqual(1000);
      const clubCounts: Record<string, number> = {};
      for (const p of sol.squad) clubCounts[p.club] = (clubCounts[p.club] ?? 0) + 1;
      expect(Math.max(...Object.values(clubCounts))).toBeLessThanOrEqual(3);
    }
  });
});

describe('cold start (fresh install, no match history)', () => {
  const minutesCfg = DEFAULT_CONFIG.minutes_model as unknown as MinutesConfig;

  it('L1 fit with zero matches returns finite prior-based params, never NaN', () => {
    const params = fitTeamStrength([], { priorTeams: { A: { attack: -0.25, defence: -0.15 }, B: { attack: 0, defence: 0 } } });
    expect(Number.isFinite(params.mu)).toBe(true);
    expect(Number.isFinite(params.homeAdv)).toBe(true);
    for (const t of params.teams) {
      expect(Number.isFinite(params.attack[t]!)).toBe(true);
      expect(Number.isFinite(params.defence[t]!)).toBe(true);
    }
    const { lambdaHome, lambdaAway } = fixtureLambdas(params, 'A', 'B');
    expect(Number.isFinite(lambdaHome)).toBe(true);
    expect(Number.isFinite(lambdaAway)).toBe(true);
    const pred = predictFromLambdas(lambdaHome, lambdaAway, params.rho);
    expect(Number.isFinite(pred.pCsHome)).toBe(true);
    expect(pred.pCsHome).toBeGreaterThan(0);
    expect(pred.pCsHome).toBeLessThan(1);
  });

  it('heavily-owned player without history gets an ownership-based start prior, not 6%', () => {
    const base = {
      status: 'a', chanceNext: null, activeInjury: null, confirmedLineup: null,
      position: 'FWD', startShare5: 0, minutesEwma: 0, startedLast: false,
      daysSinceLastMatch: null, congested: false, newSigning: false,
      returnedFromInjury: false, fixturesAhead: 1,
    };
    const haaland = predictMinutes({ ...base, selectedByPct: 69.4 }, minutesCfg);
    expect(haaland.pStart).toBeGreaterThan(0.8);
    const benchGk = predictMinutes({ ...base, position: 'GK', selectedByPct: 0.3 }, minutesCfg);
    expect(benchGk.pStart).toBeLessThan(0.35);
    // ordering: more owned ⇒ likelier to start
    const mid = predictMinutes({ ...base, selectedByPct: 15 }, minutesCfg);
    expect(haaland.pStart).toBeGreaterThan(mid.pStart);
    expect(mid.pStart).toBeGreaterThan(benchGk.pStart);
  });

  it('players WITH history are unaffected by the cold-start prior', () => {
    const nailedOn = predictMinutes(
      {
        status: 'a', chanceNext: null, activeInjury: null, confirmedLineup: null,
        position: 'DEF', selectedByPct: 2, startShare5: 0.95, minutesEwma: 88,
        startedLast: true, daysSinceLastMatch: 4, congested: false,
        newSigning: false, returnedFromInjury: false, fixturesAhead: 1,
      },
      minutesCfg,
    );
    expect(nailedOn.pStart).toBeGreaterThan(0.9); // start-share table wins, ownership irrelevant
  });
});

describe('captaincy P90 ceiling (seeded simulation)', () => {
  it('a striker haul ceiling beats a defender floor even at a lower mean', async () => {
    const { mulberry32, simulateP90 } = await import('../../src/match/engine.js');
    const scoring = { goal: { GK: 6, DEF: 6, MID: 5, FWD: 4 }, clean_sheet: { GK: 4, DEF: 4, MID: 1, FWD: 0 }, assist: 3 };
    // shapes taken from the live run: Gabriel-like DEF (CS-heavy, mean ~5.5)
    // vs Haaland-like FWD (goal-heavy, mean ~4.6)
    const defRow = { p60: 0.79, p_any: 0.9, e_goals: 0.117, e_assists: 0.058, p_cs: 0.602, p_defcon: 0.383, e_saves: 0, e_bonus: 0.45 };
    const fwdRow = { p60: 0.69, p_any: 0.92, e_goals: 0.564, e_assists: 0.082, p_cs: 0.33, p_defcon: 0.001, e_saves: 0, e_bonus: 0.56 };
    const defP90 = simulateP90([defRow], 'DEF', scoring, mulberry32(42));
    const fwdP90 = simulateP90([fwdRow], 'FWD', scoring, mulberry32(42));
    expect(fwdP90).toBeGreaterThan(defP90);
    // deterministic: same seed, same result
    expect(simulateP90([fwdRow], 'FWD', scoring, mulberry32(42))).toBe(fwdP90);
  });

  it('empty fixture list yields zero ceiling (blank gameweek)', async () => {
    const { mulberry32, simulateP90 } = await import('../../src/match/engine.js');
    const scoring = { goal: { FWD: 4 }, clean_sheet: { FWD: 0 }, assist: 3 };
    expect(simulateP90([], 'FWD', scoring, mulberry32(1))).toBe(0);
  });
});

describe('statengineexpansion X1 — minutes realism', () => {
  const realism = DEFAULT_CONFIG.minutes_realism as NonNullable<MinutesConfig['realism']>;
  const cfgR: MinutesConfig = { ...minutesCfg, realism };
  const nailed = {
    status: 'a', chanceNext: null, activeInjury: null, confirmedLineup: null,
    position: 'FWD', startShare5: 1, minutesEwma: 66, startedMinutesAvg: 88.5,
    startedLast: true, daysSinceLastMatch: 5, congested: false, newSigning: false,
    returnedFromInjury: false, fixturesAhead: 1,
  } as const;

  it('a 90-minute striker projects near-full minutes, not table-capped 78', () => {
    // minutesEwma poisoned by rests (66) but started matches average 88.5:
    // E[min|start] must follow the started-minutes signal
    const withRealism = predictMinutes({ ...nailed }, cfgR);
    const legacy = predictMinutes({ ...nailed }, minutesCfg);
    expect(withRealism.eMin).toBeGreaterThan(legacy.eMin);
    expect(withRealism.eMin).toBeGreaterThan(80);
    expect(withRealism.eMin).toBeLessThanOrEqual(realism.e_min_start_cap.FWD!);
  });

  it('every-week starters get the lifted 0.95 base', () => {
    const p = predictMinutes({ ...nailed }, cfgR);
    expect(p.pStart).toBeGreaterThanOrEqual(0.95);
  });

  it('shrinkage: thin history stays near the position table', () => {
    // one start in the window at 90 min — the table prior must dominate.
    // p_sub zeroed so eMin/pStart isolates E[min|start].
    const noSub: MinutesConfig = { ...cfgR, p_sub: { GK: 0, DEF: 0, MID: 0, FWD: 0 } };
    const thin = predictMinutes({ ...nailed, startShare5: 0.1, minutesEwma: 20, startedMinutesAvg: 90 }, noSub);
    const tableEmin = (minutesCfg.e_min_start as Record<string, number>).FWD!;
    const blended = (1 * 90 + realism.started_min_shrink_k * tableEmin) / (1 + realism.started_min_shrink_k);
    expect(thin.eMin / Math.max(0.01, thin.pStart)).toBeCloseTo(blended, 1);
  });

  it('no startedMinutesAvg → E[min|start] falls back to the legacy scaling', () => {
    // isolate E[min|start] (p_sub zeroed): with no started-minutes signal the
    // realism config must not change the per-start expectation itself
    const noSub = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const a = predictMinutes({ ...nailed, startedMinutesAvg: 0 }, { ...cfgR, p_sub: noSub });
    const b = predictMinutes({ ...nailed, startedMinutesAvg: 0 }, { ...minutesCfg, p_sub: noSub });
    expect(a.eMin / a.pStart).toBeCloseTo(b.eMin / b.pStart, 6);
  });
});

describe('statengineexpansion X2/X3 — set-piece EV and returns-driven bonus', () => {
  const spCfg = DEFAULT_CONFIG.set_piece_ev as NonNullable<ComposeInput['spCfg']>;
  const bonusCfg = DEFAULT_CONFIG.bonus_model as NonNullable<ComposeInput['bonusCfg']>;
  const premium: ComposeInput = {
    position: 'FWD', pStart: 0.95, p60: 0.78, pAny: 0.97, eMin: 85,
    xg90: 0.72, xa90: 0.15, saves90: 0, yc90: 0.1, rc90: 0.003,
    defconHitRate: 0.01, fixtureMultAtt: 1.15, pCsTeam: 0.35,
    eConcedePts: -0.5, lambdaOpponent: 1.1,
  };

  it('penalty EV is self-consistent: no double-count for incumbent takers', () => {
    // v1.4.0: the deduction (0.181) equals what the explicit pen term re-adds
    // for an every-week taker — the SAME player's history already contains
    // those pens, so being flagged taker must be ~neutral, never a windfall
    const taker = composeXpts({ ...premium, pensOrder: 1, spCfg, bonusCfg }, rules, bonusProfiles);
    const nonTaker = composeXpts({ ...premium, pensOrder: null, spCfg, bonusCfg }, rules, bonusProfiles);
    expect(taker.eGoals).toBeGreaterThanOrEqual(nonTaker.eGoals);
    expect(Math.abs(taker.eGoals - nonTaker.eGoals)).toBeLessThan(0.05);
  });

  it('with non-penalty xG data the composer uses it exactly (no estimate)', () => {
    // npxg90 known: pens removed at the source, explicit EV re-added — a
    // NEW taker whose history holds no pens gains the full pen EV
    const newTaker = composeXpts({ ...premium, npxg90: 0.72, pensOrder: 1, spCfg, bonusCfg }, rules, bonusProfiles);
    const nonTaker = composeXpts({ ...premium, pensOrder: null, spCfg, bonusCfg }, rules, bonusProfiles);
    // pen EV ≈ 0.28·1.15·0.85·0.76 ≈ 0.208 goals/match at full exposure
    expect(newTaker.eGoals - nonTaker.eGoals).toBeGreaterThan(0.15);
    expect(newTaker.eGoals - nonTaker.eGoals).toBeLessThan(0.25);
  });

  it('corner/DFK first taker gains assist EV', () => {
    const taker = composeXpts({ ...premium, cornerDfkOrder: 1, spCfg }, rules, bonusProfiles);
    const nonTaker = composeXpts({ ...premium, spCfg }, rules, bonusProfiles);
    expect(taker.eAssists).toBeGreaterThan(nonTaker.eAssists);
  });

  it('returns-driven bonus separates a premium from a budget forward', () => {
    const budget: ComposeInput = { ...premium, xg90: 0.28, xa90: 0.06, fixtureMultAtt: 0.95 };
    const prem = composeXpts({ ...premium, pensOrder: 1, spCfg, bonusCfg }, rules, bonusProfiles);
    const bud = composeXpts({ ...budget, bonusCfg }, rules, bonusProfiles);
    expect(prem.bonus).toBeGreaterThan(bud.bonus * 1.8);
    expect(prem.bonus).toBeLessThanOrEqual(bonusCfg.fwd_mid.cap);
    // the whole point of the expansion: a real premium clears daylight
    expect(prem.total).toBeGreaterThan(bud.total * 1.5);
  });

  it('bonus stays capped and non-negative across extremes', () => {
    for (const xg of [0, 0.3, 0.9, 2]) {
      const b = composeXpts({ ...premium, xg90: xg, pensOrder: 1, spCfg, bonusCfg }, rules, bonusProfiles);
      expect(b.bonus).toBeGreaterThanOrEqual(0);
      expect(b.bonus).toBeLessThanOrEqual(bonusCfg.fwd_mid.cap);
    }
  });

  it('assist conversion multiplies the assist stream only', () => {
    const withConv = composeXpts({ ...premium, assistConv: 1.1 }, rules, bonusProfiles);
    const without = composeXpts({ ...premium }, rules, bonusProfiles);
    expect(withConv.eAssists).toBeCloseTo(without.eAssists * 1.1, 6);
    expect(withConv.eGoals).toBeCloseTo(without.eGoals, 6);
  });
});

describe('statengineexpansion X7 — price-continuous attacking prior', () => {
  const cfg = DEFAULT_CONFIG.price_prior as import('../../src/stats/l0-features.js').PricePriorConfig;

  it('a £6.0 and a £15.5 forward shrink toward different targets', async () => {
    const { pricePriorRates } = await import('../../src/stats/l0-features.js');
    const budget = pricePriorRates(cfg, 'FWD', 60)!;
    const premium = pricePriorRates(cfg, 'FWD', 155)!;
    expect(budget.xg90).toBeLessThan(0.36);
    expect(premium.xg90).toBeGreaterThan(0.7);
    expect(premium.xg90 / budget.xg90).toBeGreaterThan(2);
  });

  it('multiplier is clamped to mult_range', async () => {
    const { pricePriorRates } = await import('../../src/stats/l0-features.js');
    const absurd = pricePriorRates(cfg, 'MID', 400)!;
    expect(absurd.xg90).toBeLessThanOrEqual(cfg.xg90_at_ref.MID! * cfg.mult_range[1] + 1e-9);
    const dirt = pricePriorRates(cfg, 'MID', 10)!;
    expect(dirt.xg90).toBeGreaterThanOrEqual(cfg.xg90_at_ref.MID! * cfg.mult_range[0] - 1e-9);
  });

  it('shrunk xg90 separates a cameo forward from a premium with same raw rate', () => {
    // both show raw 0.48 xg90, but one has 805 min, the other 2950
    const mk = (minutes: number, price: number) => {
      const rows: MatchRow[] = [];
      for (let i = 0; i < 38; i++) {
        rows.push({
          kickoff: new Date(Date.UTC(2026, 0, 1 + i * 7)),
          minutes: minutes / 38,
          starts: minutes > 2000,
          goals: 0, assists: 0, saves: 0, cbit: 0, cbirt: 0, defconCount: 0,
          xg: (0.48 * (minutes / 38)) / 90, xa: 0, fplPoints: 2, yc: 0, rc: 0,
        });
      }
      return computePlayerFeatures(rows, new Date(Date.UTC(2026, 7, 1)), 'FWD', {
        price,
        pricePrior: cfg,
        decayXi: 0.005,
      });
    };
    const cameo = mk(805, 60);
    const nailed = mk(2950, 155);
    expect(cameo.xg90).toBeLessThan(0.45);   // pulled down toward the £6.0 prior
    expect(nailed.xg90).toBeGreaterThan(0.5); // large sample holds near raw
  });
});

describe('statengineexpansion X8 — horizon target from long-run start share', () => {
  const realism = { ...(DEFAULT_CONFIG.minutes_realism as NonNullable<MinutesConfig['realism']>) };
  const cfgR: MinutesConfig = { ...minutesCfg, realism };
  const base = {
    status: 'a', chanceNext: null, activeInjury: null, confirmedLineup: null,
    position: 'FWD', minutesEwma: 80, startedMinutesAvg: 88,
    startedLast: true, daysSinceLastMatch: 5, congested: false, newSigning: false,
    returnedFromInjury: false,
  } as const;

  it('a career starter keeps high pStart six fixtures out; a cameo player regresses down', () => {
    const nailed6 = predictMinutes({ ...base, startShare5: 1, startShareLong: 0.9, fixturesAhead: 6 }, cfgR);
    const cameo6 = predictMinutes({ ...base, startShare5: 1, startShareLong: 0.21, fixturesAhead: 6 }, cfgR);
    expect(nailed6.pStart).toBeGreaterThan(0.85);
    expect(cameo6.pStart).toBeLessThan(nailed6.pStart - 0.1);
    // without the realism config both collapse toward the positional base
    const legacy6 = predictMinutes({ ...base, startShare5: 1, startShareLong: 0.9, fixturesAhead: 6 }, minutesCfg);
    expect(legacy6.pStart).toBeLessThan(nailed6.pStart);
  });

  it('horizon target never exceeds 0.95 and respects doubt flags', () => {
    const doubtful = predictMinutes({ ...base, chanceNext: 75, startShare5: 1, startShareLong: 1, fixturesAhead: 6 }, cfgR);
    const fit = predictMinutes({ ...base, startShare5: 1, startShareLong: 1, fixturesAhead: 6 }, cfgR);
    expect(fit.pStart).toBeLessThanOrEqual(0.95);
    expect(doubtful.pStart).toBeLessThan(fit.pStart);
  });
});
