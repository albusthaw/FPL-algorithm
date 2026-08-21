/**
 * v1.4.3 — C1 RSS parser, C2 matchday phases, C6 indexer correctness
 * (possessive matching, negation guard, entity+category story clustering),
 * A6 venue splits.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { seedProviders } from '../../src/ingest/registry.js';
import { parseRss } from '../../src/ingest/adapters/rss.js';
import { classifySignals } from '../../src/news/signals.js';
import { indexNews } from '../../src/news/indexer.js';
import { matchdayPhase } from '../../src/run/scheduler.js';
import { computePlayerFeatures, type MatchRow } from '../../src/stats/l0-features.js';

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

describe('C1 — RSS parser (dependency-free)', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Football</title>
<item>
  <title><![CDATA[Haaland &amp; Foden fire City to win]]></title>
  <link>https://example.com/story-1?utm_source=rss</link>
  <description><![CDATA[<p>Manchester City won <b>3-1</b>.</p>]]></description>
  <pubDate>Thu, 21 Aug 2026 10:00:00 GMT</pubDate>
  <guid isPermaLink="false">story-1</guid>
</item>
<item>
  <title>Keeper signs new deal</title>
  <link>https://example.com/story-2</link>
  <description>A three-year extension.</description>
</item>
<item><title>no link — skipped</title></item>
</channel></rss>`;

  it('extracts items, strips CDATA/tags, decodes entities', () => {
    const items = parseRss(XML);
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Haaland & Foden fire City to win');
    expect(items[0]!.description).toBe('Manchester City won 3-1 .');
    expect(items[0]!.guid).toBe('story-1');
    expect(items[0]!.pubDate).toContain('2026');
    expect(items[1]!.title).toBe('Keeper signs new deal');
  });
});

describe('C6/N4 — negation guard in signal classification', () => {
  it('classifies a plain hit', () => {
    expect(classifySignals('Star striker banned for three matches after red card')).toContain('disciplinary');
  });
  it('negated hits do not classify', () => {
    expect(classifySignals('Manager confirms striker will not be banned')).not.toContain('disciplinary');
    expect(classifySignals('Midfielder cleared of misconduct by the FA panel')).not.toContain('disciplinary');
    expect(classifySignals('Boss denies training bust-up rumours')).not.toContain('unprofessional');
    expect(classifySignals('Winger avoids suspension despite appeal')).not.toContain('disciplinary');
  });
  it('a negated pattern does not kill a different, real one', () => {
    const cats = classifySignals('He will not be banned, but he refused to train on Friday');
    expect(cats).toContain('unprofessional');
  });
});

describe('C6 — indexer: possessive matching + entity+category clustering', () => {
  async function seedPlayer(): Promise<string> {
    await db('teams').insert({ uid: 'team_T1', fpl_code: 43, fpl_id: 1, name: 'Man City', short_name: 'MCI', strength: '{}' });
    await db('players').insert({ uid: 'plr_T1', fpl_code: 1001, web_name: 'Haaland', full_name: 'Erling Haaland', position: 'FWD', team_uid: 'team_T1' });
    await db('player_aliases').insert([
      { player_uid: 'plr_T1', alias: 'Erling Haaland', source: 'fpl' },
      { player_uid: 'plr_T1', alias: 'Haaland', source: 'fpl' },
    ]);
    return 'plr_T1';
  }

  it("N2: \"Haaland's brace\" links despite the possessive", async () => {
    const uid = await seedPlayer();
    await db('news_items').insert({
      provider: 'rss',
      url: 'https://x.test/a',
      url_canonical: 'https://x.test/a',
      // multi-word alias not present; mononym + club context via possessive
      title: "Erling Haaland's brace sinks Arsenal",
      description: 'Two goals for the Man City striker.',
      source_tier: 1,
    });
    const r = await indexNews(db);
    expect(r.scanned).toBe(1);
    const links = await db('news_player_map').where('player_uid', uid);
    expect(links).toHaveLength(1);
  });

  it('N3: same story, different headline clusters via shared player + category', async () => {
    await seedPlayer();
    const [a] = await db('news_items')
      .insert({
        provider: 'rss',
        url: 'https://x.test/1',
        url_canonical: 'https://x.test/1',
        title: 'Erling Haaland suspended for three matches',
        description: 'The striker faces a ban.',
        source_tier: 1,
      })
      .returning('id');
    const [b] = await db('news_items')
      .insert({
        provider: 'newsdata',
        url: 'https://y.test/2',
        url_canonical: 'https://y.test/2',
        title: 'City dealt major blow ahead of derby',
        description: 'Erling Haaland is banned after his red card.',
        source_tier: 2,
      })
      .returning('id');
    const r = await indexNews(db);
    expect(r.scanned).toBe(2);
    const rows = await db('news_items').whereIn('id', [Number(a.id ?? a), Number(b.id ?? b)]).orderBy('id');
    // titles share no trigram mass — only entity+category corroboration clusters them
    expect(rows[1]!.story_id).toBe(rows[0]!.story_id);
  });

  it('unrelated items stay separate stories', async () => {
    await seedPlayer();
    await db('news_items').insert([
      { provider: 'rss', url: 'https://x.test/5', url_canonical: 'https://x.test/5', title: 'Erling Haaland signs new deal', description: 'contract extension', source_tier: 1 },
      { provider: 'rss', url: 'https://x.test/6', url_canonical: 'https://x.test/6', title: 'Stadium roof repairs finished', description: 'club news', source_tier: 3 },
    ]);
    await indexNews(db);
    const rows = await db('news_items').orderBy('id');
    expect(rows[0]!.story_id).not.toBe(rows[1]!.story_id);
  });
});

describe('C2 — matchday phase detection', () => {
  async function mkTeams(): Promise<void> {
    await db('teams').insert([
      { uid: 'team_H', fpl_code: 1, name: 'Home', short_name: 'HOM', strength: '{}' },
      { uid: 'team_A', fpl_code: 2, name: 'Away', short_name: 'AWA', strength: '{}' },
    ]);
  }

  it('quiet when nothing is near', async () => {
    expect(await matchdayPhase(db)).toBe('quiet');
  });

  it('ko_window inside 90 min of kickoff; in_play after kickoff', async () => {
    await mkTeams();
    await db('fixtures').insert({
      fixture_uid: 'fx_T1',
      season: '2026/27',
      fpl_fixture_id: 1,
      home_team_uid: 'team_H',
      away_team_uid: 'team_A',
      kickoff_utc: new Date(Date.now() + 60 * 60_000),
      state: 'scheduled',
    });
    expect(await matchdayPhase(db)).toBe('ko_window');
    await db('fixtures').where('fixture_uid', 'fx_T1').update({ kickoff_utc: new Date(Date.now() - 30 * 60_000) });
    expect(await matchdayPhase(db)).toBe('in_play');
  });

  it('deadline_24h when the next deadline is close', async () => {
    await db('gameweeks').insert({ id: 1, name: 'GW1', deadline_time: new Date(Date.now() + 6 * 3600_000), is_next: true });
    expect(await matchdayPhase(db)).toBe('deadline_24h');
  });
});

describe('A6 — venue splits in L0', () => {
  const mk = (wasHome: boolean, xg: number, kickoffDaysAgo: number): MatchRow => ({
    kickoff: new Date(Date.now() - kickoffDaysAgo * 86_400_000),
    minutes: 90,
    starts: true,
    goals: 0,
    assists: 0,
    saves: 0,
    cbit: 0,
    cbirt: 0,
    defconCount: 0,
    xg,
    xa: 0,
    fplPoints: 2,
    yc: 0,
    rc: 0,
    wasHome,
  });

  it('a genuine home specialist gets >1 at home, <1 away (both bounded)', () => {
    const rows: MatchRow[] = [];
    for (let i = 0; i < 15; i++) rows.push(mk(true, 0.8, i * 7 + 1));
    for (let i = 0; i < 15; i++) rows.push(mk(false, 0.2, i * 7 + 4));
    const f = computePlayerFeatures(rows, new Date(), 'FWD');
    expect(f.venueAttMultHome).toBeGreaterThan(1.05);
    expect(f.venueAttMultAway).toBeLessThan(0.95);
    expect(f.venueAttMultHome).toBeLessThanOrEqual(1.15);
    expect(f.venueAttMultAway).toBeGreaterThanOrEqual(0.85);
  });

  it('a thin sample stays neutral', () => {
    const rows = [mk(true, 1.5, 3), mk(false, 0.1, 10)];
    const f = computePlayerFeatures(rows, new Date(), 'FWD');
    expect(f.venueAttMultHome).toBeLessThan(1.1);
    expect(f.venueAttMultAway).toBeGreaterThan(0.9);
  });

  it('no venue data (historical rows without was_home) → exactly neutral', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...mk(true, 0.5, i * 7 + 1), wasHome: null }));
    const f = computePlayerFeatures(rows, new Date(), 'FWD');
    expect(f.venueAttMultHome).toBe(1);
    expect(f.venueAttMultAway).toBe(1);
  });
});
