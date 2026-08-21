import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';
import { latestCompleteRunId } from './players.js';
import { candidatesForRun } from './teams.js';
import { optimiseSquad } from '../fpl/optimiser.js';
import { suggestTransfers, valuateTeam } from '../fpl/suggester.js';
import { getConfig } from '../core/model-config.js';
import { pickStartingXi, type SquadPlayer, type SquadRules, type ChipSetRules, type StartingXi } from '../fpl/rules.js';

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

    // A7 (v1.4.5): the squad's simulated band — per-player P10/P90 from the
    // matrix combined as independent sigmas (captain doubled), so the XI
    // shows a floor and a ceiling, not just a mean
    let band: { p10: number; p90: number } | null = null;
    const qRows = (await db('player_matrix')
      .where('run_id', runId)
      .whereIn('player_uid', solution.xi.starters.map((p) => p.uid))
      .whereNotNull('p90')
      .select('player_uid', 'p10', 'p50', 'p90')) as { player_uid: string; p10: string; p50: string; p90: string }[];
    if (qRows.length === solution.xi.starters.length) {
      let varSum = 0;
      for (const r of qRows) {
        const mult = r.player_uid === solution.xi.captain ? 2 : 1;
        const sigma = (mult * (Number(r.p90) - Number(r.p10))) / 2.56;
        varSum += sigma * sigma;
      }
      const spread = 1.28 * Math.sqrt(varSum);
      band = { p10: Number((solution.xi.xptsTotal - spread).toFixed(1)), p90: Number((solution.xi.xptsTotal + spread).toFixed(1)) };
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
      band,
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
    // P2 (v1.4.2): preview the squad AFTER a suggested move is applied
    apply: z.object({ out: z.array(z.string()), in: z.array(z.string()) }).nullable().default(null),
  });

  // P2 (v1.4.2): the same XI payload shape Initial/Chips send to PitchView
  const xiPayload = (xi: StartingXi): Record<string, unknown> => ({
    starters: xi.starters.map((p) => p.uid),
    bench: xi.bench.map((p) => p.uid),
    formation: xi.formation,
    captain: xi.captain,
    vice: xi.vice,
    xpts: Number(xi.xptsTotal.toFixed(2)),
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

    // P2 (v1.4.2): the engine's picked best XI for THIS team, rendered by the
    // same PitchView as Initial/Chips — plus the post-transfer variant when a
    // suggested move is applied
    const xi = pickStartingXi(squad as SquadPlayer[], rules);
    const squadCards = await playerCards(runId, [...xi.starters, ...xi.bench].map((p) => p.uid));
    let applied: { out: string[]; in: string[]; xi: Record<string, unknown>; squad: Record<string, unknown>[] } | null = null;
    if (parsed.data.apply) {
      const outSet = new Set(parsed.data.apply.out);
      const inPlayers = parsed.data.apply.in.map((uid) => byUid.get(uid)).filter((c): c is NonNullable<typeof c> => !!c);
      const afterSquad = [...squad.filter((p) => !outSet.has(p.uid)), ...inPlayers];
      if (afterSquad.length === 15) {
        const afterXi = pickStartingXi(afterSquad as SquadPlayer[], rules);
        applied = {
          out: parsed.data.apply.out,
          in: parsed.data.apply.in,
          xi: xiPayload(afterXi),
          squad: await playerCards(runId, [...afterXi.starters, ...afterXi.bench].map((p) => p.uid)),
        };
      }
    }

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
    // A2 (v1.4.4): sell-urgency from the price model — an imminent predicted
    // fall (tonight's window) outranks the raw transfer counter
    const fromDate = new Date(Date.now() - 12 * 3600_000).toISOString().slice(0, 10);
    const fallPreds = (await db('price_predictions')
      .whereIn('player_uid', teamPlayers)
      .where('for_date', '>=', fromDate)
      .where('direction', 'fall')) as { player_uid: string; p: string }[];
    const fallBy = new Map(fallPreds.map((f) => [f.player_uid, Number(f.p)]));
    const priceRisk = (
      await db('player_matrix as pm')
        .join('players as p', 'p.uid', 'pm.player_uid')
        .where('pm.run_id', runId)
        .whereIn('pm.player_uid', teamPlayers)
        .where((q) => q.where('pm.transfers_in_net', '<', -30000).orWhereIn('pm.player_uid', [...fallBy.keys()]))
        .select('pm.player_uid as uid', 'p.web_name', 'pm.transfers_in_net')
    ).map((r) => ({
      ...r,
      fallP: fallBy.get(r.uid) ?? null,
      urgency: fallBy.has(r.uid) ? ((fallBy.get(r.uid) ?? 0) >= 0.85 ? 'tonight' : 'soon') : 'watch',
    }));

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
      xi: xiPayload(xi),
      squad: squadCards,
      applied,
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

  // B1 (v1.4.3, audit M1/M8): the full match preview — win/draw/loss, top
  // scorelines, clean-sheet odds, and h2h context from OUR OWN fixture
  // history (historical imports), no API dependency
  app.get('/api/fixtures/:uid/preview', async (req, reply) => {
    requireAuth(req);
    const uid = (req.params as { uid: string }).uid;
    const runId = await requireRun();
    const fx = await db('fixtures as f')
      .leftJoin('teams as th', 'th.uid', 'f.home_team_uid')
      .leftJoin('teams as ta', 'ta.uid', 'f.away_team_uid')
      .where('f.fixture_uid', uid)
      .first('f.*', 'th.name as home_name', 'th.short_name as home', 'ta.name as away_name', 'ta.short_name as away');
    if (!fx) return reply.code(404).send({ error: 'fixture not found' });
    const pred = await db('fixture_predictions').where({ run_id: runId, fixture_uid: uid }).first();
    if (!pred) return reply.code(404).send({ error: 'no prediction for this fixture in the latest run' });

    const lh = Number(pred.lambda_home_blend);
    const la = Number(pred.lambda_away_blend);
    const fact = [1, 1, 2, 6, 24, 120, 720];
    const pois = (l: number, k: number): number => (Math.exp(-l) * l ** k) / fact[k]!;
    const scorelines: { score: string; p: number }[] = [];
    for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) scorelines.push({ score: `${i}-${j}`, p: pois(lh, i) * pois(la, j) });
    scorelines.sort((a, b) => b.p - a.p);

    // h2h: the last 5 meetings across every imported season
    const meetings = await db('fixtures')
      .where((q) =>
        q
          .where({ home_team_uid: fx.home_team_uid, away_team_uid: fx.away_team_uid })
          .orWhere({ home_team_uid: fx.away_team_uid, away_team_uid: fx.home_team_uid }),
      )
      .whereIn('state', ['finished', 'checked'])
      .whereNotNull('home_score')
      .orderBy('kickoff_utc', 'desc')
      .limit(5)
      .select('season', 'kickoff_utc', 'home_team_uid', 'home_score', 'away_score');

    // B2 (v1.4.4): predicted XI (our minutes model) + confirmed sheets
    const lineupRows = (await db('lineups').where('fixture_uid', uid).select('team_uid', 'kind', 'formation', 'starters')) as {
      team_uid: string;
      kind: string;
      formation: string | null;
      starters: string[];
    }[];
    const allStarterUids = [...new Set(lineupRows.flatMap((l) => l.starters ?? []))];
    const nameRows =
      allStarterUids.length > 0
        ? ((await db('players').whereIn('uid', allStarterUids).select('uid', 'web_name', 'position')) as { uid: string; web_name: string; position: string }[])
        : [];
    const nameBy = new Map(nameRows.map((r) => [r.uid, r]));
    const sideLineups = (teamUid: string): Record<string, unknown> => {
      const of = (kind: string): unknown => {
        const l = lineupRows.find((r) => r.team_uid === teamUid && r.kind === kind);
        if (!l) return null;
        return { formation: l.formation, starters: (l.starters ?? []).map((u) => nameBy.get(u) ?? { uid: u, web_name: u.slice(0, 10), position: '?' }) };
      };
      return { predicted: of('predicted'), confirmed: of('confirmed') };
    };

    return {
      runId,
      fixture: { uid, event: fx.event, kickoff: fx.kickoff_utc, home: fx.home, away: fx.away, homeName: fx.home_name, awayName: fx.away_name },
      lineups: { home: sideLineups(fx.home_team_uid), away: sideLineups(fx.away_team_uid) },
      probabilities: { home: Number(pred.p_home), draw: Number(pred.p_draw), away: Number(pred.p_away) },
      cleanSheets: { home: Number(pred.p_cs_home), away: Number(pred.p_cs_away) },
      lambdas: { home: lh, away: la },
      topScorelines: scorelines.slice(0, 5).map((s) => ({ score: s.score, p: Number(s.p.toFixed(3)) })),
      oddsUsed: pred.odds_used,
      h2h: meetings.map((m) => ({
        season: m.season,
        kickoff: m.kickoff_utc,
        // orient to THIS fixture's home side
        score: m.home_team_uid === fx.home_team_uid ? `${m.home_score}-${m.away_score}` : `${m.away_score}-${m.home_score}`,
      })),
    };
  });
}
