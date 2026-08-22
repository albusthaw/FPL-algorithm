/**
 * A3/C3 (v1.4.4) — availability reconciliation (fixes audit S3: the
 * availability_state table shipped in 0004 and never had a writer).
 *
 * One statistical pass merges every availability signal we hold:
 *   - FPL's own flags (players.status + chance_next + the news string),
 *   - active injuries/suspensions (any structured provider),
 *   - news-text hints from the indexer's linked items ("ruled out",
 *     "back in training", C3's expected-return extraction).
 * into one row per (player, next fixture): p_available, a state label,
 * evidence, and a conflict flag when sources disagree. L3 minutes consumes
 * the result; no AI is involved anywhere.
 */
import type { Knex } from 'knex';
import { log } from '../core/logger.js';

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * C3: extract an expected-return horizon from availability prose.
 * "out for six weeks" / "ruled out for 2-3 weeks" / "sidelined for a month"
 * / FPL's own "Expected back 15 Nov" → a date (from `from`).
 */
export function extractReturnDate(text: string, from = new Date()): Date | null {
  const t = text.toLowerCase();

  // "expected back 15 nov" / "expected back 03 jan" (FPL news format)
  const m1 = /expected back (\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.exec(t);
  if (m1) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(m1[2]!);
    const day = Number(m1[1]);
    const d = new Date(Date.UTC(from.getUTCFullYear(), month, day));
    if (d.getTime() < from.getTime() - 14 * 86_400_000) d.setUTCFullYear(d.getUTCFullYear() + 1); // next year's date
    return d;
  }

  // "(out|ruled out|sidelined) for [about/around/up to] N[-M] weeks/months"
  const m2 = /(?:out|sidelined|absent)[^.]{0,30}?for (?:about |around |up to |at least )?(?:(\d+)(?:\s*[-–to]+\s*(\d+))?|(a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)) (week|month)/.exec(t);
  if (m2) {
    const lo = m2[1] ? Number(m2[1]) : m2[3] === 'a' ? 1 : (WORD_NUM[m2[3]!] ?? 1);
    const hi = m2[2] ? Number(m2[2]) : lo;
    const n = (lo + hi) / 2;
    const days = m2[4] === 'month' ? n * 30 : n * 7;
    return new Date(from.getTime() + days * 86_400_000);
  }

  return null;
}

const RULED_OUT = /\b(ruled out|will miss|misses (the|this)|out of (the|this|saturday|sunday)|not (available|in contention)|sidelined)\b/;
const BACK_TRAINING = /\b(back in (full )?training|returns? to (full )?training|back in contention|passed fit|available again|in line to return)\b/;

export interface AvailabilityWriteResult {
  players: number;
  conflicts: number;
  withReturnDates: number;
}

