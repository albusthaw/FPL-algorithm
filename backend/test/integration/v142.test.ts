/**
 * v1.4.2 — P2 savable builds (migration 0012), P1 subscription model +
 * per-source depth selector, plan-∩-entitlement option gating, and the
 * plan-refusal report lines from ensureHistoryDepth.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { seedProviders } from '../../src/ingest/registry.js';
import {
  DEFAULT_HISTORY_DEPTH,
  effectiveDepth,
  depthSelectorOptions,
  ensureHistoryDepth,
  seasonDirLabel,
  currentSeasonStartYear,
} from '../../src/ingest/backfill.js';
import { DEFAULT_PROVIDER_PLANS, PROVIDER_PLAN_TIERS, tierFor, quotaLimitFor } from '../../src/ingest/plans.js';
import { learnEntitlement } from '../../src/ingest/gateway.js';

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

describe('P2 — migration 0012: savable builds', () => {
  it('user_teams stores kind + source_run_id', async () => {
    const [u] = await db('users')
      .insert({ email: 'k@t.io', name: 'K', password_hash: 'x', role: 'user', token_balance: 0 })
      .returning('id');
    const [t] = await db('user_teams')
      .insert({ user_id: Number(u.id ?? u), name: 'Weekly XI (run 7)', kind: 'weekly', source_run_id: 7 })
      .returning('id');
    const row = await db('user_teams').where('id', Number(t.id ?? t)).first();
    expect(row.kind).toBe('weekly');
    expect(Number(row.source_run_id)).toBe(7);
  });

  it('kind defaults to manual for plain teams', async () => {
    const [u] = await db('users')
      .insert({ email: 'k2@t.io', name: 'K', password_hash: 'x', role: 'user', token_balance: 0 })
      .returning('id');
    const [t] = await db('user_teams').insert({ user_id: Number(u.id ?? u), name: 'My team' }).returning('id');
    const row = await db('user_teams').where('id', Number(t.id ?? t)).first();
    expect(row.kind).toBe('manual');
    expect(row.source_run_id).toBeNull();
  });
});

describe('P1 — subscription plan catalog', () => {
  it('every provider defaults to its free tier', () => {
    for (const [provider, sel] of Object.entries(DEFAULT_PROVIDER_PLANS)) {
      expect(sel.plan, provider).toBe(PROVIDER_PLAN_TIERS[provider]![0]!.id);
    }
  });

  it('quota_limit fill: day-metered and credit-metered plans (fixes X5)', () => {
    expect(quotaLimitFor(tierFor('api_football', 'free')!)).toBe(100);
    expect(quotaLimitFor(tierFor('api_football', 'pro')!)).toBe(7500);
    expect(quotaLimitFor(tierFor('newsdata', 'free')!)).toBe(200);
    expect(quotaLimitFor(tierFor('understat', 'free')!)).toBeNull(); // unmetered scraper
    expect(tierFor('football_data', 'nope')).toBeNull();
  });
});

describe('P1 — effectiveDepth folding', () => {
  it('vaastav/fpl per-provider selections fold into the legacy fields', () => {
    const eff = effectiveDepth({
      ...DEFAULT_HISTORY_DEPTH,
      per_provider: { vaastav: { unit: 'seasons', value: 4 }, fpl: { unit: 'career', value: 1 } },
    });
    expect(eff.mode).toBe('seasons');
    expect(eff.seasons).toBe(4);
    expect(eff.career_aggregates).toBe(true);
  });

  it('no selections → config unchanged', () => {
    const eff = effectiveDepth(DEFAULT_HISTORY_DEPTH);
    expect(eff.mode).toBe('days');
    expect(eff.career_aggregates).toBe(false);
  });
});

describe('P1 — depth selector options = plan ∩ entitlements', () => {
  it('free plans gate past seasons and the news archive, with reasons', async () => {
    const rows = await depthSelectorOptions(db, DEFAULT_HISTORY_DEPTH, DEFAULT_PROVIDER_PLANS);
    const fd = rows.find((r) => r.provider === 'football_data')!;
    expect(fd.options.find((o) => o.value === 1)!.allowed).toBe(true);
    const fd3 = fd.options.find((o) => o.value === 3)!;
    expect(fd3.allowed).toBe(false);
    expect(fd3.reason).toContain('Standard');

    const news = rows.find((r) => r.provider === 'newsdata')!;
    expect(news.options.find((o) => o.unit === 'days')!.allowed).toBe(true);
    const archive = news.options.find((o) => o.unit === 'months' && o.value === 6)!;
    expect(archive.allowed).toBe(false);
    expect(archive.reason).toContain('paid plan');

    const us = rows.find((r) => r.provider === 'understat')!;
    expect(us.options.find((o) => o.value === 12)!.allowed).toBe(true);

    const af = rows.find((r) => r.provider === 'api_football')!;
    const af3 = af.options.find((o) => o.value === 3)!;
    expect(af3.allowed).toBe(true); // 2024 falls inside the free 2022–2024 window
    expect(af3.reason).toContain('2022–2024');
  });

  it('a paid plan unlocks the options', async () => {
    const plans = {
      ...DEFAULT_PROVIDER_PLANS,
      football_data: { plan: 'standard', depth: { seasons: 5 }, rate: { per_min: 60 } },
      newsdata: { plan: 'professional', depth: { days: 2, months: 24 }, rate: { credits_day: 50000 } },
    };
    const rows = await depthSelectorOptions(db, DEFAULT_HISTORY_DEPTH, plans);
    expect(rows.find((r) => r.provider === 'football_data')!.options.find((o) => o.value === 5)!.allowed).toBe(true);
    const news = rows.find((r) => r.provider === 'newsdata')!;
    expect(news.options.find((o) => o.unit === 'months' && o.value === 24)!.allowed).toBe(true);
    expect(news.options.find((o) => o.unit === 'months' && o.value === 60)!.allowed).toBe(false);
  });

  it('a learned PLAN_DENIED refuses the option even when the plan claims it', async () => {
    const cur = currentSeasonStartYear();
    await learnEntitlement(db, 'football_data', 'pl-matches-season', `season-${cur - 1}`, false, 'HTTP 403');
    const plans = { ...DEFAULT_PROVIDER_PLANS, football_data: { plan: 'standard', depth: { seasons: 5 }, rate: {} } };
    const rows = await depthSelectorOptions(db, DEFAULT_HISTORY_DEPTH, plans);
    const opt = rows.find((r) => r.provider === 'football_data')!.options.find((o) => o.value === 5)!;
    expect(opt.allowed).toBe(false);
    expect(opt.reason).toContain('learned');
  });
});

describe('P1 — ensureHistoryDepth plan refusals (report lines, zero requests)', () => {
  it('says WHY the plan refuses instead of calling the API', async () => {
    // pin the vaastav floor as already-complete so no network import fires
    const prevSeason = seasonDirLabel(currentSeasonStartYear() - 1);
    await db('history_pulls').insert({ provider: 'vaastav', scope: prevSeason, status: 'complete', started_at: db.fn.now() });

    let fetched = 0;
    const fetchFn = (async () => {
      fetched++;
      throw new Error('no network in this test');
    }) as unknown as typeof fetch;

    const notes = await ensureHistoryDepth(
      db,
      {
        ...DEFAULT_HISTORY_DEPTH,
        per_provider: {
          newsdata: { unit: 'months', value: 6 }, // free plan: no archive
          football_data: { unit: 'seasons', value: 3 }, // free plan: current only
        },
      },
      { fetchFn, plans: DEFAULT_PROVIDER_PLANS },
    );

    expect(fetched).toBe(0);
    expect(notes.some((n) => n.includes('newsdata') && n.includes('no archive access'))).toBe(true);
    expect(notes.some((n) => n.includes('football-data') && n.includes("plan 'free'"))).toBe(true);
  });
});
