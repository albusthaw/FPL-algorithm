import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS runs (
      id               bigserial PRIMARY KEY,
      kind             text NOT NULL DEFAULT 'full'
                       CHECK (kind IN ('full','mini_lineup','micro_nightly','backtest')),
      status           text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','complete','failed')),
      triggered_by     bigint REFERENCES users(id),
      gameweek         int,
      providers_used   jsonb NOT NULL DEFAULT '[]'::jsonb,
      ai_provider      text,
      ai_skipped       bool NOT NULL DEFAULT false,
      tokens_prompt    bigint NOT NULL DEFAULT 0,
      tokens_completion bigint NOT NULL DEFAULT 0,
      tokens_cached    bigint NOT NULL DEFAULT 0,
      credits          bigint NOT NULL DEFAULT 0,
      players_analysed int NOT NULL DEFAULT 0,
      players_skipped  int NOT NULL DEFAULT 0,
      stages           jsonb NOT NULL DEFAULT '{}'::jsonb,
      degradations     jsonb NOT NULL DEFAULT '[]'::jsonb,
      error            jsonb,
      config_version   int,
      started_at       timestamptz NOT NULL DEFAULT now(),
      finished_at      timestamptz
    );
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS player_match_stats (
      player_uid   text NOT NULL REFERENCES players(uid),
      fixture_uid  text NOT NULL REFERENCES fixtures(fixture_uid),
      event        int,
      season       text NOT NULL DEFAULT '',
      opponent_uid text,
      was_home     bool,
      minutes      int NOT NULL DEFAULT 0,
      starts       bool NOT NULL DEFAULT false,
      goals        int NOT NULL DEFAULT 0,
      assists      int NOT NULL DEFAULT 0,
      cs           bool NOT NULL DEFAULT false,
      conceded     int NOT NULL DEFAULT 0,
      og           int NOT NULL DEFAULT 0,
      pen_saved    int NOT NULL DEFAULT 0,
      pen_missed   int NOT NULL DEFAULT 0,
      yc           int NOT NULL DEFAULT 0,
      rc           int NOT NULL DEFAULT 0,
      saves        int NOT NULL DEFAULT 0,
      bonus        int NOT NULL DEFAULT 0,
      bps          int NOT NULL DEFAULT 0,
      defcon_count int NOT NULL DEFAULT 0,
      cbit         int NOT NULL DEFAULT 0,
      cbirt        int NOT NULL DEFAULT 0,
      recoveries   int NOT NULL DEFAULT 0,
      tackles      int NOT NULL DEFAULT 0,
      xg           numeric(6,3),
      xa           numeric(6,3),
      xgi          numeric(6,3),
      xgc          numeric(6,3),
      npxg         numeric(6,3),
      xgchain      numeric(6,3),
      xgbuildup    numeric(6,3),
      key_passes   int,
      shots        int,
      fpl_points   int NOT NULL DEFAULT 0,
      price_at_gw  int,
      kickoff_utc  timestamptz,
      provenance   jsonb NOT NULL DEFAULT '{}'::jsonb,
      as_of        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (player_uid, fixture_uid)
    );
    CREATE INDEX IF NOT EXISTS pms_player_time_idx ON player_match_stats(player_uid, kickoff_utc DESC);

    CREATE TABLE IF NOT EXISTS player_season_history (
      id         bigserial PRIMARY KEY,
      player_uid text NOT NULL REFERENCES players(uid),
      season     text NOT NULL,
      stats      jsonb NOT NULL DEFAULT '{}'::jsonb,
      source     text NOT NULL DEFAULT 'fpl',
      as_of      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (player_uid, season)
    );

    CREATE TABLE IF NOT EXISTS team_strength_fits (
      id        bigserial PRIMARY KEY,
      run_id    bigint REFERENCES runs(id),
      method    text NOT NULL DEFAULT 'dixon_coles',
      params    jsonb NOT NULL,
      metrics    jsonb NOT NULL DEFAULT '{}'::jsonb,
      fit_window text NOT NULL DEFAULT '',
      fitted_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fixture_predictions (
      id             bigserial PRIMARY KEY,
      run_id         bigint NOT NULL REFERENCES runs(id),
      fixture_uid    text NOT NULL REFERENCES fixtures(fixture_uid),
      event          int,
      lambda_home    numeric(6,3) NOT NULL,
      lambda_away    numeric(6,3) NOT NULL,
      lambda_home_blend numeric(6,3) NOT NULL,
      lambda_away_blend numeric(6,3) NOT NULL,
      p_home         numeric(5,4) NOT NULL,
      p_draw         numeric(5,4) NOT NULL,
      p_away         numeric(5,4) NOT NULL,
      p_cs_home      numeric(5,4) NOT NULL,
      p_cs_away      numeric(5,4) NOT NULL,
      concession_home jsonb NOT NULL DEFAULT '{}'::jsonb,
      concession_away jsonb NOT NULL DEFAULT '{}'::jsonb,
      fdr_att_home   numeric(4,2),
      fdr_att_away   numeric(4,2),
      fdr_def_home   numeric(4,2),
      fdr_def_away   numeric(4,2),
      odds_used      bool NOT NULL DEFAULT false,
      created_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, fixture_uid)
    );

    CREATE TABLE IF NOT EXISTS player_fixture_predictions (
      id          bigserial PRIMARY KEY,
      run_id      bigint NOT NULL REFERENCES runs(id),
      player_uid  text NOT NULL REFERENCES players(uid),
      fixture_uid text NOT NULL REFERENCES fixtures(fixture_uid),
      event       int,
      p_start     numeric(5,4) NOT NULL,
      p60         numeric(5,4) NOT NULL,
      p_any       numeric(5,4) NOT NULL,
      e_min       numeric(5,2) NOT NULL,
      e_goals     numeric(6,4) NOT NULL DEFAULT 0,
      e_assists   numeric(6,4) NOT NULL DEFAULT 0,
      p_cs        numeric(5,4) NOT NULL DEFAULT 0,
      p_defcon    numeric(5,4) NOT NULL DEFAULT 0,
      e_saves     numeric(6,3) NOT NULL DEFAULT 0,
      e_bonus     numeric(5,3) NOT NULL DEFAULT 0,
      xpts        numeric(6,3) NOT NULL,
      variance    numeric(8,4) NOT NULL DEFAULT 0,
      components  jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, player_uid, fixture_uid)
    );
    CREATE INDEX IF NOT EXISTS pfp_run_event_idx ON player_fixture_predictions(run_id, event);

    CREATE TABLE IF NOT EXISTS feature_store (
      id              bigserial PRIMARY KEY,
      player_uid      text NOT NULL REFERENCES players(uid),
      fixture_uid     text REFERENCES fixtures(fixture_uid),
      as_of           timestamptz NOT NULL,
      feature_version int NOT NULL DEFAULT 1,
      features        jsonb NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS feature_store_idx ON feature_store(player_uid, fixture_uid, feature_version);

    CREATE TABLE IF NOT EXISTS player_matrix (
      id                 bigserial PRIMARY KEY,
      run_id             bigint NOT NULL REFERENCES runs(id),
      player_uid         text NOT NULL REFERENCES players(uid),
      gameweek           int,
      computed_at        timestamptz NOT NULL DEFAULT now(),
      p_start_xi         numeric(5,4) NOT NULL DEFAULT 0,
      p_appearance       numeric(5,4) NOT NULL DEFAULT 0,
      injury_status      text NOT NULL DEFAULT 'fit',
      injury_detail      text NOT NULL DEFAULT '',
      xg_per90           numeric(6,3) NOT NULL DEFAULT 0,
      xa_per90           numeric(6,3) NOT NULL DEFAULT 0,
      xgi_per90          numeric(6,3) NOT NULL DEFAULT 0,
      shots_per90        numeric(6,3) NOT NULL DEFAULT 0,
      key_passes_per90   numeric(6,3) NOT NULL DEFAULT 0,
      npxg_per90         numeric(6,3) NOT NULL DEFAULT 0,
      xcs                numeric(5,4) NOT NULL DEFAULT 0,
      saves_per90        numeric(6,3) NOT NULL DEFAULT 0,
      defcon_per90       numeric(6,3) NOT NULL DEFAULT 0,
      price              int NOT NULL DEFAULT 0,
      selected_by_pct    numeric(6,2) NOT NULL DEFAULT 0,
      price_change_trend int NOT NULL DEFAULT 0,
      transfers_in_net   int NOT NULL DEFAULT 0,
      form_ewma          numeric(6,3) NOT NULL DEFAULT 0,
      minutes_trend      numeric(6,2) NOT NULL DEFAULT 0,
      fdr_next1          numeric(4,2),
      fdr_next3          numeric(4,2),
      fdr_next6          numeric(4,2),
      xpts_next1         numeric(6,3) NOT NULL DEFAULT 0,
      xpts_next3         numeric(6,3) NOT NULL DEFAULT 0,
      xpts_next6         numeric(6,3) NOT NULL DEFAULT 0,
      xpts_per_event     jsonb NOT NULL DEFAULT '[]'::jsonb,
      stat_score         numeric(5,2) NOT NULL DEFAULT 0,
      ai_adjustment      numeric(5,2) NOT NULL DEFAULT 0,
      ai_rationale       text NOT NULL DEFAULT '',
      ai_stale           bool NOT NULL DEFAULT true,
      overall_score      numeric(5,2) NOT NULL DEFAULT 0,
      rank_overall       int,
      rank_position      int,
      UNIQUE (run_id, player_uid)
    );
    CREATE INDEX IF NOT EXISTS player_matrix_run_idx ON player_matrix(run_id, rank_overall);

    CREATE TABLE IF NOT EXISTS model_runs (
      id                    bigserial PRIMARY KEY,
      run_id                bigint REFERENCES runs(id),
      layer                 text NOT NULL,
      model_version         text NOT NULL DEFAULT 'v1',
      config_version        int,
      fitted_params         jsonb NOT NULL DEFAULT '{}'::jsonb,
      input_snapshot_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
      metrics               jsonb NOT NULL DEFAULT '{}'::jsonb,
      fitted_at             timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS model_errors (
      id             bigserial PRIMARY KEY,
      run_id         bigint NOT NULL REFERENCES runs(id),
      player_uid     text NOT NULL REFERENCES players(uid),
      gameweek       int NOT NULL,
      xpts_pred      numeric(6,3),
      points_actual  int,
      minutes_pred   numeric(5,2),
      minutes_actual int,
      cs_prob        numeric(5,4),
      cs_actual      bool,
      details        jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
