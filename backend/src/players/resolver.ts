import type { Knex } from 'knex';

/**
 * Entity resolution (fpl-engines-plan.md §3.2 + fpl-api-integration-plan.md §1.5).
 * Adapters emit provider-shaped staging rows; THIS is the only component that
 * touches player_identities. Nothing auto-merges below the deterministic tier.
 */

/** Unicode NFKD, strip diacritics, lowercase, drop punctuation, token-sort. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐ]/g, 'd')
    .replace(/[łŁ]/g, 'l')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[ßẞ]/g, 'ss')
    .toLowerCase()
    .replace(/['’ʼ`]/g, '') // apostrophes removed, identity kept (N'Golo → ngolo, O'Brien → obrien)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // remaining punctuation → space (Calvert-Lewin)
    .split(/\s+/)
    .filter(Boolean)
    .sort() // token order: Son Heung-min ↔ Heung-Min Son
    .join(' ');
}

/**
 * Order-PRESERVING text normalisation for substring/phrase matching (news
 * entity linking). normaliseName sorts tokens — right for canonical name
 * identity, fatal for "does this sentence contain this name": a multi-word
 * alias would only ever match when the name happened to be alphabetical.
 */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐ]/g, 'd')
    .replace(/[łŁ]/g, 'l')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[ßẞ]/g, 'ss')
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Trigram similarity between two normalised names (0..1). */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const padded = `  ${s} `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

export interface StagingIdentity {
  provider: string;
  providerId: string;
  name: string;
  teamUid?: string | null;
  position?: string | null; // GK|DEF|MID|FWD
  birthdate?: string | null; // ISO date
  shirt?: number | null;
  fplCode?: number | null; // cross-key when the provider exposes it
  payload?: Record<string, unknown>;
}

export type ResolveOutcome =
  | { kind: 'cached' | 'code' | 'exact' | 'seed'; playerUid: string }
  | { kind: 'queued'; queueId: number }
  | { kind: 'unmatched'; queueId: number }
  | { kind: 'ignored' };

const FUZZY_THRESHOLD = 0.88;
const TRANSFER_WINDOW_MONTHS = new Set([5, 6, 7, 0]); // Jun, Jul, Aug, Jan (0-indexed)

function positionCompatible(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  // providers frequently disagree on MID/FWD boundary
  const attacking = new Set(['MID', 'FWD']);
  return attacking.has(a) && attacking.has(b);
}

