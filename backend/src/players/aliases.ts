/**
 * Player alias generation for NEWS entity linking (v1.4.6).
 *
 * The bug this replaces: aliases were seeded with the resolver's
 * token-SORTING canonicaliser (normaliseName), while the indexer matches
 * aliases as ORDER-PRESERVING phrases in running text. A multi-word name only
 * ever matched when it happened to be alphabetical — "erling haaland" yes,
 * "Bruno Fernandes" never ("borges bruno fernandes"). 332 of ~600 active
 * players were unlinkable except through a single-token web_name.
 *
 * Aliases here are order-preserving (normaliseText) and cover what the press
 * actually writes: the FPL web name, the full name, first + surname, surname
 * + first, and the bare surname (a mononym — the indexer requires club
 * context for those). Everything is idempotent (ON CONFLICT DO NOTHING) and
 * the resolver's own aliases (source != 'fpl') are never touched.
 */
import type { Knex } from 'knex';
import { normaliseText } from './resolver.js';
import { log } from '../core/logger.js';

/** Bump when alias generation changes — boot re-seeds + re-indexes once. */
export const ALIAS_VERSION = 2;

// surname particles: "dos Santos Magalhães" → surname token "magalhaes";
// "van Dijk" keeps "van dijk" as the compound surname
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'del', 'della', 'di', 'du', 'la', 'le', 'van', 'von', 'der', 'den', 'ter', 'te', 'el', 'al', 'bin', 'ibn', 'y', 'e']);
const COMPOUND_PARTICLES = new Set(['van', 'von', 'de', 'del', 'di', 'le', 'la', 'da', 'der', 'den', 'ter', 'te', 'el', 'al']);

export interface AliasSource {
  webName: string;
  firstName?: string | null;
  secondName?: string | null;
  fullName?: string | null;
}

/** The surname phrase: last token, plus a leading particle when the surname
 *  is habitually written with it ("van dijk", "de bruyne", "le fee"). */
export function surnameOf(secondName: string): string {
  const tokens = normaliseText(secondName).split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  const last = tokens[tokens.length - 1]!;
  const prev = tokens[tokens.length - 2];
  if (prev && COMPOUND_PARTICLES.has(prev)) return `${prev} ${last}`;
  return last;
}

/** Order-preserving alias set for one player. Short tokens (< 3 letters)
 *  never become mononyms ("B." fragments, initials). */
export function aliasesFor(src: AliasSource): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined): void => {
    const n = normaliseText(s ?? '');
    if (n.length >= 3) out.add(n);
  };

  add(src.webName); // "b fernandes", "calvert lewin", "haaland", "enzo"
  add(src.fullName); // "bruno borges fernandes"

  const first = normaliseText(src.firstName ?? '').split(' ').filter(Boolean);
  const second = normaliseText(src.secondName ?? '');
  const surname = second ? surnameOf(second) : '';
  const firstToken = first[0] ?? '';

  if (firstToken && surname) {
    add(`${firstToken} ${surname}`); // "bruno fernandes", "gabriel magalhaes"
    if (first.length > 1) {
      // East-Asian order and hyphenated given names: both orders appear
      add(`${first.join(' ')} ${surname}`); // "heung min son"
      add(`${surname} ${first.join(' ')}`); // "son heung min"
    }
    if (second && second !== surname) add(`${firstToken} ${second}`); // "bruno borges fernandes"
  }
  // the press follows the FPL web name for the "surname": Gabriel MARTINELLI
  // Silva is "Gabriel Martinelli", never "Gabriel Silva" — pair first name
  // with a single-token web name that differs from the surname
  const web = normaliseText(src.webName).split(' ').filter(Boolean);
  if (web.length === 1 && firstToken && web[0] !== firstToken && web[0] !== surname && web[0]!.length >= 3) {
    add(`${firstToken} ${web[0]}`); // "gabriel martinelli"
  }
  // bare surname as a mononym (indexer demands club context) — never a
  // particle, never an initial
  if (surname && !PARTICLES.has(surname) && surname.replace(/\s/g, '').length >= 3) add(surname);

  return [...out];
}

/** Re-seed every active player's FPL aliases (idempotent). */
export async function reseedAliases(db: Knex): Promise<{ players: number; inserted: number }> {
  const players = (await db('players').whereNotNull('team_uid').select('uid', 'web_name', 'first_name', 'second_name', 'full_name')) as {
    uid: string;
    web_name: string;
    first_name: string;
    second_name: string;
    full_name: string;
  }[];
  let inserted = 0;
  for (const p of players) {
    for (const alias of aliasesFor({ webName: p.web_name, firstName: p.first_name, secondName: p.second_name, fullName: p.full_name })) {
      const r = await db.raw(
        `INSERT INTO player_aliases (player_uid, alias, source) VALUES (?, ?, 'fpl')
         ON CONFLICT (player_uid, alias) DO NOTHING`,
        [p.uid, alias],
      );
      inserted += Number((r as { rowCount?: number }).rowCount ?? 0);
    }
  }
  log.info({ players: players.length, inserted }, 'alias reseed');
  return { players: players.length, inserted };
}
