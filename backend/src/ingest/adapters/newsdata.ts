/**
 * NewsData.io adapter (integration plan §2.5) — the default news provider.
 * Articles are UNTRUSTED CONTENT: AI input only. Dedup by canonical URL +
 * title trigram similarity; entity linking via the alias table with
 * club-context disambiguation — a surname alone never links without club
 * co-mention.
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

/** Per-club query packs, short (free tier caps query length ~100 chars). */
export function clubQueryPack(clubName: string): string {
  return `"${clubName}" AND (injury OR "ruled out" OR lineup OR "press conference")`;
}

export async function pullNews(
  db: Knex,
  opts: { clubs?: string[]; fetchFn?: FetchFn } = {},
): Promise<{ fetched: number; inserted: number; mapped: number }> {
  const apiKey = config.keys.newsdata;
  if (!apiKey) throw new PullError('AUTH', 'NEWSDATA_KEY not configured');

  const teams = await db('teams').whereNotNull('fpl_id').select('uid', 'name', 'short_name');
  const clubs = opts.clubs ?? teams.map((t) => t.name);
  // rotate clubs across pulls: pick the 5 least-recently pulled (tracked via pull log)
  const chosen = clubs.slice(0, 5);

  let fetched = 0;
  let inserted = 0;
  let mapped = 0;

  for (const club of chosen) {
    const q = clubQueryPack(club).slice(0, 100);
    const url = `https://newsdata.io/api/1/latest?apikey=${apiKey}&q=${encodeURIComponent(q)}&language=en&category=sports`;
    let snap;
    try {
      snap = await fetchWithSnapshot(db, { provider: 'newsdata', endpoint: 'latest', url, paramsHash: normaliseName(club) });
    } catch (err) {
      if (err instanceof PullError && err.errorClass === 'RATE_LIMITED') break; // stop the sweep, resume next slot
      throw err;
    }
    const parsed = NewsResponseSchema.safeParse(snap.body);
    if (!parsed.success || parsed.data.status !== 'success') {
      await logPull(db, { provider: 'newsdata', capability: 'news', endpoint: 'latest', status: 'failed', errorClass: 'SCHEMA_DRIFT' });
      continue;
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
      // near-duplicate: same canonical URL or ≥0.9 title similarity within 72 h
      const recentTitles = await db('news_items')
        .where('fetched_at', '>', new Date(Date.now() - 72 * 3600_000))
        .select('id', 'title');
      const isDup = recentTitles.some((r) => trigramSimilarity(normaliseName(r.title), normaliseName(item.title)) >= 0.9);
      if (isDup) continue;
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
        })
        .onConflict('url_canonical')
        .ignore()
        .returning('id');
      if (!row) continue;
      inserted++;
      mapped += await linkNewsToPlayers(db, Number(row.id ?? row), `${item.title}. ${item.description ?? ''}`);
    }
    await logPull(db, { provider: 'newsdata', capability: 'news', endpoint: 'latest', records: results.length, latencyMs: snap.latencyMs, status: 'ok' });
  }
  return { fetched, inserted, mapped };
}

/**
 * Entity linking: alias exact hits; a mononym/surname alias links only when
 * the player's club is co-mentioned in the text (club-context rule).
 */
export async function linkNewsToPlayers(db: Knex, newsId: number, text: string): Promise<number> {
  const norm = ` ${normaliseName(text)} `;
  const aliases = await db('player_aliases as a')
    .join('players as p', 'p.uid', 'a.player_uid')
    .leftJoin('teams as t', 't.uid', 'p.team_uid')
    .whereNotNull('p.team_uid')
    .select('a.alias', 'a.player_uid', 't.name as team_name', 't.short_name');
  let mapped = 0;
  const seen = new Set<string>();
  for (const a of aliases) {
    if (seen.has(a.player_uid)) continue;
    const alias = a.alias as string;
    if (alias.length < 4) continue; // too short to trust at all
    if (!norm.includes(` ${alias} `)) continue;
    const isMononym = !alias.includes(' ');
    const clubMentioned =
      a.team_name != null && normaliseName(text).includes(normaliseName(a.team_name).split(' ')[0] ?? '~');
    if (isMononym && !clubMentioned) continue;
    await db('news_player_map')
      .insert({
        news_id: newsId,
        player_uid: a.player_uid,
        match_kind: isMononym ? 'club_context' : 'alias_exact',
        confidence: isMononym ? 0.8 : 0.95,
      })
      .onConflict(['news_id', 'player_uid'])
      .ignore();
    seen.add(a.player_uid);
    mapped++;
  }
  return mapped;
}
