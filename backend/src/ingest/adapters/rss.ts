/**
 * RSS ingestion engine (engineupgradeplus.md C1 — fixes audit N1).
 *
 * NewsData's free tier is a hard 200-credit/day ceiling that starved every
 * volume feature during both audit passes. RSS is the keyless anchor that
 * ends the starvation: BBC/Sky/Guardian football feeds (live-probed
 * 87/20/66 items per fetch) at ZERO credits, flowing into the SAME
 * news_items store and downstream indexer as every other news source.
 *
 * Distinct pull mechanics: conditional GETs (ETag / Last-Modified persisted
 * in api_providers.config.rss_state) so a quiet feed costs one 304; XML is
 * parsed with a dependency-free extractor (RSS 2.0 + CDATA + entities).
 * Deliberately NOT via fetchWithSnapshot: 304 semantics and multi-hundred-KB
 * XML don't fit the JSON snapshot store — pulls are logged via logPull and
 * the items themselves ARE the persisted record.
 */
import type { Knex } from 'knex';
import { logPull, parseFeedDate, type FetchFn } from '../http.js';
import { normaliseName, trigramSimilarity } from '../../players/resolver.js';
import { canonicalUrl } from './newsdata.js';
import { log } from '../../core/logger.js';

export interface RssFeed {
  id: string;
  url: string;
  tier: number; // source tier for the corroboration gates (1 = BBC/Sky)
}

export interface RssFeedsConfig {
  feeds: RssFeed[];
  max_items_per_feed: number;
}

/** ⚙ default feed registry (data — admins edit the model_config row). */
export const DEFAULT_RSS_FEEDS: RssFeedsConfig = {
  feeds: [
    { id: 'bbc', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', tier: 1 },
    // 11661 = Sky Sports Premier League. 12040 (shipped ≤1.4.5) is Sky's
    // all-sport headline feed — F1, tennis, rugby landed in the Newsroom.
    { id: 'sky', url: 'https://www.skysports.com/rss/11661', tier: 1 },
    { id: 'guardian', url: 'https://www.theguardian.com/football/rss', tier: 2 },
  ],
  max_items_per_feed: 100,
};

/** Feed URLs we shipped as defaults and later found wrong → their replacement. */
const KNOWN_FEED_REPAIRS: Record<string, string> = {
  'https://www.skysports.com/rss/12040': 'https://www.skysports.com/rss/11661',
};

/**
 * Boot-time repair of a default WE shipped: an install whose ⚙ rss_feeds row
 * still points at a known-wrong URL gets that one entry rewritten. Admin
 * customisations (other feeds, tiers, limits) are untouched; returns the
 * number of entries repaired. Idempotent.
 */
export async function repairKnownFeedDefaults(db: Knex): Promise<{ repaired: number }> {
  const { getConfig, setConfig } = await import('../../core/model-config.js');
  const cfg = await getConfig<RssFeedsConfig>(db, 'rss_feeds').catch(() => null);
  if (!cfg || !Array.isArray(cfg.feeds)) return { repaired: 0 };
  let repaired = 0;
  const feeds = cfg.feeds.map((f) => {
    const fixed = KNOWN_FEED_REPAIRS[f.url];
    if (!fixed) return f;
    repaired++;
    return { ...f, url: fixed };
  });
  if (repaired > 0) {
    await setConfig(db, 'rss_feeds', { ...cfg, feeds });
    log.info({ repaired }, 'rss feed defaults repaired');
  }
  return { repaired };
}

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  guid: string | null;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const stripCdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function tagText(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeEntities(stripCdata(m[1]!)).trim() : null;
}

/** Dependency-free RSS 2.0 item extractor (BBC/Sky/Guardian verified). */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]!;
    const title = tagText(block, 'title');
    const link = tagText(block, 'link');
    if (!title || !link) continue;
    items.push({
      title: stripTags(title),
      link,
      description: stripTags(tagText(block, 'description') ?? ''),
      pubDate: tagText(block, 'pubDate') ?? tagText(block, 'dc:date'),
      guid: tagText(block, 'guid'),
    });
  }
  return items;
}

interface FeedState {
  etag?: string;
  last_modified?: string;
}

async function loadFeedStates(db: Knex): Promise<Record<string, FeedState>> {
  const row = await db('api_providers').where('key', 'rss').first('config');
  return ((row?.config as { rss_state?: Record<string, FeedState> } | null)?.rss_state ?? {}) as Record<string, FeedState>;
}

async function saveFeedStates(db: Knex, states: Record<string, FeedState>): Promise<void> {
  await db.raw(`UPDATE api_providers SET config = config || ?::jsonb, updated_at = now() WHERE key = 'rss'`, [
    JSON.stringify({ rss_state: states }),
  ]);
}