export async function writeAvailabilityState(db: Knex): Promise<AvailabilityWriteResult> {
  const nextGw = await db('gameweeks').where('is_next', true).first('id');
  if (!nextGw) return { players: 0, conflicts: 0, withReturnDates: 0 };
  const event = Number(nextGw.id);

  const fixtures = (await db('fixtures').where('event', event).whereNotNull('fpl_fixture_id').select('fixture_uid', 'home_team_uid', 'away_team_uid', 'kickoff_utc')) as {
    fixture_uid: string;
    home_team_uid: string;
    away_team_uid: string;
    kickoff_utc: Date | null;
  }[];
  const fixtureByTeam = new Map<string, { fixture_uid: string; kickoff_utc: Date | null }>();
  for (const f of fixtures) {
    fixtureByTeam.set(f.home_team_uid, f);
    fixtureByTeam.set(f.away_team_uid, f);
  }

  const players = (await db('players').whereNotNull('team_uid').select('uid', 'team_uid', 'status', 'chance_next', 'news')) as {
    uid: string;
    team_uid: string;
    status: string;
    chance_next: number | null;
    news: string;
  }[];

  const injuries = (await db('injuries').where('is_active', true).select('player_uid', 'kind', 'reason', 'expected_return_date')) as {
    player_uid: string;
    kind: string;
    reason: string;
    expected_return_date: string | null;
  }[];
  const injuryBy = new Map(injuries.map((i) => [i.player_uid, i]));

  // recent availability-relevant news per player (tier ≤ 2, last 5 days)
  const newsRows = (await db('news_player_map as m')
    .join('news_items as n', 'n.id', 'm.news_id')
    .where('n.fetched_at', '>', new Date(Date.now() - 5 * 86_400_000))
    .where('n.source_tier', '<=', 2)
    .select('m.player_uid', 'n.title', 'n.description')) as { player_uid: string; title: string; description: string | null }[];
  const newsBy = new Map<string, string[]>();
  for (const r of newsRows) {
    (newsBy.get(r.player_uid) ?? newsBy.set(r.player_uid, []).get(r.player_uid)!).push(`${r.title}. ${r.description ?? ''}`);
  }

  const now = new Date();
  let written = 0;
  let conflicts = 0;
  let withReturnDates = 0;

  for (const p of players) {
    const fx = fixtureByTeam.get(p.team_uid);
    if (!fx) continue;
    const kickoff = fx.kickoff_utc ? new Date(fx.kickoff_utc) : null;

    // FPL flags — the anchor truth
    let pAvail = p.status === 'a' ? 1.0 : p.status === 'd' ? (p.chance_next != null ? p.chance_next / 100 : 0.5) : 0.05;
    let state = p.status === 'a' ? 'available' : p.status === 'd' ? 'doubtful' : p.status === 's' ? 'suspended' : 'out';
    const evidence: Record<string, unknown> = { fpl_status: p.status, fpl_chance_next: p.chance_next };

    // structured injuries
    const inj = injuryBy.get(p.uid);
    if (inj) {
      evidence.injury = { kind: inj.kind, reason: inj.reason, expected_return: inj.expected_return_date };
      const returned = inj.expected_return_date && kickoff && new Date(inj.expected_return_date).getTime() <= kickoff.getTime();
      if (!returned) {
        pAvail = Math.min(pAvail, inj.kind === 'suspension' ? 0.02 : 0.25);
        if (state === 'available') state = 'doubtful';
      }
    }

    // C3: news-text hints + expected-return extraction (FPL news string first)
    const texts = [p.news, ...(newsBy.get(p.uid) ?? [])].filter(Boolean);
    let returnDate: Date | null = null;
    let newsSaysOut = false;
    let newsSaysBack = false;
    for (const text of texts) {
      const t = text.toLowerCase();
      returnDate = returnDate ?? extractReturnDate(t, now);
      if (RULED_OUT.test(t)) newsSaysOut = true;
      if (BACK_TRAINING.test(t)) newsSaysBack = true;
    }
    if (returnDate) {
      withReturnDates++;
      evidence.expected_return = returnDate.toISOString().slice(0, 10);
      if (kickoff && returnDate.getTime() > kickoff.getTime()) {
        pAvail = Math.min(pAvail, 0.05);
        if (state === 'available' || state === 'doubtful') state = 'out';
      }
    }
    if (newsSaysBack && p.status === 'd') {
      pAvail = Math.max(pAvail, 0.6);
      evidence.news_back_in_training = true;
    }

    // conflict: FPL says fine, a tier-1/2 source says out (or vice versa)
    let conflict = false;
    if (newsSaysOut && p.status === 'a' && !newsSaysBack) {
      conflict = true;
      pAvail = Math.min(pAvail, 0.75); // FPL-leaning, but flagged
      evidence.news_ruled_out = true;
    }
    if (conflict) conflicts++;

    await db.raw(
      `INSERT INTO availability_state (player_uid, fixture_uid, p_available, state, evidence, conflict, as_of)
       VALUES (?, ?, ?, ?, ?, ?, now())
       ON CONFLICT (player_uid, fixture_uid) DO UPDATE
         SET p_available = excluded.p_available, state = excluded.state,
             evidence = excluded.evidence, conflict = excluded.conflict, as_of = now()`,
      [p.uid, fx.fixture_uid, pAvail.toFixed(3), state, JSON.stringify(evidence), conflict],
    );
    written++;
  }

  log.info({ players: written, conflicts, withReturnDates, event }, 'availability reconciliation pass');
  return { players: written, conflicts, withReturnDates };
}
