import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS teams (
      uid        text PRIMARY KEY,
      fpl_code   int NOT NULL UNIQUE,
      fpl_id     int,
      name       text NOT NULL,
      short_name text NOT NULL,
      strength   jsonb NOT NULL DEFAULT '{}'::jsonb,
      as_of      timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS players (
      uid                 text PRIMARY KEY,
      fpl_code            int NOT NULL UNIQUE,
      fpl_id              int,
      web_name            text NOT NULL,
      first_name          text NOT NULL DEFAULT '',
      second_name         text NOT NULL DEFAULT '',
      full_name           text NOT NULL DEFAULT '',
      position            text NOT NULL DEFAULT 'UNK',
      element_type        int NOT NULL DEFAULT 0,
      team_uid            text REFERENCES teams(uid),
      shirt               int,
      birthdate           date,
      status              text NOT NULL DEFAULT 'a',
      news                text NOT NULL DEFAULT '',
      news_added          timestamptz,
      chance_this         int,
      chance_next         int,
      now_cost            int NOT NULL DEFAULT 0,
      selected_by_percent numeric(6,2) NOT NULL DEFAULT 0,
      transfers_in_event  int NOT NULL DEFAULT 0,
      transfers_out_event int NOT NULL DEFAULT 0,
      season_stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
      flags               jsonb NOT NULL DEFAULT '{}'::jsonb,
      joined_at           timestamptz NOT NULL DEFAULT now(),
      as_of               timestamptz NOT NULL DEFAULT now(),
      created_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS players_team_idx ON players(team_uid);
    CREATE INDEX IF NOT EXISTS players_position_idx ON players(position);

    CREATE TABLE IF NOT EXISTS player_identities (
      id            bigserial PRIMARY KEY,
      player_uid    text NOT NULL REFERENCES players(uid),
      provider      text NOT NULL,
      provider_id   text NOT NULL,
      provider_name text NOT NULL DEFAULT '',
      confidence    numeric(4,2) NOT NULL DEFAULT 1.00,
      matched_by    text NOT NULL CHECK (matched_by IN ('code','exact_name','fuzzy','manual','seed')),
      tombstoned_at timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_id)
    );
    CREATE INDEX IF NOT EXISTS player_identities_uid_idx ON player_identities(player_uid);

    CREATE TABLE IF NOT EXISTS player_aliases (
      id         bigserial PRIMARY KEY,
      player_uid text NOT NULL REFERENCES players(uid),
      alias      text NOT NULL,
      source     text NOT NULL DEFAULT 'fpl',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (player_uid, alias)
    );
    CREATE INDEX IF NOT EXISTS player_aliases_alias_idx ON player_aliases(alias);

    CREATE TABLE IF NOT EXISTS player_position_history (
      id             bigserial PRIMARY KEY,
      player_uid     text NOT NULL REFERENCES players(uid),
      position       text NOT NULL,
      element_type   int NOT NULL,
      effective_from timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS resolution_queue (
      id                  bigserial PRIMARY KEY,
      provider            text NOT NULL,
      provider_id         text NOT NULL,
      payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
      candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,
      status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','resolved','ignored','unmatched')),
      resolved_player_uid text REFERENCES players(uid),
      resolved_by         bigint REFERENCES users(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      resolved_at         timestamptz,
      UNIQUE (provider, provider_id)
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
