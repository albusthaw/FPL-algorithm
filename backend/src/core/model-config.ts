import type { Knex } from 'knex';

/**
 * Every constant marked ⚙ in fpl-engines-plan.md lives here as a versioned
 * model_config row — data, not code. Runs record the config version used.
 */
export const DEFAULT_CONFIG: Record<string, unknown> = {
  // FPL scoring rules, 2026/27 (fpl-engines-plan.md §2.4)
  scoring_rules: {
    season: '2026/27',
    appearance: { under60: 1, from60: 2 },
    goal: { GK: 6, DEF: 6, MID: 5, FWD: 4 },
    assist: 3,
    clean_sheet: { GK: 4, DEF: 4, MID: 1, FWD: 0 },
    saves_per_point: 3,
    penalty_save: 5,
    goals_conceded_per_minus1: 2, // GK+DEF only
    defcon: { DEF: { threshold: 10, metric: 'cbit', points: 2 }, MID: { threshold: 12, metric: 'cbirt', points: 2 }, FWD: { threshold: 12, metric: 'cbirt', points: 2 }, GK: { threshold: 10, metric: 'cbit', points: 2 } },
    penalty_miss: -2,
    yellow: -1,
    red: -3,
    own_goal: -2,
  },
  // 2026/27 BPS weights (captured at build; refit as season data lands)
  bps_weights: {
    version: '2026/27',
    goal: { GK: 24, DEF: 24, MID: 18, FWD: 12 },
    assist: 9,
    clean_sheet: { GK: 12, DEF: 12 },
    save: 2,
    big_chance_save_bonus: 1,
    penalty_save: 7,
    cbi_per: 3,
    recovery_per: 3,
    tackled_penalty: 0,
  },
  // L12 stat_score weights (fpl-engines-plan.md §4.13)
  stat_score_weights: { w1: 0.4, w2: 0.15, w3: 0.1, w4: 0.15, w5: 0.12, w6: 0.08 },
  stat_score_caps: { unavailable: 25, doubtful: 60 },
  // L0 feature factory
  feature_factory: {
    windows: [1, 3, 5, 10, 38],
    min_minutes_for_rate: 450,
    shrinkage_k: 6,
    shrinkage_k_attacking: 10, // xG/xA stabilise slower than volume stats

    decay_xi_player: 0.01,
    new_season_alpha_k: 8,
    championship_attack_mult: 0.6,
  },
  // L1 Dixon-Coles
  dixon_coles: {
    xi_decay_per_day: 0.0035,
    xg_blend_weight: 0.6,
    max_goals_grid: 10,
    home_advantage_init: 0.25,
    rho_init: -0.08,
    promoted_attack: -0.25,
    promoted_defence: -0.15,
  },
  // L2 odds blend
  odds_blend: { w_mkt_fresh: 0.65, fresh_hours: 48 },
  // L3 minutes model v1 (calibrated heuristic table)
  minutes_model: {
    start_share_table: [
      { min_share: 0.92, ewma_min: 75, p_start: 0.93 },
      { min_share: 0.78, ewma_min: 55, p_start: 0.85 },
      { min_share: 0.55, ewma_min: 40, p_start: 0.68 },
      { min_share: 0.38, ewma_min: 25, p_start: 0.45 },
      { min_share: 0.18, ewma_min: 12, p_start: 0.25 },
      { min_share: 0.0, ewma_min: 0, p_start: 0.08 },
    ],
    undroppable_floors: [
      { own: 35, p: 0.88 },
      { own: 20, p: 0.8 },
    ],
    congestion_mult: 0.85,
    returned_injury_mult: 0.75,
    new_signing_mult: 0.7,
    e_min_start: { GK: 90, DEF: 88, MID: 82, FWD: 78 },
    p_sub: { GK: 0.02, DEF: 0.25, MID: 0.35, FWD: 0.35 },
    e_min_sub: { GK: 45, DEF: 25, MID: 22, FWD: 20 },
    horizon_regression: 0.9,
    minutes_ewma_halflife_matches: 4,
  },
  // L4 attacking production
  attacking: { finishing_clip: [0.85, 1.15], finishing_min_minutes: 2500, assist_conv: 1.05, pen_goal_prob: 0.76 },
  // ── statengineexpansion.md (v1.3.0) — new keys seed on upgrade ──────────
  // X1 minutes realism: E[min|start] from the player's own started matches
  minutes_realism: {
    started_min_shrink_k: 4, // matches of trust before the player's own number dominates
    e_min_start_cap: { GK: 90, DEF: 89, MID: 86, FWD: 86 },
    top_start_share_p: 0.95, // an every-week starter, not 0.93
    horizon_target_mult: 0.92, // X8: horizon target = own long-run start share × this
  },
  // X7 price-continuous attacking prior: FPL price is the market's published
  // expected-returns prior — shrink a £6.0 and a £15.5 forward toward
  // DIFFERENT targets (attacking rates only; volume stats keep band priors)
  price_prior: {
    elasticity: 0.9,
    mult_range: [0.5, 2.2],
    ref_price: { GK: 50, DEF: 50, MID: 65, FWD: 75 }, // tenths
    xg90_at_ref: { GK: 0.005, DEF: 0.08, MID: 0.16, FWD: 0.4 },
    xa90_at_ref: { GK: 0.005, DEF: 0.08, MID: 0.16, FWD: 0.12 },
  },
  // X2 set-piece & penalty expected value (plan §4.5, delivered)
  set_piece_ev: {
    team_pens_per_match: 0.28,
    taker_share: { 1: 0.85, 2: 0.1 },
    pen_conversion: 0.76,
    // order-1 takers: pens are already inside historical xG. Must equal what
    // the explicit pen term re-adds (team_pens × share × xG-per-pen ≈ 0.181),
    // or incumbent takers get their penalties counted twice.
    pen_xg_deduction: 0.181,
    corner_dfk_xa_bump: 0.04,
  },
  // X3 bonus rides returns, not averages (constants refit each season)
  bonus_model: {
    fwd_mid: { base: 0.1, slope: 1.15, cap: 2.5 },
    def: { base: 0.12, slope: 1.05, cs_term: 0.9, cap: 2.5 },
    gk: { base: 0.08, cs_term: 0.8, saves_norm: 3.5, cap: 2.0 },
  },
  // X4 gentler in-season decay for per-90 rates (half-life ~140 football-days)
  feature_decay: { rate_xi_per_day: 0.005 },
  // X5 human factors — bounded, structured; the AI pass stays the free-text channel
  human_factors: {
    ownership_momentum_weight: 0.04, // w7 in stat_score
    suspension_tightrope: { yellows: 4, haircut_next3: 0.96, haircut_next6: 0.93 },
    // v1.4.0: news-driven signals (emotion, discipline, unprofessionalism,
    // transfer/contract noise, personal events, managerial churn) — keyword
    // classified in the news indexer, applied as bounded multipliers here.
    news_signals: {
      window_days: 10,
      clamp: [0.9, 1.03],
      corroboration: { require_tier: 2, min_items: 2 },
      categories: {
        disciplinary: { n1: 0.96, n3: 0.97, n6: 0.98 },
        unprofessional: { n1: 0.96, n3: 0.97, n6: 0.98 },
        transfer_talk: { n1: 0.98, n3: 0.975, n6: 0.97 },
        contract_dispute: { n1: 0.99, n3: 0.985, n6: 0.98 },
        personal_event: { n1: 0.96, n3: 0.98, n6: 0.99 },
        morale_boost: { n1: 1.02, n3: 1.015, n6: 1.01 },
        managerial_change: { n1: 0.98, n3: 0.99, n6: 1.0 },
      },
    },
  },
  // v1.4.0 news pull throughput (free-tier credit budgeting + pagination)
  news_pull: {
    poll_clubs: 5,
    run_pages_per_club: 2,
    poll_pages_per_club: 1,
    credit_budget_run: 45,
    credit_budget_poll: 6,
  },
  // v1.4.0 historical depth: default = live pulls only (last 7 days) with the
  // previous-season floor; admins raise it up to 10 per-GW seasons (vaastav)
  // and ~20 years of per-season career aggregates (FPL history_past)
  history_depth: {
    mode: 'days',
    days: 7,
    seasons: 1,
    career_aggregates: false,
    max_seasons: 10,
  },
  // L5 DEFCON
  defcon: { window_matches: 15, mult_range: [0.8, 1.25] },
  // L7 bonus v1 empirical profile table (expected bonus given event profile)
  bonus_profiles: {
    scored: { GK: 2.2, DEF: 2.0, MID: 1.5, FWD: 1.3 },
    scored_and_cs: { GK: 2.9, DEF: 2.6, MID: 1.8, FWD: 1.3 },
    assisted: { GK: 1.2, DEF: 1.1, MID: 0.9, FWD: 0.8 },
    cs_and_defcon: { GK: 0.9, DEF: 0.75, MID: 0.3, FWD: 0.1 },
    high_saves: { GK: 1.1, DEF: 0, MID: 0, FWD: 0 },
    nothing: { GK: 0.06, DEF: 0.05, MID: 0.04, FWD: 0.03 },
  },
  // L11 simulation (interface reserved; off in v1)
  simulation: { enabled: false, n_sims: 5000 },
  // match engine
  match_engine: {
    leverage_window_events: 6,
    target_list_size: 8,
    captaincy_pool_size: 6,
    coverage_window_events: 3,
    dgw_projection_events: 10,
    differential_ownership_max: 10,
    swing_threshold: 2.0,
    chip_urgency_events: 4,
    wc_horizon_events: 6,
  },
  // AI engine
  ai: {
    prompt_version: 1,
    batch_size: 20,
    max_news_per_player: 5,
    news_snippet_chars: 320,
    verdict_cache_hours: 24,
    exclusion_bottom_pct: 25,
    estimate_margin_pct: 10,
  },
  ai_pricing: {
    // $ per Mtok in/out/cached; 1 credit ≈ $0.001 of provider cost
    version: 1,
    credit_usd: 0.001,
    providers: {
      anthropic: { in: 1.0, out: 5.0, cached: 0.1 },
      openai: { in: 1.1, out: 4.4, cached: 0.55 },
      gemini: { in: 0.3, out: 2.5, cached: 0.075 },
      deepseek: { in: 0.14, out: 0.28, cached: 0.0028 },
      kimi: { in: 0.6, out: 2.5, cached: 0.15 },
      ollama: { in: 0, out: 0, cached: 0 },
      modal: { in: 0.2, out: 0.2, cached: 0.2 },
      mock: { in: 0, out: 0, cached: 0 },
    },
  },
  // chips: 2026/27 two-set system (seeded from FPL bootstrap chips[])
  chip_rules: {
    season: '2026/27',
    sets: [
      { set: 1, start_event: 1, stop_event: 19, chips: ['wildcard', 'freehit', 'bboost', '3xc'] },
      { set: 2, start_event: 20, stop_event: 38, chips: ['wildcard', 'freehit', 'bboost', '3xc'] },
    ],
    free_transfers_per_gw: 1,
    max_banked_transfers: 5,
    hit_cost: 4,
  },
  squad_rules: {
    squad_size: 15,
    positions: { GK: 2, DEF: 5, MID: 5, FWD: 3 },
    max_per_club: 3,
    budget: 1000,
    valid_formations: [
      [1, 3, 4, 3], [1, 3, 5, 2], [1, 4, 3, 3], [1, 4, 4, 2],
      [1, 4, 5, 1], [1, 5, 3, 2], [1, 5, 4, 1], [1, 5, 2, 3], [1, 3, 3, 4],
    ],
  },
  polling: {
    bootstrap_hours: 6,
    bootstrap_deadline_minutes: 30,
    fixtures_daily_hour: 6,
    injuries_hours: [8, 16],
    news_per_day: 4,
    lineup_burst_start_min: 75,
    lineup_burst_interval_min: 5,
    element_summary_cache_hours: 24,
  },
  staleness: { injuries_hours: 72, odds_hours: 24, lineups_hours: 3 },
  cold_start: { early_season_variance_mult: 1.4 },
};

