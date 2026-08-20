/**
 * AI-provider enable-time probe (fpl-ai-engine-plan.md §10):
 *   npx tsx scripts/probe/ai-provider.ts <key>
 * Auth check, one minimal completion, one schema-enforced completion,
 * usage-field presence assertions. Failures keep the provider
 * un-enableable (the admin activate route runs healthCheck()).
 */
import { createDb } from '../../backend/src/core/db.js';
import { buildAdapter } from '../../backend/src/ai/gateway.js';
import { validateVerdicts } from '../../backend/src/ai/validator.js';
import { SYSTEM_BLOCK, buildRunContext } from '../../backend/src/ai/prompt.js';

const key = process.argv[2];
if (!key) {
  console.error('usage: npx tsx scripts/probe/ai-provider.ts <anthropic|openai|gemini|deepseek|kimi|ollama|modal|mock>');
  process.exit(2);
}

async function main(): Promise<void> {
  const db = createDb();
  const row = await db('ai_providers').where({ key }).first();
  const adapter = buildAdapter(key!, row?.config ?? {});
  const report: string[] = [];

  // 1. health / auth
  const health = await adapter.healthCheck();
  report.push(`health: ${health.ok ? 'OK' : 'FAIL'} — ${health.detail}`);
  if (!health.ok) {
    print(report);
    process.exit(1);
  }

  // 2. schema-enforced completion with one synthetic player
  const inv = { triggeredByUserId: 0, triggerKind: 'admin_action' as const };
  const batch = 'PLAYER plr_PROBE|MID|TST|8.0|70.0|12.0|0.90|5.0|fit\n  NEWS[probe|1h] Probe headline — probe snippet.\n\nReturn the JSON array now for these 1 players.';
  const started = Date.now();
  const result = await adapter.analyse(SYSTEM_BLOCK, buildRunContext(1, '', ''), batch, inv);
  report.push(`completion: ${Date.now() - started}ms, finish=${result.finishReason}, model=${result.model}`);

  // 3. usage-field presence (the §8.1 normalisation map must produce numbers)
  const u = result.usage;
  const usageOk = Number.isFinite(u.promptTokens) && Number.isFinite(u.completionTokens) && u.promptTokens > 0;
  report.push(`usage: prompt=${u.promptTokens} completion=${u.completionTokens} cached=${u.cachedPromptTokens} — ${usageOk ? 'OK' : 'MISSING FIELDS'}`);

  // 4. schema validation of the output
  const validation = validateVerdicts(result.text, new Set(['plr_PROBE']));
  report.push(`verdict schema: ${validation.ok ? `OK (${validation.verdicts.length} verdicts)` : `INVALID — ${validation.errors[0] ?? ''}`}`);

  // 5. vision claim check
  report.push(`vision claimed: ${adapter.supportsVision} (parseTeamImage untested by this probe — costs an image call)`);

  print(report);
  await db.destroy();
  if (!usageOk || !validation.ok) process.exit(1);
}

function print(lines: string[]): void {
  console.log(`\n── AI probe: ${key} ──`);
  for (const line of lines) console.log('  ' + line);
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
