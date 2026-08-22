/**
 * OpenAI-compatible chat-completions base adapter — serves OpenAI, DeepSeek,
 * Kimi (Moonshot) and Modal-deployed vLLM endpoints. Usage-field
 * normalisation per the archived AI plan §8.1.
 *
 * P4 (v1.4.1): every request is built from the model-capability registry —
 * token-limit param name (max_tokens vs max_completion_tokens), whether
 * temperature may be sent at all, JSON mode, and per-MODEL vision. A 400
 * naming a parameter is LEARNED (mirroring ingest entitlement learning) and
 * the request retried once with the corrected shape.
 */
import {
  resolveCapabilities,
  learnFromParamError,
  type CapabilityConfig,
  type ModelCapabilities,
} from '../../core/ai-capabilities.js';
import type { AIInvocation, AIProviderAdapter, ProviderResult, ProviderUsage } from '../types.js';

export interface OpenAICompatibleOpts {
  key: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  capabilityConfig: CapabilityConfig;
  learned?: Partial<ModelCapabilities> | null;
  /** Called when a live 400 teaches a capability fact — persist it. */
  onLearned?: (patch: Partial<ModelCapabilities>) => void | Promise<void>;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxTokens?: number; // reasoning-style models spend completion tokens thinking — give them room
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

/** Content may arrive as a string or an array of typed parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join('');
  }
  return '';
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  key: string;
  supportsVision: boolean;
  supportsNativeJsonSchema: boolean;
  private learned: Partial<ModelCapabilities> | null;

  constructor(protected opts: OpenAICompatibleOpts) {
    this.key = opts.key;
    this.learned = opts.learned ?? null;
    const visionCaps = this.capsFor(opts.visionModel ?? opts.model);
    this.supportsVision = visionCaps.vision;
    this.supportsNativeJsonSchema = this.capsFor(opts.model).json === 'json_schema';
  }

  protected capsFor(model: string): ModelCapabilities {
    return resolveCapabilities(this.opts.capabilityConfig, this.key, model, this.learned);
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

  private buildBody(
    model: string,
    messages: unknown[],
    caps: ModelCapabilities,
    opts: { json: boolean; temperature: number; maxTokens: number },
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { model, messages };
    body[caps.tokenParam] = Math.min(opts.maxTokens, caps.maxOutput ?? opts.maxTokens);
    if (caps.temperature === 'free') body.temperature = opts.temperature;
    if (opts.json) {
      if (caps.json === 'json_schema') body.response_format = { type: 'json_schema', json_schema: VERDICT_JSON_SCHEMA };
      else if (caps.json === 'json_object') body.response_format = { type: 'json_object' };
    }
    return body;
  }

  /** POST /chat/completions with single param-learning retry on 400. */
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const doPost = async (b: Record<string, unknown>): Promise<Response> =>
      fetchFn(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.extraHeaders,
        },
        body: JSON.stringify(b),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await doPost(body);
    if (res.status === 400) {
      const text = await res.text();
      const patch = learnFromParamError(text);
      if (patch) {
        this.learned = { ...(this.learned ?? {}), ...patch };
        await this.opts.onLearned?.(patch);
        const retried: Record<string, unknown> = { ...body };
        if (patch.tokenParam === 'max_completion_tokens' && 'max_tokens' in retried) {
          retried.max_completion_tokens = retried.max_tokens;
          delete retried.max_tokens;
        }
        if (patch.temperature === 'omit') delete retried.temperature;
        res = await doPost(retried);
        if (!res.ok) throw new Error(`${this.key} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
        return (await res.json()) as Record<string, unknown>;
      }
      throw new Error(`${this.key} HTTP 400: ${text.slice(0, 400)}`);
    }
    if (!res.ok) throw new Error(`${this.key} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private toResult(json: Record<string, unknown>, fallbackModel: string): ProviderResult {
    const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const finish = String(choice.finish_reason ?? 'stop');
    return {
      raw: json,
      text: contentText(message.content),
      usage: this.normaliseUsage(json.usage as Record<string, unknown>),
      finishReason: finish === 'length' ? 'length' : finish === 'content_filter' ? 'filtered' : 'complete',
      model: String(json.model ?? fallbackModel),
    };
  }

  protected async chat(messages: unknown[], useJsonMode: boolean): Promise<ProviderResult> {
    const caps = this.capsFor(this.opts.model);
    const body = this.buildBody(this.opts.model, messages, caps, {
      json: useJsonMode,
      temperature: 0.2,
      maxTokens: this.opts.maxTokens ?? 4096,
    });
    const json = await this.post(body, this.opts.timeoutMs ?? 120_000);
    return this.toResult(json, this.opts.model);
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
    // user-role-only repair: valid on every provider family (assistant-first
    // sequences 400 on several APIs), and the previous output travels as data
    return this.chat(
      [
        {
          role: 'user',
          content: `Your previous JSON output failed validation: ${errors}.\n\nPrevious output:\n${previous.text.slice(0, 8000)}\n\nReturn ONLY the corrected JSON array.`,
        },
      ],
      true,
    );
  }

  async parseTeamImage(imageBase64: string, mimeType: string, _inv: AIInvocation): Promise<ProviderResult> {
    const model = this.opts.visionModel ?? this.opts.model;
    const caps = this.capsFor(model);
    if (!caps.vision) throw new Error(`${this.key} model ${model} does not support vision`);
    const { VISION_PROMPT } = await import('../prompt.js');
    const body = this.buildBody(
      model,
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      caps,
      { json: false, temperature: 0, maxTokens: this.opts.maxTokens ?? 4096 },
    );
    const json = await this.post(body, this.opts.timeoutMs ?? 180_000);
    // real finish reason — a truncated vision reply must be diagnosable
    return this.toResult(json, model);
  }

  /** Text-only reformat of OCR output into the team-parse JSON (P3). */
  async parseTeamText(ocrText: string, _inv: AIInvocation): Promise<ProviderResult> {
    const { OCR_REFORMAT_PROMPT } = await import('../prompt.js');
    return this.chat(
      [
        { role: 'system', content: OCR_REFORMAT_PROMPT },
        { role: 'user', content: ocrText.slice(0, 6000) },
      ],
      true,
    );
  }

  /**
   * Probe-and-learn (admin model selection): one tiny request; parameter 400s
   * teach the registry. Returns the effective capabilities after the probe.
   */
  async probeCapabilities(): Promise<ModelCapabilities> {
    const caps = this.capsFor(this.opts.model);
    const body = this.buildBody(this.opts.model, [{ role: 'user', content: 'Reply with the word: pong' }], caps, {
      json: false,
      temperature: 0.2,
      maxTokens: 16,
    });
    try {
      await this.post(body, 30_000);
    } catch {
      /* non-param errors (auth, network) leave the registry untouched */
    }
    return this.capsFor(this.opts.model);
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

  async listModels(): Promise<string[]> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${this.opts.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...this.opts.extraHeaders },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id).sort();
  }
}
