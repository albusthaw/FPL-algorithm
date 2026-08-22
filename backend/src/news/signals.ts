/**
 * News signal classifier — the statistical half of the human-factors layer
 * (fpl-project.md §5 human factors; v1.4.0). Keyword/rule based, NO AI:
 * this runs inside every run's news-index stage, and scheduled runs are
 * statistical-only by construction. The AI pass remains the free-text
 * refinement channel on top.
 *
 * Categories cover what moves a player besides fitness: discipline and
 * unprofessionalism before match days, transfer/contract noise, personal
 * events, morale boosts, and managerial upheaval.
 */

export type SignalCategory =
  | 'disciplinary'
  | 'unprofessional'
  | 'transfer_talk'
  | 'contract_dispute'
  | 'personal_event'
  | 'morale_boost'
  | 'managerial_change';

// patterns run over lowercased "title. description" text
const RULES: Record<SignalCategory, RegExp[]> = {
  disciplinary: [
    /\bred card\b/, /\bsent off\b/, /\bsuspend(ed|sion)\b/, /\bban(ned)?\b/,
    /\bfa charge\b/, /\bcharged by\b/, /\barrest(ed)?\b/, /\bcourt\b/,
    /\bfined\b/, /\bviolent conduct\b/, /\bmisconduct\b/,
  ],
  unprofessional: [
    /\bbust-?up\b/, /\btraining.{0,12}(row|bust-?up|incident|altercation)\b/,
    /\bdisciplinary (action|issue|breach)\b/, /\bnightclub\b/, /\blate (to|for) training\b/,
    /\bfall(ing|s)? out\b/, /\bfallout\b/, /\bdropped (from|for) (the )?(squad|match|game)\b/,
    /\brefus(ed|es|ing) to (train|play)\b/, /\bstormed? (off|out)\b/, /\bunprofessional\b/,
  ],
  transfer_talk: [
    /\btransfer (request|talks?|target|battle|saga|interest)\b/, /\bwants? (a )?move\b/,
    /\bbid (accepted|rejected|submitted|made)\b/, /\brelease clause\b/,
    /\bset to (join|leave|sign)\b/, /\bagreed? (personal )?terms\b/, /\bmedical (booked|scheduled|today)\b/,
    /\bexit talks?\b/, /\bwant(s|ed)? (to )?leave\b/, /\bin talks (with|over)\b.*\b(move|transfer)\b/,
  ],
  contract_dispute: [
    /\bcontract (stand-?off|dispute|row|talks? stall(ed)?|rejected)\b/, /\breject(s|ed) (a )?(new )?contract\b/,
    /\bwants? (a )?new (deal|contract)\b/, /\bcontract (expires?|running down)\b/, /\bstalemate\b/,
  ],
  personal_event: [
    /\bpersonal reasons?\b/, /\bcompassionate leave\b/, /\bbereavement\b/, /\bfamily (emergency|reasons?|matter)\b/,
    /\bbirth of\b/, /\bpaternity\b/, /\bmourning\b/, /\bfuneral\b/,
  ],
  morale_boost: [
    /\bsigns? (a )?new (deal|contract)\b/, /\bcontract extension\b/, /\bnamed captain\b/, /\bnew captain\b/,
    /\bplayer of the (month|season|year)\b/, /\bmilestone\b/, /\breturns? to (full )?training\b/,
    /\bback in training\b/, /\bcommitted (his|her|their) future\b/,
  ],
  managerial_change: [
    /\bmanager (sacked|fired|dismissed|resigns?|departs?|leaves)\b/, /\bsacks? (their |its )?(head coach|manager|boss)\b/,
    /\bcaretaker (manager|boss|charge)\b/, /\bnew (manager|head coach) (appointed|named|confirmed)\b/,
    /\bparts? (company|ways) with\b/, /\binterim (manager|boss|head coach)\b/,
  ],
};

