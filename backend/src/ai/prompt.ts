/**
 * Cache-aware prompt layout (fpl-ai-engine-plan.md §6): byte-stable prefix,
 * volatile suffix. NO timestamps, run ids, or user names in the first two
 * blocks; per-player serialisation is a fixed-order pipe-delimited line.
 * Any change to the SYSTEM block bumps prompt_version in model_config.
 */
import type { PlayerNewsBundle } from './types.js';

export const SYSTEM_BLOCK = `You are the news-analysis layer of a Fantasy Premier League decision engine.
The statistical engine has already scored every player. Your ONLY job is to judge what statistics cannot see, based on the news snippets provided per player: press-conference hints, "trained fully today", tactical role changes, manager quotes, transfer sagas, morale, new-signing integration.

Rules:
- Return ONLY a JSON array. One object per player you received: {"player_uid": string, "adjustment": integer, "rationale": string, "confidence": number}.
- adjustment is an integer from -20 to +20. 0 = news is neutral/irrelevant. Positive = news implies MORE fantasy value than the stats suggest, negative = LESS.
- Magnitude guide: +-1..4 mild hint; +-5..10 clear signal (confirmed role change, "will start"); +-11..20 major (unreported injury, transfer agreed, public fallout).
- rationale: one line, max 160 characters, cite the decisive news item.
- confidence: 0..1, how reliable the sources are (club/BBC/Sky high, aggregators low).
- Judge ONLY from the news given. Do not invent facts. Do not re-score statistics - the engine already did.
- FPL scoring digest: goals GK/DEF 6, MID 5, FWD 4; assist 3; clean sheet GK/DEF 4, MID 1; defensive contribution +2 (DEF at 10 CBIT, MID/FWD at 12 CBIRT); saves 1 per 3; bonus 1-3; appearance 1-2; cards/own-goals negative.
- Matrix line format per player: UID|position|club|price|stat_score|xpts_next3|p_start|form|status.`;

export function buildRunContext(gameweek: number, deadlineIso: string, globalNotes: string): string {
  return `GAMEWEEK ${gameweek} — deadline ${deadlineIso}.${globalNotes ? `\nNotes: ${globalNotes}` : ''}`;
}

export function buildBatchBlock(bundle: PlayerNewsBundle[]): string {
  const lines: string[] = [];
  for (const p of bundle) {
    lines.push(`PLAYER ${p.matrixLine}`);
    for (const n of p.news) {
      lines.push(`  NEWS[${n.source}|${Math.round(n.ageHours)}h] ${n.title} — ${n.snippet}`);
    }
  }
  lines.push('', `Return the JSON array now for these ${bundle.length} players.`);
  return lines.join('\n');
}

export function buildMatrixLine(p: {
  uid: string;
  position: string;
  club: string;
  price: number;
  statScore: number;
  xptsNext3: number;
  pStart: number;
  form: number;
  status: string;
}): string {
  return [
    p.uid,
    p.position,
    p.club,
    (p.price / 10).toFixed(1),
    p.statScore.toFixed(1),
    p.xptsNext3.toFixed(1),
    p.pStart.toFixed(2),
    p.form.toFixed(1),
    p.status,
  ].join('|');
}

export const VISION_PROMPT = `This image is a screenshot of a Fantasy Premier League team (pitch view or list view).
Extract all 15 players. Return ONLY a JSON array of 15 objects:
{"name": string (as shown), "club": string|null (short code if visible), "price": number|null (in millions, e.g. 7.5), "captain": boolean (armband C), "vice": boolean (armband V), "bench_position": integer 1-4 or null (bench players left-to-right; the bench GK is 1)}.
Read names exactly as printed. null for anything not visible. No prose, JSON only.`;
