/**
 * v1.4.4 — B3 live engine (bonus projection, auto-subs, poller), A3/C3
 * availability reconciliation + return-date extraction, A2 price model +
 * self-calibration.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { seedProviders } from '../../src/ingest/registry.js';
import { projectBonus, previewAutoSubs, pollLiveOnce } from '../../src/match/live.js';
import { extractReturnDate, writeAvailabilityState } from '../../src/stats/availability.js';
import { predictOne, thresholdFor, predictPriceMoves, calibratePriceModel, DEFAULT_PRICE_MODEL } from '../../src/stats/prices.js';
import { getConfig } from '../../src/core/model-config.js';

let db: Knex;

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedProviders(db);
});

describe('B3 — BPS bonus projection with FPL tie sharing', () => {
  it('distinct BPS → 3/2/1', () => {
    const b = projectBonus([
      { uid: 'a', bps: 40 },
      { uid: 'b', bps: 30 },
      { uid: 'c', bps: 20 },
      { uid: 'd', bps: 10 },
    ]);
    expect([b.get('a'), b.get('b'), b.get('c'), b.get('d')]).toEqual([3, 2, 1, undefined]);
  });
  it('two tied at the top → both 3, next gets 1', () => {
    const b = projectBonus([
      { uid: 'a', bps: 40 },
      { uid: 'b', bps: 40 },
      { uid: 'c', bps: 20 },
    ]);
    expect([b.get('a'), b.get('b'), b.get('c')]).toEqual([3, 3, 1]);
  });
  it('three tied at the top → all 3, nobody else scores', () => {
    const b = projectBonus([
      { uid: 'a', bps: 40 },
      { uid: 'b', bps: 40 },
      { uid: 'c', bps: 40 },
      { uid: 'd', bps: 39 },
    ]);
    expect([b.get('a'), b.get('b'), b.get('c'), b.get('d')]).toEqual([3, 3, 3, undefined]);
  });
  it('tie at second → both 2, nobody gets 1', () => {
    const b = projectBonus([
      { uid: 'a', bps: 40 },
      { uid: 'b', bps: 30 },
      { uid: 'c', bps: 30 },
      { uid: 'd', bps: 20 },
    ]);
    expect([b.get('a'), b.get('b'), b.get('c'), b.get('d')]).toEqual([3, 2, 2, undefined]);
  });
});

describe('B3 — auto-sub preview', () => {
  const squad = [
    { uid: 'gk1', position: 'GK', slot: 1, isStarter: true, benchPosition: null },
    ...['d1', 'd2', 'd3', 'd4'].map((uid, i) => ({ uid, position: 'DEF', slot: 2 + i, isStarter: true, benchPosition: null })),
    ...['m1', 'm2', 'm3', 'm4'].map((uid, i) => ({ uid, position: 'MID', slot: 6 + i, isStarter: true, benchPosition: null })),
    ...['f1', 'f2'].map((uid, i) => ({ uid, position: 'FWD', slot: 10 + i, isStarter: true, benchPosition: null })),
    { uid: 'gk2', position: 'GK', slot: 12, isStarter: false, benchPosition: 1 },
    { uid: 'b1', position: 'MID', slot: 13, isStarter: false, benchPosition: 2 },
    { uid: 'b2', position: 'DEF', slot: 14, isStarter: false, benchPosition: 3 },
    { uid: 'b3', position: 'FWD', slot: 15, isStarter: false, benchPosition: 4 },
  ];
  const played = (overrides: Record<string, { minutes: number; fixtureFinished: boolean }>): Map<string, { minutes: number; fixtureFinished: boolean }> => {
    const m = new Map<string, { minutes: number; fixtureFinished: boolean }>();
    for (const p of squad) m.set(p.uid, { minutes: 90, fixtureFinished: true });
    for (const [k, v] of Object.entries(overrides)) m.set(k, v);
    return m;
  };

  it('a blanked starter is replaced in bench order', () => {
    const subs = previewAutoSubs(squad, played({ m1: { minutes: 0, fixtureFinished: true } }));
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ out: 'm1', in: 'b1' });
  });
  it('a GK only swaps with the bench GK', () => {
    const subs = previewAutoSubs(squad, played({ gk1: { minutes: 0, fixtureFinished: true } }));
    expect(subs[0]).toMatchObject({ out: 'gk1', in: 'gk2' });
  });
  it('nobody comes on while the fixture is still live', () => {
    const subs = previewAutoSubs(squad, played({ m1: { minutes: 0, fixtureFinished: false } }));
    expect(subs).toHaveLength(0);
  });
  it('formation minimums hold: a 3rd-DEF blank cannot be replaced by a FWD', () => {
    const backThree = squad.filter((s) => s.uid !== 'd4');
    const subs = previewAutoSubs(
      backThree,
      played({ d1: { minutes: 0, fixtureFinished: true }, b2: { minutes: 0, fixtureFinished: true } }),
    );
    // bench DEF (b2) also blanked; b1 (MID) or b3 (FWD) would break DEF≥3 → no sub
    expect(subs).toHaveLength(0);
  });
});

describe('B3 — live poller against a fake FPL', () => {
  it('persists live_event_stats with projected bonus and updates fixture state', async () => {
    await db('gameweeks').insert({ id: 3, name: 'GW3', deadline_time: new Date(Date.now() - 3600_000), is_current: true });
    await db('teams').insert([
      { uid: 'team_H', fpl_code: 1, fpl_id: 1, name: 'Home', short_name: 'HOM', strength: '{}' },
      { uid: 'team_A', fpl_code: 2, fpl_id: 2, name: 'Away', short_name: 'AWA', strength: '{}' },
    ]);
    await db('players').insert([
      { uid: 'plr_1', fpl_code: 11, fpl_id: 101, web_name: 'Alpha', position: 'FWD', team_uid: 'team_H' },
      { uid: 'plr_2', fpl_code: 12, fpl_id: 102, web_name: 'Beta', position: 'MID', team_uid: 'team_A' },
    ]);
    await db('fixtures').insert({
      fixture_uid: 'fx_L1',
      season: '2026/27',
      fpl_fixture_id: 9,
      event: 3,
      home_team_uid: 'team_H',
      away_team_uid: 'team_A',
      kickoff_utc: new Date(Date.now() - 3600_000),
      state: 'scheduled',
    });
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('/live')) {
        return new Response(
          JSON.stringify({
            elements: [
              { id: 101, stats: { minutes: 60, goals_scored: 1, assists: 0, clean_sheets: 0, goals_conceded: 0, saves: 0, bonus: 0, bps: 32, yellow_cards: 0, red_cards: 0, total_points: 7 }, explain: [{ fixture: 9, stats: [] }] },
              { id: 102, stats: { minutes: 60, goals_scored: 0, assists: 1, clean_sheets: 0, goals_conceded: 1, saves: 0, bonus: 0, bps: 25, yellow_cards: 0, red_cards: 0, total_points: 5 }, explain: [{ fixture: 9, stats: [] }] },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([{ id: 9, started: true, finished: false, minutes: 60, team_h_score: 1, team_a_score: 0 }]), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await pollLiveOnce(db, fakeFetch);
    expect(r).toMatchObject({ event: 3, players: 2, fixturesLive: 1 });
    const rows = await db('live_event_stats').where('event', 3).orderBy('player_uid');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ player_uid: 'plr_1', goals: 1, projected_bonus: 3 });
    expect(rows[1]).toMatchObject({ player_uid: 'plr_2', assists: 1, projected_bonus: 2 });
    expect((await db('fixtures').where('fixture_uid', 'fx_L1').first())!.state).toBe('live');
  });
});

describe('A3/C3 — availability reconciliation', () => {
  it('extractReturnDate parses the common phrasings', () => {
    const from = new Date('2026-08-21T00:00:00Z');
    const sixWeeks = extractReturnDate('haaland ruled out for six weeks with a hamstring injury', from)!;
    expect(Math.round((sixWeeks.getTime() - from.getTime()) / 86_400_000)).toBe(42);
    const range = extractReturnDate('he is out for 2-4 weeks', from)!;
    expect(Math.round((range.getTime() - from.getTime()) / 86_400_000)).toBe(21);
    const fplStyle = extractReturnDate('hamstring injury - expected back 15 nov', from)!;
    expect(fplStyle.toISOString().slice(0, 10)).toBe('2026-11-15');
    expect(extractReturnDate('scores twice in training match', from)).toBeNull();
  });

  it('writes one merged row per player and flags FPL-vs-news conflicts', async () => {
    await db('gameweeks').insert({ id: 5, name: 'GW5', deadline_time: new Date(Date.now() + 2 * 86_400_000), is_next: true });
    await db('teams').insert({ uid: 'team_X', fpl_code: 7, fpl_id: 7, name: 'X', short_name: 'XXX', strength: '{}' });
    await db('fixtures').insert({
      fixture_uid: 'fx_A1',
      season: '2026/27',
      fpl_fixture_id: 50,
      event: 5,
      home_team_uid: 'team_X',
      away_team_uid: 'team_X',
      kickoff_utc: new Date(Date.now() + 3 * 86_400_000),
      state: 'scheduled',
    }).catch(async () => {
      // self-play fixtures violate nothing in the schema, but guard anyway
    });
    await db('players').insert([
      { uid: 'plr_fit', fpl_code: 21, fpl_id: 201, web_name: 'Fit', position: 'MID', team_uid: 'team_X', status: 'a', news: '' },
      { uid: 'plr_doubt', fpl_code: 22, fpl_id: 202, web_name: 'Doubt', position: 'DEF', team_uid: 'team_X', status: 'd', chance_next: 50, news: 'Knock - 50% chance of playing' },
      { uid: 'plr_out', fpl_code: 23, fpl_id: 203, web_name: 'Out', position: 'FWD', team_uid: 'team_X', status: 'a', news: 'ruled out for six weeks' },
    ]);

    const r = await writeAvailabilityState(db);
    expect(r.players).toBe(3);
    const rows = await db('availability_state').orderBy('player_uid');
    const by = new Map(rows.map((x) => [x.player_uid, x]));
    expect(Number(by.get('plr_fit')!.p_available)).toBe(1);
    expect(by.get('plr_fit')!.state).toBe('available');
    expect(Number(by.get('plr_doubt')!.p_available)).toBeCloseTo(0.5, 2);
    // FPL still says 'a' but the news string says ruled out past the kickoff
    expect(Number(by.get('plr_out')!.p_available)).toBeLessThanOrEqual(0.1);
    expect(by.get('plr_out')!.state).toBe('out');
    expect(r.withReturnDates).toBeGreaterThanOrEqual(1);
  });
});

describe('A2 — ownership-scaled price model + self-calibration', () => {
  it('threshold scales with ownership', () => {
    expect(thresholdFor(DEFAULT_PRICE_MODEL, 40)).toBeGreaterThan(thresholdFor(DEFAULT_PRICE_MODEL, 10));
    expect(thresholdFor(DEFAULT_PRICE_MODEL, 10)).toBeGreaterThan(thresholdFor(DEFAULT_PRICE_MODEL, 1));
    const r = predictOne(DEFAULT_PRICE_MODEL, 200_000, 10);
    expect(r.direction).toBe('rise');
    expect(predictOne(DEFAULT_PRICE_MODEL, -200_000, 10).direction).toBe('fall');
    expect(predictOne(DEFAULT_PRICE_MODEL, 5_000, 10).direction).toBe('hold');
  });

  it('nightly pass stores calls; calibration raises θ when precision is poor', async () => {
    await db('teams').insert({ uid: 'team_P', fpl_code: 9, fpl_id: 9, name: 'P', short_name: 'PPP', strength: '{}' });
    const mkPlayer = (i: number, net: number, own: number): Record<string, unknown> => ({
      uid: `plr_p${i}`,
      fpl_code: 900 + i,
      fpl_id: 900 + i,
      web_name: `P${i}`,
      position: 'MID',
      team_uid: 'team_P',
      selected_by_percent: own,
      transfers_in_event: net > 0 ? net : 0,
      transfers_out_event: net < 0 ? -net : 0,
    });
    await db('players').insert([1, 2, 3, 4, 5, 6].map((i) => mkPlayer(i, 400_000, 5)));

    const today = new Date().toISOString().slice(0, 10);
    const r = await predictPriceMoves(db, today);
    expect(r.rises).toBe(6);
    // only one actually rose → precision 1/6 → θ goes UP as a new config version
    await db('price_events').insert({ player_uid: 'plr_p1', event_date: today, old_cost: 50, new_cost: 51 });
    const before = ((await getConfig<{ theta_base: number }>(db, 'price_model')) ?? DEFAULT_PRICE_MODEL).theta_base;
    const cal = await calibratePriceModel(db);
    expect(cal).not.toBeNull();
    expect(cal!.precision).toBeCloseTo(1 / 6, 2);
    const after = (await getConfig<{ theta_base: number }>(db, 'price_model')).theta_base;
    expect(after).toBeGreaterThan(before);
  });
});
