import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { indexNews, playerSignalRows } from '../../src/news/indexer.js';
import { buildNewsBundles } from '../../src/ai/bundles.js';
import { backfillCareerAggregates } from '../../src/ingest/backfill.js';

let db: Knex;

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function seedPlayer(uid: string, name: string, team: string, alias: string): Promise<void> {
  await db('teams')
    .insert({ uid: `team_${team}`, fpl_code: team.length * 101, fpl_id: team.length, name: team, short_name: team.slice(0, 3).toUpperCase(), strength: '{}' })
    .onConflict('uid')
    .ignore();
  await db('players').insert({
    uid,
    fpl_code: uid.length * 7919 + name.length,
    fpl_id: name.length,
    web_name: name,
    full_name: name,
    position: 'FWD',
    team_uid: `team_${team}`,
    status: 'a',
    now_cost: 60,
  });
  await db('player_aliases').insert([
    { player_uid: uid, alias, source: 'web_name' },
    { player_uid: uid, alias: alias.split(' ').pop()!, source: 'surname' },
  ]);
}

async function seedNews(id: number, title: string, opts: { tier?: number; description?: string; ageHours?: number } = {}): Promise<void> {
  await db('news_items').insert({
    id,
    provider: 'newsdata',
    url: `https://example.com/a${id}`,
    url_canonical: `https://example.com/a${id}`,
    title,
    description: opts.description ?? '',
    content: '',
    source_name: 'test',
    source_domain: opts.tier === 1 ? 'bbc.co.uk' : 'example.com',
    source_tier: opts.tier ?? 3,
    published_at: new Date(Date.now() - (opts.ageHours ?? 1) * 3600_000),
    fetched_at: new Date(Date.now() - (opts.ageHours ?? 1) * 3600_000),
  });
}

describe('news indexer (storage engine + systematic linking)', () => {
  it('links players in bulk, retroactively — including club-context mononyms', async () => {
    await seedPlayer('plr_a1', 'Marchetti', 'Newcastle United', 'luca marchetti');
    await seedNews(1, 'Luca Marchetti doubtful for Saturday');
    await seedNews(2, 'Marchetti stars as Newcastle cruise'); // surname + club context
    await seedNews(3, 'Marchetti linked with a summer move'); // surname, NO club → must not link
    const r = await indexNews(db);
    expect(r.scanned).toBe(3);
    const links = await db('news_player_map').where('player_uid', 'plr_a1').pluck('news_id');
    expect(links.map(Number).sort()).toEqual([1, 2]);
  });

  it('clusters near-duplicate titles into one story instead of dropping them', async () => {
    await seedPlayer('plr_b2', 'Okafor', 'Leeds', 'sam okafor');
    await seedNews(11, 'Sam Okafor ruled out for six weeks with hamstring injury', { tier: 3 });
    await seedNews(12, 'Sam Okafor ruled out for six weeks with hamstring injury!', { tier: 1 });
    await seedNews(13, 'Completely different: cup draw announced');
    const r = await indexNews(db);
    expect(r.storiesAssigned).toBeGreaterThanOrEqual(1);
    const rows = await db('news_items').whereIn('id', [11, 12]).select('id', 'story_id');
    const stories = new Set(rows.map((x) => Number(x.story_id)));
    expect(stories.size).toBe(1); // same story
    const other = await db('news_items').where('id', 13).first('story_id');
    expect(Number(other.story_id)).toBe(13); // self-rooted
  });

  it('classifies signals and exposes them per player with story collapse', async () => {
    await seedPlayer('plr_c3', 'Duarte', 'Everton', 'nico duarte');
    // the same disciplinary story from two sources: one count, tier = best
    await seedNews(21, 'Nico Duarte sent off in explosive derby bust-up', { tier: 3 });
    await seedNews(22, 'Nico Duarte sent off in explosive derby bust-up …', { tier: 1 });
    await indexNews(db);
    const rows = await playerSignalRows(db, 10);
    const mine = rows.get('plr_c3') ?? [];
    const disciplinary = mine.filter((r) => r.category === 'disciplinary');
    expect(disciplinary.length).toBe(1); // story-collapsed, not double-counted
    expect(disciplinary[0]!.tier).toBeLessThanOrEqual(3);
  });

  it('re-scan picks up links for aliases added AFTER the article arrived', async () => {
    await seedNews(31, 'New signing Tomas Vrba completes medical at Fulham');
    await indexNews(db); // nothing to link yet
    expect(await db('news_player_map').count('* as c').then((r) => Number(r[0]!.c))).toBe(0);
    await seedPlayer('plr_d4', 'Vrba', 'Fulham', 'tomas vrba');
    const r2 = await indexNews(db); // rolling re-scan window re-reads it
    expect(r2.linked).toBe(1);
    expect(await db('news_player_map').where('player_uid', 'plr_d4').count('* as c').then((r) => Number(r[0]!.c))).toBe(1);
  });
});

describe('AI bundles: one representative per story per player', () => {
  it('overlapping coverage never repeats in the prompt payload', async () => {
    await seedPlayer('plr_e5', 'Iversen', 'Brentford', 'kris iversen');
    await seedNews(41, 'Kris Iversen doubtful after knock in training', { tier: 3 });
    await seedNews(42, 'Kris Iversen doubtful after knock in training today', { tier: 1 });
    await indexNews(db);
    const [run] = await db('runs').insert({ kind: 'full', status: 'complete' }).returning('id');
    const runId = Number(run.id ?? run);
    await db('player_matrix').insert({
      run_id: runId,
      player_uid: 'plr_e5',
      gameweek: 1,
      p_start_xi: 0.9,
      p_appearance: 0.9,
      injury_status: 'fit',
      price: 60,
      stat_score: 50,
      xpts_next1: 4,
      xpts_next3: 12,
      xpts_next6: 24,
    });
    const bundles = await buildNewsBundles(db, runId);
    const mine = bundles.find((b) => b.playerUid === 'plr_e5')!;
    expect(mine.news.length).toBe(1); // story-deduped
    expect(mine.news[0]!.source).toBe('test');
  });
});

describe('career-aggregate backfill (FPL history_past)', () => {
  it('sweeps element-summary into player_season_history, resumably', async () => {
    await seedPlayer('plr_f6', 'Veteran', 'Arsenal', 'old veteran');
    const fakeFetch = (async (url: string) => {
      expect(url).toContain('element-summary');
      return new Response(
        JSON.stringify({
          history_past: [
            { season_name: '2007/08', total_points: 112, minutes: 2900, goals_scored: 9, assists: 6 },
            { season_name: '2025/26', total_points: 180, minutes: 3100, goals_scored: 17, assists: 4, expected_goals: '15.30' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const r = await backfillCareerAggregates(db, { fetchFn: fakeFetch, throttleMs: 0 });
    expect(r.seasonRows).toBe(2);
    const rows = await db('player_season_history').where('player_uid', 'plr_f6').orderBy('season');
    expect(rows.length).toBe(2);
    expect(rows[0]!.season).toBe('2007/08'); // ~20 years back when FPL has it
    expect((rows[1]!.stats as { xg: number }).xg).toBeCloseTo(15.3, 1);
    // resumable: second sweep skips players already covered
    const r2 = await backfillCareerAggregates(db, { fetchFn: fakeFetch, throttleMs: 0 });
    expect(r2.skipped).toBe(1);
    expect(r2.seasonRows).toBe(0);
  });
});
