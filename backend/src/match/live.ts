/**
 * B3 (v1.4.4) — the live gameweek engine (fixes audit M2).
 *
 * FPL's free in-play endpoints were entirely unused: event/{gw}/live gives
 * per-player live stats + BPS, fixtures?event= gives per-fixture state.
 * One poll pass persists live_event_stats (with our OWN bonus projection
 * from the live BPS board, 3/2/1 with FPL's tie sharing), and an SSE data
 * channel (X2) tells every open dashboard the moment fresh numbers land.
 *
 * Everything here is statistical — the scheduler drives it, so it must
 * never import the AI layer.
 */
import { EventEmitter } from 'node:events';
import type { Knex } from 'knex';
import { log } from '../core/logger.js';
import type { FetchFn } from '../ingest/http.js';

const FPL_BASE = 'https://fantasy.premierleague.com/api';

/** Data-freshness channel: 'live' events fire after each poll pass. */
export const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(100);

/**
 * FPL bonus from a fixture's BPS board: 3/2/1 with tie sharing — ties at a
 * rank ALL take that rank's points and the next rank(s) collapse (two tied
 * top → both 3, next gets 1; three tied top → all 3, nobody else scores).
 */
export function projectBonus(board: { uid: string; bps: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...board].filter((b) => b.bps > 0).sort((a, b) => b.bps - a.bps);
  const AWARDS = [3, 2, 1];
  let rank = 0; // index into AWARDS
  let i = 0;
  while (i < sorted.length && rank < 3) {
    const tied = sorted.filter((b) => b.bps === sorted[i]!.bps);
    for (const t of tied) out.set(t.uid, AWARDS[rank]!);
    i += tied.length;
    rank += tied.length; // ties consume the ranks below them
  }
  return out;
}

interface LiveElement {
  id: number;
  stats: {
    minutes: number;
    goals_scored: number;
    assists: number;
    clean_sheets: number;
    goals_conceded: number;
    saves: number;
    bonus: number;
    bps: number;
    yellow_cards: number;
    red_cards: number;
    defensive_contribution?: number;
    total_points: number;
  };
  explain: { fixture: number; stats: unknown[] }[];
}

export interface LivePollResult {
  event: number | null;
  players: number;
  fixturesLive: number;
}

/**
 * One poll pass: event/{gw}/live + fixtures?event= → live_event_stats rows
 * with the projected bonus, and fixtures.state kept current. Emits 'live'.
 */
