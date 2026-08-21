/**
 * NewsData.io adapter (integration plan §2.5) — the default news provider.
 * Articles are UNTRUSTED CONTENT: AI input only.
 *
 * v1.4.0 storage-engine rules: overlapping coverage is HANDLED, not dropped —
 * an exact URL repeat bumps the stored item's seen_count/last_seen_at; a
 * near-duplicate title still inserts and is clustered into the same story by
 * the news indexer. Entity linking moved to the indexer (one systematic
 * pass, retroactive re-scans). Free-tier throughput is respected with an
 * explicit per-sweep credit budget and nextPage pagination.
 */
import { z } from 'zod';
import type { Knex } from 'knex';
import { config } from '../../core/config.js';
import { fetchWithSnapshot, logPull, type FetchFn } from '../http.js';
import { PullError } from '../errors.js';
import { normaliseName, trigramSimilarity } from '../../players/resolver.js';

const NewsItemSchema = z
  .object({
    article_id: z.string().optional(),
    title: z.string(),
    link: z.string(),
    description: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    pubDate: z.string().nullable().optional(),
    source_id: z.string().nullable().optional(),
    source_url: z.string().nullable().optional(),
  })
  .passthrough();

const NewsResponseSchema = z
  .object({
    status: z.string(),
    totalResults: z.number().optional(),
    results: z.array(NewsItemSchema).nullable().optional(),
    nextPage: z.string().nullable().optional(),
  })
  .passthrough();

const TIER1_DOMAINS = ['bbc.co.uk', 'bbc.com', 'skysports.com', 'theathletic.com', 'premierleague.com'];
const TIER2_DOMAINS = ['theguardian.com', 'telegraph.co.uk', 'independent.co.uk', 'football.london', 'standard.co.uk'];

function sourceTier(domain: string): number {
  if (TIER1_DOMAINS.some((d) => domain.endsWith(d))) return 1;
  if (TIER2_DOMAINS.some((d) => domain.endsWith(d))) return 2;
  return 3;
}

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Team-news pack: availability terms (free tier caps query ~100 chars). */
export function clubQueryPack(clubName: string): string {
  return `"${clubName}" AND (injury OR "ruled out" OR lineup OR "press conference")`;
}

/** Broad pack: everything about the club — feeds the human-factors signals
 * (transfers, discipline, contracts, managerial churn) the narrow pack
 * filters out. */
export function clubBroadPack(clubName: string): string {
  return `"${clubName}"`;
}

export interface NewsPullConfig {
  poll_clubs: number; // clubs per background poll
  run_pages_per_club: number; // nextPage depth on a full Run sweep
  poll_pages_per_club: number;
  credit_budget_run: number; // max requests per Run sweep
  credit_budget_poll: number; // max requests per background poll
}

export const DEFAULT_NEWS_PULL: NewsPullConfig = {
  poll_clubs: 5,
  run_pages_per_club: 2,
  poll_pages_per_club: 1,
  credit_budget_run: 45,
  credit_budget_poll: 6,
};

