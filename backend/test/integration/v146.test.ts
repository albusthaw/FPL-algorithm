/**
 * v1.4.6 — news linking correctness: order-preserving alias generation,
 * longest-match masking, whole-word club context, same-club mononym
 * ambiguity, link replacement on re-index, alias-version boot gate.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { testDb, truncateAll } from '../helpers/db.js';
import { seedProviders } from '../../src/ingest/registry.js';
import { aliasesFor, surnameOf, reseedAliases, ALIAS_VERSION } from '../../src/players/aliases.js';
import { indexNews, clubTermsFor, ensureNewsIndexVersion } from '../../src/news/indexer.js';
import { getConfig, setConfig } from '../../src/core/model-config.js';
import { parseFeedDate } from '../../src/ingest/http.js';
import { pullRssFeeds, repairKnownFeedDefaults, DEFAULT_RSS_FEEDS } from '../../src/ingest/adapters/rss.js';
import { providersForEnv } from '../../src/core/secrets.js';
import { clearAuthError } from '../../src/ingest/gateway.js';

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

describe('aliasesFor — order-preserving press names', () => {
  it('Bruno Fernandes: first+surname, full name, web name, surname', () => {
    const a = aliasesFor({ webName: 'B.Fernandes', firstName: 'Bruno', secondName: 'Borges Fernandes', fullName: 'Bruno Borges Fernandes' });
    expect(a).toContain('bruno fernandes');
    expect(a).toContain('bruno borges fernandes');
    expect(a).toContain('fernandes');
    expect(a).toContain('b fernandes');
    expect(a).not.toContain('borges bruno fernandes'); // the old sorted seed
  });
  it('particles: Gabriel dos Santos Magalhães → gabriel magalhaes + magalhaes; van Dijk keeps the particle', () => {
    const g = aliasesFor({ webName: 'Gabriel', firstName: 'Gabriel', secondName: 'dos Santos Magalhães', fullName: 'Gabriel dos Santos Magalhães' });
    expect(g).toContain('gabriel');
    expect(g).toContain('gabriel magalhaes');
    expect(g).toContain('magalhaes');
    expect(g).not.toContain('santos');
    expect(surnameOf('van Dijk')).toBe('van dijk');
    const v = aliasesFor({ webName: 'Virgil', firstName: 'Virgil', secondName: 'van Dijk', fullName: 'Virgil van Dijk' });
    expect(v).toContain('van dijk');
    expect(v).toContain('virgil van dijk');
  });
  it('hyphens + diacritics + East-Asian order', () => {
    const c = aliasesFor({ webName: 'Calvert-Lewin', firstName: 'Dominic', secondName: 'Calvert-Lewin', fullName: 'Dominic Calvert-Lewin' });
    expect(c).toContain('calvert lewin');
    expect(c).toContain('dominic calvert lewin');
    const o = aliasesFor({ webName: 'Ødegaard', firstName: 'Martin', secondName: 'Ødegaard', fullName: 'Martin Ødegaard' });
    expect(o).toContain('odegaard');
    const s = aliasesFor({ webName: 'Son', firstName: 'Heung-Min', secondName: 'Son', fullName: 'Heung-Min Son' });
    expect(s).toContain('heung min son');
    expect(s).toContain('son heung min');
  });
  it('never emits initials or two-letter fragments as mononyms', () => {
    const n = aliasesFor({ webName: 'N.Williams', firstName: 'Neco', secondName: 'Williams', fullName: 'Neco Williams' });
    expect(n).not.toContain('n');
    expect(n).toContain('neco williams');
    expect(n).toContain('williams');
  });
  it('club press names are whole phrases, no generic "united"/"city"', () => {
    expect(clubTermsFor('Man Utd')).toContain('manchester united');
    expect(clubTermsFor('Man Utd')).not.toContain('united');
    expect(clubTermsFor('Man City')).not.toContain('city');
    expect(clubTermsFor("Nott'm Forest")).toContain('nottingham forest');
  });
});

async function seedLeague(): Promise<void> {
  await db('teams').insert([
    { uid: 'team_MUN', fpl_code: 1, fpl_id: 1, name: 'Man Utd', short_name: 'MUN', strength: '{}' },
    { uid: 'team_MCI', fpl_code: 43, fpl_id: 2, name: 'Man City', short_name: 'MCI', strength: '{}' },
    { uid: 'team_ARS', fpl_code: 3, fpl_id: 3, name: 'Arsenal', short_name: 'ARS', strength: '{}' },
  ]);
  await db('players').insert([
    { uid: 'plr_bruno', fpl_code: 11, fpl_id: 11, web_name: 'B.Fernandes', first_name: 'Bruno', second_name: 'Borges Fernandes', full_name: 'Bruno Borges Fernandes', position: 'MID', team_uid: 'team_MUN' },
    { uid: 'plr_rico', fpl_code: 12, fpl_id: 12, web_name: 'Lewis', first_name: 'Rico', second_name: 'Lewis', full_name: 'Rico Lewis', position: 'DEF', team_uid: 'team_MCI' },
    { uid: 'plr_myles', fpl_code: 13, fpl_id: 13, web_name: 'Lewis-Skelly', first_name: 'Myles', second_name: 'Lewis-Skelly', full_name: 'Myles Lewis-Skelly', position: 'DEF', team_uid: 'team_ARS' },
    { uid: 'plr_gabriel', fpl_code: 14, fpl_id: 14, web_name: 'Gabriel', first_name: 'Gabriel', second_name: 'dos Santos Magalhães', full_name: 'Gabriel dos Santos Magalhães', position: 'DEF', team_uid: 'team_ARS' },
    { uid: 'plr_martinelli', fpl_code: 15, fpl_id: 15, web_name: 'Martinelli', first_name: 'Gabriel', second_name: 'Martinelli Silva', full_name: 'Gabriel Martinelli Silva', position: 'MID', team_uid: 'team_ARS' },
    // two "Silva" mononyms at the SAME club → ambiguous
    { uid: 'plr_silva1', fpl_code: 16, fpl_id: 16, web_name: 'Silva', first_name: 'Bernardo', second_name: 'Silva', full_name: 'Bernardo Silva', position: 'MID', team_uid: 'team_MCI' },
    { uid: 'plr_silva2', fpl_code: 17, fpl_id: 17, web_name: 'F.Silva', first_name: 'Fabio', second_name: 'Silva', full_name: 'Fabio Silva', position: 'FWD', team_uid: 'team_MCI' },
    // "Bradley" is Conor Bradley's surname AND Bradley Burrowes's given name
    { uid: 'plr_bradley', fpl_code: 18, fpl_id: 18, web_name: 'Bradley', first_name: 'Conor', second_name: 'Bradley', full_name: 'Conor Bradley', position: 'DEF', team_uid: 'team_MCI' },
    { uid: 'plr_burrowes', fpl_code: 19, fpl_id: 19, web_name: 'Burrowes', first_name: 'Bradley', second_name: 'Burrowes', full_name: 'Bradley Burrowes', position: 'MID', team_uid: 'team_ARS' },
    // an English-word surname ("hall", "mount", "rice")
    { uid: 'plr_hall', fpl_code: 20, fpl_id: 20, web_name: 'Hall', first_name: 'Lewis', second_name: 'Hall', full_name: 'Lewis Hall', position: 'DEF', team_uid: 'team_ARS' },
  ]);
  await reseedAliases(db);
}

const insertItem = async (id: string, title: string, description = ''): Promise<number> => {
  const [row] = await db('news_items')
    .insert({ provider: 'rss', url: `https://t.test/${id}`, url_canonical: `https://t.test/${id}`, title, description, source_tier: 1 })
    .returning('id');
  return Number(row.id ?? row);
};
const linkedTo = async (newsId: number): Promise<string[]> => (await db('news_player_map').where('news_id', newsId).pluck('player_uid')).sort();

describe('indexNews — linking rules', () => {
  it('links Bruno Fernandes from ordinary prose (the reported bug)', async () => {
    await seedLeague();
    const id = await insertItem('a', 'Bruno Fernandes scores twice as Manchester United beat Burnley');
    await indexNews(db);
    expect(await linkedTo(id)).toEqual(['plr_bruno']);
  });

  it('surname mononym needs the club named as a whole word; "manager" is not Man Utd', async () => {
    await seedLeague();
    const ok = await insertItem('b', 'Fernandes rescues a point for Man Utd at Old Trafford');
    const notClub = await insertItem('c', 'The manager praised Fernandes after the derby'); // no club term
    await indexNews(db);
    expect(await linkedTo(ok)).toEqual(['plr_bruno']);
    expect(await linkedTo(notClub)).toEqual([]);
  });

  it('longest match masks the span: Lewis-Skelly never links Rico Lewis', async () => {
    await seedLeague();
    const id = await insertItem('d', 'Man City given definitive Myles Lewis-Skelly transfer response by Arsenal');
    await indexNews(db);
    expect(await linkedTo(id)).toEqual(['plr_myles']);
  });

  it('Gabriel Martinelli does not link Gabriel (Magalhães); a bare Gabriel does', async () => {
    await seedLeague();
    const a = await insertItem('e', 'Gabriel Martinelli fires Arsenal past Leeds');
    const b = await insertItem('f', 'Arsenal defender Gabriel signs new deal');
    await indexNews(db);
    expect(await linkedTo(a)).toEqual(['plr_martinelli']);
    expect(await linkedTo(b)).toEqual(['plr_gabriel']);
  });

  it('a mononym shared by two players at the same club is ambiguous — only full names link', async () => {
    await seedLeague();
    const bare = await insertItem('g', 'Silva shines again for Man City');
    const full = await insertItem('h', 'Bernardo Silva shines again for Man City');
    await indexNews(db);
    expect(await linkedTo(bare)).toEqual([]);
    expect(await linkedTo(full)).toEqual(['plr_silva1']);
  });

  it('masked_phrases blank a colliding name before matching', async () => {
    await seedLeague();
    await setConfig(db, 'news_indexer', { rescan_days: 7, cluster_days: 7, cluster_sim: 0.85, masked_phrases: ['Gabriel Heinze'] });
    const id = await insertItem('i', 'Arsenal legend Gabriel Heinze returns to the Emirates as a pundit');
    await indexNews(db);
    expect(await linkedTo(id)).toEqual([]);
  });

  it('a given-name-like mononym followed by a capitalised word is someone else: "Bradley Barcola" never links Conor Bradley', async () => {
    await seedLeague();
    const barcola = await insertItem('l', 'Bradley Barcola sends Man City fans wild on Premier League debut', 'Barcola started on the bench for Man City.');
    const bare = await insertItem('m', 'Man City full-back Bradley impresses again', "Bradley's crossing was excellent for Man City.");
    const full = await insertItem('n', 'Conor Bradley signs new Man City deal');
    const titleCase = await insertItem('o', 'Bradley Set For Man City Return', 'Bradley is set to return for Man City after injury.');
    const hyphen = await insertItem('p', 'Man City watch Bradley-Smith closely'); // compound name → not Conor
    const comma = await insertItem('q', 'Man City: Bradley, Foden and Haaland all fit');
    await indexNews(db);
    expect(await linkedTo(barcola)).toEqual([]);
    expect(await linkedTo(bare)).toEqual(['plr_bradley']);
    expect(await linkedTo(full)).toEqual(['plr_bradley']);
    expect(await linkedTo(titleCase)).toEqual(['plr_bradley']); // sentence-case description recovers the Title Case headline
    expect(await linkedTo(hyphen)).toEqual([]);
    expect(await linkedTo(comma)).toEqual(['plr_bradley']);
  });

  it('a mononym must be written as a NAME: capitalised and not preceded by another capitalised non-club word', async () => {
    await seedLeague();
    const estate = await insertItem('s', 'Arsenal buy £190m estate for new training complex', 'The club will acquire the Woolsington Hall estate previously owned by Sir John Hall.');
    const noun = await insertItem('t', 'Arsenal squad gather in the dining hall before kick-off');
    const bare = await insertItem('u', 'Hall impresses as Arsenal beat Leeds');
    const possessive = await insertItem('v', "Arsenal's Hall set for England call-up");
    // Title Case headline: capitalisation carries no information → a plain surname still links
    const titleCase = await insertItem('w', 'Arsenal Agree Deal To Sign Hall From Newcastle');
    const rescued = await insertItem('x', 'Arsenal Defender Hall Set For Return', 'Hall is set to return for Arsenal after injury.');
    const listed = await insertItem('y', 'Arsenal injury latest: Saliba, Hall, Rice and return dates');
    // aggregated NewsData descriptions glue source names onto headlines: an ALL-CAPS neighbour is not a first name
    const mashup = await insertItem('z', 'Arsenal v Leeds: prediction and team news', 'Arsenal team news ESPN Hall, Saliba in training and available for selection');
    await indexNews(db);
    expect(await linkedTo(estate)).toEqual([]);
    expect(await linkedTo(noun)).toEqual([]);
    expect(await linkedTo(bare)).toEqual(['plr_hall']);
    expect(await linkedTo(possessive)).toEqual(['plr_hall']);
    expect(await linkedTo(titleCase)).toEqual(['plr_hall']);
    expect(await linkedTo(rescued)).toEqual(['plr_hall']);
    expect(await linkedTo(listed)).toEqual(['plr_hall']);
    expect(await linkedTo(mashup)).toEqual(['plr_hall']);
  });

  it('a given-name-like mononym in a Title Case headline needs its description to vouch for it', async () => {
    await seedLeague();
    const barcolaTitle = await insertItem('aa', 'Bradley Barcola Sends Man City Fans Wild'); // no description → precision wins
    const bradleyTitle = await insertItem('ab', 'Bradley Set For Man City Return'); // indistinguishable in Title Case → no link
    const vouched = await insertItem('ac', 'Bradley Set For Man City Return', 'Bradley is expected to start for Man City.');
    await indexNews(db);
    expect(await linkedTo(barcolaTitle)).toEqual([]);
    expect(await linkedTo(bradleyTitle)).toEqual([]);
    expect(await linkedTo(vouched)).toEqual(['plr_bradley']);
  });

  it('standsAlone: pure surnames are untouched by the given-name guard (only given-name-like mononyms consult it)', async () => {
    await seedLeague();
    // "Fernandes Bruno" order is not English press usage but "fernandes" is not a given name → the guard never runs
    const id = await insertItem('r', 'Man Utd star Fernandes Rashford double act delights Old Trafford');
    await indexNews(db);
    expect(await linkedTo(id)).toEqual(['plr_bruno']);
  });

  it('re-index REPLACES links: a false positive from an old alias table disappears', async () => {
    await seedLeague();
    const id = await insertItem('j', 'Man City given definitive Myles Lewis-Skelly transfer response');
    // simulate the ≤1.4.5 false positive
    await db('news_player_map').insert({ news_id: id, player_uid: 'plr_rico', match_kind: 'club_context', confidence: 0.8 });
    await indexNews(db, { full: true });
    expect(await linkedTo(id)).toEqual(['plr_myles']);
  });
});

describe('ensureNewsIndexVersion — one-time retroactive correction', () => {
  it('re-seeds + re-indexes when the stored alias version is behind, then is a no-op', async () => {
    await seedLeague();
    // model_config survives truncateAll (it is seed data): simulate the ≤1.4.5 state explicitly
    await setConfig(db, 'news_index_state', { alias_version: 0 });
    await db('player_aliases').where('source', 'fpl').del(); // an old install: no usable aliases
    const id = await insertItem('k', 'Bruno Fernandes captains Manchester United to victory');
    await indexNews(db);
    expect(await linkedTo(id)).toEqual([]); // nothing to match yet
    const first = await ensureNewsIndexVersion(db);
    expect(first.reindexed).toBe(true);
    expect(await linkedTo(id)).toEqual(['plr_bruno']);
    const state = await getConfig<{ alias_version: number }>(db, 'news_index_state');
    expect(state.alias_version).toBe(ALIAS_VERSION);
    const second = await ensureNewsIndexVersion(db);
    expect(second.reindexed).toBe(false);
  });
});

describe('parseFeedDate — feed pubDates never crash an insert (v1.4.6 live finding)', () => {
  it('ISO and RFC-822 GMT parse directly', () => {
    expect(parseFeedDate('2026-09-04T13:00:00Z')?.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(parseFeedDate('Fri, 04 Sep 2026 13:00:00 GMT')?.toISOString()).toBe('2026-09-04T13:00:00.000Z');
  });
  it('Sky-style BST (the crash) resolves to UTC+1; other feed abbreviations map too', () => {
    expect(parseFeedDate('Fri, 04 Sep 2026 14:00:00 BST')?.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(parseFeedDate('Sat, 05 Sep 2026 09:30:00 CEST')?.toISOString()).toBe('2026-09-05T07:30:00.000Z');
    expect(parseFeedDate('Sat, 05 Sep 2026 09:30:00 EDT')?.toISOString()).toBe('2026-09-05T13:30:00.000Z');
  });
  it('missing, empty, garbage and unknown abbreviations → null, never Invalid Date', () => {
    expect(parseFeedDate(null)).toBeNull();
    expect(parseFeedDate(undefined)).toBeNull();
    expect(parseFeedDate('   ')).toBeNull();
    expect(parseFeedDate('not a date')).toBeNull();
    expect(parseFeedDate('Fri, 04 Sep 2026 14:00:00 XYZ')).toBeNull();
    for (const s of ['x', '2026-13-45', 'Fri, 99 Sep 2026 14:00:00 BST']) {
      const d = parseFeedDate(s);
      expect(d === null || !Number.isNaN(d.getTime())).toBe(true);
    }
  });
});

describe('repairKnownFeedDefaults — the all-sport Sky feed we shipped is rewritten once, customisations kept', () => {
  it('rewrites 12040 → 11661 in place and is then a no-op; other feeds untouched', async () => {
    await setConfig(db, 'rss_feeds', {
      feeds: [
        { id: 'bbc', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', tier: 1 },
        { id: 'sky', url: 'https://www.skysports.com/rss/12040', tier: 1 },
        { id: 'mine', url: 'https://example.test/custom.xml', tier: 3 },
      ],
      max_items_per_feed: 42,
    });
    expect((await repairKnownFeedDefaults(db)).repaired).toBe(1);
    const cfg = await getConfig<typeof DEFAULT_RSS_FEEDS>(db, 'rss_feeds');
    expect(cfg.feeds.map((f) => f.url)).toEqual([
      'https://feeds.bbci.co.uk/sport/football/rss.xml',
      'https://www.skysports.com/rss/11661',
      'https://example.test/custom.xml',
    ]);
    expect(cfg.max_items_per_feed).toBe(42);
    expect((await repairKnownFeedDefaults(db)).repaired).toBe(0);
    expect(DEFAULT_RSS_FEEDS.feeds.find((f) => f.id === 'sky')?.url).toBe('https://www.skysports.com/rss/11661');
    // leave the shared model_config in its shipped state for the other suites
    await setConfig(db, 'rss_feeds', DEFAULT_RSS_FEEDS);
  });
});

describe('a new key clears a stale AUTH error on its provider (live finding: NewsData stuck on "error" after its key was re-entered)', () => {
  it('providersForEnv maps env vars to provider keys', () => {
    expect(providersForEnv('NEWSDATA_KEY')).toEqual(['newsdata']);
    expect(providersForEnv('MODAL_KEY')).toEqual(['modal']);
    expect(providersForEnv('NOT_A_KEY')).toEqual([]);
  });
  it('clearAuthError heals only providers in state error, once', async () => {
    await db('api_providers').where('key', 'newsdata').update({ state: 'error', circuit_failures: 3 });
    await db('api_providers').where('key', 'api_football').update({ state: 'degraded' });
    expect(await clearAuthError(db, providersForEnv('NEWSDATA_KEY'))).toBe(1);
    const nd = await db('api_providers').where('key', 'newsdata').first('state', 'circuit_failures', 'circuit_open_until');
    expect(nd).toMatchObject({ state: 'ok', circuit_failures: 0, circuit_open_until: null });
    expect(await clearAuthError(db, providersForEnv('NEWSDATA_KEY'))).toBe(0);
    // a degraded (circuit) provider is not an AUTH problem — untouched
    expect(await clearAuthError(db, ['api_football'])).toBe(0);
    expect((await db('api_providers').where('key', 'api_football').first('state')).state).toBe('degraded');
    expect(await clearAuthError(db, [])).toBe(0);
  });
});

describe('pullRssFeeds — one malformed item never kills the feed pass', () => {
  const xml = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
  const item = (n: number, pubDate: string, title = `Story ${n} about Bruno Fernandes`) =>
    `<item><title>${title}</title><link>https://example.test/story-${n}</link><description>d${n}</description><pubDate>${pubDate}</pubDate><guid>g${n}</guid></item>`;
  const feed = { feeds: [{ id: 'sky', url: 'https://sky.test/rss', tier: 1 }], max_items_per_feed: 100 };

  it('BST dates land as timestamps, an unparseable date lands as null, and the feed logs ok', async () => {
    const body = xml(item(1, 'Fri, 04 Sep 2026 14:00:00 BST') + item(2, 'Fri, 04 Sep 2026 13:00:00 GMT') + item(3, 'yesterday-ish'));
    const fetchFn = async () => new Response(body, { status: 200, headers: { etag: '"e1"' } });
    const res = await pullRssFeeds(db, feed, fetchFn);
    expect(res).toMatchObject({ feeds: 1, fetched: 3, inserted: 3, bumped: 0 });
    const rows = (await db('news_items').where('provider', 'rss').orderBy('external_id').select('external_id', 'published_at')) as {
      external_id: string;
      published_at: Date | null;
    }[];
    expect(rows.map((r) => r.external_id)).toEqual(['g1', 'g2', 'g3']);
    expect(rows[0]!.published_at?.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(rows[1]!.published_at?.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(rows[2]!.published_at).toBeNull();
    const logRow = await db('api_pull_log').where({ provider: 'rss', endpoint: 'sky' }).orderBy('id', 'desc').first('status', 'records', 'error_detail');
    expect(logRow.status).toBe('ok');
    expect(Number(logRow.records)).toBe(3);
    expect(logRow.error_detail).toBeNull();
  });

  it('a per-item DB failure is counted and skipped; the rest of the feed still inserts', async () => {
    // "&#0;" decodes to a NUL byte, which PostgreSQL rejects in text (22021) —
    // exactly the class of single-row failure that used to abort the whole pass
    const body = xml(item(1, 'Fri, 04 Sep 2026 14:00:00 BST') + item(2, 'Fri, 04 Sep 2026 14:05:00 BST', 'Broken &#0; title'));
    const fetchFn = async () => new Response(body, { status: 200 });
    const res = await pullRssFeeds(db, feed, fetchFn);
    expect(res.fetched).toBe(2);
    expect(res.inserted).toBe(1);
    const logRow = await db('api_pull_log').where({ provider: 'rss', endpoint: 'sky' }).orderBy('id', 'desc').first('status', 'error_detail');
    expect(logRow.status).toBe('ok');
    expect(logRow.error_detail).toBe('1 items skipped');
  });
});
