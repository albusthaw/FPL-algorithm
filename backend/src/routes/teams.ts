import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';
import { config } from '../core/config.js';
import { parseTeamImage } from '../ai/gateway.js';
import { normaliseName, trigramSimilarity } from '../players/resolver.js';
import { latestCompleteRunId } from './players.js';
import { getConfig } from '../core/model-config.js';
import { valuateTeam } from '../fpl/suggester.js';
import type { OptimiserCandidate } from '../fpl/optimiser.js';
import type { SquadRules } from '../fpl/rules.js';

const TeamPlayerSchema = z.object({
  uid: z.string(),
  slot: z.number().int().min(1).max(15),
  isCaptain: z.boolean().default(false),
  isVice: z.boolean().default(false),
  benchPosition: z.number().int().min(1).max(4).nullable().default(null),
});

const TeamSchema = z.object({
  name: z.string().min(1).max(80),
  bank: z.number().int().min(0).max(2000).default(0),
  freeTransfers: z.number().int().min(0).max(5).default(1),
  chipsUsed: z.array(z.object({ chip: z.string(), set: z.number().int() })).default([]),
  notes: z.string().max(2000).default(''),
  players: z.array(TeamPlayerSchema).max(15).default([]),
});

export async function teamRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  const loadTeam = async (id: number, userId: number): Promise<Record<string, unknown> | null> => {
    const team = await db('user_teams').where({ id, user_id: userId }).first();
    if (!team) return null;
    const players = await db('user_team_players as tp')
      .join('players as p', 'p.uid', 'tp.player_uid')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .where('tp.team_id', id)
      .orderBy('tp.slot')
      .select('tp.*', 'p.web_name', 'p.position', 'p.now_cost as price', 'p.status', 't.short_name as club');
    return { ...team, players };
  };

  app.get('/api/teams', async (req) => {
    requireAuth(req);
    const teams = await db('user_teams').where('user_id', req.user.id).orderBy('updated_at', 'desc');
    const counts = (await db('user_team_players')
      .whereIn('team_id', teams.map((t) => t.id))
      .select('team_id')
      .count({ c: '*' })
      .groupBy('team_id')) as { team_id: number; c: unknown }[];
    const countMap = new Map(counts.map((c) => [c.team_id, Number(c.c)]));
    return { teams: teams.map((t) => ({ ...t, playerCount: countMap.get(t.id) ?? 0 })) };
  });

  app.get('/api/teams/:id', async (req, reply) => {
    requireAuth(req);
    const team = await loadTeam(Number((req.params as { id: string }).id), req.user.id);
    if (!team) return reply.code(404).send({ error: 'team not found' });
    // valuation vs latest run
    const runId = await latestCompleteRunId(db);
    let valuation = null;
    if (runId && (team.players as unknown[]).length === 15) {
      const rules = await getConfig<SquadRules>(db, 'squad_rules');
      const candidates = await candidatesForRun(db, runId);
      const byUid = new Map(candidates.map((c) => [c.uid, c]));
      const squad = (team.players as { player_uid: string }[])
        .map((p) => byUid.get(p.player_uid))
        .filter((c): c is OptimiserCandidate => !!c);
      if (squad.length === 15) {
        const benchmark = candidates
          .slice()
          .sort((a, b) => b.xpts - a.xpts)
          .slice(0, 11)
          .reduce((s, c) => s + c.xpts, 0);
        valuation = valuateTeam(squad, benchmark, rules);
      }
    }
    return { team, valuation };
  });

  app.post('/api/teams', async (req, reply) => {
    requireAuth(req);
    const parsed = TeamSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid team' });
    const [row] = await db('user_teams')
      .insert({
        user_id: req.user.id,
        name: parsed.data.name,
        bank: parsed.data.bank,
        free_transfers: parsed.data.freeTransfers,
        chips_used: JSON.stringify(parsed.data.chipsUsed),
        notes: parsed.data.notes,
      })
      .returning('id');
    const teamId = Number(row.id ?? row);
    await replaceTeamPlayers(db, teamId, parsed.data.players);
    return { team: await loadTeam(teamId, req.user.id) };
  });

  app.put('/api/teams/:id', async (req, reply) => {
    requireAuth(req);
    const id = Number((req.params as { id: string }).id);
    const existing = await db('user_teams').where({ id, user_id: req.user.id }).first();
    if (!existing) return reply.code(404).send({ error: 'team not found' });
    const parsed = TeamSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid team' });
    await db('user_teams').where({ id }).update({
      name: parsed.data.name,
      bank: parsed.data.bank,
      free_transfers: parsed.data.freeTransfers,
      chips_used: JSON.stringify(parsed.data.chipsUsed),
      notes: parsed.data.notes,
      updated_at: db.fn.now(),
    });
    await replaceTeamPlayers(db, id, parsed.data.players);
    return { team: await loadTeam(id, req.user.id) };
  });

  app.delete('/api/teams/:id', async (req, reply) => {
    requireAuth(req);
    const id = Number((req.params as { id: string }).id);
    const existing = await db('user_teams').where({ id, user_id: req.user.id }).first();
    if (!existing) return reply.code(404).send({ error: 'team not found' });
    await db('user_team_players').where('team_id', id).del();
    await db('coverage_reports').where('team_id', id).del();
    await db('chip_recommendations').where('team_id', id).del();
    await db('team_uploads').where('team_id', id).update({ team_id: null });
    await db('user_teams').where({ id }).del();
    return { ok: true };
  });

  app.post('/api/teams/:id/clone', async (req, reply) => {
    requireAuth(req);
    const id = Number((req.params as { id: string }).id);
    const source = await loadTeam(id, req.user.id);
    if (!source) return reply.code(404).send({ error: 'team not found' });
    const [row] = await db('user_teams')
      .insert({
        user_id: req.user.id,
        name: `${source.name} (copy)`,
        bank: source.bank,
        free_transfers: source.free_transfers,
        chips_used: JSON.stringify(source.chips_used ?? []),
        notes: source.notes,
      })
      .returning('id');
    const newId = Number(row.id ?? row);
    for (const p of source.players as Record<string, unknown>[]) {
      await db('user_team_players').insert({
        team_id: newId,
        player_uid: p.player_uid,
        slot: p.slot,
        is_captain: p.is_captain,
        is_vice: p.is_vice,
        bench_position: p.bench_position,
        purchase_price: p.purchase_price,
      });
    }
    return { team: await loadTeam(newId, req.user.id) };
  });

  /**
   * Image upload → vision parse → entity resolution → CONFIRMATION payload.
   * Never auto-trusts OCR: the client must POST /confirm with resolved uids.
   */
  app.post('/api/teams/upload-image', async (req, reply) => {
    requireAuth(req);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no image uploaded' });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      return reply.code(400).send({ error: 'unsupported image type (png/jpeg/webp only)' });
    }
    const buffer = await file.toBuffer();
    // store under DATA_DIR (never inside the release directory)
    const uploadsDir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const filename = `team-${req.user.id}-${Date.now()}.${file.mimetype.split('/')[1]}`;
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);

    let parseResult;
    try {
      parseResult = await parseTeamImage(
        db,
        { triggeredByUserId: req.user.id, triggerKind: 'image_parse' },
        buffer.toString('base64'),
        file.mimetype,
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: (err as Error).message });
    }

    // entity resolution against the player DB with ambiguity pickers
    const players = await db('players as p')
      .leftJoin('teams as t', 't.uid', 'p.team_uid')
      .whereNotNull('p.team_uid')
      .select('p.uid', 'p.web_name', 'p.full_name', 'p.position', 'p.now_cost', 't.short_name as club');
    const resolved = (parseResult.players as { name: string; club: string | null; price: number | null; captain: boolean; vice: boolean; bench_position: number | null }[]).map((parsedPlayer) => {
      const norm = normaliseName(parsedPlayer.name);
      const candidates = players
        .map((p) => ({
          uid: p.uid,
          web_name: p.web_name,
          club: p.club,
          position: p.position,
          price: p.now_cost,
          similarity: Math.max(
            trigramSimilarity(norm, normaliseName(p.web_name)),
            trigramSimilarity(norm, normaliseName(p.full_name)),
          ),
        }))
        .filter((c) => c.similarity >= 0.5)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 4);
      // club co-match promotes confidence
      const withClub = parsedPlayer.club
        ? candidates.filter((c) => c.club?.toLowerCase() === parsedPlayer.club!.toLowerCase())
        : [];
      const best = withClub[0] ?? candidates[0] ?? null;
      const ambiguous =
        !best ||
        best.similarity < 0.85 ||
        (candidates.length > 1 && candidates[1]!.similarity > best.similarity - 0.08 && candidates[1]!.uid !== best.uid);
      return { parsed: parsedPlayer, best: best?.uid ?? null, ambiguous, candidates };
    });

    const [uploadRow] = await db('team_uploads')
      .insert({
        user_id: req.user.id,
        image_path: path.join('uploads', filename),
        parse_result: JSON.stringify({ provider: parseResult.provider, players: parseResult.players, resolved: resolved.map((r) => ({ name: r.parsed.name, best: r.best, ambiguous: r.ambiguous })) }),
        status: 'parsed',
        ai_call_id: parseResult.aiCallId,
      })
      .returning('id');

    return {
      uploadId: Number(uploadRow.id ?? uploadRow),
      credits: parseResult.credits,
      provider: parseResult.provider,
      resolved,
    };
  });

  const ConfirmSchema = z.object({
    uploadId: z.number().int(),
    teamId: z.number().int().nullable().default(null), // null → create new
    name: z.string().max(80).default('Imported team'),
    players: z.array(TeamPlayerSchema).length(15),
  });

  app.post('/api/teams/confirm-upload', async (req, reply) => {
    requireAuth(req);
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid confirmation' });
    const upload = await db('team_uploads').where({ id: parsed.data.uploadId, user_id: req.user.id }).first();
    if (!upload) return reply.code(404).send({ error: 'upload not found' });

    let teamId = parsed.data.teamId;
    if (teamId) {
      const team = await db('user_teams').where({ id: teamId, user_id: req.user.id }).first();
      if (!team) return reply.code(404).send({ error: 'team not found' });
      await db('user_teams').where({ id: teamId }).update({ updated_at: db.fn.now() });
    } else {
      const [row] = await db('user_teams').insert({ user_id: req.user.id, name: parsed.data.name }).returning('id');
      teamId = Number(row.id ?? row);
    }
    await replaceTeamPlayers(db, teamId, parsed.data.players);
    await db('team_uploads').where('id', upload.id).update({ status: 'confirmed', team_id: teamId });
    return { team: await loadTeam(teamId, req.user.id) };
  });
}