export async function pullNews(
  db: Knex,
  opts: { clubs?: string[]; maxClubs?: number; fetchFn?: FetchFn; pull?: Partial<NewsPullConfig>; sweep?: boolean } = {},
): Promise<{ fetched: number; inserted: number; bumped: number; requests: number }> {
  const apiKey = config.keys.newsdata;
  if (!apiKey) throw new PullError('AUTH', 'NEWSDATA_KEY not configured');
  const cfg: NewsPullConfig = { ...DEFAULT_NEWS_PULL, ...(opts.pull ?? {}) };
  const sweep = opts.sweep ?? false;
  const pagesPerQuery = sweep ? cfg.run_pages_per_club : cfg.poll_pages_per_club;
  const budget = sweep ? cfg.credit_budget_run : cfg.credit_budget_poll;

  const teams = await db('teams').whereNotNull('fpl_id').select('uid', 'name', 'short_name');
  const clubs = opts.clubs ?? teams.map((t) => t.name);
  // A Run sweeps every club; background polls take a small rotating window
  // (the offset walks forward by the number of pulls already logged).
  const maxClubs = opts.maxClubs ?? (sweep ? clubs.length : cfg.poll_clubs);
  const countRows = (await db('api_pull_log').where({ provider: 'newsdata' }).count('* as c')) as { c: string }[];
  const pullCount = Number(countRows[0]?.c ?? 0);
  let chosen = clubs;
  if (clubs.length > maxClubs) {
    const offset = (pullCount * maxClubs) % clubs.length;
    chosen = [...clubs.slice(offset), ...clubs.slice(0, offset)].slice(0, maxClubs);
  }
  // alternate packs so both team-news AND human-factor stories flow in:
  // even pull-log parity → availability pack, odd → broad pack
  const broadPass = pullCount % 2 === 1;

  let fetched = 0;
  let inserted = 0;
  let bumped = 0;
  let requests = 0;

  // one dedup-pool load per pull, not one per article
  const recentTitles = (await db('news_items')
    .where('fetched_at', '>', new Date(Date.now() - 72 * 3600_000))
    .select('id', 'title', 'story_id')) as { id: number; title: string; story_id: number | null }[];
  const pool = recentTitles.map((r) => ({ ...r, norm: normaliseName(r.title) }));

  outer: for (const club of chosen) {
    const q = (broadPass ? clubBroadPack(club) : clubQueryPack(club)).slice(0, 100);
    let pageToken: string | null = null;
    for (let page = 0; page < pagesPerQuery; page++) {
      if (requests >= budget) break outer;
      const pageParam = pageToken ? `&page=${encodeURIComponent(pageToken)}` : '';
      const url = `https://newsdata.io/api/1/latest?apikey=${apiKey}&q=${encodeURIComponent(q)}&language=en&category=sports${pageParam}`;
      let snap;
      try {
        snap = await fetchWithSnapshot(db, {
          provider: 'newsdata',
          endpoint: 'latest',
          url,
          paramsHash: `${normaliseName(club)}:${broadPass ? 'b' : 'a'}:${page}`,
        });
        requests++;
      } catch (err) {
        if (err instanceof PullError && err.errorClass === 'RATE_LIMITED') break outer; // resume next slot
        throw err;
      }
      const parsed = NewsResponseSchema.safeParse(snap.body);
      if (!parsed.success || parsed.data.status !== 'success') {
        await logPull(db, { provider: 'newsdata', capability: 'news', endpoint: 'latest', status: 'failed', errorClass: 'SCHEMA_DRIFT' });
        break;
      }
      const results = parsed.data.results ?? [];
      fetched += results.length;
      for (const item of results) {
        const canonical = canonicalUrl(item.link);
        const domain = (() => {
          try {
            return new URL(item.source_url ?? item.link).hostname.replace(/^www\./, '');
          } catch {
            return '';
          }
        })();
        // overlap handling: same story from another source clusters via the
        // indexer — record the adoptive story id at insert when we can see it
        const itemNorm = normaliseName(item.title);
        const near = pool.find((r) => trigramSimilarity(r.norm, itemNorm) >= 0.9);
        const [row] = await db('news_items')
          .insert({
            provider: 'newsdata',
            external_id: item.article_id ?? null,
            url: item.link,
            url_canonical: canonical,
            title: item.title.slice(0, 500),
            description: (item.description ?? '').slice(0, 2000),
            content: (item.content ?? '').slice(0, 8000),
            source_name: item.source_id ?? '',
            source_domain: domain,
            source_tier: sourceTier(domain),
            published_at: item.pubDate ? new Date(item.pubDate) : null,
            story_id: near ? (near.story_id ?? near.id) : null,
            last_seen_at: db.fn.now(),
          })
          .onConflict('url_canonical')
          .ignore()
          .returning('id');
        if (!row) {
          // exact URL repeat: corroboration, not garbage — bump the record
          await db('news_items')
            .where('url_canonical', canonical)
            .update({ seen_count: db.raw('seen_count + 1'), last_seen_at: db.fn.now() });
          bumped++;
          continue;
        }
        inserted++;
        const newId = Number(row.id ?? row);
        pool.push({ id: newId, title: item.title, story_id: near ? (near.story_id ?? near.id) : null, norm: itemNorm });
      }
      await logPull(db, {
        provider: 'newsdata',
        capability: 'news',
        endpoint: 'latest',
        records: results.length,
        latencyMs: snap.latencyMs,
        status: 'ok',
      });
      pageToken = parsed.data.nextPage ?? null;
      if (!pageToken || results.length === 0) break;
    }
  }
  return { fetched, inserted, bumped, requests };
}
