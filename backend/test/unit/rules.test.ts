import { describe, it, expect } from 'vitest';
import {
  validateSquad,
  pickStartingXi,
  chipSetForEvent,
  rollFreeTransfers,
  transferHitCost,
  type SquadPlayer,
  type SquadRules,
  type ChipSetRules,
} from '../../src/fpl/rules.js';
import { DEFAULT_CONFIG } from '../../src/core/model-config.js';

const rules = DEFAULT_CONFIG.squad_rules as SquadRules;
const chipRules = DEFAULT_CONFIG.chip_rules as ChipSetRules;

function makeSquad(overrides: Partial<SquadPlayer>[] = []): SquadPlayer[] {
  const spec: [string, number][] = [
    ['GK', 2],
    ['DEF', 5],
    ['MID', 5],
    ['FWD', 3],
  ];
  const squad: SquadPlayer[] = [];
  let i = 0;
  for (const [pos, n] of spec) {
    for (let k = 0; k < n; k++) {
      squad.push({ uid: `p${i}`, position: pos, club: `club${i % 8}`, price: 60, xpts: 4 + (i % 5), ...overrides[i] });
      i++;
    }
  }
  return squad;
}

describe('squad validation (property-style over generated squads)', () => {
  it('accepts a legal squad', () => {
    expect(validateSquad(makeSquad(), rules).valid).toBe(true);
  });

  it('rejects wrong size', () => {
    const v = validateSquad(makeSquad().slice(0, 14), rules);
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toMatch(/15/);
  });

  it('rejects wrong position counts', () => {
    const squad = makeSquad();
    squad[0]!.position = 'DEF'; // 1 GK / 6 DEF
    const v = validateSquad(squad, rules);
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toMatch(/GK/);
  });

  it('rejects >3 per club', () => {
    const squad = makeSquad();
    for (let i = 0; i < 4; i++) squad[i + 2]!.club = 'liverpool';
    const v = validateSquad(squad, rules);
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toMatch(/liverpool/);
  });

  it('rejects over budget', () => {
    const squad = makeSquad().map((p) => ({ ...p, price: 100 })); // 1500 > 1000
    const v = validateSquad(squad, rules);
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toMatch(/budget/);
  });

  it('rejects duplicate players', () => {
    const squad = makeSquad();
    squad[1]!.uid = squad[0]!.uid;
    expect(validateSquad(squad, rules).valid).toBe(false);
  });

  it('randomised: every generated violation is caught', () => {
    for (let seed = 0; seed < 200; seed++) {
      const squad = makeSquad();
      const kind = seed % 4;
      if (kind === 0) squad.pop();
      if (kind === 1) squad[3]!.position = 'MID';
      if (kind === 2) for (let i = 0; i < 4; i++) squad[2 + i]!.club = 'x';
      if (kind === 3) squad.forEach((p) => (p.price = 90));
      expect(validateSquad(squad, rules).valid).toBe(false);
    }
  });
});

describe('starting XI picker', () => {
  it('picks a valid formation with 11 starters and 4 bench', () => {
    const xi = pickStartingXi(makeSquad(), rules);
    expect(xi.starters).toHaveLength(11);
    expect(xi.bench).toHaveLength(4);
    expect(xi.formation[0]).toBe(1);
    expect(xi.bench[0]!.position).toBe('GK'); // bench GK first
    expect(xi.captain).toBeTruthy();
    expect(xi.vice).toBeTruthy();
    expect(xi.captain).not.toBe(xi.vice);
  });

  it('maximises xpts across formations', () => {
    const squad = makeSquad();
    // make forwards worthless — expect a 3-FWD formation NOT to be chosen
    for (const p of squad) if (p.position === 'FWD') p.xpts = 0.1;
    const xi = pickStartingXi(squad, rules);
    expect(xi.formation[3]).toBeLessThanOrEqual(2);
  });
});

describe('2026/27 chip set expiry', () => {
  it('set 1 usable only up to GW19', () => {
    expect(chipSetForEvent(chipRules, 'wildcard', 10, [])).toBe(1);
    expect(chipSetForEvent(chipRules, 'wildcard', 19, [])).toBe(1);
    expect(chipSetForEvent(chipRules, 'wildcard', 20, [])).toBe(2);
  });

  it('no carry-over: used set-1 chip cannot be replayed in set 1', () => {
    expect(chipSetForEvent(chipRules, 'freehit', 15, [{ chip: 'freehit', set: 1 }])).toBeNull();
    expect(chipSetForEvent(chipRules, 'freehit', 25, [{ chip: 'freehit', set: 1 }])).toBe(2);
  });

  it('both sets used → never playable', () => {
    const used = [
      { chip: 'bboost', set: 1 },
      { chip: 'bboost', set: 2 },
    ];
    for (let gw = 1; gw <= 38; gw++) {
      expect(chipSetForEvent(chipRules, 'bboost', gw, used)).toBeNull();
    }
  });

  it('property: set expiry never violated across all GWs and chips', () => {
    for (const chip of ['wildcard', 'freehit', 'bboost', '3xc']) {
      for (let gw = 1; gw <= 38; gw++) {
        const set = chipSetForEvent(chipRules, chip, gw, []);
        if (gw <= 19) expect(set).toBe(1);
        else expect(set).toBe(2);
      }
    }
  });
});

describe('transfers', () => {
  it('banks to max 5', () => {
    expect(rollFreeTransfers(1, chipRules)).toBe(2);
    expect(rollFreeTransfers(5, chipRules)).toBe(5);
  });

  it('hits cost 4 each beyond free', () => {
    expect(transferHitCost(1, 1, chipRules)).toBe(0);
    expect(transferHitCost(3, 1, chipRules)).toBe(8);
    expect(transferHitCost(2, 5, chipRules)).toBe(0);
  });
});