async function replaceTeamPlayers(
  db: Knex,
  teamId: number,
  players: { uid: string; slot: number; isCaptain: boolean; isVice: boolean; benchPosition: number | null }[],
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('user_team_players').where('team_id', teamId).del();
    for (const p of players) {
      await trx('user_team_players').insert({
        team_id: teamId,
        player_uid: p.uid,
        slot: p.slot,
        is_captain: p.isCaptain,
        is_vice: p.isVice,
        bench_position: p.benchPosition,
      });
    }
  });
}

/** Shared: build optimiser candidates from a run's matrix + next-event predictions. */
export async function candidatesForRun(db: Knex, runId: number, horizon: 1 | 3 | 6 = 3): Promise<OptimiserCandidate[]> {
  const col = horizon === 1 ? 'xpts_next1' : horizon === 3 ? 'xpts_next3' : 'xpts_next6';
  const rows = await db('player_matrix as pm')
    .join('players as p', 'p.uid', 'pm.player_uid')
    .leftJoin('teams as t', 't.uid', 'p.team_uid')
    .where('pm.run_id', runId)
    .select('pm.player_uid as uid', 'p.position', 't.short_name as club', 'pm.price', db.raw(`pm.${col} as xpts`), 'pm.p_start_xi');
  return rows
    .filter((r) => r.club)
    .map((r) => ({
      uid: r.uid,
      position: r.position,
      club: r.club,
      price: r.price,
      xpts: Number(r.xpts),
      pStart: Number(r.p_start_xi),
    }));
}
