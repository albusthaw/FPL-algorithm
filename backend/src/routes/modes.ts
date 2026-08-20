import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';
import { latestCompleteRunId } from './players.js';
import { candidatesForRun } from './teams.js';
import { optimiseSquad } from '../fpl/optimiser.js';
import { suggestTransfers, valuateTeam } from '../fpl/suggester.js';
import { getConfig } from '../core/model-config.js';
import type { SquadRules, ChipSetRules } from '../fpl/rules.js';

export async function modeRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  const requireRun = async (): Promise<number> => {
    const runId = await latestCompleteRunId(db);
    if (!runId) {
      const err = new Error('no completed run yet — press Run first') as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    }
    return runId;
  };

  const playerCards = async (runId: number, uids: string[]): Promise<Record<string, unknown>[]> => {
    if (uids.length === 0) return [];
    const rows = await db('player_matrix as pm')
      .join('players as p', 'p.uid', 'pm.player_uid')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .where('pm.run_id', runId)
      .whereIn('pm.player_uid', uids)
      .select('pm.player_uid as uid', 'p.web_name', 'p.position', 't.short_name as club', 'pm.price', 'pm.xpts_next1', 'pm.xpts_next3', 'pm.xpts_next6', 'pm.overall_score', 'pm.p_start_xi', 'pm.ai_rationale', 'pm.injury_status');
    const map = new Map(rows.map((r) => [r.uid, r]));
    return uids.map((uid) => map.get(uid)).filter((r): r is NonNullable<typeof r> => !!r);
  };

  // ── Mode 1: Initial Team Selection
  const InitialSchema = z.object({
    horizon: z.union([z.literal(1), z.literal(3), z.literal(6)]).default(6),
    budget: z.number().int().min(500).max(1200).default(1000),
    locked: z.array(z.string()).default([]),
    banned: z.array(z.string()).default([]),
    compareTeamId: z.coerce.number().int().nullable().default(null),
  });

  app.post('/api/modes/initial', async (req, reply) => {
    requireAuth(req);
    const parsed = InitialSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const runId = await requireRun();
    const rules = await getConfig<SquadRules>(db, 'squad_rules');
    const candidates = await candidatesForRun(db, runId, parsed.data.horizon);
    const solution = optimiseSquad(candidates, rules, {
      budget: parsed.data.budget,
      locked: parsed.data.locked,
      banned: parsed.data.banned,
    });
    const squadCards = await playerCards(runId, solution.squad.map((p) => p.uid));

    // optional diff vs a saved team: out/in, Δxpts, Δbudget
    let diff = null;
    if (parsed.data.compareTeamId) {
      const teamPlayers = await db('user_team_players').where('team_id', parsed.data.compareTeamId).pluck('player_uid');
      const theirs = new Set<string>(teamPlayers);
      const ours = new Set(solution.squad.map((p) => p.uid));
      const byUid = new Map(candidates.map((c) => [c.uid, c]));
      const out = [...theirs].filter((uid) => !ours.has(uid));
      const inn = [...ours].filter((uid) => !theirs.has(uid));
      const theirSquad = teamPlayers.map((uid: string) => byUid.get(uid)).filter((c): c is NonNullable<typeof c> => !!c);
      const benchmark = solution.xi.xptsTotal;
      diff = {
        out: await playerCards(runId, out),
        in: await playerCards(runId, inn),
        deltaXpts: Number((solution.squad.reduce((s, p) => s + (p.xpts ?? 0), 0) - theirSquad.reduce((s, p) => s + p.xpts, 0)).toFixed(2)),
        deltaBudget: solution.totalCost - theirSquad.reduce((s, p) => s + p.price, 0),
        valuation: theirSquad.length === 15 ? valuateTeam(theirSquad, benchmark, rules) : null,
      };
    }

    return {
      runId,
      squad: squadCards,
      xi: {
        starters: solution.xi.starters.map((p) => p.uid),
        bench: solution.xi.bench.map((p) => p.uid),
        formation: solution.xi.formation,
        captain: solution.xi.captain,
        vice: solution.xi.vice,
        xpts: Number(solution.xi.xptsTotal.toFixed(2)),
      },
      totalCost: solution.totalCost,
      method: solution.method,
      diff,
    };
  });

  // ── Mode 2: Free Hit / Wildcard
  const ChipsSchema = z.object({
    teamId: z.coerce.number().int(),
    chip: z.enum(['freehit', 'wildcard']).nullable().default(null),
    event: z.number().int().nullable().default(null),
  });

  app.post('/api/modes/chips', async (req, reply) => {
    requireAuth(req);
    const parsed = ChipsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const runId = await requireRun();
    const team = await db('user_teams').where({ id: parsed.data.teamId, user_id: req.user.id }).first();
    if (!team) return reply.code(404).send({ error: 'team not found' });

    const recommendations = await db('chip_recommendations as cr')
      .where({ 'cr.run_id': runId, 'cr.team_id': team.id })
      .orderBy('cr.value', 'desc')
      .select('cr.chip', 'cr.chip_set', 'cr.event', 'cr.value', 'cr.urgency', 'cr.caveats');
    const coverage = await db('coverage_reports').where({ run_id: runId, team_id: team.id }).first();

    // DGW/BGW strip for the planner
    const fixtureCounts = (await db('fixtures')
      .whereNotNull('event')
      .where('season', db.raw(`(SELECT season FROM fixtures WHERE state IN ('scheduled','live') ORDER BY kickoff_utc LIMIT 1)`))
      .select('event')
      .count({ c: '*' })
      .groupBy('event')
      .orderBy('event')) as { event: number; c: unknown }[];

    // build the chip squad when a chip+event is chosen
    let chipSquad = null;
    if (parsed.data.chip && parsed.data.event) {
      const rules = await getConfig<SquadRules>(db, 'squad_rules');
      const chipRules = await getConfig<ChipSetRules>(db, 'chip_rules');
      const { chipSetForEvent } = await import('../fpl/rules.js');
      const set = chipSetForEvent(chipRules, parsed.data.chip, parsed.data.event, team.chips_used ?? []);
      if (set == null) return reply.code(422).send({ error: `${parsed.data.chip} is not playable at GW${parsed.data.event} (set expired or already used)` });

      const horizon = parsed.data.chip === 'freehit' ? 1 : 6;
      const candidates = await candidatesForRun(db, runId, horizon as 1 | 6);
      const teamPlayers = await db('user_team_players').where('team_id', team.id).pluck('player_uid');
      const byUid = new Map(candidates.map((c) => [c.uid, c]));
      const currentValue = teamPlayers.reduce((s: number, uid: string) => s + (byUid.get(uid)?.price ?? 0), 0) + team.bank;
      const solution = optimiseSquad(candidates, rules, { budget: currentValue });
      const theirs = new Set<string>(teamPlayers);
      const ours = new Set(solution.squad.map((p) => p.uid));
      chipSquad = {
        chip: parsed.data.chip,
        chipSet: set,
        event: parsed.data.event,
        squad: await playerCards(runId, solution.squad.map((p) => p.uid)),
        xi: {
          starters: solution.xi.starters.map((p) => p.uid),
          bench: solution.xi.bench.map((p) => p.uid),
          formation: solution.xi.formation,
          captain: solution.xi.captain,
          vice: solution.xi.vice,
          xpts: Number(solution.xi.xptsTotal.toFixed(2)),
        },
        budget: currentValue,
        totalCost: solution.totalCost,
        diff: {
          out: await playerCards(runId, [...theirs].filter((uid) => !ours.has(uid))),
          in: await playerCards(runId, [...ours].filter((uid) => !theirs.has(uid))),
        },
      };
    }

    return {
      runId,
      recommendations,
      coverage,
      gwFixtureCounts: fixtureCounts.map((f) => ({ event: f.event, fixtures: Number(f.c) })),
      chipSquad,
    };
  });

  // ── Mode 3: Weekly
  const WeeklySchema = z.object({
    teamId: z.coerce.number().int(),
    horizon: z.union([z.literal(1), z.literal(3), z.literal(6)]).default(3),
  });

  app.post('/api/modes/weekly', async (req, reply) => {
    requireAuth(req);
    const parsed = WeeklySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const runId = await requireRun();
    const team = await db('user_teams').where({ id: parsed.data.teamId, user_id: req.user.id }).first();
    if (!team) return reply.code(404).send({ error: 'team not found' });
    const teamPlayers = await db('user_team_players').where('team_id', team.id).pluck('player_uid');
    if (teamPlayers.length !== 15) return reply.code(422).send({ error: 'team must have 15 players for weekly suggestions' });

    const rules = await getConfig<SquadRules>(db, 'squad_rules');
    const chipRules = await getConfig<ChipSetRules>(db, 'chip_rules');
    const candidates = await candidatesForRun(db, runId, parsed.data.horizon);
    const byUid = new Map(candidates.map((c) => [c.uid, c]));
    const squad = teamPlayers.map((uid: string) => byUid.get(uid)).filter((c): c is NonNullable<typeof c> => !!c);
    if (squad.length !== 15) return reply.code(422).send({ error: 'some team players are missing from the latest run — press Run' });

    const suggestions = suggestTransfers({
      squad,
      bank: team.bank,
      freeTransfers: team.free_transfers,
      candidates,
      rules,
      chipRules,
    });

    // enrich with cards
    const enrich = async (moves: typeof suggestions.singles): Promise<unknown[]> =>
      Promise.all(
        moves.map(async (m) => ({
          ...m,
          outCards: await playerCards(runId, m.out),
          inCards: await playerCards(runId, m.in),
        })),
      );

    // injury alerts inside the squad + price-change risk
    const alerts = await db('player_matrix as pm')
      .join('players as p', 'p.uid', 'pm.player_uid')
      .where('pm.run_id', runId)
      .whereIn('pm.player_uid', teamPlayers)
      .whereNot('pm.injury_status', 'fit')
      .select('pm.player_uid as uid', 'p.web_name', 'pm.injury_status', 'pm.injury_detail');
    const priceRisk = await db('player_matrix as pm')
      .join('players as p', 'p.uid', 'pm.player_uid')
      .where('pm.run_id', runId)
      .whereIn('pm.player_uid', teamPlayers)
      .where('pm.transfers_in_net', '<', -30000)
      .select('pm.player_uid as uid', 'p.web_name', 'pm.transfers_in_net');

    // captaincy pool + match-engine targets for this GW
    const captaincy = await db('target_lists as tl')
      .join('players as p', 'p.uid', 'tl.player_uid')
      .where({ 'tl.run_id': runId, 'tl.scope': 'captaincy' })
      .orderBy('tl.rank')
      .select('tl.player_uid as uid', 'p.web_name', 'tl.score', 'tl.reasons');
    const targets = await db('target_lists as tl')
      .join('players as p', 'p.uid', 'tl.player_uid')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .where({ 'tl.run_id': runId, 'tl.scope': 'global' })
      .orderBy('tl.rank')
      .limit(10)
      .select('tl.player_uid as uid', 'p.web_name', 'p.position', 't.short_name as club', 'tl.score', 'tl.reasons');

    return {
      runId,
      best0: suggestions.best0,
      singles: await enrich(suggestions.singles),
      doubles: await enrich(suggestions.doubles),
      hitAdvice:
        suggestions.doubles[0] && suggestions.doubles[0].hitCost > 0 && suggestions.doubles[0].netGain > 0
          ? `A -${suggestions.doubles[0].hitCost} hit is worth it over ${parsed.data.horizon} GWs (net +${suggestions.doubles[0].netGain.toFixed(1)} xPts)`
          : 'No hit is worth taking this week',
      alerts,
      priceRisk,
      captaincy,
      targets,
    };
  });

  // match-engine insights for the dashboard / mode screens
  app.get('/api/insights', async (req) => {
    requireAuth(req);
    const runId = await requireRun();
    const insights = await db('match_insights as mi')
      .join('fixtures as f', 'f.fixture_uid', 'mi.fixture_uid')
      .leftJoin('teams as th', 'th.uid', 'f.home_team_uid')
      .leftJoin('teams as ta', 'ta.uid', 'f.away_team_uid')
      .where('mi.run_id', runId)
      .orderBy('mi.mci', 'desc')
      .limit(20)
      .select('mi.*', 'th.short_name as home', 'ta.short_name as away', 'f.kickoff_utc');
    return { runId, insights };
  });
}
