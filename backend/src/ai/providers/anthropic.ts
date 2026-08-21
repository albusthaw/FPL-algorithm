/**
 * Anthropic (Claude) — reference adapter (fpl-ai-engine-plan.md §4.1).
 * Explicit prompt caching via cache_control on the stable prefix; exact
 * token estimation via the free count_tokens endpoint.
 */
import type { AIInvocation, AIProviderAdapter, ProviderResult, ProviderUsage } from '../types.js';
import { VISION_PROMPT, OCR_REFORMAT_PROMPT } from '../prompt.js';
import { resolveCapabilities, type CapabilityConfig, type ModelCapabilities } from '../../core/ai-capabilities.js';

export interface AnthropicOpts {
  apiKey: string;
  model?: string;
  visionModel?: string;
  capabilityConfig: CapabilityConfig;
  fetchFn?: typeof fetch;
}

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
// current canonical id — date-suffixed snapshots are legacy aliases (P4)
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_VISION_MODEL = 'claude-sonnet-5';

export class AnthropicAdapter implements AIProviderAdapter {
  key = 'anthropic';
  supportsVision = true;
  supportsNativeJsonSchema = true;

  constructor(private opts: AnthropicOpts) {}

  private capsFor(model: string): ModelCapabilities {
    return resolveCapabilities(this.opts.capabilityConfig, 'anthropic', model);
  }

  /** temperature only where the model generation still accepts it (P4:
   *  the 4.6+/5 family returns 400 on any sampling param). */
  private temp(model: string, value: number): Record<string, unknown> {
    return this.capsFor(model).temperature === 'free' ? { temperature: value } : {};
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': VERSION,
    };
  }

  private normaliseUsage(u: Record<string, unknown> | undefined): ProviderUsage {
    const usage = u ?? {};
    return {
      promptTokens:
        Number(usage.input_tokens ?? 0) +
        Number(usage.cache_read_input_tokens ?? 0) +
        Number(usage.cache_creation_input_tokens ?? 0),
      completionTokens: Number(usage.output_tokens ?? 0),
      cachedPromptTokens: Number(usage.cache_read_input_tokens ?? 0),
    };
  }

  private async messages(body: Record<string, unknown>, timeoutMs = 120_000): Promise<ProviderResult> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${API}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json = (await res.json()) as Record<string, unknown>;
    const content = (json.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const stop = String(json.stop_reason ?? 'end_turn');
    return {
      raw: json,
      text,
      usage: this.normaliseUsage(json.usage as Record<string, unknown>),
      finishReason: stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'refused' : 'complete',
      model: String(json.model ?? this.opts.model ?? ''),
    };
  }

  async analyse(system: string, runContext: string, batchBlock: string, _inv: AIInvocation): Promise<ProviderResult> {
    const model = this.opts.model ?? DEFAULT_MODEL;
    return this.messages({
      model,
      max_tokens: 4096,
      ...this.temp(model, 0.2),
      // stable prefix with a cache breakpoint at the end of the run context
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: runContext, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: batchBlock },
          ],
        },
      ],
    });
  }

  async repair(previous: ProviderResult, errors: string, _inv: AIInvocation): Promise<ProviderResult> {
    // user-role-only (P4): the Messages API rejects assistant-first sequences
    const model = this.opts.model ?? DEFAULT_MODEL;
    return this.messages({
      model,
      max_tokens: 4096,
      ...this.temp(model, 0),
      messages: [
        {
          role: 'user',
          content: `Your previous JSON output failed validation: ${errors}.\n\nPrevious output:\n${previous.text.slice(0, 8000)}\n\nReturn ONLY the corrected JSON array.`,
        },
      ],
    });
  }

  async parseTeamImage(imageBase64: string, mimeType: string, _inv: AIInvocation): Promise<ProviderResult> {
    const model = this.opts.visionModel ?? this.opts.model ?? DEFAULT_VISION_MODEL;
    return this.messages(
      {
        model,
        max_tokens: 4096,
        ...this.temp(model, 0),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
              { type: 'text', text: VISION_PROMPT },
            ],
          },
        ],
      },
      180_000,
    );
  }

  /** Text-only reformat of OCR output into the team-parse JSON (P3). */
  async parseTeamText(ocrText: string, _inv: AIInvocation): Promise<ProviderResult> {
    const model = this.opts.model ?? DEFAULT_MODEL;
    return this.messages({
      model,
      max_tokens: 2048,
      ...this.temp(model, 0),
      system: [{ type: 'text', text: OCR_REFORMAT_PROMPT }],
      messages: [{ role: 'user', content: ocrText.slice(0, 6000) }],
    });
  }

  async estimateTokens(system: string, runContext: string, batchBlock: string): Promise<number> {
    // free, exact count endpoint
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(`${API}/messages/count_tokens`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.opts.model ?? DEFAULT_MODEL,
          system,
          messages: [{ role: 'user', content: `${runContext}\n\n${batchBlock}` }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { input_tokens: number };
        return json.input_tokens;
      }
    } catch {
      /* fall through to approximation */
    }
    return Math.ceil((system.length + runContext.length + batchBlock.length) / 3.6);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.opts.apiKey) return { ok: false, detail: 'ANTHROPIC_API_KEY not configured' };
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(`${API}/models`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      return { ok: res.ok, detail: res.ok ? 'reachable' : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }

  async listModels(): Promise<string[]> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${API}/models?limit=100`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id).sort();
  }
}
