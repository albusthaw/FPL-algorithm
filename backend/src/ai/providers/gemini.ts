/**
 * Google Gemini adapter (fpl-ai-engine-plan.md §4.3): responseSchema-guided
 * JSON (repair retry stays ON), implicit caching, free countTokens.
 */
import type { AIInvocation, AIProviderAdapter, ProviderResult, ProviderUsage } from '../types.js';
import { VISION_PROMPT } from '../prompt.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiAdapter implements AIProviderAdapter {
  key = 'gemini';
  supportsVision = true;
  supportsNativeJsonSchema = false; // schema-guided, not strict → repair ON

  constructor(private opts: { apiKey: string; model?: string; fetchFn?: typeof fetch }) {}

  private model(): string {
    return this.opts.model ?? 'gemini-2.5-flash';
  }

  private normaliseUsage(u: Record<string, unknown> | undefined): ProviderUsage {
    const m = u ?? {};
    return {
      promptTokens: Number(m.promptTokenCount ?? 0),
      completionTokens: Number(m.candidatesTokenCount ?? 0),
      cachedPromptTokens: Number(m.cachedContentTokenCount ?? 0),
    };
  }

  private async generate(contents: unknown[], systemText: string | null, json: boolean, timeoutMs = 120_000): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        ...(json
          ? {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    player_uid: { type: 'STRING' },
                    adjustment: { type: 'INTEGER' },
                    rationale: { type: 'STRING' },
                    confidence: { type: 'NUMBER' },
                  },
                  required: ['player_uid', 'adjustment', 'rationale', 'confidence'],
                },
              },
            }
          : {}),
      },
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    };
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${API}/models/${this.model()}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const out = (await res.json()) as Record<string, unknown>;
    const candidates = (out.candidates as Record<string, unknown>[] | undefined) ?? [];
    const first = candidates[0] ?? {};
    const parts = ((first.content as Record<string, unknown> | undefined)?.parts as { text?: string }[] | undefined) ?? [];
    const finish = String(first.finishReason ?? 'STOP');
    return {
      raw: out,
      text: parts.map((p) => p.text ?? '').join(''),
      usage: this.normaliseUsage(out.usageMetadata as Record<string, unknown>),
      finishReason: finish === 'MAX_TOKENS' ? 'length' : finish === 'SAFETY' ? 'filtered' : 'complete',
      model: this.model(),
    };
  }

  async analyse(system: string, runContext: string, batchBlock: string, _inv: AIInvocation): Promise<ProviderResult> {
    return this.generate([{ role: 'user', parts: [{ text: `${runContext}\n\n${batchBlock}` }] }], system, true);
  }

  async repair(previous: ProviderResult, errors: string, _inv: AIInvocation): Promise<ProviderResult> {
    return this.generate(
      [
        { role: 'model', parts: [{ text: previous.text.slice(0, 8000) }] },
        { role: 'user', parts: [{ text: `Your previous output failed validation: ${errors}. Return ONLY the corrected JSON array.` }] },
      ],
      null,
      true,
    );
  }

  async parseTeamImage(imageBase64: string, mimeType: string, _inv: AIInvocation): Promise<ProviderResult> {
    return this.generate(
      [
        {
          role: 'user',
          parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: VISION_PROMPT }],
        },
      ],
      null,
      false,
      180_000,
    );
  }

  async estimateTokens(system: string, runContext: string, batchBlock: string): Promise<number> {
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(`${API}/models/${this.model()}:countTokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `${system}\n${runContext}\n${batchBlock}` }] }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { totalTokens: number };
        return json.totalTokens;
      }
    } catch {
      /* approximation below */
    }
    return Math.ceil((system.length + runContext.length + batchBlock.length) / 3.6);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.opts.apiKey) return { ok: false, detail: 'GEMINI_API_KEY not configured' };
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(`${API}/models/${this.model()}`, {
        headers: { 'x-goog-api-key': this.opts.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, detail: res.ok ? 'reachable' : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }

  async listModels(): Promise<string[]> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(`${API}/models?pageSize=100`, {
      headers: { 'x-goog-api-key': this.opts.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .sort();
  }
}
