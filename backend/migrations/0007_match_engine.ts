import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS match_insights (
      id           bigserial PRIMARY KEY,
      run_id       bigint NOT NULL REFERENCES runs(id),
      fixture_uid  text NOT NULL REFERENCES fixtures(fixture_uid),
      event        int,
      side         text NOT NULL CHECK (side IN ('home','away')),
      att_leverage numeric(4,2) NOT NULL DEFAULT 0,
      def_leverage numeric(4,2) NOT NULL DEFAULT 0,
      mci          numeric(4,2) NOT NULL DEFAULT 0,
      star_density numeric(6,2) NOT NULL DEFAULT 0,
      volatility   bool NOT NULL DEFAULT false,
      reasons      jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, fixture_uid, side)
    );
    CREATE INDEX IF NOT EXISTS match_insights_run_idx ON match_insights(run_id, event);

    CREATE TABLE IF NOT EXISTS target_lists (
      id          bigserial PRIMARY KEY,
      run_id      bigint NOT NULL REFERENCES runs(id),
      event       int NOT NULL,
      scope       text NOT NULL CHECK (scope IN ('global','fixture','differential','captaincy')),
      fixture_uid text REFERENCES fixtures(fixture_uid),
      player_uid  text NOT NULL REFERENCES players(uid),
      rank        int NOT NULL,
      score       numeric(8,3) NOT NULL,
      reasons     jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS target_lists_run_idx ON target_lists(run_id, event, scope);

    CREATE TABLE IF NOT EXISTS coverage_reports (
      id             bigserial PRIMARY KEY,
      run_id         bigint NOT NULL REFERENCES runs(id),
      team_id        bigint NOT NULL REFERENCES user_teams(id),
      window_events  int NOT NULL DEFAULT 3,
      coverage_score numeric(6,2) NOT NULL DEFAULT 0,
      gaps           jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS chip_recommendations (
      id         bigserial PRIMARY KEY,
      run_id     bigint NOT NULL REFERENCES runs(id),
      team_id    bigint REFERENCES user_teams(id),
      chip       text NOT NULL CHECK (chip IN ('wildcard','freehit','bboost','3xc')),
      chip_set   int NOT NULL CHECK (chip_set IN (1,2)),
      event      int NOT NULL,
      value      numeric(7,3) NOT NULL DEFAULT 0,
      urgency    int NOT NULL DEFAULT 0,
      caveats    jsonb NOT NULL DEFAULT '[]'::jsonb,
      best_squad jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chip_recs_run_idx ON chip_recommendations(run_id, team_id);
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
