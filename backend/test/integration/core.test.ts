import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { applyTokens, InsufficientTokensError } from '../../src/tokens/ledger.js';
import { setProviderEnabled, MaxProvidersError } from '../../src/ingest/gateway.js';
import { setAliveProvider, analysePlayers } from '../../src/ai/gateway.js';
import { resolveIdentity } from '../../src/players/resolver.js';
import { seedProviders } from '../../src/ingest/registry.js';
import { hashPassword, verifyPassword } from '../../src/auth/auth.js';

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

async function mkUser(role: 'user' | 'admin' = 'user', balance = 0): Promise<number> {
  const [row] = await db('users')
    .insert({ email: `u${Date.now()}${Math.random()}@t.io`, name: 'T', password_hash: 'x', role, token_balance: balance })
    .returning('id');
  return Number(row.id ?? row);
}

describe('token ledger', () => {
  it('debits atomically and records balance_after', async () => {
    const uid = await mkUser('user', 100);
    const r = await applyTokens(db, { userId: uid, delta: -40, reason: 'run' });
    expect(r.balanceAfter).toBe(60);
    const ledger = await db('token_ledger').where('user_id', uid);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.balance_after)).toBe(60);
  });

  it('balance can never go negative', async () => {
    const uid = await mkUser('user', 10);
    await expect(applyTokens(db, { userId: uid, delta: -11, reason: 'run' })).rejects.toBeInstanceOf(InsufficientTokensError);
    expect(Number((await db('users').where('id', uid).first())!.token_balance)).toBe(10);
  });

  it('CONCURRENT debits never overdraw (FOR UPDATE serialisation)', async () => {
    const uid = await mkUser('user', 100);
    const attempts = Array.from({ length: 10 }, () =>
      applyTokens(db, { userId: uid, delta: -30, reason: 'run' }).then(
        () => 'ok' as const,
        (err) => (err instanceof InsufficientTokensError ? ('refused' as const) : Promise.reject(err)),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(3); // 3×30 = 90 ≤ 100
    const final = Number((await db('users').where('id', uid).first())!.token_balance);
    expect(final).toBe(10);
    // ledger sums reconcile
    const sum = await db('token_ledger').where('user_id', uid).sum({ s: 'delta' }).first();
    expect(Number(sum!.s)).toBe(-90);
  });

  it('admins are never debited but usage is recorded', async () => {
    const uid = await mkUser('admin', 0);
    const r = await applyTokens(db, { userId: uid, delta: -500, reason: 'run' });
    expect(r.balanceAfter).toBe(0);
    const ledger = await db('token_ledger').where('user_id', uid);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.delta)).toBe(0);
    expect(ledger[0]!.note).toMatch(/500/);
  });
});

describe('provider gates', () => {
  it('max-2 API switch: third enable refused, even concurrently', async () => {
    await setProviderEnabled(db, 'api_football', true);
    await setProviderEnabled(db, 'newsdata', true);
    await expect(setProviderEnabled(db, 'sportmonks', true)).rejects.toBeInstanceOf(MaxProvidersError);

    // concurrent: disable both, then race 4 enables — at most 2 win
    await setProviderEnabled(db, 'api_football', false);
    await setProviderEnabled(db, 'newsdata', false);
    const keys = ['api_football', 'newsdata', 'sportmonks', 'football_data'];
    const results = await Promise.all(
      keys.map((k) => setProviderEnabled(db, k, true).then(() => 'ok', (e) => (e instanceof MaxProvidersError ? 'refused' : Promise.reject(e)))),
    );
    expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(2);
    const enabled = await db('api_providers').where('enabled', true).whereNot('key', 'fpl').pluck('key');
    expect(enabled.length).toBeLessThanOrEqual(2);
  });

  it('the FPL anchor is not part of the switch', async () => {
    await expect(setProviderEnabled(db, 'fpl', false)).rejects.toThrow(/anchor/);
  });

  it('max-1 AI switch: activation atomically deactivates the incumbent', async () => {
    await setAliveProvider(db, 'mock');
    await setAliveProvider(db, 'ollama');
    const alive = await db('ai_providers').where('alive', true);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.key).toBe('ollama');

    // concurrent flips still end with exactly one alive
    await Promise.all(['mock', 'anthropic', 'gemini', 'deepseek'].map((k) => setAliveProvider(db, k)));
    expect(await db('ai_providers').where('alive', true)).toHaveLength(1);
  });
});

