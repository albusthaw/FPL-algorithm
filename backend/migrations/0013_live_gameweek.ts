import type { Knex } from 'knex';

/**
 * v1.4.4 — B3 live gameweek engine + A2 price intelligence.
 * live_event_stats: per-(event, player) live totals from FPL event/{gw}/live,
 * including our BPS-derived bonus projection. price_predictions: the nightly
 * threshold model's calls, kept so the model can self-calibrate against
 * actual price_events. Additive, forward-only (CLAUDE.md Rule #1).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS live_event_stats (
      event           int  NOT NULL,
      player_uid      text NOT NULL REFERENCES players(uid),
      minutes         int  NOT NULL DEFAULT 0,
      goals           int  NOT NULL DEFAULT 0,
      assists         int  NOT NULL DEFAULT 0,
      clean_sheets    int  NOT NULL DEFAULT 0,
      goals_conceded  int  NOT NULL DEFAULT 0,
      saves           int  NOT NULL DEFAULT 0,
      bps             int  NOT NULL DEFAULT 0,
      bonus           int  NOT NULL DEFAULT 0,
      projected_bonus int  NOT NULL DEFAULT 0,
      defcon          int  NOT NULL DEFAULT 0,
      yellow_cards    int  NOT NULL DEFAULT 0,
      red_cards       int  NOT NULL DEFAULT 0,
      total_points    int  NOT NULL DEFAULT 0,
      stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
      as_of           timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (event, player_uid)
    );
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS price_predictions (
      player_uid    text NOT NULL REFERENCES players(uid),
      for_date      date NOT NULL,
      direction     text NOT NULL CHECK (direction IN ('rise','fall','hold')),
      p             numeric(4,3) NOT NULL,
      net_transfers bigint NOT NULL DEFAULT 0,
      threshold     numeric(12,2),
      evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (player_uid, for_date)
    );
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS price_predictions_date_idx ON price_predictions (for_date, direction)`);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
