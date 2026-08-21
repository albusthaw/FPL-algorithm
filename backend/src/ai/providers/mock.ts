/**
 * MockProvider — 8th adapter, dev/CI only (fpl-ai-engine-plan.md §10).
 * Deterministic verdicts, scriptable failures. E2E runs and the run-report
 * UI are tested against it with zero cost.
 */
import type { AIInvocation, AIProviderAdapter, ProviderResult } from '../types.js';

export interface MockScript {
  invalidJsonTimes?: number; // return invalid JSON for the first N analyse calls
  rateLimit?: boolean;
  filtered?: boolean;
  lengthFinish?: boolean;
}

export interface MockRosterPlayer {
  name: string;
  club: string | null;
  price: number | null;
  captain: boolean;
  vice: boolean;
  bench_position: number | null;
}

export class MockProvider implements AIProviderAdapter {
  key = 'mock';
  supportsVision = true;
  supportsNativeJsonSchema = true;
  calls = 0;

  constructor(
    private script: MockScript = {},
    private roster?: MockRosterPlayer[], // seeded from ai_providers.config for realistic vision parses
  ) {}

  private usage(prompt: string, completion: string): ProviderResult['usage'] {
    return {
      promptTokens: Math.ceil(prompt.length / 4),
      completionTokens: Math.ceil(completion.length / 4),
      cachedPromptTokens: this.calls > 1 ? Math.ceil(prompt.length / 8) : 0,
    };
  }

  async analyse(system: string, runContext: string, batchBlock: string, _inv: AIInvocation): Promise<ProviderResult> {
    this.calls++;
    if (this.script.rateLimit) throw new Error('mock HTTP 429: rate limited');
    if (this.script.filtered) {
      return { raw: {}, text: '', usage: this.usage(system, ''), finishReason: 'filtered', model: 'mock-1' };
    }
    if ((this.script.invalidJsonTimes ?? 0) >= this.calls) {
      const text = 'Sure! Here are my verdicts: not-json-at-all {{{';
      return { raw: {}, text, usage: this.usage(system + runContext + batchBlock, text), finishReason: 'complete', model: 'mock-1' };
    }
    // deterministic verdicts: adjustment derived from the uid hash, bounded
    const uids = [...batchBlock.matchAll(/PLAYER (plr_[A-Z0-9]+)\|/g)].map((m) => m[1]!);
    const verdicts = uids.map((uid) => {
      let h = 0;
      for (const c of uid) h = (h * 31 + c.charCodeAt(0)) % 997;
      const adjustment = (h % 9) - 4; // −4..+4
      return {
        player_uid: uid,
        adjustment,
        rationale: adjustment === 0 ? 'News neutral; no stat-invisible signal.' : adjustment > 0 ? 'Press hints at secure role; upside beyond stats.' : 'Rotation risk hinted in press conference.',
        confidence: 0.55 + (h % 40) / 100,
      };
    });
    const text = JSON.stringify(verdicts);
    return {
      raw: { verdicts },
      text,
      usage: this.usage(system + runContext + batchBlock, text),
      finishReason: this.script.lengthFinish ? 'length' : 'complete',
      model: 'mock-1',
    };
  }

  async repair(_previous: ProviderResult, _errors: string, inv: AIInvocation): Promise<ProviderResult> {
    // repair always succeeds with an empty-but-valid array unless scripted otherwise
    this.script.invalidJsonTimes = 0;
    return this.analyse('', '', _previous.text.includes('PLAYER') ? _previous.text : '', inv);
  }

  async parseTeamImage(_imageBase64: string, _mimeType: string, _inv: AIInvocation): Promise<ProviderResult> {
    // deterministic 15-man parse used by E2E vision tests; a roster seeded
    // from the live player DB (ai_providers.config.roster) takes precedence
    // over this static fallback (player names churn every season)
    const players = this.roster ?? [
      { name: 'Raya', club: 'ARS', price: 6.0, captain: false, vice: false, bench_position: null },
      { name: 'Gabriel', club: 'ARS', price: 6.3, captain: false, vice: false, bench_position: null },
      { name: 'Virgil', club: 'LIV', price: 6.0, captain: false, vice: false, bench_position: null },
      { name: 'Timber', club: 'ARS', price: 6.0, captain: false, vice: false, bench_position: null },
      { name: 'M.Salah', club: 'LIV', price: 14.5, captain: true, vice: false, bench_position: null },
      { name: 'Palmer', club: 'CHE', price: 10.5, captain: false, vice: true, bench_position: null },
      { name: 'Saka', club: 'ARS', price: 10.0, captain: false, vice: false, bench_position: null },
      { name: 'Rogers', club: 'AVL', price: 7.0, captain: false, vice: false, bench_position: null },
      { name: 'Haaland', club: 'MCI', price: 14.0, captain: false, vice: false, bench_position: null },
      { name: 'Isak', club: 'LIV', price: 10.5, captain: false, vice: false, bench_position: null },
      { name: 'Watkins', club: 'AVL', price: 9.0, captain: false, vice: false, bench_position: null },
      { name: 'Dúbravka', club: 'BUR', price: 4.0, captain: false, vice: false, bench_position: 1 },
      { name: 'Esteve', club: 'BUR', price: 4.0, captain: false, vice: false, bench_position: 2 },
      { name: 'Reinildo', club: 'SUN', price: 4.0, captain: false, vice: false, bench_position: 3 },
      { name: 'Anthony', club: 'BUR', price: 5.0, captain: false, vice: false, bench_position: 4 },
    ];
    const text = JSON.stringify(players);
    return { raw: { players }, text, usage: { promptTokens: 1600, completionTokens: 400, cachedPromptTokens: 0 }, finishReason: 'complete', model: 'mock-vision-1' };
  }

  async parseTeamText(ocrText: string, inv: AIInvocation): Promise<ProviderResult> {
    // OCR reformat behaves like the vision parse in tests — deterministic
    void ocrText;
    return this.parseTeamImage('', 'text/plain', inv);
  }

  async estimateTokens(system: string, runContext: string, batchBlock: string): Promise<number> {
    return Math.ceil((system.length + runContext.length + batchBlock.length) / 4);
  }

  async listModels(): Promise<string[]> {
    return ['mock-analyst-1', 'mock-vision-1'];
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'mock provider always healthy' };
  }
}
