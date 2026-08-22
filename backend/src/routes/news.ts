/**
 * News product surface (engineupgradeplus.md C5 — closes audit N6's "no
 * user-facing news surface"): the dashboard feed, the per-player timeline,
 * and same-origin photo serving (CSP img-src 'self' blocks external hosts
 * by design — photos come from the DATA_DIR/media cache).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { requireAuth } from './auth.js';
import { mediaDir, hasPhoto } from '../ingest/media.js';

export async function newsRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  // dashboard feed: newest story representatives with linked players + signals
  app.get('/api/news/feed', async (req) => {
    requireAuth(req);
    const q = req.query as { limit?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit ?? 25)));
    // one representative per story: the earliest item is the story root —
    // show the ROOT (id = story_id) with the story's corroboration count
    const items = (await db.raw(
      `SELECT n.id, n.title, n.description, n.source_name, n.source_domain, n.source_tier,
              n.published_at, n.fetched_at, n.signals, n.story_id,
              (SELECT count(*) FROM news_items s WHERE s.story_id = n.story_id) AS story_items
       FROM news_items n
       WHERE n.id = n.story_id OR n.story_id IS NULL
       ORDER BY COALESCE(n.published_at, n.fetched_at) DESC
       LIMIT ?`,
      [limit],
    )) as { rows: Record<string, unknown>[] };
    const ids = items.rows.map((r) => Number(r.id));
    const links =
      ids.length === 0
        ? []
        : ((await db('news_player_map as m')
            .join('players as p', 'p.uid', 'm.player_uid')
            .join('news_items as n', 'n.id', 'm.news_id')
            .whereIn(db.raw('COALESCE(n.story_id, n.id)') as never, ids)
            .select('m.player_uid', 'p.web_name', 'p.fpl_code', db.raw('COALESCE(n.story_id, n.id) as root_id'))) as {
            player_uid: string;
            web_name: string;
            fpl_code: number;
            root_id: number;
          }[]);
    const byRoot = new Map<number, { uid: string; web_name: string; fpl_code: number }[]>();
    for (const l of links) {
      const arr = byRoot.get(Number(l.root_id)) ?? byRoot.set(Number(l.root_id), []).get(Number(l.root_id))!;
      if (!arr.some((x) => x.uid === l.player_uid)) arr.push({ uid: l.player_uid, web_name: l.web_name, fpl_code: l.fpl_code });
    }
    return {
      feed: items.rows.map((r) => ({
        ...r,
        players: (byRoot.get(Number(r.id)) ?? []).slice(0, 6).map((p) => ({ ...p, photo: hasPhoto(p.fpl_code) ? `/api/media/players/${p.fpl_code}.png` : null })),
      })),
    };
  });

  // per-player timeline: every linked item, story-deduped, with signals
  app.get('/api/players/:uid/news', async (req, reply) => {
    requireAuth(req);
    const uid = (req.params as { uid: string }).uid;
    const player = await db('players').where('uid', uid).first('uid', 'web_name', 'fpl_code');
    if (!player) return reply.code(404).send({ error: 'player not found' });
    const rows = (await db('news_player_map as m')
      .join('news_items as n', 'n.id', 'm.news_id')
      .where('m.player_uid', uid)
      .orderBy(db.raw('COALESCE(n.published_at, n.fetched_at)') as never, 'desc')
      .limit(120)
      .select('n.id', 'n.story_id', 'n.title', 'n.description', 'n.source_name', 'n.source_domain', 'n.source_tier', 'n.published_at', 'n.fetched_at', 'n.signals', 'n.seen_count', 'm.match_kind', 'm.confidence')) as Record<string, unknown>[];
    // one representative per story (best tier arrives first per the sort? no —
    // newest first; keep the newest item per story, count corroboration)
    const seen = new Map<number, { corroboration: number }>();
    const timeline: Record<string, unknown>[] = [];
    for (const r of rows) {
      const root = Number(r.story_id ?? r.id);
      const s = seen.get(root);
      if (s) {
        s.corroboration++;
        continue;
      }
      seen.set(root, { corroboration: 1 });
      timeline.push(r);
    }
    for (const t of timeline) t.corroboration = seen.get(Number(t.story_id ?? t.id))!.corroboration;
    return {
      player: { ...player, photo: hasPhoto(player.fpl_code) ? `/api/media/players/${player.fpl_code}.png` : null },
      timeline: timeline.slice(0, 40),
    };
  });

  // same-origin photo serving from the DATA_DIR/media cache (X2/CSP)
  app.get('/api/media/players/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^p\d+\.png$/.test(file)) return reply.code(400).send({ error: 'bad media path' });
    const full = path.join(mediaDir(), file);
    if (!fs.existsSync(full)) return reply.code(404).send({ error: 'not cached' });
    reply.header('Content-Type', 'image/png');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(full));
  });
}
