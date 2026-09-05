/**
 * News indexer (v1.4.0, corrected v1.4.3 + v1.4.6) — the systematic pass the
 * pull-time linking never was. Runs statistically (no AI) after every news
 * pull:
 *
 *  1. RE-LINK: every unindexed item — plus a rolling re-scan window so
 *     alias-table improvements retroactively link older articles — is
 *     entity-linked in ONE pass over an in-memory alias table. Links for a
 *     scanned item are REPLACED, so a corrected alias table also removes
 *     yesterday's false positives.
 *  2. CLASSIFY: keyword signal categories stored on the item (signals jsonb).
 *  3. CLUSTER: near-duplicate titles (and entity+category corroboration)
 *     within the overlap window collapse into stories.
 *
 * v1.4.6 matching rules (the "Bruno Fernandes has zero news" fix):
 *  - aliases are order-preserving phrases (players/aliases.ts) and are
 *    matched LONGEST FIRST; a matched phrase is masked out of the text so a
 *    shorter alias can never fire inside it ("Myles Lewis-Skelly" no longer
 *    links Rico Lewis; "Gabriel Martinelli" no longer links Gabriel).
 *  - a mononym (single token) needs its club named in the text as a WHOLE
 *    WORD from the club's press names ("Man Utd", "Manchester United") — the
 *    old `includes('man')` matched "manager" and "Germany".
 *  - a mononym shared by two players at the SAME club is ambiguous and never
 *    links on its own (their multi-word aliases still do).
 *  - a mononym must appear as a NAME: Capitalised, and not immediately
 *    preceded by another capitalised non-club word ("Woolsington Hall" is an
 *    estate, not Lewis Hall; "dining hall" is not either). A mononym that is
 *    also a GIVEN name in the league ("Bradley", "Gabriel", "Enzo") must also
 *    not be followed by one — "Bradley Barcola", "Enzo Maresca" — since that
 *    person may not be in the players table at all (live findings, v1.4.6).
 *    ALL-CAPS neighbours (ESPN, BBC, FC) never count; in a Title Case headline
 *    capitalisation is uninformative, so a plain surname links and a
 *    given-name-like one waits for the sentence-case description.
 *  - ⚙ news_indexer.masked_phrases: admin-editable phrases blanked before
 *    matching (a manager or pundit whose name collides with a player's).
 */
import type { Knex } from 'knex';
import { normaliseName, normaliseText, trigramSimilarity } from '../players/resolver.js';
import { getConfig } from '../core/model-config.js';
import { classifySignals } from './signals.js';

export interface IndexResult {
  scanned: number;
  linked: number;
  playersLinked: number;
  storiesAssigned: number;
  signalsFound: number;
  full: boolean;
}

export interface NewsIndexerConfig {
  rescan_days: number; // alias improvements re-link this far back
  cluster_days: number; // near-dup titles this far apart still one story
  cluster_sim: number;
  masked_phrases: string[]; // blanked before matching (name collisions)
}

export const DEFAULT_NEWS_INDEXER: NewsIndexerConfig = {
  rescan_days: 7,
  cluster_days: 7,
  cluster_sim: 0.85,
  masked_phrases: [],
};

/** FPL team name (normalised) → what the press calls the club. Generic
 *  words shared across clubs ("united", "city") are deliberately absent. */
