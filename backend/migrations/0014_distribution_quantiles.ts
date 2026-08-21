import type { Knex } from 'knex';

/**
 * v1.4.5 — A7 distribution-true variance: per-player Monte Carlo quantiles
 * (P10/P50/P90) on the matrix, so the UI can show floors and ceilings
 * instead of a single mean. Additive, forward-only (CLAUDE.md Rule #1).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE player_matrix ADD COLUMN IF NOT EXISTS p10 numeric(6,3)`);
  await knex.raw(`ALTER TABLE player_matrix ADD COLUMN IF NOT EXISTS p50 numeric(6,3)`);
  await knex.raw(`ALTER TABLE player_matrix ADD COLUMN IF NOT EXISTS p90 numeric(6,3)`);
  // A5: the style writer's computed multipliers live in a jsonb bag beside
  // the 0003 columns (which stay reserved for a stats provider's raw feed)
  await knex.raw(`ALTER TABLE team_style_stats ADD COLUMN IF NOT EXISTS stats jsonb NOT NULL DEFAULT '{}'::jsonb`);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
