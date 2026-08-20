import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS user_teams (
      id             bigserial PRIMARY KEY,
      user_id        bigint NOT NULL REFERENCES users(id),
      name           text NOT NULL,
      bank           int NOT NULL DEFAULT 0,
      free_transfers int NOT NULL DEFAULT 1,
      chips_used     jsonb NOT NULL DEFAULT '[]'::jsonb,
      notes          text NOT NULL DEFAULT '',
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS user_teams_user_idx ON user_teams(user_id);

    CREATE TABLE IF NOT EXISTS user_team_players (
      id             bigserial PRIMARY KEY,
      team_id        bigint NOT NULL REFERENCES user_teams(id),
      player_uid     text NOT NULL REFERENCES players(uid),
      slot           int NOT NULL CHECK (slot BETWEEN 1 AND 15),
      is_captain     bool NOT NULL DEFAULT false,
      is_vice        bool NOT NULL DEFAULT false,
      bench_position int CHECK (bench_position BETWEEN 1 AND 4),
      purchase_price int,
      UNIQUE (team_id, slot),
      UNIQUE (team_id, player_uid)
    );

    CREATE TABLE IF NOT EXISTS team_uploads (
      id           bigserial PRIMARY KEY,
      team_id      bigint REFERENCES user_teams(id),
      user_id      bigint NOT NULL REFERENCES users(id),
      image_path   text NOT NULL,
      parse_result jsonb,
      status       text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','parsed','confirmed','failed')),
      ai_call_id   bigint REFERENCES ai_calls(id),
      created_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
