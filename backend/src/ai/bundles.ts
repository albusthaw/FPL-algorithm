/**
 * News-bundle builder for the AI pass — lives in the AI layer so the run
 * scheduler's import graph stays provably AI-free (fpl-project.md §7.0).
 */
import type { Knex } from 'knex';
import { buildMatrixLine } from './prompt.js';
import type { PlayerNewsBundle } from './types.js';

/**
 * Build compact PlayerNewsBundles: only-new-since-last-analysis news per
 * player, source-tier ordered.
 */
export async function buildNewsBundles(db: Knex, runId: number): Promise<PlayerNewsBundle[]> {
  const matrix = await db('player_matrix as pm')
    .join('players as p', 'p.uid', 'pm.player_uid')
    .leftJoin('teams as t', 't.uid', 'p.team_uid')
    .where('pm.run_id', runId)
    .select(
      'pm.player_uid',
      'pm.stat_score',
      'pm.xpts_next3',
      'pm.p_start_xi',
      'pm.form_ewma',
      'pm.injury_status',
      'pm.price',
      'p.web_name',
      'p.position',
      't.short_name as club',
    );

  // last analysed timestamp per player (verdict cache created_at)
  const lastAnalysed = new Map<string, Date>(
    ((
      await db('ai_verdict_cache')
        .select('player_uid')
        .max({ at: 'created_at' })
        .groupBy('player_uid')
    ) as { player_uid: string; at: unknown }[]).map((r) => [r.player_uid, new Date(r.at as string)]),
  );

  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const newsRows = await db('news_player_map as m')
    .join('news_items as n', 'n.id', 'm.news_id')
    .where('n.fetched_at', '>', cutoff)
    .select('m.player_uid', 'n.id', 'n.title', 'n.description', 'n.source_name', 'n.source_tier', 'n.published_at', 'n.fetched_at')
    .orderBy('n.source_tier', 'asc')
    .orderBy('n.published_at', 'desc');
  const newsByPlayer = new Map<string, typeof newsRows>();
  for (const n of newsRows) {
    const last = lastAnalysed.get(n.player_uid);
    if (last && new Date(n.fetched_at) <= last) continue; // only NEW news
    (newsByPlayer.get(n.player_uid) ?? newsByPlayer.set(n.player_uid, []).get(n.player_uid)!).push(n);
  }

  return matrix.map((m) => ({
    playerUid: m.player_uid,
    webName: m.web_name,
    position: m.position,
    club: m.club ?? '',
    price: m.price,
    matrixLine: buildMatrixLine({
      uid: m.player_uid,
      position: m.position,
      club: m.club ?? '',
      price: m.price,
      statScore: Number(m.stat_score),
      xptsNext3: Number(m.xpts_next3),
      pStart: Number(m.p_start_xi),
      form: Number(m.form_ewma),
      status: m.injury_status,
    }),
    news: (newsByPlayer.get(m.player_uid) ?? []).map((n) => ({
      id: n.id,
      title: n.title,
      snippet: n.description ?? '',
      source: n.source_name || 'unknown',
      ageHours: (Date.now() - new Date(n.published_at ?? n.fetched_at).getTime()) / 3600_000,
    })),
  }));
}
