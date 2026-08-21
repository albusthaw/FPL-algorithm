/**
 * B3/X2 (v1.4.4) — the live gameweek surface: GET /api/live (scoreboard,
 * bonus board, price ticker, optional team view with auto-sub preview and
 * live captain points) and the SSE data channel that pushes a tick whenever
 * the poller lands fresh numbers.
 */
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';
import { liveEvents, previewAutoSubs } from '../match/live.js';

export async function liveRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  app.get('/api/live', async (req) => {
    requireAuth(req);
    const q = req.query as { teamId?: string };
    const gw = await db('gameweeks').where('is_current', true).first('id', 'name', 'deadline_time', 'finished');
    const next = await db('gameweeks').where('is_next', true).first('id', 'name', 'deadline_time');
    const event = gw ? Number(gw.id) : null;

    const fixtures = event
      ? await db('fixtures as f')
          .leftJoin('teams as th', 'th.uid', 'f.home_team_uid')
          .leftJoin('teams as ta', 'ta.uid', 'f.away_team_uid')
          .where('f.event', event)
          .whereNotNull('f.fpl_fixture_id')
          .orderBy('f.kickoff_utc')
          .select('f.fixture_uid', 'f.kickoff_utc', 'f.state', 'f.home_score', 'f.away_score', 'th.short_name as home', 'ta.short_name as away')
      : [];

    // live board: top scorers + the projected-bonus leaders
    const board = event
      ? await db('live_event_stats as l')
          .join('players as p', 'p.uid', 'l.player_uid')
          .leftJoin('teams as t', 't.uid', 'p.team_uid')
          .where('l.event', event)
          .orderBy('l.total_points', 'desc')
          .limit(15)
          .select('l.player_uid as uid', 'p.web_name', 'p.position', 't.short_name as club', 'l.minutes', 'l.goals', 'l.assists', 'l.bps', 'l.bonus', 'l.projected_bonus', 'l.total_points')
      : [];

    // price ticker: last night's actual moves + tonight's predictions
    const recentMoves = await db('price_events as pe')
      .join('players as p', 'p.uid', 'pe.player_uid')
      .where('pe.created_at', '>', new Date(Date.now() - 48 * 3600_000))
      .orderBy('pe.id', 'desc')
      .limit(12)
      .select('pe.player_uid as uid', 'p.web_name', 'pe.old_cost', 'pe.new_cost', 'pe.event_date');
    const predictions = await db('price_predictions as pp')
      .join('players as p', 'p.uid', 'pp.player_uid')
      .where('pp.for_date', '>=', new Date(Date.now() - 12 * 3600_000).toISOString().slice(0, 10))
      .whereNot('pp.direction', 'hold')
      .orderBy('pp.p', 'desc')
      .limit(12)
      .select('pp.player_uid as uid', 'p.web_name', 'pp.direction', 'pp.p', 'pp.net_transfers', 'pp.for_date');

    // optional team view: live points with auto-subs + captain doubling
    let team = null;
    if (q.teamId && event) {
      const t = await db('user_teams').where({ id: Number(q.teamId), user_id: req.user.id }).first();
      if (t) {
        const squad = (await db('user_team_players as tp')
          .join('players as p', 'p.uid', 'tp.player_uid')
          .where('tp.team_id', t.id)
          .select('tp.player_uid as uid', 'p.web_name', 'p.position', 'tp.slot', 'tp.is_captain', 'tp.is_vice', 'tp.bench_position')) as {
          uid: string;
          web_name: string;
          position: string;
          slot: number;
          is_captain: boolean;
          is_vice: boolean;
          bench_position: number | null;
        }[];
        const liveRows = (await db('live_event_stats').where('event', event).whereIn('player_uid', squad.map((s) => s.uid))) as {
          player_uid: string;
          minutes: number;
          bonus: number;
          projected_bonus: number;
          total_points: number;
          stats: { fixture?: number | null };
        }[];
        const liveBy = new Map(liveRows.map((r) => [r.player_uid, r]));
        // "did his match finish?" — resolved via the player's club fixtures
        const clubFixtureFinished = new Map<string, boolean>();
        const clubs = (await db('players').whereIn('uid', squad.map((s) => s.uid)).select('uid', 'team_uid')) as { uid: string; team_uid: string }[];
        const fxByTeam = await db('fixtures')
          .where('event', event)
          .whereNotNull('fpl_fixture_id')
          .select('fixture_uid', 'home_team_uid', 'away_team_uid', 'state');
        for (const c of clubs) {
          const fx = fxByTeam.filter((f) => f.home_team_uid === c.team_uid || f.away_team_uid === c.team_uid);
          clubFixtureFinished.set(c.uid, fx.length > 0 && fx.every((f) => f.state === 'finished' || f.state === 'checked'));
        }

        const played = new Map(squad.map((s) => [s.uid, { minutes: liveBy.get(s.uid)?.minutes ?? 0, fixtureFinished: clubFixtureFinished.get(s.uid) ?? false }]));
        const subs = previewAutoSubs(
          squad.map((s) => ({ uid: s.uid, position: s.position, slot: s.slot, isStarter: s.bench_position == null, benchPosition: s.bench_position })),
          played,
        );
        const subbedOut = new Set(subs.map((s) => s.out));
        const subbedIn = new Set(subs.map((s) => s.in));
        const captain = squad.find((s) => s.is_captain);
        const vice = squad.find((s) => s.is_vice);
        const captainPlays = captain && !(clubFixtureFinished.get(captain.uid) && (liveBy.get(captain.uid)?.minutes ?? 0) === 0);
        const effectiveCaptain = captainPlays ? captain : vice;
        let total = 0;
        const rows = squad
          .map((s) => {
            const l = liveBy.get(s.uid);
            const starterNow = (s.bench_position == null && !subbedOut.has(s.uid)) || subbedIn.has(s.uid);
            const isCap = effectiveCaptain?.uid === s.uid;
            const pts = (l?.total_points ?? 0) + Math.max(0, (l?.projected_bonus ?? 0) - (l?.bonus ?? 0));
            const counted = starterNow ? pts * (isCap ? 2 : 1) : 0;
            total += counted;
            return { ...s, live: l ?? null, starterNow, effectiveCaptain: isCap, points: pts, counted };
          })
          .sort((a, b) => a.slot - b.slot);
        team = { id: t.id, name: t.name, total, autoSubs: subs, players: rows };
      }
    }

    return {
      event,
      eventName: gw?.name ?? null,
      eventFinished: gw?.finished ?? null,
      nextDeadline: next?.deadline_time ?? null,
      nextEventName: next?.name ?? null,
      fixtures,
      board,
      priceTicker: { moves: recentMoves, predictions },
      team,
    };
  });

  // A2 (v1.4.4): tonight's risers/fallers + the model's recent scorecard
  app.get('/api/prices/predictions', async (req) => {
    requireAuth(req);
    const fromDate = new Date(Date.now() - 12 * 3600_000).toISOString().slice(0, 10);
    const predictions = await db('price_predictions as pp')
      .join('players as p', 'p.uid', 'pp.player_uid')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .where('pp.for_date', '>=', fromDate)
      .whereNot('pp.direction', 'hold')
      .orderBy([{ column: 'pp.direction', order: 'asc' }, { column: 'pp.p', order: 'desc' }])
      .limit(60)
      .select('pp.player_uid as uid', 'p.web_name', 'p.position', 't.short_name as club', 'p.now_cost', 'pp.direction', 'pp.p', 'pp.net_transfers', 'pp.threshold', 'pp.for_date');
    // yesterday's scorecard: calls vs actual moves
    const yday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const calls = (await db('price_predictions').where('for_date', yday).whereNot('direction', 'hold')) as { player_uid: string; direction: string }[];
    const actual = (await db('price_events').where('event_date', yday).select('player_uid', 'old_cost', 'new_cost')) as { player_uid: string; old_cost: number; new_cost: number }[];
    const actualDir = new Map(actual.map((a) => [a.player_uid, a.new_cost > a.old_cost ? 'rise' : 'fall']));
    const hits = calls.filter((c) => actualDir.get(c.player_uid) === c.direction).length;
    return {
      predictions,
      scorecard: calls.length > 0 ? { date: yday, calls: calls.length, hits, actualMoves: actual.length } : null,
    };
  });

  // X2: the SSE data-freshness channel — one 'tick' per completed live poll
  app.get('/api/live/stream', async (req, reply) => {
    requireAuth(req);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    liveEvents.on('live', send);
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => {
      liveEvents.removeListener('live', send);
      clearInterval(heartbeat);
    });
  });
}