let cache: Map<string, { version: number; value: unknown }> | null = null;

export async function seedModelConfig(db: Knex): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    const exists = await db('model_config').where({ key }).first();
    if (!exists) {
      await db('model_config').insert({ key, version: 1, value: JSON.stringify(value) });
    }
  }
  cache = null;
}

export async function getConfig<T = unknown>(db: Knex, key: string): Promise<T> {
  if (!cache) {
    cache = new Map();
    const rows = await db('model_config')
      .select('key', 'version', 'value')
      .orderBy('version', 'asc');
    for (const row of rows) cache.set(row.key, { version: row.version, value: row.value });
  }
  const hit = cache.get(key);
  if (!hit) throw new Error(`model_config key missing: ${key}`);
  return hit.value as T;
}

export async function getConfigVersion(db: Knex, key: string): Promise<number> {
  await getConfig(db, key);
  return cache!.get(key)!.version;
}

export async function setConfig(db: Knex, key: string, value: unknown): Promise<number> {
  const current = await db('model_config').where({ key }).orderBy('version', 'desc').first();
  const version = current ? current.version + 1 : 1;
  await db('model_config').insert({ key, version, value: JSON.stringify(value) });
  invalidateConfigCache();
  return version;
}

export function invalidateConfigCache(): void {
  cache = null;
}
