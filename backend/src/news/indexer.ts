/**
 * News indexer (v1.4.0) — the systematic pass the pull-time linking never
 * was. Runs statistically (no AI) after every news pull:
 *
 *  1. RE-LINK: every unindexed item — plus a rolling re-scan window so
 *     alias-table improvements retroactively link older articles — is
 *     entity-linked in ONE pass over an in-memory alias table.
 *  2. CLASSIFY: keyword signal categories stored on the item (signals jsonb).
 *  3. CLUSTER: near-duplicate titles within the overlap window collapse
 *     into stories (story_id = the root item's id). Overlapping coverage
 *     from many sources is thereby HANDLED — it corroborates a story and
 *     bumps confidence — instead of being dropped or double-counted.
 */
import type { Knex } from 'knex';
import { normaliseName, normaliseText, trigramSimilarity } from '../players/resolver.js';
import { classifySignals } from './signals.js';

export interface IndexResult {
  scanned: number;
  linked: number;
  playersLinked: number;
  storiesAssigned: number;
  signalsFound: number;
}

const RESCAN_DAYS = 7; // alias improvements re-link this far back
const CLUSTER_DAYS = 7; // near-dup titles this far apart still one story
const CLUSTER_SIM = 0.85;

interface AliasRow {
  alias: string;
  player_uid: string;
  team_first: string; // first word of the club name, normalised ('' if none)
}

export async function indexNews(db: Knex): Promise<IndexResult> {
  const rescanCutoff = new Date(Date.now() - RESCAN_DAYS * 86_400_000);
  const items = (await db('news_items')
    .where((q) => q.whereNull('indexed_at').orWhere('fetched_at', '>', rescanCutoff))
    .select('id', 'title', 'description', 'source_tier', 'fetched_at', 'story_id', 'signals')
    .orderBy('id', 'asc')) as {
    id: number;
    title: string;
    description: string | null;
    source_tier: number;
    fetched_at: Date;
    story_id: number | null;
    signals: unknown;
  }[];
  if (items.length === 0) return { scanned: 0, linked: 0, playersLinked: 0, storiesAssigned: 0, signalsFound: 0 };

  // one alias load for the whole pass (pull-time code reloaded it per article)
  const aliases: AliasRow[] = (
    await db('player_aliases as a')
      .join('players as p', 'p.uid', 'a.player_uid')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .whereNotNull('p.team_uid')
      .select('a.alias', 'a.player_uid', 't.name as team_name')
  ).map((r) => ({
    // aliases match as PHRASES in running text — order-preserving normal form
    alias: normaliseText(r.alias as string),
    player_uid: r.player_uid as string,
    team_first: r.team_name ? (normaliseText(r.team_name).split(' ')[0] ?? '') : '',
  }));

  let linked = 0;
  const playersSeen = new Set<string>();
  let storiesAssigned = 0;
  let signalsFound = 0;

  // recent titles for clustering (indexed items included — cluster roots)
  const clusterCutoff = new Date(Date.now() - CLUSTER_DAYS * 86_400_000);
  const clusterPool = (await db('news_items')
    .where('fetched_at', '>', clusterCutoff)
    .select('id', 'title', 'story_id')) as { id: number; title: string; story_id: number | null }[];
  const poolNorm = clusterPool.map((p) => ({ ...p, norm: normaliseName(p.title) }));

  for (const item of items) {
    const text = `${item.title}. ${item.description ?? ''}`;
    const norm = ` ${normaliseText(text)} `;

    // 1. entity linking (alias exact; mononyms need the club co-mentioned)
    const linkRows: { news_id: number; player_uid: string; match_kind: string; confidence: number }[] = [];
    const seen = new Set<string>();
    for (const a of aliases) {
      if (seen.has(a.player_uid)) continue;
      if (a.alias.length < 4) continue;
      if (!norm.includes(` ${a.alias} `)) continue;
      const isMononym = !a.alias.includes(' ');
      if (isMononym && (a.team_first === '' || !norm.includes(a.team_first))) continue;
      seen.add(a.player_uid);
      linkRows.push({
        news_id: item.id,
        player_uid: a.player_uid,
        match_kind: isMononym ? 'club_context' : 'alias_exact',
        confidence: isMononym ? 0.8 : 0.95,
      });
    }
    if (linkRows.length > 0) {
      await db('news_player_map').insert(linkRows).onConflict(['news_id', 'player_uid']).ignore();
      linked += linkRows.length;
      for (const r of linkRows) playersSeen.add(r.player_uid);
    }

    // 2. signal classification
    const signals = classifySignals(text);
    if (signals.length > 0) signalsFound++;

    // 3. story clustering: adopt the earliest similar title's story
    let storyId = item.story_id;
    if (storyId == null) {
      const itemNorm = normaliseName(item.title);
      for (const other of poolNorm) {
        if (other.id >= item.id) continue; // only adopt from earlier items
        if (trigramSimilarity(other.norm, itemNorm) >= CLUSTER_SIM) {
          storyId = other.story_id ?? other.id;
          break;
        }
      }
      if (storyId == null) storyId = item.id; // self-rooted story
      else storiesAssigned++;
      const pooled = poolNorm.find((p) => p.id === item.id);
      if (pooled) pooled.story_id = storyId;
    }

    await db('news_items')
      .where('id', item.id)
      .update({ story_id: storyId, signals: JSON.stringify(signals), indexed_at: db.fn.now() });
  }

  return { scanned: items.length, linked, playersLinked: playersSeen.size, storiesAssigned, signalsFound };
}

/**
 * Active signal rows per player over the human-factors window — one row per
 * (player, item, category), with the item's source tier, for the engine's
 * corroboration + multiplier logic. Stories are collapsed: only the story
 * root's categories count once per story (overlap corroborates via count).
 */
export async function playerSignalRows(
  db: Knex,
  windowDays: number,
): Promise<Map<string, { category: string; tier: number }[]>> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  const rows = (await db('news_player_map as m')
    .join('news_items as n', 'n.id', 'm.news_id')
    .where('n.fetched_at', '>', cutoff)
    .whereRaw(`n.signals != '[]'::jsonb`)
    .select('m.player_uid', 'n.id', 'n.story_id', 'n.signals', 'n.source_tier')) as {
    player_uid: string;
    id: number;
    story_id: number | null;
    signals: unknown;
    source_tier: number;
  }[];

  const out = new Map<string, { category: string; tier: number }[]>();
  const storySeen = new Set<string>(); // player|story|category — one count per story
  for (const r of rows) {
    const cats = Array.isArray(r.signals) ? (r.signals as string[]) : [];
    for (const cat of cats) {
      const key = `${r.player_uid}|${r.story_id ?? r.id}|${cat}`;
      if (storySeen.has(key)) continue;
      storySeen.add(key);
      (out.get(r.player_uid) ?? out.set(r.player_uid, []).get(r.player_uid)!).push({ category: cat, tier: r.source_tier });
    }
  }
  return out;
}
