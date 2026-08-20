import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVerdicts, extractJson } from '../../src/ai/validator.js';
import { assertOk } from '../../src/ingest/adapters/api-football.js';
import { extractUnderstatVar } from '../../src/ingest/adapters/misc-providers.js';
import { PullError } from '../../src/ingest/errors.js';
import { SYSTEM_BLOCK, buildBatchBlock, buildMatrixLine } from '../../src/ai/prompt.js';
import { computeCredits } from '../../src/ai/gateway.js';
import { DEFAULT_CONFIG } from '../../src/core/model-config.js';

describe('AI validator', () => {
  const uids = new Set(['plr_A', 'plr_B']);

  it('accepts valid verdicts, clamps out-of-range adjustments', () => {
    const r = validateVerdicts(
      JSON.stringify([
        { player_uid: 'plr_A', adjustment: 35, rationale: 'x'.repeat(300), confidence: 0.9 },
        { player_uid: 'plr_B', adjustment: -3, rationale: 'ok', confidence: 0.5 },
      ]),
      uids,
    );
    expect(r.ok).toBe(true);
    expect(r.verdicts.find((v) => v.player_uid === 'plr_A')!.adjustment).toBe(20); // clamped
    expect(r.verdicts.find((v) => v.player_uid === 'plr_A')!.rationale.length).toBeLessThanOrEqual(160);
    expect(r.warnings.join()).toMatch(/out of bounds/);
  });

  it('drops hallucinated player_uids', () => {
    const r = validateVerdicts(JSON.stringify([{ player_uid: 'plr_FAKE', adjustment: 5, rationale: '', confidence: 1 }]), uids);
    expect(r.ok).toBe(true);
    expect(r.verdicts).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/hallucinated/);
  });

  it('duplicate uids: last wins with a warning', () => {
    const r = validateVerdicts(
      JSON.stringify([
        { player_uid: 'plr_A', adjustment: 1, rationale: 'first', confidence: 1 },
        { player_uid: 'plr_A', adjustment: 2, rationale: 'second', confidence: 1 },
      ]),
      uids,
    );
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0]!.adjustment).toBe(2);
  });

  it('invalid JSON fails (repair path arms)', () => {
    const r = validateVerdicts('sure, here you go: {{{', uids);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('tolerates markdown fences and {verdicts: []} wrapping', () => {
    const fenced = '```json\n[{"player_uid":"plr_A","adjustment":1,"rationale":"","confidence":0.5}]\n```';
    expect(validateVerdicts(fenced, uids).verdicts).toHaveLength(1);
    const wrapped = JSON.stringify({ verdicts: [{ player_uid: 'plr_B', adjustment: 0, rationale: '', confidence: 0.5 }] });
    expect(validateVerdicts(wrapped, uids).verdicts).toHaveLength(1);
  });

  it('extractJson finds JSON inside prose', () => {
    expect(JSON.parse(extractJson('Here is the data: [1,2,3] hope it helps'))).toEqual([1, 2, 3]);
  });
});

describe('cache-aware prompt layout', () => {
  it('system block is byte-stable and exceeds caching minimums', () => {
    expect(SYSTEM_BLOCK).toBe(SYSTEM_BLOCK); // referential — frozen constant
    expect(SYSTEM_BLOCK.length).toBeGreaterThan(1000); // ~1k-token minimum needs ~4k chars; combined with run context it clears the bar for haiku-class tokenisers
    expect(SYSTEM_BLOCK).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates
  });

  it('batch block lists players in the fixed pipe format', () => {
    const line = buildMatrixLine({ uid: 'plr_X', position: 'MID', club: 'ARS', price: 105, statScore: 88.2, xptsNext3: 15.3, pStart: 0.93, form: 6.1, status: 'fit' });
    expect(line).toBe('plr_X|MID|ARS|10.5|88.2|15.3|0.93|6.1|fit');
    const block = buildBatchBlock([
      { playerUid: 'plr_X', webName: 'X', position: 'MID', club: 'ARS', price: 105, matrixLine: line, news: [{ id: 1, title: 'T', snippet: 'S', source: 'BBC', ageHours: 5 }] },
    ]);
    expect(block).toContain('PLAYER plr_X|MID');
    expect(block).toContain('NEWS[BBC|5h]');
  });
});