const CLUB_PRESS_NAMES: Record<string, string[]> = {
  'man city': ['man city', 'manchester city'],
  'man utd': ['man utd', 'man united', 'manchester united'],
  spurs: ['spurs', 'tottenham', 'tottenham hotspur'],
  'nottm forest': ['nottingham forest', 'nottm forest', 'forest'],
  wolves: ['wolves', 'wolverhampton', 'wolverhampton wanderers'],
  'west ham': ['west ham', 'west ham united', 'hammers'],
  newcastle: ['newcastle', 'newcastle united', 'magpies'],
  brighton: ['brighton', 'brighton and hove albion', 'brighton hove albion', 'seagulls'],
  bournemouth: ['bournemouth', 'afc bournemouth', 'cherries'],
  leeds: ['leeds', 'leeds united'],
  arsenal: ['arsenal', 'gunners'],
  liverpool: ['liverpool', 'anfield'],
  chelsea: ['chelsea', 'stamford bridge'],
  everton: ['everton', 'toffees'],
  'aston villa': ['aston villa', 'villa', 'villans'],
  'crystal palace': ['crystal palace', 'palace', 'selhurst'],
  fulham: ['fulham', 'craven cottage'],
  brentford: ['brentford', 'bees'],
  burnley: ['burnley', 'clarets'],
  sunderland: ['sunderland', 'black cats'],
  leicester: ['leicester', 'leicester city', 'foxes'],
  ipswich: ['ipswich', 'ipswich town'],
  southampton: ['southampton', 'saints'],
  luton: ['luton', 'luton town'],
  'sheffield utd': ['sheffield united', 'sheffield utd', 'blades'],
};

// tokens that name a club TYPE, not a club — never usable as context alone
const GENERIC_CLUB_TOKENS = new Set(['fc', 'afc', 'united', 'utd', 'city', 'town', 'athletic', 'rovers', 'wanderers', 'hotspur', 'albion', 'county', 'west', 'east', 'north', 'south', 'real', 'sporting', 'club', 'the']);

export function clubTermsFor(teamName: string): string[] {
  const n = normaliseText(teamName);
  const tokens = n.split(' ').filter(Boolean);
  const terms = new Set<string>([n, ...(CLUB_PRESS_NAMES[n] ?? []), ...(CLUB_PRESS_NAMES[tokens[0] ?? ''] ?? [])]);
  // each distinctive token stands alone ("Newcastle" for Newcastle United,
  // "Villa" for Aston Villa) — generic type words never do
  for (const t of tokens) if (t.length >= 4 && !GENERIC_CLUB_TOKENS.has(t)) terms.add(t);
  return [...terms].filter((t) => t.length >= 4);
}

interface AliasRow {
  alias: string; // order-preserving normal form
  player_uid: string;
  team_uid: string;
  tokens: number;
}

const pad = (s: string): string => ` ${s} `;
/** Blank every whole-word occurrence of `phrase` inside padded `text`. */
function maskPhrase(text: string, phrase: string): string {
  const needle = pad(phrase);
  if (!text.includes(needle)) return text;
  return text.split(needle).join(' '.repeat(needle.length));
}

/** Diacritics folded the way normaliseText folds them, but case PRESERVED. */
function foldDiacritics(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/[æ]/g, 'ae')
    .replace(/[Æ]/g, 'Ae')
    .replace(/[ßẞ]/g, 'ss');
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `alias` (a surname mononym) occur in the case-preserved text as a
 * player's name on its own? An occurrence qualifies when
 *  - it is Capitalised — "Hall" the defender, never "dining hall", "Mount"
 *    never "mount a comeback", "Rice" never the food;
 *  - it is not immediately preceded (no punctuation between) by another
 *    capitalised word — "Woolsington Hall" is an estate, "Lewis Hall" would
 *    already have been masked as a longer alias — the club's own press names
 *    excepted ("Liverpool Isak", "City Haaland" after the possessive strip);
 *  - when `givenNameLike`, it is not immediately followed (optionally across a
 *    hyphen) by another capitalised word — "Bradley Barcola", "Enzo Maresca"
 *    — again with the club itself excepted ("Bradley Liverpool").
 * Any qualifying occurrence links, so a full name elsewhere never suppresses
 * a genuine bare mention; a Title Case headline is usually rescued by its
 * sentence-case description.
 */
export interface StandsAloneOpts {
  givenNameLike?: boolean;
  /** index in `plain` where the headline ends and the description begins */
  titleEnd?: number;
  /** the headline is Title Case — capitalisation carries no information there */
  titleCase?: boolean;
}

// function words Title Case conventionally leaves lowercase — not evidence either way
const TITLE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'by', 'with', 'from', 'as', 'vs', 'v', 'into', 'over', 'after', 'amid', 'is', 'are', 'be']);

