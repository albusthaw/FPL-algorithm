/**
 * AI engine contracts (fpl-ai-engine-plan.md §1–§3).
 * Every AI call requires an AIInvocation — there is no default. The
 * scheduler is wired WITHOUT the AI gateway dependency; an AI call without
 * a human to bill is unrepresentable (ai_calls.user_id NOT NULL).
 */

export interface AIInvocation {
  triggeredByUserId: number;
  triggerKind: 'run_button' | 'image_parse' | 'admin_action';
  runId?: number;
}

export interface PlayerNewsBundle {
  playerUid: string;
  webName: string;
  position: string;
  club: string;
  price: number; // tenths
  matrixLine: string; // terse fixed-order pipe-delimited serialisation
  news: { id: number; title: string; snippet: string; source: string; ageHours: number }[];
}

export interface AIVerdict {
  player_uid: string;
  adjustment: number; // −20..+20 int (engine clamps)
  rationale: string; // ≤160 chars
  confidence: number; // 0..1
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}

export interface ProviderResult {
  raw: unknown;
  text: string; // model output text (JSON expected)
  usage: ProviderUsage;
  finishReason: 'complete' | 'length' | 'filtered' | 'refused';
  model: string;
}

export interface ParsedTeamPlayer {
  name: string;
  club: string | null;
  price: number | null;
  captain: boolean;
  vice: boolean;
  bench_position: number | null;
}

export interface AIProviderAdapter {
  key: string;
  supportsVision: boolean;
  supportsNativeJsonSchema: boolean;
  analyse(system: string, runContext: string, batchBlock: string, inv: AIInvocation): Promise<ProviderResult>;
  repair(previous: ProviderResult, errors: string, inv: AIInvocation): Promise<ProviderResult>;
  parseTeamImage(imageBase64: string, mimeType: string, inv: AIInvocation): Promise<ProviderResult>;
  estimateTokens(system: string, runContext: string, batchBlock: string): Promise<number>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  /** Live model list from the provider — powers the admin panel's model picker. */
  listModels?(): Promise<string[]>;
}
