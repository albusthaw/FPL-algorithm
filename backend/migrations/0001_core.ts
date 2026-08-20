import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS users (
      id            bigserial PRIMARY KEY,
      email         text NOT NULL UNIQUE,
      name          text NOT NULL,
      password_hash text NOT NULL,
      role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      token_balance bigint NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
      created_by    bigint REFERENCES users(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           bigserial PRIMARY KEY,
      token_hash   text NOT NULL UNIQUE,
      user_id      bigint NOT NULL REFERENCES users(id),
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      revoked_at   timestamptz,
      ip           text,
      user_agent   text
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS token_ledger (
      id            bigserial PRIMARY KEY,
      user_id       bigint NOT NULL REFERENCES users(id),
      delta         bigint NOT NULL,
      balance_after bigint NOT NULL,
      reason        text NOT NULL CHECK (reason IN ('topup','run','vision','refund','adjust')),
      run_id        bigint,
      admin_id      bigint REFERENCES users(id),
      note          text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS token_ledger_user_idx ON token_ledger(user_id, created_at);

    CREATE TABLE IF NOT EXISTS model_config (
      id         bigserial PRIMARY KEY,
      key        text NOT NULL,
      version    int  NOT NULL,
      value      jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (key, version)
    );

    CREATE TABLE IF NOT EXISTS feature_states (
      name       text PRIMARY KEY,
      enabled    bool NOT NULL,
      manifest   jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS auth_events (
      id         bigserial PRIMARY KEY,
      user_id    bigint REFERENCES users(id),
      email      text,
      kind       text NOT NULL CHECK (kind IN ('login_ok','login_fail','lockout','logout','password_reset')),
      ip         text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS login_throttle (
      key          text PRIMARY KEY,
      fail_count   int NOT NULL DEFAULT 0,
      locked_until timestamptz,
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