/** ≥75 % of the content words capitalised → a Title Case headline. */
export function isTitleCase(s: string): boolean {
  const words = s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((w) => w.length >= 2 && /^\p{L}+$/u.test(w) && !TITLE_STOPWORDS.has(w.toLowerCase()));
  if (words.length < 3) return false;
  return words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length >= 0.75;
}

export function standsAlone(plain: string, alias: string, clubTerms: string[], opts: StandsAloneOpts = {}): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(alias)}(?![\\p{L}\\p{N}])`, 'giu');
  const titleEnd = opts.titleEnd ?? 0;
  const isClubWord = (word: string): boolean => {
    const w = normaliseText(word);
    return w.length > 0 && clubTerms.some((t) => t === w || t.startsWith(`${w} `) || t.endsWith(` ${w}`));
  };
  // a neighbouring capitalised word reads as part of a longer name — unless it
  // is the club itself or an ALL-CAPS token (ESPN, BBC, FC: aggregated NewsData
  // descriptions glue source names straight onto headlines)
  const nameLike = (word: string): boolean => !isClubWord(word) && !/^[\p{Lu}\p{N}'’\-–]{2,}$/u.test(word);
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    if (!/^\p{Lu}/u.test(m[0]!)) continue; // lowercase → a word, not a name
    const inTitleCase = opts.titleCase === true && m.index < titleEnd;
    if (!inTitleCase) {
      // in a Title Case headline every word is capitalised, so the word BEFORE
      // carries no information — only sentence-case text can fail this check
      const before = plain.slice(0, m.index);
      const prev = /(\p{Lu}[\p{L}\p{N}'’\-–]*)[\s\-–—]+$/u.exec(before);
      if (prev && nameLike(prev[1]!)) continue; // "Woolsington Hall"
    }
    if (opts.givenNameLike) {
      // "Bradley Barcola" / "Bradley Set For Return" are indistinguishable in
      // Title Case, so a following capitalised word always defers to the
      // description; "Bradley," / "Bradley starts" stand alone in any case
      const rest = plain.slice(m.index + m[0].length);
      const next = /^[\s\-–—]+(\p{Lu}[\p{L}\p{N}'’\-–]*)/u.exec(rest);
      if (next && nameLike(next[1]!)) continue;
    }
    return true;
  }
  return false;
}

export async function indexNews(db: Knex, opts: { full?: boolean } = {}): Promise<IndexResult> {
  const cfg = { ...DEFAULT_NEWS_INDEXER, ...((await getConfig<Partial<NewsIndexerConfig>>(db, 'news_indexer').catch(() => null)) ?? {}) };
  const full = opts.full === true;
  const rescanCutoff = new Date(Date.now() - cfg.rescan_days * 86_400_000);
  const itemsQuery = db('news_items').select('id', 'title', 'description', 'source_tier', 'fetched_at', 'story_id', 'signals').orderBy('id', 'asc');
  const items = (full
    ? await itemsQuery
    : await itemsQuery.where((q) => q.whereNull('indexed_at').orWhere('fetched_at', '>', rescanCutoff))) as {
    id: number;
    title: string;
    description: string | null;
    source_tier: number;
    fetched_at: Date;
    story_id: number | null;
    signals: unknown;
  }[];
  if (items.length === 0) return { scanned: 0, linked: 0, playersLinked: 0, storiesAssigned: 0, signalsFound: 0, full };

  // one alias load for the whole pass
  const rawAliases = (await db('player_aliases as a')
    .join('players as p', 'p.uid', 'a.player_uid')
    .join('teams as t', 't.uid', 'p.team_uid')
    .whereNotNull('p.team_uid')
    .select('a.alias', 'a.player_uid', 'p.team_uid', 't.name as team_name')) as { alias: string; player_uid: string; team_uid: string; team_name: string }[];
  const clubTerms = new Map<string, string[]>();
  for (const r of rawAliases) if (!clubTerms.has(r.team_uid)) clubTerms.set(r.team_uid, clubTermsFor(r.team_name));

  // owners per alias → same-club mononym ambiguity
  const owners = new Map<string, Set<string>>();
  const teamOf = new Map<string, string>();
  const normalised: AliasRow[] = [];
  for (const r of rawAliases) {
    const alias = normaliseText(r.alias);
    if (alias.length < 3) continue;
    teamOf.set(r.player_uid, r.team_uid);
    (owners.get(alias) ?? owners.set(alias, new Set()).get(alias)!).add(r.player_uid);
    normalised.push({ alias, player_uid: r.player_uid, team_uid: r.team_uid, tokens: alias.split(' ').length });
  }
  const ambiguousMononym = (row: AliasRow): boolean => {
    if (row.tokens > 1) return false;
    const set = owners.get(row.alias)!;
    if (set.size < 2) return false;
    for (const other of set) if (other !== row.player_uid && teamOf.get(other) === row.team_uid) return true;
    return false;
  };
  // longest match first: more tokens, then longer string
  const aliases = normalised
    .filter((row) => !ambiguousMononym(row))
    .sort((a, b) => b.tokens - a.tokens || b.alias.length - a.alias.length);
  const maskedPhrases = cfg.masked_phrases.map((p) => normaliseText(p)).filter((p) => p.length >= 3);

  // a mononym that is ALSO a given name somewhere in the league ("Bradley",
  // "Gabriel", "Enzo", "Lewis") is trusted only where it stands alone: an
  // occurrence immediately followed by another capitalised word is somebody's
  // FIRST name ("Bradley Barcola", "Enzo Maresca") — even when that somebody
  // is not (yet) in the players table, so longest-match masking cannot help
  const givenNames = new Set<string>();
  const firstNames = (await db('players').whereNotNull('team_uid').select('first_name')) as { first_name: string | null }[];
  for (const r of firstNames) for (const t of normaliseText(r.first_name ?? '').split(' ')) if (t.length >= 3) givenNames.add(t);

  let linked = 0;
  const playersSeen = new Set<string>();
  let storiesAssigned = 0;
  let signalsFound = 0;

  // recent titles for clustering (indexed items included — cluster roots)
  const clusterCutoff = new Date(Date.now() - cfg.cluster_days * 86_400_000);
  const clusterPool = (await db('news_items')
    .where('fetched_at', '>', clusterCutoff)
    .select('id', 'title', 'story_id', 'signals')) as { id: number; title: string; story_id: number | null; signals: unknown }[];
  const poolNorm = clusterPool.map((p) => ({ ...p, norm: normaliseName(p.title) }));
  // entity+category corroboration (v1.4.3): the same story under a different
  // headline clusters when items share a linked player AND a signal category
  const poolSignals = new Map<number, Set<string>>(
    clusterPool.map((p) => [p.id, new Set(Array.isArray(p.signals) ? (p.signals as string[]) : [])]),
  );
  const poolPlayers = new Map<number, Set<string>>();
  if (clusterPool.length > 0) {
    const links = (await db('news_player_map')
      .whereIn('news_id', clusterPool.map((p) => p.id))
      .select('news_id', 'player_uid')) as { news_id: number; player_uid: string }[];
    for (const l of links) (poolPlayers.get(l.news_id) ?? poolPlayers.set(l.news_id, new Set()).get(l.news_id)!).add(l.player_uid);
  }
  const intersects = (a: Set<string> | undefined, b: Set<string> | undefined): boolean => {
    if (!a || !b || a.size === 0 || b.size === 0) return false;
    for (const x of a) if (b.has(x)) return true;
    return false;
  };

  for (const item of items) {
    const text = `${item.title}. ${item.description ?? ''}`;
    // possessives stripped BEFORE normalising ("Haaland's brace" → haaland)
    const depossessed = text.replace(/(['’])s\b/g, '');
    const norm = pad(normaliseText(depossessed));
    const plain = foldDiacritics(depossessed); // case preserved, for the name-shape checks
    const titlePlain = foldDiacritics(item.title.replace(/(['’])s\b/g, ''));
    const shape: StandsAloneOpts = { titleEnd: titlePlain.length, titleCase: isTitleCase(titlePlain) };
    let masked = norm;
    for (const phrase of maskedPhrases) masked = maskPhrase(masked, phrase);

    // 1. entity linking — longest alias first, consuming the matched span
    const linkRows: { news_id: number; player_uid: string; match_kind: string; confidence: number }[] = [];
    const seen = new Set<string>();
    for (const a of aliases) {
      if (seen.has(a.player_uid)) continue;
      if (!masked.includes(pad(a.alias))) continue;
      const isMononym = a.tokens === 1;
      if (isMononym) {
        const terms = clubTerms.get(a.team_uid) ?? [];
        if (!terms.some((t) => norm.includes(pad(t)))) continue; // club must be named as a whole word
        if (!standsAlone(plain, a.alias, terms, { ...shape, givenNameLike: givenNames.has(a.alias) })) continue; // "Woolsington Hall", "Bradley Barcola"
      }
      seen.add(a.player_uid);
      masked = maskPhrase(masked, a.alias);
      linkRows.push({
        news_id: item.id,
        player_uid: a.player_uid,
        match_kind: isMononym ? 'club_context' : 'alias_exact',
        confidence: isMononym ? 0.8 : 0.95,
      });
    }
    // links are DERIVED — replace, so alias corrections also remove old false positives
    await db('news_player_map').where('news_id', item.id).del();
    if (linkRows.length > 0) {
      await db('news_player_map').insert(linkRows).onConflict(['news_id', 'player_uid']).ignore();
      linked += linkRows.length;
      for (const r of linkRows) playersSeen.add(r.player_uid);
    }

    // 2. signal classification
    const signals = classifySignals(text);
    if (signals.length > 0) signalsFound++;

    const itemPlayers = new Set(seen);
    poolPlayers.set(item.id, itemPlayers);
    const itemSignals = new Set<string>(signals);
    poolSignals.set(item.id, itemSignals);

    // 3. story clustering (unchanged): adopt the earliest similar title's
    //    story; entity+category overlap corroborates a different headline
    let storyId = item.story_id;
    if (storyId == null) {
      const itemNorm = normaliseName(item.title);
      for (const other of poolNorm) {
        if (other.id >= item.id) continue;
        if (trigramSimilarity(other.norm, itemNorm) >= cfg.cluster_sim) {
          storyId = other.story_id ?? other.id;
          break;
        }
      }
      if (storyId == null && (itemPlayers.size > 0 || itemSignals.size > 0)) {
        for (const other of poolNorm) {
          if (other.id >= item.id) continue;
          if (intersects(poolPlayers.get(other.id), itemPlayers) && intersects(poolSignals.get(other.id), itemSignals)) {
            storyId = other.story_id ?? other.id;
            break;
          }
        }
      }
      if (storyId == null) storyId = item.id;
      else storiesAssigned++;
      const pooled = poolNorm.find((p) => p.id === item.id);
      if (pooled) pooled.story_id = storyId;
    }

    await db('news_items')
      .where('id', item.id)
      .update({ story_id: storyId, signals: JSON.stringify(signals), indexed_at: db.fn.now() });
  }

  return { scanned: items.length, linked, playersLinked: playersSeen.size, storiesAssigned, signalsFound, full };
}

/**
 * v1.4.6 boot hook: when alias generation has changed since this DB was last
 * indexed, re-seed every player's aliases and re-index EVERY article once
 * (retroactive correction for installs upgraded from ≤ 1.4.5). Statistical,
 * idempotent, runs in the background after listen.
 */
export async function ensureNewsIndexVersion(db: Knex): Promise<{ reindexed: boolean; aliasVersion: number }> {
  const { ALIAS_VERSION, reseedAliases } = await import('../players/aliases.js');
  const { setConfig } = await import('../core/model-config.js');
  const state = (await getConfig<{ alias_version?: number }>(db, 'news_index_state').catch(() => null)) ?? { alias_version: 0 };
  if ((state.alias_version ?? 0) >= ALIAS_VERSION) return { reindexed: false, aliasVersion: ALIAS_VERSION };
  await reseedAliases(db);
  const r = await indexNews(db, { full: true });
  await setConfig(db, 'news_index_state', { ...state, alias_version: ALIAS_VERSION, reindexed_at: new Date().toISOString(), last_full: r });
  return { reindexed: true, aliasVersion: ALIAS_VERSION };
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