export interface RssPullResult {
  feeds: number;
  notModified: number;
  fetched: number;
  inserted: number;
  bumped: number;
}

/** Pull every configured feed once; conditional GETs make quiet polls ~free. */
export async function pullRssFeeds(db: Knex, cfg: RssFeedsConfig, fetchFn?: FetchFn): Promise<RssPullResult> {
  const f = fetchFn ?? fetch;
  const states = await loadFeedStates(db);
  let notModified = 0;
  let fetched = 0;
  let inserted = 0;
  let bumped = 0;

  // one near-dup pool per pull (same overlap handling as the NewsData path)
  const recentTitles = (await db('news_items')
    .where('fetched_at', '>', new Date(Date.now() - 72 * 3600_000))
    .select('id', 'title', 'story_id')) as { id: number; title: string; story_id: number | null }[];
  const pool = recentTitles.map((r) => ({ ...r, norm: normaliseName(r.title) }));

  for (const feed of cfg.feeds) {
    const state = states[feed.id] ?? {};
    const headers: Record<string, string> = { 'user-agent': 'fpl-algorithm/1.4 rss-reader' };
    if (state.etag) headers['if-none-match'] = state.etag;
    if (state.last_modified) headers['if-modified-since'] = state.last_modified;
    let res: Response;
    try {
      res = await f(feed.url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : '';
      const detail = `${err instanceof Error ? err.message : String(err)}${cause}`;
      await logPull(db, { provider: 'rss', capability: 'news', endpoint: feed.id, status: 'failed', errorClass: 'NETWORK', errorDetail: detail });
      continue; // one dead feed never blocks the others
    }
    if (res.status === 304) {
      notModified++;
      await logPull(db, { provider: 'rss', capability: 'news', endpoint: feed.id, records: 0, status: 'ok' });
      continue;
    }
    if (!res.ok) {
      // the status is the diagnosis operators need in Admin → Logs ("HTTP 403"
      // from an egress filter reads very differently from a 500)
      await logPull(db, {
        provider: 'rss',
        capability: 'news',
        endpoint: feed.id,
        status: 'failed',
        errorClass: res.status === 429 ? 'RATE_LIMITED' : 'NETWORK',
        errorDetail: `HTTP ${res.status} ${res.statusText}`.trim(),
      });
      continue;
    }
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    states[feed.id] = { ...(etag ? { etag } : {}), ...(lastModified ? { last_modified: lastModified } : {}) };

    const xml = await res.text();
    const items = parseRss(xml).slice(0, cfg.max_items_per_feed);
    fetched += items.length;
    let feedErrors = 0;
    for (const item of items) {
      // one malformed item (an unparseable date, a 3-kB title) must never
      // kill the feed pass — v1.4.6 found Sky's "BST" pubDates doing exactly
      // that, which silently ended every scheduler news tick after the BBC
      try {
      const canonical = canonicalUrl(item.link);
      const domain = (() => {
        try {
          return new URL(item.link).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      const itemNorm = normaliseName(item.title);
      const near = pool.find((r) => trigramSimilarity(r.norm, itemNorm) >= 0.9);
      const [row] = await db('news_items')
        .insert({
          provider: 'rss',
          external_id: item.guid,
          url: item.link,
          url_canonical: canonical,
          title: item.title.slice(0, 500),
          description: item.description.slice(0, 2000),
          content: '',
          source_name: feed.id,
          source_domain: domain,
          source_tier: feed.tier,
          published_at: parseFeedDate(item.pubDate),
          story_id: near ? (near.story_id ?? near.id) : null,
          last_seen_at: db.fn.now(),
        })
        .onConflict('url_canonical')
        .ignore()
        .returning('id');
      if (!row) {
        await db('news_items')
          .where('url_canonical', canonical)
          .update({ seen_count: db.raw('seen_count + 1'), last_seen_at: db.fn.now() });
        bumped++;
        continue;
      }
      inserted++;
      pool.push({ id: Number(row.id ?? row), title: item.title, story_id: near ? (near.story_id ?? near.id) : null, norm: itemNorm });
      } catch (err) {
        feedErrors++;
        if (feedErrors <= 3) log.warn({ feed: feed.id, link: item.link, err: String(err).slice(0, 200) }, 'rss item skipped');
      }
    }
    await logPull(db, { provider: 'rss', capability: 'news', endpoint: feed.id, records: items.length, status: 'ok', errorDetail: feedErrors ? `${feedErrors} items skipped` : undefined });
  }

  await saveFeedStates(db, states);
  return { feeds: cfg.feeds.length, notModified, fetched, inserted, bumped };
}
