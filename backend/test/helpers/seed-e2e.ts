/**
 * E2E seed: test users, the mock AI provider alive, and a season-correct
 * 15-man roster for the mock vision parse (built from the live player DB —
 * hardcoded names churn every season).
 *   npx tsx test/helpers/seed-e2e.ts
 */
import { db } from '../../src/core/db.js';
import { hashPassword } from '../../src/auth/auth.js';
import { setAliveProvider } from '../../src/ai/gateway.js';

async function ensureUser(email: string, name: string, password: string, role: string, tokens: number): Promise<void> {
  const existing = await db('users').where({ email }).first();
  if (!existing) {
    await db('users').insert({ email, name, password_hash: await hashPassword(password), role, token_balance: tokens });
  }
}

async function buildRoster(): Promise<Record<string, unknown>[]> {
  const pick = async (position: string, n: number): Promise<{ web_name: string; club: string; now_cost: number }[]> =>
    db('players as p')
      .join('teams as t', 't.uid', 'p.team_uid')
      .where('p.position', position)
      .where('p.status', 'a')
      .orderBy('p.selected_by_percent', 'desc')
      .limit(n * 3)
      .select('p.web_name', 't.short_name as club', 'p.now_cost');

  // valid squad shape with ≤3/club, ordered by ownership
  const clubCount: Record<string, number> = {};
  const take = (pool: { web_name: string; club: string; now_cost: number }[], n: number): typeof pool => {
    const out: typeof pool = [];
    for (const p of pool) {
      if (out.length >= n) break;
      if ((clubCount[p.club] ?? 0) >= 3) continue;
      clubCount[p.club] = (clubCount[p.club] ?? 0) + 1;
      out.push(p);
    }
    return out;
  };
  const gks = take(await pick('GK', 2), 2);
  const defs = take(await pick('DEF', 5), 5);
  const mids = take(await pick('MID', 5), 5);
  const fwds = take(await pick('FWD', 3), 3);
  const squad = [...gks, ...defs, ...mids, ...fwds];
  if (squad.length !== 15) throw new Error(`roster build got ${squad.length}/15 — run sync-fpl first`);

  // starters: GK1, DEF 1-4, MID 1-4, FWD 1-2; bench: GK2 + DEF5 + MID5 + FWD3
  const benchIdx = new Map<number, number>([
    [1, 1], // second GK
    [6, 2], // fifth DEF
    [11, 3], // fifth MID
    [14, 4], // third FWD
  ]);
  return squad.map((p, i) => ({
    name: p.web_name,
    club: p.club,
    price: p.now_cost / 10,
    captain: i === 7, // first MID starter
    vice: i === 8,
    bench_position: benchIdx.get(i) ?? null,
  }));
}

await ensureUser('admin@fpl.test', 'E2E Admin', 'admin-password-123', 'admin', 0);
await ensureUser('user@fpl.test', 'E2E User', 'user-password-1234', 'user', 1000);
const roster = await buildRoster();
await db('ai_providers').where({ key: 'mock' }).update({ config: JSON.stringify({ roster }) });
await setAliveProvider(db, 'mock');
console.log('e2e seed done — mock roster:', roster.map((r) => r.name).join(', '));
await db.destroy();
