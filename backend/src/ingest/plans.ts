/**
 * Provider subscription model (engineupgradeplus.md P1 / Part 2.9).
 *
 * Every site pulls differently AND sells differently — the tier catalog below
 * is the researched truth table (Part 2, live-probed 2026-08) of what each
 * named plan can reach. The SELECTED plan per provider is ⚙ `provider_plans`
 * in model_config (data, admin-editable); this module is the menu the admin
 * picks from. Depth options offered on the Run screen = the selected plan's
 * depth ∩ the entitlement table's learned denials.
 */

export interface PlanDepth {
  days?: number; // rolling live window a plan can see (news)
  months?: number; // archive reach in months (news archive)
  seasons?: number; // whole seasons back, including the current one
  career?: boolean; // per-player career aggregates available
}

export interface PlanRate {
  per_min?: number;
  per_day?: number;
  credits_day?: number;
}

export interface PlanTier {
  id: string;
  label: string;
  cost: string; // display only — billing happens on the vendor's site
  depth: PlanDepth;
  rate: PlanRate;
  note: string;
}

/** The stored ⚙ provider_plans value: selected tier snapshot per provider. */
export interface ProviderPlan {
  plan: string;
  depth: PlanDepth;
  rate: PlanRate;
  expires?: string;
}
export type ProviderPlansConfig = Record<string, ProviderPlan>;

/** Researched tier catalog. Data about EXTERNAL vendors, versioned with the
 *  code that implements each tier's pull mechanics. */
export const PROVIDER_PLAN_TIERS: Record<string, PlanTier[]> = {
  fpl: [
    {
      id: 'free',
      label: 'Official (free)',
      cost: 'free',
      depth: { seasons: 1, career: true },
      rate: {},
      note: 'per-GW current season; element-summary career aggregates back to each player’s FPL debut (~20y for veterans)',
    },
  ],
  vaastav: [
    {
      id: 'free',
      label: 'GitHub dataset (free)',
      cost: 'free',
      depth: { seasons: 10 },
      rate: {},
      note: 'per-GW match rows 2016-17 → previous season; imported into player_match_stats',
    },
  ],
  football_data: [
    {
      id: 'free',
      label: 'Free tier',
      cost: 'free',
      depth: { seasons: 1 },
      rate: { per_min: 10 },
      note: 'current season only; past ?season=YYYY requests are refused (learned as PLAN_DENIED)',
    },
    {
      id: 'standard',
      label: 'Standard',
      cost: '€49/mo',
      depth: { seasons: 5 },
      rate: { per_min: 60 },
      note: 'unlocks past seasons via ?season=YYYY on PL matches/standings/scorers',
    },
  ],
  api_football: [
    {
      id: 'free',
      label: 'Free plan',
      cost: 'free',
      depth: { seasons: 3 },
      rate: { per_day: 100 },
      note: 'seasons 2022–2024 only (live-probed); current season refused; 100 req/day',
    },
    {
      id: 'pro',
      label: 'Pro',
      cost: '$29/mo',
      depth: { seasons: 15 },
      rate: { per_day: 7500 },
      note: 'current season + injuries/lineups/odds + multi-season history',
    },
  ],
  newsdata: [
    {
      id: 'free',
      label: 'Free tier',
      cost: 'free',
      depth: { days: 2 },
      rate: { credits_day: 200 },
      note: 'latest 48 h only; 200 credits/day (10 articles per credit); archive endpoint refused',
    },
    {
      id: 'basic',
      label: 'Basic',
      cost: '$199/mo',
      depth: { days: 2, months: 6 },
      rate: { credits_day: 20000 },
      note: 'archive endpoint back 6 months',
    },
    {
      id: 'professional',
      label: 'Professional',
      cost: '$349/mo',
      depth: { days: 2, months: 24 },
      rate: { credits_day: 50000 },
      note: 'archive endpoint back 2 years',
    },
    {
      id: 'corporate',
      label: 'Corporate',
      cost: '$599/mo',
      depth: { days: 2, months: 60 },
      rate: { credits_day: 100000 },
      note: 'archive endpoint back 5 years',
    },
  ],
  sportmonks: [
    {
      id: 'free',
      label: 'Free plan',
      cost: 'free',
      depth: {},
      rate: { per_day: 3000 },
      note: 'Danish Superliga + Scottish Premiership only — NO EPL (live-probed); depth selector dormant',
    },
    {
      id: 'european',
      label: 'European',
      cost: '€39/mo',
      depth: { seasons: 5 },
      rate: { per_day: 30000 },
      note: 'EPL sidelined/lineups/xG; season history per plan',
    },
  ],
  thesportsdb: [
    {
      id: 'free',
      label: 'Free (v1)',
      cost: 'free',
      depth: {},
      rate: { per_min: 30 },
      note: 'media/badges/rounds only; league search capped at 10 rows; no stats depth',
    },
    {
      id: 'premium',
      label: 'Premium (v2)',
      cost: '$9/mo',
      depth: { seasons: 10 },
      rate: { per_min: 100 },
      note: 'v2 API, livescores, full historical event data',
    },
  ],
  understat: [
    {
      id: 'free',
      label: 'Public site (free)',
      cost: 'free',
      depth: { seasons: 12 },
      rate: {},
      note: 'league xG pages back to 2014; per-season aggregates; names resolve via the review queue',
    },
  ],
};

/** Default ⚙ provider_plans: everyone starts on the free tier. */
export const DEFAULT_PROVIDER_PLANS: ProviderPlansConfig = Object.fromEntries(
  Object.entries(PROVIDER_PLAN_TIERS).map(([provider, tiers]) => {
    const free = tiers.find((t) => t.id === 'free') ?? tiers[0]!;
    return [provider, { plan: free.id, depth: free.depth, rate: free.rate }];
  }),
);

export function tierFor(provider: string, planId: string): PlanTier | null {
  return (PROVIDER_PLAN_TIERS[provider] ?? []).find((t) => t.id === planId) ?? null;
}

/** api_providers.quota_limit fill (fixes audit X5): requests/day if the plan
 *  is day-metered, credits/day for credit-metered plans, else null. */
export function quotaLimitFor(tier: PlanTier): number | null {
  return tier.rate.per_day ?? tier.rate.credits_day ?? null;
}