describe('entity resolution', () => {
  beforeEach(async () => {
    await db('teams').insert([
      { uid: 'team_LIV', fpl_code: 14, fpl_id: 12, name: 'Liverpool', short_name: 'LIV' },
      { uid: 'team_CRY', fpl_code: 31, fpl_id: 7, name: 'Crystal Palace', short_name: 'CRY' },
    ]);
    await db('players').insert([
      { uid: 'plr_SON', fpl_code: 85971, web_name: 'Son', first_name: 'Heung-min', second_name: 'Son', full_name: 'Heung-min Son', position: 'MID', element_type: 3, team_uid: 'team_LIV', birthdate: '1992-07-08' },
      { uid: 'plr_EMER1', fpl_code: 1001, web_name: 'Emerson', first_name: '', second_name: 'Emerson', full_name: 'Emerson', position: 'DEF', element_type: 2, team_uid: 'team_LIV', shirt: 2 },
      { uid: 'plr_EMER2', fpl_code: 1002, web_name: 'Emerson', first_name: '', second_name: 'Emerson', full_name: 'Emerson', position: 'DEF', element_type: 2, team_uid: 'team_CRY', shirt: 33 },
    ]);
    await db('player_aliases').insert([
      { player_uid: 'plr_SON', alias: 'heung min son', source: 'fpl' },
      { player_uid: 'plr_SON', alias: 'son', source: 'fpl' },
      { player_uid: 'plr_EMER1', alias: 'emerson', source: 'fpl' },
      { player_uid: 'plr_EMER2', alias: 'emerson', source: 'fpl' },
    ]);
  });

  it('token-order variant resolves deterministically with team match', async () => {
    const r = await resolveIdentity(db, { provider: 'api_football', providerId: '184', name: 'Son Heung-Min', teamUid: 'team_LIV', position: 'MID' });
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') expect(r.playerUid).toBe('plr_SON');
  });

  it('second sighting is a cache hit', async () => {
    await resolveIdentity(db, { provider: 'api_football', providerId: '184', name: 'Son Heung-Min', teamUid: 'team_LIV', position: 'MID' });
    const r2 = await resolveIdentity(db, { provider: 'api_football', providerId: '184', name: 'H. Son' });
    expect(r2.kind).toBe('cached');
  });

  it('mononym collision (two Emersons) requires a secondary signal — queues without one', async () => {
    const r = await resolveIdentity(db, { provider: 'sportmonks', providerId: '555', name: 'Emerson', teamUid: null });
    expect(['queued', 'unmatched']).toContain(r.kind);
    const queue = await db('resolution_queue').where({ provider: 'sportmonks', provider_id: '555' });
    expect(queue).toHaveLength(1);
    // NOTHING auto-merged
    expect(await db('player_identities').where({ provider: 'sportmonks', provider_id: '555' })).toHaveLength(0);
  });

  it('mononym with team + shirt resolves deterministically', async () => {
    const r = await resolveIdentity(db, { provider: 'sportmonks', providerId: '556', name: 'Emerson', teamUid: 'team_CRY', shirt: 33, position: 'DEF' });
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') expect(r.playerUid).toBe('plr_EMER2');
  });

  it('unknown player parks in the queue and never creates a player row', async () => {
    const before = await db('players').count({ c: '*' }).first();
    const r = await resolveIdentity(db, { provider: 'api_football', providerId: '999', name: 'Cup Youthman', teamUid: 'team_LIV' });
    expect(['queued', 'unmatched']).toContain(r.kind);
    const after = await db('players').count({ c: '*' }).first();
    expect(Number(after!.c)).toBe(Number(before!.c));
  });
});

describe('AI pipeline with MockProvider (E2E, zero cost)', () => {
  it('verdicts written, ledger debited, ai_calls recorded with user_id', async () => {
    const uid = await mkUser('user', 1000);
    await setAliveProvider(db, 'mock');
    // players must exist for the verdict cache FK
    await db('teams').insert({ uid: 'team_X', fpl_code: 99, fpl_id: 1, name: 'X', short_name: 'X' });
    await db('players').insert([
      { uid: 'plr_01AAAAAAAAAAAAAAAAAAAAAA', fpl_code: 1, web_name: 'A', position: 'MID', element_type: 3, team_uid: 'team_X' },
      { uid: 'plr_01BBBBBBBBBBBBBBBBBBBBBB', fpl_code: 2, web_name: 'B', position: 'FWD', element_type: 4, team_uid: 'team_X' },
    ]);

    const bundles = [
      {
        playerUid: 'plr_01AAAAAAAAAAAAAAAAAAAAAA',
        webName: 'A',
        position: 'MID',
        club: 'X',
        price: 80,
        matrixLine: 'plr_01AAAAAAAAAAAAAAAAAAAAAA|MID|X|8.0|70.0|12.0|0.90|5.0|fit',
        news: [{ id: 1, title: 'A trained fully', snippet: 'looked sharp', source: 'BBC', ageHours: 4 }],
      },
      {
        playerUid: 'plr_01BBBBBBBBBBBBBBBBBBBBBB',
        webName: 'B',
        position: 'FWD',
        club: 'X',
        price: 60,
        matrixLine: 'plr_01BBBBBBBBBBBBBBBBBBBBBB|FWD|X|6.0|55.0|8.0|0.70|3.2|fit',
        news: [], // no news → skipped
      },
    ];
    const outcome = await analysePlayers(
      db,
      { triggeredByUserId: uid, triggerKind: 'run_button' },
      bundles,
      { gameweek: 1, deadlineIso: '2026-08-21T17:30:00Z', excludedUids: new Set() },
    );
    expect(outcome.analysed).toBe(1);
    expect(outcome.skippedNoNews).toBe(1);
    expect(outcome.verdicts).toHaveLength(1);
    expect(Math.abs(outcome.verdicts[0]!.adjustment)).toBeLessThanOrEqual(20);

    const calls = await db('ai_calls');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => Number(c.user_id) === uid)).toBe(true);

    // second run with identical news → verdict cache hit, zero new analyse
    const outcome2 = await analysePlayers(db, { triggeredByUserId: uid, triggerKind: 'run_button' }, bundles, {
      gameweek: 1,
      deadlineIso: '2026-08-21T17:30:00Z',
      excludedUids: new Set(),
    });
    expect(outcome2.cacheHits).toBe(1);
    expect(outcome2.analysed).toBe(0);
  });

  it('ai_calls.user_id NOT NULL — an unbilled AI call is unrepresentable', async () => {
    await expect(
      db('ai_calls').insert({ user_id: null, provider: 'mock', kind: 'analyse', trigger_kind: 'run_button' }),
    ).rejects.toThrow(/null/i);
  });
});

describe('auth primitives', () => {
  it('argon2id hash verifies and rejects wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });
});
