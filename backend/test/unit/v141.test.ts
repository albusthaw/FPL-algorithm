/**
 * v1.4.1 units: P4 capability registry, param learning, adapter request
 * shapes, X1 env locking, P3 OCR pipeline pieces.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  resolveCapabilities,
  learnFromParamError,
} from '../../src/core/ai-capabilities.js';
import { OpenAICompatibleAdapter } from '../../src/ai/providers/openai-compatible.js';
import { AnthropicAdapter } from '../../src/ai/providers/anthropic.js';
import { GeminiAdapter } from '../../src/ai/providers/gemini.js';

const CFG = DEFAULT_CAPABILITIES;

describe('P4 — model capability registry', () => {
  it('OpenAI gpt-5/o-series: max_completion_tokens + temperature locked', () => {
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-5.6-turbo', 'o3', 'o4-mini', 'o1-preview']) {
      const caps = resolveCapabilities(CFG, 'openai', m);
      expect(caps.tokenParam).toBe('max_completion_tokens');
      expect(caps.temperature).toBe('omit');
      expect(caps.vision).toBe(true);
    }
  });

  it('OpenAI gpt-4 family: max_completion_tokens accepted, temperature free', () => {
    const caps = resolveCapabilities(CFG, 'openai', 'gpt-4o-mini');
    expect(caps.tokenParam).toBe('max_completion_tokens');
    expect(caps.temperature).toBe('free');
  });

  it('Anthropic: temperature omitted on the 4.6+/5 family, free on ≤4.5', () => {
    expect(resolveCapabilities(CFG, 'anthropic', 'claude-sonnet-5').temperature).toBe('omit');
    expect(resolveCapabilities(CFG, 'anthropic', 'claude-opus-4-7').temperature).toBe('omit');
    expect(resolveCapabilities(CFG, 'anthropic', 'claude-haiku-4-5').temperature).toBe('free');
    expect(resolveCapabilities(CFG, 'anthropic', 'claude-sonnet-5').tokenParam).toBe('max_tokens');
  });

  it('DeepSeek: vision is per-MODEL — the vision-exp sibling unlocks it', () => {
    expect(resolveCapabilities(CFG, 'deepseek', 'deepseek-v4-flash').vision).toBe(false);
    expect(resolveCapabilities(CFG, 'deepseek', 'deepseek-v4-flash-vision-exp').vision).toBe(true);
    expect(resolveCapabilities(CFG, 'deepseek', 'deepseek-v4-flash').tokenParam).toBe('max_tokens');
  });

  it('learned overrides win over registry rules', () => {
    const caps = resolveCapabilities(CFG, 'deepseek', 'deepseek-v4-flash', { tokenParam: 'max_completion_tokens' });
    expect(caps.tokenParam).toBe('max_completion_tokens');
  });

  it('learnFromParamError decodes both provider 400 shapes', () => {
    expect(
      learnFromParamError(`{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}`),
    ).toEqual({ tokenParam: 'max_completion_tokens' });
    expect(
      learnFromParamError(`{"error":{"message":"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."}}`),
    ).toEqual({ temperature: 'omit' });
    expect(learnFromParamError('{"error":{"message":"invalid api key"}}')).toBeNull();
  });
});

describe('P4 — adapter request shapes (recorded-fixture fakes)', () => {
  const capture = (): { bodies: Record<string, unknown>[]; fetchFn: typeof fetch } => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'x' }),
        { status: 200 },
      );
    }) as typeof fetch;
    return { bodies, fetchFn };
  };

  it('gpt-5-class request carries max_completion_tokens and NO temperature', async () => {
    const { bodies, fetchFn } = capture();
    const a = new OpenAICompatibleAdapter({
      key: 'openai', baseUrl: 'http://fake', apiKey: 'k', model: 'gpt-5-mini', capabilityConfig: CFG, fetchFn,
    });
    await a.analyse('sys', 'ctx', 'batch', { triggeredByUserId: 1, triggerKind: 'run_button' });
    expect(bodies[0]).toHaveProperty('max_completion_tokens');
    expect(bodies[0]).not.toHaveProperty('max_tokens');
    expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('deepseek request keeps max_tokens + temperature (rename would break it)', async () => {
    const { bodies, fetchFn } = capture();
    const a = new OpenAICompatibleAdapter({
      key: 'deepseek', baseUrl: 'http://fake', apiKey: 'k', model: 'deepseek-v4-flash', capabilityConfig: CFG, fetchFn,
    });
    await a.analyse('sys', 'ctx', 'batch', { triggeredByUserId: 1, triggerKind: 'run_button' });
    expect(bodies[0]).toHaveProperty('max_tokens');
    expect(bodies[0]).toHaveProperty('temperature');
    expect((bodies[0] as { response_format?: { type: string } }).response_format?.type).toBe('json_object');
  });

  it('a live max_tokens 400 is learned and retried once with the corrected shape', async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }], usage: {}, model: 'x' }),
        { status: 200 },
      );
    }) as typeof fetch;
    let learned: Record<string, unknown> | null = null;
    // an unknown/custom model id that the registry defaults to max_tokens for
    const a = new OpenAICompatibleAdapter({
      key: 'modal', baseUrl: 'http://fake', apiKey: 'k', model: 'my-vllm-model', capabilityConfig: CFG, fetchFn,
      onLearned: (p) => { learned = { ...(learned ?? {}), ...p }; },
    });
    const res = await a.analyse('sys', 'ctx', 'batch', { triggeredByUserId: 1, triggerKind: 'run_button' });
    expect(res.finishReason).toBe('complete');
    expect(bodies[0]).toHaveProperty('max_tokens');
    expect(bodies[1]).toHaveProperty('max_completion_tokens');
    expect(bodies[1]).not.toHaveProperty('max_tokens');
    expect(learned).toEqual({ tokenParam: 'max_completion_tokens' });
  });

  it('vision reply truncation is detectable (finish_reason length)', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '[{"name":"Haal' }, finish_reason: 'length' }], usage: {}, model: 'x' }),
        { status: 200 },
      )) as typeof fetch;
    const a = new OpenAICompatibleAdapter({
      key: 'openai', baseUrl: 'http://fake', apiKey: 'k', model: 'gpt-4o-mini', capabilityConfig: CFG, fetchFn,
    });
    const res = await a.parseTeamImage('aGk=', 'image/png', { triggeredByUserId: 1, triggerKind: 'image_parse' });
    expect(res.finishReason).toBe('length');
  });

  it('array-of-parts content is flattened, not stringified as [object Object]', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '[{"a"' }, { type: 'text', text: ':1}]' }] }, finish_reason: 'stop' }], usage: {}, model: 'x' }),
        { status: 200 },
      )) as typeof fetch;
    const a = new OpenAICompatibleAdapter({
      key: 'kimi', baseUrl: 'http://fake', apiKey: 'k', model: 'kimi-k2-0711-preview', capabilityConfig: CFG, fetchFn,
    });
    const res = await a.analyse('s', 'c', 'b', { triggeredByUserId: 1, triggerKind: 'run_button' });
    expect(res.text).toBe('[{"a":1}]');
  });

  it('anthropic repair is user-role-only and omits temperature on 5-family', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '[]' }], usage: {}, stop_reason: 'end_turn', model: 'claude-sonnet-5' }), { status: 200 });
    }) as typeof fetch;
    const a = new AnthropicAdapter({ apiKey: 'k', model: 'claude-sonnet-5', capabilityConfig: CFG, fetchFn });
    await a.repair({ raw: {}, text: 'bad', usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 }, finishReason: 'complete', model: 'x' }, 'err', {
      triggeredByUserId: 1, triggerKind: 'run_button',
    });
    const msgs = bodies[0]!.messages as { role: string }[];
    expect(msgs[0]!.role).toBe('user');
    expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('gemini repair contents start with a user turn and 2.5 gets the raised output budget', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason: 'STOP' }], usageMetadata: {} }), { status: 200 });
    }) as typeof fetch;
    const g = new GeminiAdapter({ apiKey: 'k', model: 'gemini-2.5-flash', capabilityConfig: CFG, fetchFn });
    await g.repair({ raw: {}, text: 'bad', usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 }, finishReason: 'complete', model: 'x' }, 'err', {
      triggeredByUserId: 1, triggerKind: 'run_button',
    });
    const contents = bodies[0]!.contents as { role: string }[];
    expect(contents[0]!.role).toBe('user');
    expect((bodies[0]!.generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(8192);
  });
});

describe('X1 — env writer locking + canonical path', () => {
  it('concurrent upserts never lose keys (lock serialises the RMW)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envlock-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'A=1\n');
    process.env.ENV_FILE = file;
    const { upsertEnvVar, resetEnvFileCache } = await import('../../src/core/env.js');
    resetEnvFileCache();
    // interleave many writers synchronously-ish
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => upsertEnvVar(`KEY_${i % 5}`, `v${i}`))),
    );
    const text = fs.readFileSync(file, 'utf8');
    for (let k = 0; k < 5; k++) expect(text).toMatch(new RegExp(`^KEY_${k}=v\\d+$`, 'm'));
    expect(text).toMatch(/^A=1$/m); // pre-existing key survives
    delete process.env.ENV_FILE;
    resetEnvFileCache();
  });
});

describe('P3 — OCR pipeline pieces', () => {
  it('preprocess + OCR extracts names from a synthetic FPL-style screenshot', async () => {
    const sharp = (await import('sharp')).default;
    const names = ['RAYA', 'GABRIEL', 'VIRGIL', 'SALAH', 'HAALAND', 'PALMER', 'SAKA', 'WATKINS', 'ROGERS', 'ISAK', 'TIMBER'];
    const rows = names.map((n, i) => `<text x="40" y="${60 + i * 56}" font-size="34" font-family="DejaVu Sans, sans-serif" fill="white">${n} 7.5</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${120 + names.length * 56}"><rect width="100%" height="100%" fill="#1C2B4A"/>${rows}</svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const { ocrTeamImage, terminateOcr } = await import('../../src/ocr/parse.js');
    const result = await ocrTeamImage(png);
    await terminateOcr();
    expect(result.nameLike).toBeGreaterThanOrEqual(8); // the ⚙ min_names gate
    const found = names.filter((n) => result.text.toUpperCase().includes(n));
    expect(found.length).toBeGreaterThanOrEqual(7);
  }, 120_000);
});
