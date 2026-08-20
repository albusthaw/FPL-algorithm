import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      key            text PRIMARY KEY,
      name           text NOT NULL,
      alive          bool NOT NULL DEFAULT false,
      supports_vision bool NOT NULL DEFAULT false,
      state          text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','degraded','error')),
      config         jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ai_calls (
      id                bigserial PRIMARY KEY,
      user_id           bigint NOT NULL REFERENCES users(id),
      run_id            bigint REFERENCES runs(id),
      provider          text NOT NULL,
      model             text NOT NULL DEFAULT '',
      kind              text NOT NULL CHECK (kind IN ('analyse','vision','probe','repair')),
      trigger_kind      text NOT NULL CHECK (trigger_kind IN ('run_button','image_parse','admin_action')),
      batch_size        int NOT NULL DEFAULT 0,
      prompt_tokens     bigint NOT NULL DEFAULT 0,
      completion_tokens bigint NOT NULL DEFAULT 0,
      cached_tokens     bigint NOT NULL DEFAULT 0,
      credits           bigint NOT NULL DEFAULT 0,
      pricing_version   int,
      latency_ms        int NOT NULL DEFAULT 0,
      finish_reason     text NOT NULL DEFAULT 'complete',
      status            text NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok','failed_validation','failed','filtered','refused')),
      error             text,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ai_calls_run_idx ON ai_calls(run_id);
    CREATE INDEX IF NOT EXISTS ai_calls_user_idx ON ai_calls(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ai_verdict_cache (
      id             bigserial PRIMARY KEY,
      cache_key      text NOT NULL UNIQUE,
      player_uid     text NOT NULL REFERENCES players(uid),
      verdict        jsonb NOT NULL,
      prompt_version int NOT NULL DEFAULT 1,
      created_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_verdict_cache_expiry_idx ON ai_verdict_cache(expires_at);

    CREATE TABLE IF NOT EXISTS ai_exclusions (
      id         bigserial PRIMARY KEY,
      user_id    bigint NOT NULL REFERENCES users(id),
      player_uid text NOT NULL REFERENCES players(uid),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, player_uid)
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
