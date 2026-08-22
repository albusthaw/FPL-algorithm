import type { Knex } from 'knex';

/**
 * v1.4.1 — X1 key persistence. Append-only audit of every admin key write:
 * which env var, who, old/new last-4 hints (never values), when. Lets a
 * future "my key vanished" report be answered from the record instead of
 * guesswork. Additive, forward-only (CLAUDE.md Rule #1).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS key_audit (
      id bigserial PRIMARY KEY,
      env_var text NOT NULL,
      actor_user_id bigint,
      old_hint text,
      new_hint text,
      action text NOT NULL DEFAULT 'set',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS key_audit_env_idx ON key_audit (env_var, created_at)`);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
