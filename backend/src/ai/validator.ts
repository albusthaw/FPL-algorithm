/**
 * One Validator for all providers (fpl-ai-engine-plan.md §7).
 * Single repair retry, ever. Bounds clamped by the engine; hallucinated
 * player_uids dropped; duplicates last-wins; missing players → stale.
 */
import { z } from 'zod';
import type { AIVerdict } from './types.js';

const VerdictSchema = z.object({
  player_uid: z.string(),
  adjustment: z.number(),
  rationale: z.string().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});

const VerdictArraySchema = z.union([
  z.array(VerdictSchema),
  z.object({ verdicts: z.array(VerdictSchema) }).transform((o) => o.verdicts),
]);

export interface ValidationResult {
  ok: boolean;
  verdicts: AIVerdict[];
  warnings: string[];
  errors: string[];
}

export function validateVerdicts(text: string, expectedUids: Set<string>): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    return { ok: false, verdicts: [], warnings, errors: [`invalid JSON: ${String(err)}`] };
  }

  const result = VerdictArraySchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      verdicts: [],
      warnings,
      errors: result.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const byUid = new Map<string, AIVerdict>();
  for (const v of result.data) {
    if (!expectedUids.has(v.player_uid)) {
      warnings.push(`hallucinated player_uid dropped: ${v.player_uid}`);
      continue;
    }
    if (byUid.has(v.player_uid)) warnings.push(`duplicate uid ${v.player_uid} — last wins`);
    const clamped = Math.max(-20, Math.min(20, Math.round(v.adjustment)));
    if (clamped !== v.adjustment) warnings.push(`adjustment out of bounds for ${v.player_uid}: ${v.adjustment} → ${clamped}`);
    byUid.set(v.player_uid, {
      player_uid: v.player_uid,
      adjustment: clamped,
      rationale: v.rationale.slice(0, 160),
      confidence: v.confidence,
    });
  }
  return { ok: true, verdicts: [...byUid.values()], warnings, errors };
}

/** Tolerate markdown fences and prose around the JSON body. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  const firstBracket = text.search(/[[{]/);
  if (firstBracket >= 0) {
    const lastArr = text.lastIndexOf(']');
    const lastObj = text.lastIndexOf('}');
    const end = Math.max(lastArr, lastObj);
    if (end > firstBracket) return text.slice(firstBracket, end + 1);
  }
  return text.trim();
}

const ParsedPlayerSchema = z.object({
  name: z.string(),
  club: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
  captain: z.boolean().default(false),
  vice: z.boolean().default(false),
  bench_position: z.number().int().min(1).max(4).nullable().default(null),
});
export const ParsedTeamSchema = z.union([
  z.array(ParsedPlayerSchema),
  z.object({ players: z.array(ParsedPlayerSchema) }).transform((o) => o.players),
]);