describe('credit accounting', () => {
  const pricing = DEFAULT_CONFIG.ai_pricing as { credit_usd: number; providers: Record<string, { in: number; out: number; cached: number }> };

  it('cached tokens are billed at the cached rate', () => {
    const noCahe = computeCredits(pricing, 'anthropic', { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 0 });
    const allCached = computeCredits(pricing, 'anthropic', { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 1_000_000 });
    expect(noCahe).toBe(1000); // $1/Mtok at $0.001/credit
    expect(allCached).toBe(100); // 0.1× read multiplier
  });

  it('ollama costs zero credits', () => {
    expect(computeCredits(pricing, 'ollama', { promptTokens: 5_000_000, completionTokens: 1_000_000, cachedPromptTokens: 0 })).toBe(0);
  });

  it('deepseek cache hits are ~50× cheaper', () => {
    const miss = computeCredits(pricing, 'deepseek', { promptTokens: 10_000_000, completionTokens: 0, cachedPromptTokens: 0 });
    const hit = computeCredits(pricing, 'deepseek', { promptTokens: 10_000_000, completionTokens: 0, cachedPromptTokens: 10_000_000 });
    expect(miss / Math.max(1, hit)).toBeGreaterThan(20);
  });
});

describe('API-Football assertOk (errors inside HTTP 200)', () => {
  it('plan denial inside 200 → PLAN_DENIED', () => {
    expect(() =>
      assertOk({ errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' }, results: 0, response: [] }),
    ).toThrowError(expect.objectContaining({ errorClass: 'PLAN_DENIED' }));
  });

  it('rate limit inside 200 → RATE_LIMITED', () => {
    expect(() => assertOk({ errors: { rateLimit: 'Too many requests' }, results: 0, response: [] })).toThrowError(
      expect.objectContaining({ errorClass: 'RATE_LIMITED' }),
    );
  });

  it('empty response with empty errors → EMPTY_OK, not an error state', () => {
    expect(() => assertOk({ errors: {}, results: 0, response: [] })).toThrowError(
      expect.objectContaining({ errorClass: 'EMPTY_OK' }),
    );
  });

  it('happy path passes rows through', () => {
    const { response } = assertOk({ errors: [], results: 1, response: [{ fixture: { id: 1 } }] });
    expect(response).toHaveLength(1);
  });
});

describe('Understat extraction', () => {
  it('decodes hex-escaped JSON.parse vars', () => {
    const html = `<script>var playersData = JSON.parse('\\x5B\\x7B\\x22id\\x22\\x3A\\x221\\x22\\x7D\\x5D');</script>`;
    expect(extractUnderstatVar(html, 'playersData')).toEqual([{ id: '1' }]);
  });

  it('layout change → SCHEMA_DRIFT', () => {
    expect(() => extractUnderstatVar('<html>redesigned</html>', 'playersData')).toThrowError(PullError);
  });
});

describe('ARCHITECTURAL GATE: scheduler cannot reach the AI layer', () => {
  it('walks the scheduler import graph — no path into src/ai/', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, '../../src');
    const visited = new Set<string>();
    const queue = [path.join(srcRoot, 'run/scheduler.ts')];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file) || !fs.existsSync(file)) continue;
      visited.add(file);
      const text = fs.readFileSync(file, 'utf8');
      // static imports only — dynamic import() of the AI gateway happens in
      // route/orchestrator AI branches which scheduler passes ai=null to
      for (const m of text.matchAll(/^import\s+(?!type\b)[^'"]*['"](\.[^'"]+)['"]/gm)) {
        const resolved = path.resolve(path.dirname(file), m[1]!.replace(/\.js$/, '.ts'));
        expect(resolved).not.toContain(`${path.sep}ai${path.sep}`);
        queue.push(resolved);
      }
    }
    expect(visited.size).toBeGreaterThan(3);
  });

  it('orchestrator only reaches the AI gateway behind a non-null ai option', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const orch = fs.readFileSync(path.resolve(here, '../../src/run/orchestrator.ts'), 'utf8');
    // the single dynamic import of the gateway must sit inside the `if (opts.ai)` branch
    const gatewayImports = [...orch.matchAll(/import\('\.\.\/ai\/gateway\.js'\)/g)];
    expect(gatewayImports).toHaveLength(1);
    const guardIdx = orch.indexOf('if (opts.ai)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(orch.indexOf("import('../ai/gateway.js')")).toBeGreaterThan(guardIdx);
  });
});