export async function resolveIdentity(db: Knex, row: StagingIdentity): Promise<ResolveOutcome> {
  // 1. cache hit — the 99% path
  const existing = await db('player_identities')
    .where({ provider: row.provider, provider_id: row.providerId })
    .whereNull('tombstoned_at')
    .first('player_uid');
  if (existing) return { kind: 'cached', playerUid: existing.player_uid };

  // Already parked / permanently ignored?
  const queued = await db('resolution_queue')
    .where({ provider: row.provider, provider_id: row.providerId })
    .first();
  if (queued?.status === 'ignored') return { kind: 'ignored' };

  // 2. cross-key: provider exposes an FPL code we hold
  if (row.fplCode != null) {
    const byCode = await db('players').where('fpl_code', row.fplCode).first('uid');
    if (byCode) {
      await insertIdentity(db, byCode.uid, row, 'code', 1.0);
      return { kind: 'code', playerUid: byCode.uid };
    }
  }

  // 3. deterministic tier: normalised name + secondary signals.
  const norm = normaliseName(row.name);
  const isMononym = norm.split(' ').length === 1;
  const inWindow = TRANSFER_WINDOW_MONTHS.has(new Date().getUTCMonth());

  // blocking: same team first, then league-wide
  const aliasHits = await db('player_aliases as a')
    .join('players as p', 'p.uid', 'a.player_uid')
    .where('a.alias', norm)
    .select('p.uid', 'p.team_uid', 'p.position', 'p.birthdate', 'p.shirt');

  const deterministic = aliasHits.filter((c) => {
    const teamMatch = row.teamUid != null && c.team_uid === row.teamUid;
    const birthMatch = row.birthdate != null && c.birthdate != null &&
      String(c.birthdate).slice(0, 10) === row.birthdate.slice(0, 10);
    const shirtMatch = row.shirt != null && c.shirt != null && c.shirt === row.shirt;
    const posOk = positionCompatible(row.position, c.position);
    if (isMononym) {
      // mononyms REQUIRE a secondary signal beyond team
      return teamMatch && posOk && (birthMatch || shirtMatch);
    }
    // full names: name+team+position, or name+birthdate anywhere
    return (teamMatch && posOk && (birthMatch || shirtMatch || row.birthdate == null)) ||
      (birthMatch && posOk);
  });

  const uniqueUids = [...new Set(deterministic.map((c) => c.uid))];
  if (uniqueUids.length === 1) {
    // during transfer windows a team mismatch downgrades to review — but here team matched or birthdate matched
    await insertIdentity(db, uniqueUids[0]!, row, 'exact_name', 0.98);
    return { kind: 'exact', playerUid: uniqueUids[0]! };
  }

  // 4. fuzzy tier — ranking only, ALWAYS queued for manual review
  const pool = row.teamUid && !inWindow
    ? await db('players').where('team_uid', row.teamUid).select('uid', 'web_name', 'full_name', 'team_uid', 'position')
    : await db('players').select('uid', 'web_name', 'full_name', 'team_uid', 'position');

  const candidates = pool
    .map((p) => {
      const sim = Math.max(
        trigramSimilarity(norm, normaliseName(p.full_name || p.web_name)),
        trigramSimilarity(norm, normaliseName(p.web_name)),
      );
      return { uid: p.uid, name: p.full_name || p.web_name, team_uid: p.team_uid, position: p.position, similarity: Number(sim.toFixed(3)) };
    })
    .filter((c) => c.similarity >= FUZZY_THRESHOLD - 0.15)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  const status = candidates.length > 0 && candidates[0]!.similarity >= FUZZY_THRESHOLD ? 'pending' : 'unmatched';
  const [idRow] = await db('resolution_queue')
    .insert({
      provider: row.provider,
      provider_id: row.providerId,
      payload: JSON.stringify({ name: row.name, teamUid: row.teamUid, position: row.position, birthdate: row.birthdate, shirt: row.shirt, ...row.payload }),
      candidates: JSON.stringify(candidates),
      status,
    })
    .onConflict(['provider', 'provider_id'])
    .merge(['payload', 'candidates'])
    .returning('id');
  const queueId = Number(idRow.id ?? idRow);
  return status === 'pending' ? { kind: 'queued', queueId } : { kind: 'unmatched', queueId };
}

async function insertIdentity(
  db: Knex,
  playerUid: string,
  row: StagingIdentity,
  matchedBy: 'code' | 'exact_name' | 'fuzzy' | 'manual' | 'seed',
  confidence: number,
): Promise<void> {
  await db.raw(
    `INSERT INTO player_identities (player_uid, provider, provider_id, provider_name, confidence, matched_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_id) DO NOTHING`,
    [playerUid, row.provider, row.providerId, row.name, confidence, matchedBy],
  );
  // alias learning: the provider's spelling never queues again
  await db.raw(
    `INSERT INTO player_aliases (player_uid, alias, source)
     VALUES (?, ?, ?)
     ON CONFLICT (player_uid, alias) DO NOTHING`,
    [playerUid, normaliseName(row.name), row.provider],
  );
}

/** Manual resolution from the admin review queue. */
export async function resolveManually(
  db: Knex,
  queueId: number,
  playerUid: string | null, // null → ignore permanently
  adminId: number,
): Promise<void> {
  const row = await db('resolution_queue').where('id', queueId).first();
  if (!row) throw new Error(`queue row ${queueId} not found`);
  if (playerUid) {
    const payload = row.payload ?? {};
    await insertIdentity(
      db,
      playerUid,
      { provider: row.provider, providerId: row.provider_id, name: payload.name ?? '' },
      'manual',
      1.0,
    );
    await db('resolution_queue').where('id', queueId).update({
      status: 'resolved',
      resolved_player_uid: playerUid,
      resolved_by: adminId,
      resolved_at: db.fn.now(),
    });
  } else {
    await db('resolution_queue').where('id', queueId).update({
      status: 'ignored',
      resolved_by: adminId,
      resolved_at: db.fn.now(),
    });
  }
}

/** Un-map (tombstone) a wrong merge; affected staging rows must be replayed. */
export async function unmapIdentity(db: Knex, provider: string, providerId: string): Promise<void> {
  await db('player_identities')
    .where({ provider, provider_id: providerId })
    .update({ tombstoned_at: db.fn.now() });
}
