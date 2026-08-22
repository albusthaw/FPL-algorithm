import type { Knex } from 'knex';

/**
 * v1.4.2 — P2 savable builds. Every generated squad (Initial XI, Free Hit,
 * Wildcard, Weekly snapshot) becomes savable: user_teams grows a kind
 * (manual|imported|initial_xi|freehit|wildcard|weekly) and remembers which
 * run priced the build. Additive, forward-only (CLAUDE.md Rule #1).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE user_teams ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual'`);
  await knex.raw(`ALTER TABLE user_teams ADD COLUMN IF NOT EXISTS source_run_id bigint`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS user_teams_kind_idx ON user_teams (user_id, kind)`);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
