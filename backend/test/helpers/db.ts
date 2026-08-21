import knexFactory, { type Knex } from 'knex';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://fpl:fpl@127.0.0.1:5432/fpl_algorithm_test';

export async function testDb(): Promise<Knex> {
  const { createDb, runMigrations } = await import('../../src/core/db.js');
  const db = createDb(process.env.DATABASE_URL);
  await runMigrations(db);
  const { seedModelConfig } = await import('../../src/core/model-config.js');
  const { registerFeatures } = await import('../../src/core/kernel.js');
  const { seedProviders } = await import('../../src/ingest/registry.js');
  await seedModelConfig(db);
  await registerFeatures(db);
  await seedProviders(db);
  return db;
}

/** Truncate mutable tables between suites (keeps migrations + seeds). */
export async function truncateAll(db: Knex): Promise<void> {
  await db.raw(`
    TRUNCATE users, sessions, token_ledger, auth_events, login_throttle,
      players, teams, player_identities, player_aliases, player_position_history, resolution_queue,
      raw_payloads, api_pull_log, quarantine_rows, provider_entitlements, pull_jobs,
      fixtures, gameweeks, news_items, news_player_map, injuries, price_events,
      availability_state, lineups, odds_snapshots, set_piece_roles, team_style_stats, field_audit,
      runs, player_match_stats, player_season_history, team_strength_fits,
      fixture_predictions, player_fixture_predictions, feature_store, player_matrix, model_runs, model_errors,
      ai_calls, ai_verdict_cache, ai_exclusions,
      user_teams, user_team_players, team_uploads,
      match_insights, target_lists, coverage_reports, chip_recommendations,
      history_pulls, key_audit,
      api_providers, ai_providers
    RESTART IDENTITY CASCADE`);
}
