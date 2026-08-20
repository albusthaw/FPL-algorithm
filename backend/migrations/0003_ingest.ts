import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS api_providers (
      key                text PRIMARY KEY,
      name               text NOT NULL,
      enabled            bool NOT NULL DEFAULT false,
      state              text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','degraded','error')),
      capabilities       text[] NOT NULL DEFAULT '{}',
      quota_used         int NOT NULL DEFAULT 0,
      quota_limit        int,
      quota_reset_at     timestamptz,
      circuit_failures   int NOT NULL DEFAULT 0,
      circuit_open_until timestamptz,
      config             jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at         timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS raw_payloads (
      id          bigserial PRIMARY KEY,
      provider    text NOT NULL,
      endpoint    text NOT NULL,
      params_hash text NOT NULL,
      fetched_at  timestamptz NOT NULL DEFAULT now(),
      http_status int NOT NULL,
      body        jsonb,
      body_text   text,
      body_sha256 text NOT NULL,
      unchanged   bool NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS raw_payloads_lookup_idx
      ON raw_payloads(provider, endpoint, params_hash, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS api_pull_log (
      id             bigserial PRIMARY KEY,
      provider       text NOT NULL,
      capability     text NOT NULL,
      endpoint       text NOT NULL,
      params         jsonb NOT NULL DEFAULT '{}'::jsonb,
      records        int NOT NULL DEFAULT 0,
      quota_consumed int NOT NULL DEFAULT 1,
      latency_ms     int NOT NULL DEFAULT 0,
      status         text NOT NULL CHECK (status IN ('ok','degraded','failed','empty_ok')),
      error_class    text,
      error_detail   text,
      quota_headers  jsonb,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS api_pull_log_provider_idx ON api_pull_log(provider, created_at DESC);

    CREATE TABLE IF NOT EXISTS quarantine_rows (
      id             bigserial PRIMARY KEY,
      provider       text NOT NULL,
      endpoint       text NOT NULL,
      raw_payload_id bigint REFERENCES raw_payloads(id),
      row            jsonb NOT NULL,
      errors         jsonb NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS provider_entitlements (
      id         bigserial PRIMARY KEY,
      provider   text NOT NULL,
      endpoint   text NOT NULL,
      params_key text NOT NULL,
      allowed    bool NOT NULL,
      detail     text,
      learned_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, endpoint, params_key)
    );

    CREATE TABLE IF NOT EXISTS pull_jobs (
      id                bigserial PRIMARY KEY,
      provider          text NOT NULL,
      capability        text NOT NULL,
      endpoint_template text NOT NULL,
      params            jsonb NOT NULL DEFAULT '{}'::jsonb,
      cadence           text NOT NULL,
      enabled           bool NOT NULL DEFAULT true,
      last_run_at       timestamptz,
      last_status       text
    );

    CREATE TABLE IF NOT EXISTS fixtures (
      fixture_uid    text PRIMARY KEY,
      season         text NOT NULL DEFAULT '',
      fpl_fixture_id int,
      fpl_code       bigint,
      event          int,
      home_team_uid  text NOT NULL REFERENCES teams(uid),
      away_team_uid  text NOT NULL REFERENCES teams(uid),
      kickoff_utc    timestamptz,
      state          text NOT NULL DEFAULT 'scheduled'
                     CHECK (state IN ('scheduled','live','finished','checked','postponed')),
      home_score     int,
      away_score     int,
      fpl_fdr_h      int,
      fpl_fdr_a      int,
      stats          jsonb NOT NULL DEFAULT '{}'::jsonb,
      as_of          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (season, fpl_fixture_id)
    );
    CREATE INDEX IF NOT EXISTS fixtures_event_idx ON fixtures(event);
    CREATE INDEX IF NOT EXISTS fixtures_teams_idx ON fixtures(home_team_uid, away_team_uid);

    CREATE TABLE IF NOT EXISTS gameweeks (
      id                  int PRIMARY KEY,
      name                text NOT NULL,
      deadline_time       timestamptz NOT NULL,
      finished            bool NOT NULL DEFAULT false,
      data_checked        bool NOT NULL DEFAULT false,
      is_current          bool NOT NULL DEFAULT false,
      is_next             bool NOT NULL DEFAULT false,
      average_entry_score int,
      as_of               timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id            bigserial PRIMARY KEY,
      provider      text NOT NULL,
      external_id   text,
      url           text NOT NULL,
      url_canonical text NOT NULL UNIQUE,
      title         text NOT NULL,
      description   text NOT NULL DEFAULT '',
      content       text NOT NULL DEFAULT '',
      source_name   text NOT NULL DEFAULT '',
      source_domain text NOT NULL DEFAULT '',
      source_tier   int NOT NULL DEFAULT 3,
      published_at  timestamptz,
      fetched_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS news_items_published_idx ON news_items(published_at DESC);

    CREATE TABLE IF NOT EXISTS news_player_map (
      id         bigserial PRIMARY KEY,
      news_id    bigint NOT NULL REFERENCES news_items(id),
      player_uid text NOT NULL REFERENCES players(uid),
      match_kind text NOT NULL CHECK (match_kind IN ('alias_exact','alias_fuzzy','club_context')),
      confidence numeric(4,2) NOT NULL DEFAULT 1.00,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (news_id, player_uid)
    );
    CREATE INDEX IF NOT EXISTS news_player_map_player_idx ON news_player_map(player_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS injuries (
      id                   bigserial PRIMARY KEY,
      player_uid           text NOT NULL REFERENCES players(uid),
      source               text NOT NULL,
      kind                 text NOT NULL CHECK (kind IN ('injury','illness','suspension','other')),
      reason               text NOT NULL DEFAULT '',
      start_date           date,
      expected_return_date date,
      actual_return_date   date,
      fixture_scope        int[] NOT NULL DEFAULT '{}',
      severity_class       text NOT NULL DEFAULT 'moderate'
                           CHECK (severity_class IN ('minor','moderate','major')),
      confidence           numeric(4,2) NOT NULL DEFAULT 0.80,
      is_active            bool NOT NULL DEFAULT true,
      superseded_by        bigint,
      as_of                timestamptz NOT NULL DEFAULT now(),
      created_at           timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS injuries_player_idx ON injuries(player_uid, is_active);

    CREATE TABLE IF NOT EXISTS price_events (
      id         bigserial PRIMARY KEY,
      player_uid text NOT NULL REFERENCES players(uid),
      event_date date NOT NULL,
      old_cost   int NOT NULL,
      new_cost   int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS availability_state (
      id          bigserial PRIMARY KEY,
      player_uid  text NOT NULL REFERENCES players(uid),
      fixture_uid text REFERENCES fixtures(fixture_uid),
      p_available numeric(4,3) NOT NULL,
      state       text NOT NULL,
      evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
      conflict    bool NOT NULL DEFAULT false,
      as_of       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (player_uid, fixture_uid)
    );

    CREATE TABLE IF NOT EXISTS lineups (
      id          bigserial PRIMARY KEY,
      fixture_uid text NOT NULL REFERENCES fixtures(fixture_uid),
      team_uid    text NOT NULL REFERENCES teams(uid),
      kind        text NOT NULL CHECK (kind IN ('predicted','confirmed')),
      formation   text,
      starters    jsonb NOT NULL DEFAULT '[]'::jsonb,
      bench       jsonb NOT NULL DEFAULT '[]'::jsonb,
      as_of       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (fixture_uid, team_uid, kind)
    );

    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id          bigserial PRIMARY KEY,
      fixture_uid text NOT NULL REFERENCES fixtures(fixture_uid),
      bookmaker   text NOT NULL,
      market      text NOT NULL,
      line        numeric(6,2),
      prices      jsonb NOT NULL,
      taken_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS odds_snapshots_fixture_idx ON odds_snapshots(fixture_uid, taken_at DESC);

    CREATE TABLE IF NOT EXISTS set_piece_roles (
      id            bigserial PRIMARY KEY,
      player_uid    text NOT NULL UNIQUE REFERENCES players(uid),
      pens_order    int,
      dfk_order     int,
      corners_order int,
      source        text NOT NULL DEFAULT 'fpl' CHECK (source IN ('fpl','admin_override')),
      as_of         timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS team_style_stats (
      id           bigserial PRIMARY KEY,
      team_uid     text NOT NULL REFERENCES teams(uid),
      stat_window  text NOT NULL,
      possession   numeric(5,2),
      ppda         numeric(6,2),
      deep         numeric(7,2),
      deep_allowed numeric(7,2),
      as_of        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (team_uid, stat_window)
    );

    CREATE TABLE IF NOT EXISTS field_audit (
      id         bigserial PRIMARY KEY,
      table_name text NOT NULL,
      row_key    text NOT NULL,
      field      text NOT NULL,
      old_value  text,
      new_value  text,
      source     text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
