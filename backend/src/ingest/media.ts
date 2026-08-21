/**
 * Player-photo cache (engineupgradeplus.md C5). The SPA's CSP is
 * img-src 'self' — external photo hosts are blocked BY DESIGN (X2), so
 * photos are cached under DATA_DIR/media/ (never inside the release
 * directory, Rule 1c) and served same-origin by routes/news.ts.
 *
 * Primary source: the official FPL player photo, keyed EXACTLY by
 * fpl_code (p{code}.png) — no name-search ambiguity. Fallback: a
 * TheSportsDB cutout via name search (free key, 10-row cap, throttled).
 * Statistical ingestion only — safe from the scheduler.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Knex } from 'knex';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import type { FetchFn } from './http.js';

const FPL_PHOTO_BASE = 'https://resources.premierleague.com/premierleague/photos/players/110x140';

export function mediaDir(): string {
  return path.join(config.dataDir, 'media', 'players');
}

export function photoPath(fplCode: number): string {
  return path.join(mediaDir(), `p${fplCode}.png`);
}

export function hasPhoto(fplCode: number): boolean {
  try {
    return fs.existsSync(photoPath(fplCode));
  } catch {
    return false;
  }
}

async function fetchToFile(url: string, dest: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    const res = await fetchFn(url, { headers: { 'user-agent': 'fpl-algorithm/1.4' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return false; // placeholder/error page, not a photo
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cache photos for the most relevant players missing one (latest-run rank
 * order). Resumable and cheap: existing files are skipped, one request per
 * missing player, bounded by `limit` per pass.
 */
export async function cachePlayerPhotos(
  db: Knex,
  opts: { limit?: number; fetchFn?: FetchFn } = {},
): Promise<{ checked: number; cached: number; failed: number }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const limit = opts.limit ?? 150;
  fs.mkdirSync(mediaDir(), { recursive: true });

  const latestRun = await db('runs').where('status', 'complete').orderBy('id', 'desc').first('id');
  const players = (await db('players as p')
    .leftJoin('player_matrix as pm', (j) => {
      j.on('pm.player_uid', 'p.uid').andOnVal('pm.run_id', latestRun ? Number(latestRun.id) : -1);
    })
    .whereNotNull('p.fpl_code')
    .whereNotNull('p.team_uid')
    .orderBy(db.raw('pm.rank_overall NULLS LAST'))
    .limit(limit * 3)
    .select('p.uid', 'p.fpl_code', 'p.web_name')) as { uid: string; fpl_code: number; web_name: string }[];

  let checked = 0;
  let cached = 0;
  let failed = 0;
  for (const p of players) {
    if (cached + failed >= limit) break;
    if (hasPhoto(p.fpl_code)) continue;
    checked++;
    const ok = await fetchToFile(`${FPL_PHOTO_BASE}/p${p.fpl_code}.png`, photoPath(p.fpl_code), fetchFn);
    if (ok) {
      cached++;
    } else {
      // TSDB cutout fallback (free key; name search) — best-effort
      const tsdbOk = await tsdbCutout(p.web_name, p.fpl_code, fetchFn);
      if (tsdbOk) cached++;
      else failed++;
    }
    await new Promise((r) => setTimeout(r, 150)); // polite throttle
  }
  if (cached > 0 || failed > 0) log.info({ checked, cached, failed }, 'player photo cache pass');
  return { checked, cached, failed };
}

async function tsdbCutout(name: string, fplCode: number, fetchFn: FetchFn): Promise<boolean> {
  const key = config.keys.thesportsdb || '3';
  try {
    const res = await fetchFn(`https://www.thesportsdb.com/api/v1/json/${key}/searchplayers.php?p=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { player?: { strCutout?: string | null; strThumb?: string | null; strSport?: string }[] } | null;
    const hit = (body?.player ?? []).find((pl) => pl.strSport === 'Soccer' && (pl.strCutout || pl.strThumb));
    if (!hit) return false;
    return fetchToFile((hit.strCutout ?? hit.strThumb)!, photoPath(fplCode), fetchFn);
  } catch {
    return false;
  }
}