// C6/N4 (v1.4.3): negation guard — a keyword hit inside a negating context
// ("will NOT be banned", "cleared of misconduct", "denies bust-up",
// "avoids suspension") must not classify. The window looks back 40 chars
// from the match; the guard kills THAT hit, other patterns still count.
// clause boundaries (, ; . ! ?) reset negation scope — "not banned, but he
// refused to train" keeps the second clause's hit
const NEGATION_WINDOW = /\b(not|no|never|den(?:y|ies|ied)|dismiss(?:es|ed)?|reject(?:s|ed)?|quash(?:es|ed)?|avoid(?:s|ed)?|escap(?:es|ed)?|cleared of|without|rul(?:es|ed) out)\b[^.!?,;]*$/;

export function isNegated(text: string, matchIndex: number): boolean {
  const back = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  return NEGATION_WINDOW.test(back);
}

/** Classify one article's text into zero or more signal categories. */
export function classifySignals(text: string): SignalCategory[] {
  const t = ` ${text.toLowerCase()} `;
  const hits: SignalCategory[] = [];
  for (const [cat, patterns] of Object.entries(RULES) as [SignalCategory, RegExp[]][]) {
    let hit = false;
    for (const p of patterns) {
      const m = p.exec(t);
      if (m && !isNegated(t, m.index)) {
        hit = true;
        break;
      }
    }
    if (hit) hits.push(cat);
  }
  return hits;
}

export interface NewsSignalsConfig {
  window_days: number;
  clamp: [number, number]; // combined multiplier bounds
  // negative categories need corroboration: a tier-1/2 source, or 2+ items
  corroboration: { require_tier: number; min_items: number };
  categories: Record<string, { n1: number; n3: number; n6: number }>;
}

export interface PlayerSignalEvidence {
  categories: SignalCategory[];
  items: number;
  bestTier: number;
  mult: { n1: number; n3: number; n6: number };
}

/**
 * Combine a player's active signal categories into bounded xPts multipliers.
 * Multiplicative across categories, clamped to cfg.clamp — human factors
 * nudge, they never dominate (mirrors the AI ±20 bound philosophy).
 */
export function signalMultipliers(
  categories: SignalCategory[],
  cfg: NewsSignalsConfig,
): { n1: number; n3: number; n6: number } {
  let n1 = 1;
  let n3 = 1;
  let n6 = 1;
  for (const cat of new Set(categories)) {
    const m = cfg.categories[cat];
    if (!m) continue;
    n1 *= m.n1;
    n3 *= m.n3;
    n6 *= m.n6;
  }
  const [lo, hi] = cfg.clamp;
  const clamp = (x: number): number => Math.min(hi, Math.max(lo, x));
  return { n1: clamp(n1), n3: clamp(n3), n6: clamp(n6) };
}

const NEGATIVE: Set<SignalCategory> = new Set([
  'disciplinary',
  'unprofessional',
  'transfer_talk',
  'contract_dispute',
  'personal_event',
  'managerial_change',
]);

/**
 * Filter a player's raw signal rows down to corroborated categories.
 * rows: one per (news item, category) hit with the item's tier.
 */
export function corroboratedCategories(
  rows: { category: SignalCategory; tier: number }[],
  cfg: NewsSignalsConfig,
): SignalCategory[] {
  const byCat = new Map<SignalCategory, { count: number; bestTier: number }>();
  for (const r of rows) {
    const cur = byCat.get(r.category) ?? { count: 0, bestTier: 99 };
    cur.count++;
    cur.bestTier = Math.min(cur.bestTier, r.tier);
    byCat.set(r.category, cur);
  }
  const out: SignalCategory[] = [];
  for (const [cat, agg] of byCat) {
    if (NEGATIVE.has(cat)) {
      if (agg.bestTier <= cfg.corroboration.require_tier || agg.count >= cfg.corroboration.min_items) out.push(cat);
    } else {
      out.push(cat); // positive signals apply on a single source — low stakes
    }
  }
  return out;
}
