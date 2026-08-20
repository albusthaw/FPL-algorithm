/**
 * Ollama self-hosted adapter (fpl-ai-engine-plan.md §4.6): native /api/chat
 * with grammar-constrained structured outputs; zero token cost by default;
 * loopback-only unless OLLAMA_ALLOW_REMOTE=true.
 */
import type { AIInvocation, AIProviderAdapter, ProviderResult } from '../types.js';
import { VISION_PROMPT } from '../prompt.js';

const VERDICT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['player_uid', 'adjustment', 'rationale', 'confidence'],
    properties: {
      player_uid: { type: 'string' },
      adjustment: { type: 'integer' },
      rationale: { type: 'string' },
      confidence: { type: 'number' },
    },
  },
};

export class OllamaAdapter implements AIProviderAdapter {
  key = 'ollama';
  supportsVision: boolean;
  supportsNativeJsonSchema = true; // grammar-constrained; repair still armed (small models drift)

  constructor(
    private opts: { url: string; model?: string; visionModel?: string; allowRemote?: boolean; fetchFn?: typeof fetch },
  ) {
    this.supportsVision = !!opts.visionModel;
  }

  private assertUrl(): void {
    const url = new URL(this.opts.url);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (!loopback && !this.opts.allowRemote) {
      throw new Error('non-loopback Ollama URL refused — set OLLAMA_ALLOW_REMOTE=true behind authenticated reverse proxy');
    }
  }

  private async chat(messages: unknown[], opts: { schema?: unknown; images?: boolean } = {}): Promise<ProviderResult> {
    this.assertUrl();
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${this.opts.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.images ? (this.opts.visionModel ?? this.opts.model ?? 'llama3.1:8b') : (this.opts.model ?? 'llama3.1:8b'),
        messages,
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0.2, num_ctx: 8192 },
        ...(opts.schema ? { format: opts.schema } : {}),
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json = (await res.json()) as Record<string, unknown>;
    const message = (json.message ?? {}) as Record<string, unknown>;
    return {
      raw: json,
      text: String(message.content ?? ''),
      usage: {
        promptTokens: Number(json.prompt_eval_count ?? 0),
        completionTokens: Number(json.eval_count ?? 0),
        cachedPromptTokens: 0,
      },
      finishReason: json.done_reason === 'length' ? 'length' : 'complete',
      model: String(json.model ?? ''),
    };
  }

  async analyse(system: string, runContext: string, batchBlock: string, _inv: AIInvocation): Promise<ProviderResult> {
    return this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: `${runContext}\n\n${batchBlock}` },
      ],
      { schema: VERDICT_SCHEMA },
    );
  }

  async repair(previous: ProviderResult, errors: string, _inv: AIInvocation): Promise<ProviderResult> {
    return this.chat(
      [
        { role: 'assistant', content: previous.text.slice(0, 8000) },
        { role: 'user', content: `Your previous output failed validation: ${errors}. Return ONLY the corrected JSON array.` },
      ],
      { schema: VERDICT_SCHEMA },
    );
  }

  async parseTeamImage(imageBase64: string, _mimeType: string, _inv: AIInvocation): Promise<ProviderResult> {
    if (!this.supportsVision) throw new Error('ollama vision model not configured');
    return this.chat([{ role: 'user', content: VISION_PROMPT, images: [imageBase64] }], { images: true });
  }

  async estimateTokens(system: string, runContext: string, batchBlock: string): Promise<number> {
    return Math.ceil((system.length + runContext.length + batchBlock.length) / 3.6);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      this.assertUrl();
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(`${this.opts.url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const json = (await res.json()) as { models?: { name: string }[] };
      const models = (json.models ?? []).map((m) => m.name);
      const wanted = this.opts.model ?? 'llama3.1:8b';
      return models.some((m) => m.startsWith(wanted.split(':')[0]!))
        ? { ok: true, detail: `models: ${models.slice(0, 5).join(', ')}` }
        : { ok: false, detail: `model ${wanted} not pulled (have: ${models.slice(0, 5).join(', ') || 'none'})` };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }
}
