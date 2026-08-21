import type { Knex } from 'knex';

/**
 * Team-id mappings per provider. Previously team ids were (incorrectly)
 * written into player_identities, which its player_uid foreign key rejects —
 * so provider pulls ran without team context and every row queued for
 * manual review. Additive, forward-only (CLAUDE.md Rule #1).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS team_identities (
      id bigserial PRIMARY KEY,
      team_uid text NOT NULL REFERENCES teams(uid),
      provider text NOT NULL,
      provider_id text NOT NULL,
      provider_name text NOT NULL DEFAULT '',
      confidence numeric(4,2) NOT NULL DEFAULT 1.00,
      matched_by text NOT NULL DEFAULT 'seed',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_id)
    );
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS team_identities_team_idx ON team_identities (team_uid)`);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