export async function pollLiveOnce(db: Knex, fetchFn?: FetchFn): Promise<LivePollResult> {
  const f = fetchFn ?? fetch;
  const gw = await db('gameweeks').where('is_current', true).first('id', 'finished');
  if (!gw) return { event: null, players: 0, fixturesLive: 0 };
  const event = Number(gw.id);

  const [liveRes, fixturesRes] = await Promise.all([
    f(`${FPL_BASE}/event/${event}/live/`, { headers: { 'user-agent': 'fpl-algorithm/1.4' }, signal: AbortSignal.timeout(15_000) }),
    f(`${FPL_BASE}/fixtures/?event=${event}`, { headers: { 'user-agent': 'fpl-algorithm/1.4' }, signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!liveRes.ok || !fixturesRes.ok) throw new Error(`FPL live poll HTTP ${liveRes.status}/${fixturesRes.status}`);
  const live = (await liveRes.json()) as { elements?: LiveElement[] };
  const fixtures = (await fixturesRes.json()) as {
    id: number;
    started?: boolean;
    finished?: boolean;
    finished_provisional?: boolean;
    minutes?: number;
    team_h_score?: number | null;
    team_a_score?: number | null;
  }[];

  const uidByFplId = new Map<number, string>(
    ((await db('players').whereNotNull('fpl_id').select('uid', 'fpl_id')) as { uid: string; fpl_id: number }[]).map((p) => [p.fpl_id, p.uid]),
  );

  // fixture state upkeep (id = fpl fixture id within the current season)
  let fixturesLive = 0;
  for (const fx of fixtures) {
    const state = fx.finished || fx.finished_provisional ? 'finished' : fx.started ? 'live' : null;
    if (state === 'live') fixturesLive++;
    if (state) {
      await db('fixtures')
        .where({ fpl_fixture_id: fx.id })
        .whereIn('state', ['scheduled', 'live'])
        .whereNotNull('event')
        .update({ state, home_score: fx.team_h_score ?? null, away_score: fx.team_a_score ?? null, as_of: db.fn.now() });
    }
  }

  // BPS boards per fixture → projected bonus (only while a fixture is
  // un-finalised; FPL's own `bonus` stat takes over once awarded)
  const fixtureOfPlayer = new Map<string, number>();
  const boards = new Map<number, { uid: string; bps: number }[]>();
  for (const el of live.elements ?? []) {
    const uid = uidByFplId.get(el.id);
    if (!uid) continue;
    const fixtureId = el.explain[0]?.fixture;
    if (fixtureId == null) continue;
    fixtureOfPlayer.set(uid, fixtureId);
    (boards.get(fixtureId) ?? boards.set(fixtureId, []).get(fixtureId)!).push({ uid, bps: el.stats.bps });
  }
  const projected = new Map<string, number>();
  for (const [, board] of boards) for (const [uid, pts] of projectBonus(board)) projected.set(uid, pts);

  // persist
  let players = 0;
  const batch: Record<string, unknown>[] = [];
  for (const el of live.elements ?? []) {
    const uid = uidByFplId.get(el.id);
    if (!uid) continue;
    if (el.stats.minutes === 0 && el.stats.total_points === 0) continue; // untouched players stay out
    batch.push({
      event,
      player_uid: uid,
      minutes: el.stats.minutes,
      goals: el.stats.goals_scored,
      assists: el.stats.assists,
      clean_sheets: el.stats.clean_sheets,
      goals_conceded: el.stats.goals_conceded,
      saves: el.stats.saves,
      bps: el.stats.bps,
      bonus: el.stats.bonus,
      projected_bonus: el.stats.bonus > 0 ? el.stats.bonus : (projected.get(uid) ?? 0),
      defcon: el.stats.defensive_contribution ?? 0,
      yellow_cards: el.stats.yellow_cards,
      red_cards: el.stats.red_cards,
      total_points: el.stats.total_points,
      stats: JSON.stringify({ fixture: fixtureOfPlayer.get(uid) ?? null }),
      as_of: db.fn.now(),
    });
    players++;
  }
  for (let i = 0; i < batch.length; i += 300) {
    await db('live_event_stats')
      .insert(batch.slice(i, i + 300))
      .onConflict(['event', 'player_uid'])
      .merge();
  }

  liveEvents.emit('live', { event, players, fixturesLive, at: new Date().toISOString() });
  if (players > 0) log.info({ event, players, fixturesLive }, 'live poll');
  return { event, players, fixturesLive };
}

export interface AutoSubPreview {
  out: string;
  in: string;
  reason: string;
}

/**
 * Auto-sub preview for a 15-man squad against the live board: starters with
 * 0 minutes in FINISHED fixtures step down in bench order, respecting FPL's
 * formation minimums (1 GK, ≥3 DEF, ≥2 MID, ≥1 FWD).
 */
export function previewAutoSubs(
  squad: { uid: string; position: string; slot: number; isStarter: boolean; benchPosition: number | null }[],
  played: Map<string, { minutes: number; fixtureFinished: boolean }>,
): AutoSubPreview[] {
  const starters = squad.filter((p) => p.isStarter);
  const bench = squad.filter((p) => !p.isStarter).sort((a, b) => (a.benchPosition ?? 9) - (b.benchPosition ?? 9));
  const counts = (list: { position: string }[]): Record<string, number> => {
    const c: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of list) c[p.position] = (c[p.position] ?? 0) + 1;
    return c;
  };
  const MIN: Record<string, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };

  const out: AutoSubPreview[] = [];
  const active = [...starters];
  const benchLeft = [...bench];
  for (const st of starters) {
    const rec = played.get(st.uid);
    if (!rec || !rec.fixtureFinished || rec.minutes > 0) continue; // only definite blanks
    // find the first eligible bench player who played (or hasn't finished yet)
    for (let i = 0; i < benchLeft.length; i++) {
      const sub = benchLeft[i]!;
      const subRec = played.get(sub.uid);
      if (subRec && subRec.fixtureFinished && subRec.minutes === 0) continue; // sub also blanked
      if (st.position === 'GK' && sub.position !== 'GK') continue;
      if (st.position !== 'GK' && sub.position === 'GK') continue;
      const after = counts(active.filter((p) => p.uid !== st.uid).concat(sub));
      if ((['GK', 'DEF', 'MID', 'FWD'] as const).some((pos) => (after[pos] ?? 0) < MIN[pos]!)) continue;
      out.push({ out: st.uid, in: sub.uid, reason: `did not play — bench ${sub.benchPosition ?? i + 1} steps in` });
      active.splice(active.findIndex((p) => p.uid === st.uid), 1, sub);
      benchLeft.splice(i, 1);
      break;
    }
  }
  return out;
}
