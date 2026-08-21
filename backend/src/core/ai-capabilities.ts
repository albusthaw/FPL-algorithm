/**
 * AI model-capability registry (engineupgradeplus.md P4 / Part 3.3).
 *
 * One mechanism ends the parameter-drift bug class (max_tokens vs
 * max_completion_tokens, locked temperature, per-MODEL vision): ordered
 * pattern rules stored as ⚙ `ai_model_capabilities` in model_config — data,
 * admin-editable, refit as providers drift, never hard-coded again. A
 * lint-style architectural test asserts no adapter hard-codes the drifted
 * params.
 *
 * Learned overrides (from live probes on model selection) are merged on top
 * from ai_providers.config.capabilities — the AI-side mirror of the ingest
 * layer's entitlement learning.
 */

export interface ModelCapabilities {
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** 'free' → send the configured temperature; 'omit' → never send one. */
  temperature: 'free' | 'omit';
  vision: boolean;
  json: 'json_schema' | 'json_object' | 'none';
  maxOutput?: number;
}

export interface CapabilityRule {
  provider?: string; // omit = any provider
  match: string; // glob over the model id: * = any run, | = alternatives
  token_param?: ModelCapabilities['tokenParam'];
  temperature?: ModelCapabilities['temperature'];
  vision?: boolean;
  json?: ModelCapabilities['json'];
  max_output?: number;
}

export interface CapabilityConfig {
  rules: CapabilityRule[];
  provider_defaults: Record<string, Partial<ModelCapabilities>>;
}

/** Seeded truth table (researched + live-probed 2026-08). Data, not law:
 *  admins edit the model_config row; probes layer learned facts on top. */
export const DEFAULT_CAPABILITIES: CapabilityConfig = {
  rules: [
    // OpenAI reasoning-era models: max_completion_tokens only, temperature locked to default
    { provider: 'openai', match: 'gpt-5*|o1*|o3*|o4*', token_param: 'max_completion_tokens', temperature: 'omit', vision: true, json: 'json_schema' },
    // older OpenAI chat models: max_completion_tokens is universally accepted; temperature still free
    { provider: 'openai', match: 'gpt-4*|chatgpt*', token_param: 'max_completion_tokens', temperature: 'free', vision: true, json: 'json_schema' },
    // Anthropic: sampling params allowed on the ≤4.5 generation only —
    // 4.6+/5-family models 400 on temperature, so the default is omit.
    // Rules apply in order with later fields overriding: general first,
    // the ≤4.5 exception after so it wins for those models.
    { provider: 'anthropic', match: 'claude-*', token_param: 'max_tokens', temperature: 'omit', vision: true, json: 'none' },
    { provider: 'anthropic', match: 'claude-3*|claude-*-4-5*', temperature: 'free' },
    // DeepSeek: vision is per-MODEL (deepseek-v4-flash-vision-exp live-probed 2026-08)
    { provider: 'deepseek', match: '*vision*', vision: true },
    // Gemini 2.5-era: thinking tokens spend from maxOutputTokens — give room
    { provider: 'gemini', match: 'gemini-2.5*|gemini-3*', max_output: 8192 },
    // any provider: a model id advertising vision gets it
    { match: '*vision*|*-vl*', vision: true },
  ],
  provider_defaults: {
    openai: { tokenParam: 'max_completion_tokens', temperature: 'free', vision: true, json: 'json_schema' },
    anthropic: { tokenParam: 'max_tokens', temperature: 'omit', vision: true, json: 'none' },
    gemini: { tokenParam: 'max_tokens', temperature: 'free', vision: true, json: 'none' },
    deepseek: { tokenParam: 'max_tokens', temperature: 'free', vision: false, json: 'json_object' },
    kimi: { tokenParam: 'max_tokens', temperature: 'free', vision: false, json: 'json_object' },
    ollama: { tokenParam: 'max_tokens', temperature: 'free', vision: false, json: 'none' },
    modal: { tokenParam: 'max_tokens', temperature: 'free', vision: false, json: 'json_object' },
    mock: { tokenParam: 'max_tokens', temperature: 'free', vision: true, json: 'json_schema' },
  },
};

const BASE: ModelCapabilities = { tokenParam: 'max_tokens', temperature: 'free', vision: false, json: 'none' };

function globToRegExp(glob: string): RegExp {
  const parts = glob.split('|').map((g) => g.trim().split('*').map(escapeRe).join('.*'));
  return new RegExp(`^(?:${parts.join('|')})$`, 'i');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the effective capabilities for (provider, model): provider default,
 * then EVERY matching rule in order (later rules override earlier fields),
 * then learned overrides from live probes.
 */
export function resolveCapabilities(
  cfg: CapabilityConfig,
  provider: string,
  model: string,
  learned?: Partial<ModelCapabilities> | null,
): ModelCapabilities {
  let caps: ModelCapabilities = { ...BASE, ...(cfg.provider_defaults[provider] ?? {}) };
  for (const rule of cfg.rules) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!globToRegExp(rule.match).test(model)) continue;
    caps = {
      ...caps,
      ...(rule.token_param ? { tokenParam: rule.token_param } : {}),
      ...(rule.temperature ? { temperature: rule.temperature } : {}),
      ...(rule.vision !== undefined ? { vision: rule.vision } : {}),
      ...(rule.json ? { json: rule.json } : {}),
      ...(rule.max_output !== undefined ? { maxOutput: rule.max_output } : {}),
    };
  }
  if (learned) caps = { ...caps, ...learned };
  return caps;
}

/**
 * Interpret a provider 400 body: which learned override would fix it?
 * Mirrors entitlement learning — a denial teaches, permanently.
 */
export function learnFromParamError(body: string): Partial<ModelCapabilities> | null {
  const t = body.toLowerCase();
  if (t.includes('max_tokens') && t.includes('max_completion_tokens')) {
    return { tokenParam: 'max_completion_tokens' };
  }
  if (t.includes("'temperature'") || (t.includes('temperature') && (t.includes('unsupported') || t.includes('not supported') || t.includes('only the default')))) {
    return { temperature: 'omit' };
  }
  return null;
}
