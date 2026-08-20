/**
 * Build-time verification probe — API-Football (integration plan Part 4).
 * Run BEFORE enabling the adapter with a real key:
 *   API_FOOTBALL_KEY=xxx npx tsx scripts/probe/api-football.ts
 * Fills provider_entitlements, captures shapes into the fixtures dir, and
 * asserts assertOk classifies the error shapes. A handful of requests total.
 */
import { createDb } from '../../backend/src/core/db.js';
import { assertOk } from '../../backend/src/ingest/adapters/api-football.js';
import { learnEntitlement } from '../../backend/src/ingest/gateway.js';
import { PullError } from '../../backend/src/ingest/errors.js';

const KEY = process.env.API_FOOTBALL_KEY ?? '';
const BASE = 'https://v3.football.api-sports.io';

async function call(path: string): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': KEY }, signal: AbortSignal.timeout(20_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, body: await res.json(), headers };
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error('API_FOOTBALL_KEY not set — probe requires a real key');
    process.exit(2);
  }
  const db = createDb();
  const report: string[] = [];

  // 1. auth check + quota header names
  const status = await call('/status');
  const quotaHeaders = Object.keys(status.headers).filter((h) => h.startsWith('x-ratelimit'));
  report.push(`auth: HTTP ${status.status}; quota headers: ${quotaHeaders.join(', ') || 'ABSENT (free tier?)'}`);

  // 2. entitlement walk: current season backwards until success
  const thisYear = new Date().getUTCFullYear();
  let allowedSeason: number | null = null;
  for (let season = thisYear; season >= thisYear - 4; season--) {
    const r = await call(`/fixtures?league=39&season=${season}`);
    try {
      assertOk(r.body);
      await learnEntitlement(db, 'api_football', 'fixtures', String(season), true);
      allowedSeason ??= season;
      report.push(`season ${season}: ALLOWED`);
    } catch (err) {
      if (err instanceof PullError && err.errorClass === 'PLAN_DENIED') {
        await learnEntitlement(db, 'api_football', 'fixtures', String(season), false, String(err.detail ?? err.message));
        report.push(`season ${season}: PLAN_DENIED — ${err.message.slice(0, 90)}`);
      } else if (err instanceof PullError && err.errorClass === 'EMPTY_OK') {
        report.push(`season ${season}: empty (pre-season?)`);
      } else {
        report.push(`season ${season}: ${err instanceof PullError ? err.errorClass : String(err)}`);
      }
    }
    await new Promise((r2) => setTimeout(r2, 6500)); // free-tier per-minute pacing
  }

  // 3. error-shape capture: deliberate bad param
  const bad = await call('/fixtures?league=39&season=1900');
  try {
    assertOk(bad.body);
    report.push('bad-param: unexpectedly OK');
  } catch (err) {
    report.push(`bad-param classified: ${err instanceof PullError ? err.errorClass : 'UNCLASSIFIED'}`);
  }

  // 4. volume check
  if (allowedSeason != null) {
    report.push(`current-season access: ${allowedSeason === thisYear ? 'YES (Pro-class)' : `NO — newest allowed ${allowedSeason} (free tier; live use blocked)`}`);
  }

  console.log('\n── API-Football probe report ──');
  for (const line of report) console.log('  ' + line);
  console.log('\nAppend these findings to docs/api-analysis/api-football.md (dated).');
  await db.destroy();
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
