import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';

export async function latestCompleteRunId(db: Knex): Promise<number | null> {
  const row = await db('runs').where('status', 'complete').orderBy('id', 'desc').first('id');
  return row ? Number(row.id) : null;
}

export async function playerRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  app.get('/api/players', async (req) => {
    requireAuth(req);
    const runId = await latestCompleteRunId(db);
    const q = req.query as { position?: string; search?: string; sort?: string };
    if (!runId) {
      // no run yet: raw player list
      const players = await db('players as p')
        .leftJoin('teams as t', 't.uid', 'p.team_uid')
        .whereNotNull('p.team_uid')
        .select('p.uid', 'p.web_name', 'p.full_name', 'p.position', 'p.now_cost as price', 'p.status', 'p.selected_by_percent', 't.short_name as club')
        .orderBy('p.now_cost', 'desc')
        .limit(700);
      return { runId: null, players };
    }
    // previous run for movement arrows (both run_ids named per §6.3)
    const prev = await db('runs').where('status', 'complete').where('id', '<', runId).orderBy('id', 'desc').first('id');
    let query = db('player_matrix as pm')
      .join('players as p', 'p.uid', 'pm.player_uid')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .where('pm.run_id', runId)
      .select(
        'pm.player_uid as uid',
        'p.web_name',
        'p.full_name',
        'p.position',
        't.short_name as club',
        'pm.price',
        'pm.selected_by_pct',
        'pm.stat_score',
        'pm.ai_adjustment',
        'pm.ai_stale',
        'pm.overall_score',
        'pm.rank_overall',
        'pm.rank_position',
        'pm.xpts_next1',
        'pm.xpts_next3',
        'pm.xpts_next6',
        'pm.p_start_xi',
        'pm.injury_status',
        'pm.form_ewma',
        'pm.fdr_next3',
        // A6 (v1.4.3, audit S5): FPL's own benchmark + ICT, ingested since
        // v1.0 and never surfaced — display columns (never model inputs here)
        db.raw(`(p.season_stats->>'ep_next')::numeric as ep_next`),
        db.raw(`(p.season_stats->>'ict_index')::numeric as ict_index`),
      );
    if (q.position) query = query.where('p.position', q.position.toUpperCase());
    if (q.search) query = query.whereRaw('(p.web_name ILIKE ? OR p.full_name ILIKE ?)', [`%${q.search}%`, `%${q.search}%`]);
    const players = await query.orderBy('pm.rank_overall', 'asc').limit(700);

    let movement: Record<string, number> = {};
    if (prev) {
      const prevRanks = await db('player_matrix').where('run_id', prev.id).select('player_uid', 'rank_overall');
      const prevMap = new Map(prevRanks.map((r) => [r.player_uid, r.rank_overall]));
      movement = Object.fromEntries(
        players
          .filter((p) => prevMap.has(p.uid) && prevMap.get(p.uid) != null && p.rank_overall != null)
          .map((p) => [p.uid, (prevMap.get(p.uid) as number) - p.rank_overall]),
      );
    }
    return { runId, prevRunId: prev?.id ?? null, players, movement };
  });

  app.get('/api/players/:uid', async (req, reply) => {
    requireAuth(req);
    const { uid } = req.params as { uid: string };
    const player = await db('players as p')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .where('p.uid', uid)
      .select('p.*', 't.short_name as club', 't.name as club_name')
      .first();
    if (!player) return reply.code(404).send({ error: 'player not found' });
    delete player.season_stats;

    const runId = await latestCompleteRunId(db);
    const matrix = runId
      ? await db('player_matrix').where({ run_id: runId, player_uid: uid }).first()
      : null;
    const history = await db('player_matrix as pm')
      .join('runs as r', 'r.id', 'pm.run_id')
      .where('pm.player_uid', uid)
      .where('r.status', 'complete')
      .orderBy('pm.run_id', 'desc')
      .limit(20)
      .select('pm.run_id', 'pm.overall_score', 'pm.stat_score', 'pm.ai_adjustment', 'pm.ai_rationale', 'pm.rank_overall', 'pm.xpts_next1', 'pm.computed_at');
    const upcoming = runId
      ? await db('player_fixture_predictions as pfp')
          .join('fixtures as f', 'f.fixture_uid', 'pfp.fixture_uid')
          .leftJoin('teams as th', 'th.uid', 'f.home_team_uid')
          .leftJoin('teams as ta', 'ta.uid', 'f.away_team_uid')
          .where({ 'pfp.run_id': runId, 'pfp.player_uid': uid })
          .orderBy('pfp.event')
          .select('pfp.*', 'th.short_name as home', 'ta.short_name as away', 'f.kickoff_utc')
      : [];
    const recentMatches = await db('player_match_stats')
      .where('player_uid', uid)
      .orderBy('kickoff_utc', 'desc')
      .limit(10)
      .select('event', 'season', 'minutes', 'goals', 'assists', 'fpl_points', 'bonus', 'xg', 'xa', 'cbit', 'cbirt', 'was_home', 'kickoff_utc');
    return { player, matrix, history, upcoming, recentMatches };
  });
}
