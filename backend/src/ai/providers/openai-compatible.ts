/**
 * OpenAI-compatible chat-completions base adapter — serves OpenAI, DeepSeek,
 * Kimi (Moonshot) and Modal-deployed vLLM endpoints. Usage-field
 * normalisation per fpl-ai-engine-plan.md §8.1.
 */
import type { AIInvocation, AIProviderAdapter, ProviderResult, ProviderUsage } from '../types.js';

export interface OpenAICompatibleOpts {
  key: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  supportsVision: boolean;
  supportsNativeJsonSchema: boolean;
  jsonMode?: 'json_object' | 'json_schema' | 'none';
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const VERDICT_JSON_SCHEMA = {
  name: 'verdicts',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['player_uid', 'adjustment', 'rationale', 'confidence'],
          properties: {
            player_uid: { type: 'string' },
            adjustment: { type: 'integer' },
            rationale: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
      },
    },
  },
};

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  key: string;
  supportsVision: boolean;
  supportsNativeJsonSchema: boolean;

  constructor(protected opts: OpenAICompatibleOpts) {
    this.key = opts.key;
    this.supportsVision = opts.supportsVision;
    this.supportsNativeJsonSchema = opts.supportsNativeJsonSchema;
  }

  protected normaliseUsage(usage: Record<string, unknown> | undefined): ProviderUsage {
    const u = usage ?? {};
    const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
    const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0);
    // DeepSeek: prompt_cache_hit_tokens; OpenAI: prompt_tokens_details.cached_tokens
    const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
    const cached = Number(u.prompt_cache_hit_tokens ?? details.cached_tokens ?? 0);
    return { promptTokens: prompt, completionTokens: completion, cachedPromptTokens: cached };
  }

  protected async chat(messages: unknown[], useJsonMode: boolean): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
    };
    if (useJsonMode) {
      if (this.opts.jsonMode === 'json_schema') {
        body.response_format = { type: 'json_schema', json_schema: VERDICT_JSON_SCHEMA };
      } else if (this.opts.jsonMode === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
    }
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.key} HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const finish = String(choice.finish_reason ?? 'stop');
    return {
      raw: json,
      text: String(message.content ?? ''),
      usage: this.normaliseUsage(json.usage as Record<string, unknown>),
      finishReason: finish === 'length' ? 'length' : finish === 'content_filter' ? 'filtered' : 'complete',
      model: String(json.model ?? this.opts.model),
    };
  }

  async analyse(system: string, runContext: string, batchBlock: string, _inv: AIInvocation): Promise<ProviderResult> {
    // json_object mode requires the word "json" in the prompt (DeepSeek/Kimi);
    // SYSTEM_BLOCK contains it. Stable prefix = system + runContext messages.
    return this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: `${runContext}\n\n${batchBlock}` },
      ],
      true,
    );
  }

  async repair(previous: ProviderResult, errors: string, _inv: AIInvocation): Promise<ProviderResult> {
    return this.chat(
      [
        { role: 'assistant', content: previous.text.slice(0, 8000) },
        { role: 'user', content: `Your previous output failed validation: ${errors}. Return ONLY the corrected JSON array.` },
      ],
      true,
    );
  }

  async parseTeamImage(imageBase64: string, mimeType: string, _inv: AIInvocation): Promise<ProviderResult> {
    if (!this.supportsVision) throw new Error(`${this.key} does not support vision`);
    const { VISION_PROMPT } = await import('../prompt.js');
    const body: Record<string, unknown> = {
      model: this.opts.visionModel ?? this.opts.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 4096,
    };
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}`, ...this.opts.extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
    });
    if (!res.ok) throw new Error(`${this.key} vision HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json = (await res.json()) as Record<string, unknown>;
    const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    return {
      raw: json,
      text: String(message.content ?? ''),
      usage: this.normaliseUsage(json.usage as Record<string, unknown>),
      finishReason: 'complete',
      model: String(json.model ?? this.opts.model),
    };
  }

  async estimateTokens(system: string, runContext: string, batchBlock: string): Promise<number> {
    // local approximation (+10% margin applied by the caller per §8.3)
    return Math.ceil((system.length + runContext.length + batchBlock.length) / 3.6);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.opts.apiKey && this.key !== 'ollama' && this.key !== 'modal') {
      return { ok: false, detail: 'API key not configured' };
    }
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(`${this.opts.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...this.opts.extraHeaders },
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, detail: res.ok ? 'reachable' : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }
}
