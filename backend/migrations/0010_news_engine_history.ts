import type { Knex } from 'knex';

/**
 * v1.4.0 — news storage engine + indexer, and historical-depth backfill.
 * Additive, forward-only (CLAUDE.md Rule #1): new columns on news_items
 * (story clustering, signal classification, index bookkeeping), a
 * full-text index, per-season career aggregates from the FPL API, and a
 * resumable backfill ledger.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS story_id bigint`);
  await knex.raw(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS seen_count int NOT NULL DEFAULT 1`);
  await knex.raw(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`);
  await knex.raw(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS indexed_at timestamptz`);
  await knex.raw(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS signals jsonb NOT NULL DEFAULT '[]'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS news_items_story_idx ON news_items (story_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS news_items_fetched_idx ON news_items (fetched_at)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS news_items_unindexed_idx ON news_items (indexed_at) WHERE indexed_at IS NULL`);
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS news_items_fts_idx ON news_items
     USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')))`,
  );

  // evidence for news-driven human-factor adjustments, per run
  await knex.raw(`ALTER TABLE player_matrix ADD COLUMN IF NOT EXISTS human_signals jsonb`);

  // FPL element-summary history_past lands in the EXISTING (0004)
  // player_season_history table (player_uid, season, stats jsonb, source) —
  // no reshape needed; just make lookups by player fast
  await knex.raw(`CREATE INDEX IF NOT EXISTS player_season_history_player_idx ON player_season_history (player_uid)`);

  // the human_factors config row exists on upgraded installs and boot-time
  // seeding only inserts MISSING keys — merge the new news_signals sub-key
  // into rows that lack it (pure default data; user tweaks are preserved)
  await knex.raw(`
    UPDATE model_config
    SET value = value::jsonb || '{"news_signals": {
      "window_days": 10,
      "clamp": [0.9, 1.03],
      "corroboration": {"require_tier": 2, "min_items": 2},
      "categories": {
        "disciplinary":      {"n1": 0.96, "n3": 0.97,  "n6": 0.98},
        "unprofessional":    {"n1": 0.96, "n3": 0.97,  "n6": 0.98},
        "transfer_talk":     {"n1": 0.98, "n3": 0.975, "n6": 0.97},
        "contract_dispute":  {"n1": 0.99, "n3": 0.985, "n6": 0.98},
        "personal_event":    {"n1": 0.96, "n3": 0.98,  "n6": 0.99},
        "morale_boost":      {"n1": 1.02, "n3": 1.015, "n6": 1.01},
        "managerial_change": {"n1": 0.98, "n3": 0.99,  "n6": 1.0}
      }
    }}'::jsonb
    WHERE key = 'human_factors' AND NOT jsonb_exists(value::jsonb, 'news_signals')
  `);

  // resumable backfill ledger: one row per (provider, scope), e.g.
  // ('vaastav', '2018-19') or ('fpl', 'history_past')
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS history_pulls (
      id bigserial PRIMARY KEY,
      provider text NOT NULL,
      scope text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      records int NOT NULL DEFAULT 0,
      detail text,
      started_at timestamptz,
      finished_at timestamptz,
      UNIQUE (provider, scope)
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
