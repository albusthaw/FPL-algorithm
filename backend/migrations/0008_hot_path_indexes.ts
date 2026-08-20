import type { Knex } from 'knex';

/**
 * v1.0.1 — indexes for the hot read paths observed in v1.0.0:
 * news recency scans (BatchPlanner), verdict-cache lookups by player, and
 * ledger listing. Purely additive (Rule #1: forward-only, never destructive).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS news_items_fetched_idx ON news_items(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS ai_verdict_cache_player_idx ON ai_verdict_cache(player_uid, created_at DESC);
    CREATE INDEX IF NOT EXISTS ai_calls_created_idx ON ai_calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS pms_fixture_idx ON player_match_stats(fixture_uid);
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
