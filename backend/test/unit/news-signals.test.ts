import { describe, it, expect } from 'vitest';
import {
  classifySignals,
  signalMultipliers,
  corroboratedCategories,
  type NewsSignalsConfig,
  type SignalCategory,
} from '../../src/news/signals.js';
import { DEFAULT_CONFIG } from '../../src/core/model-config.js';
import { targetVaastavSeasons, seasonDirLabel, currentSeasonStartYear, DEFAULT_HISTORY_DEPTH } from '../../src/ingest/backfill.js';

const cfg = (DEFAULT_CONFIG.human_factors as { news_signals: NewsSignalsConfig }).news_signals;

describe('news signal classifier (human factors v2)', () => {
  it('classifies discipline, unprofessionalism and transfer noise', () => {
    expect(classifySignals('Star striker sent off in training-ground bust-up')).toEqual(
      expect.arrayContaining(['disciplinary', 'unprofessional']),
    );
    expect(classifySignals('Midfielder hands in transfer request after bid rejected')).toContain('transfer_talk');
    expect(classifySignals('Defender rejects new contract as talks stall')).toContain('contract_dispute');
    expect(classifySignals('Winger away from squad for personal reasons')).toContain('personal_event');
    expect(classifySignals('Club captain signs new deal until 2030')).toContain('morale_boost');
    expect(classifySignals('Manager sacked after winless start; caretaker boss named')).toContain('managerial_change');
  });

  it('plain team news carries no signals', () => {
    expect(classifySignals('Injury update ahead of Saturday: two doubts in defence')).toEqual([]);
    expect(classifySignals('Press conference: boss praises the squad depth')).toEqual([]);
  });

  it('multipliers are bounded by the clamp whatever stacks up', () => {
    const all = Object.keys(cfg.categories) as SignalCategory[];
    const m = signalMultipliers(all, cfg);
    expect(m.n1).toBeGreaterThanOrEqual(cfg.clamp[0]);
    expect(m.n6).toBeLessThanOrEqual(cfg.clamp[1]);
    // no signals → exactly neutral
    expect(signalMultipliers([], cfg)).toEqual({ n1: 1, n3: 1, n6: 1 });
    // a single negative category nudges, never dominates
    const one = signalMultipliers(['disciplinary'], cfg);
    expect(one.n1).toBeLessThan(1);
    expect(one.n1).toBeGreaterThan(0.9);
  });

  it('negative signals need corroboration; positives apply on one source', () => {
    // one tier-3 tabloid whisper: not enough for a negative category
    expect(corroboratedCategories([{ category: 'transfer_talk', tier: 3 }], cfg)).toEqual([]);
    // a tier-1 source is enough on its own
    expect(corroboratedCategories([{ category: 'transfer_talk', tier: 1 }], cfg)).toContain('transfer_talk');
    // two independent tier-3 items corroborate each other
    expect(
      corroboratedCategories(
        [
          { category: 'transfer_talk', tier: 3 },
          { category: 'transfer_talk', tier: 3 },
        ],
        cfg,
      ),
    ).toContain('transfer_talk');
    // positive morale signal applies from a single tier-3 source
    expect(corroboratedCategories([{ category: 'morale_boost', tier: 3 }], cfg)).toContain('morale_boost');
  });
});

describe('historical depth targets', () => {
  it('days mode keeps the previous-season floor only', () => {
    const t = targetVaastavSeasons({ ...DEFAULT_HISTORY_DEPTH, mode: 'days' }, new Date(Date.UTC(2026, 7, 21)));
    expect(t).toEqual(['2025-26']);
  });

  it('seasons mode counts back from the previous season, capped by the dataset start', () => {
    const at = new Date(Date.UTC(2026, 7, 21)); // current season 2026-27
    expect(targetVaastavSeasons({ ...DEFAULT_HISTORY_DEPTH, mode: 'seasons', seasons: 3 }, at)).toEqual([
      '2025-26',
      '2024-25',
      '2023-24',
    ]);
    const deep = targetVaastavSeasons({ ...DEFAULT_HISTORY_DEPTH, mode: 'seasons', seasons: 25 }, at);
    expect(deep[deep.length - 1]).toBe('2016-17'); // vaastav dataset floor
    expect(deep.length).toBe(10);
  });

  it('season labels and start-year logic handle the pre-August window', () => {
    expect(seasonDirLabel(2019)).toBe('2019-20');
    expect(currentSeasonStartYear(new Date(Date.UTC(2026, 3, 1)))).toBe(2025); // April = still 2025-26
    expect(currentSeasonStartYear(new Date(Date.UTC(2026, 7, 21)))).toBe(2026);
  });
});

describe('normaliseText (order-preserving phrase matching)', () => {
  it('keeps token order — the entity-linking regression', async () => {
    const { normaliseText, normaliseName } = await import('../../src/players/resolver.js');
    expect(normaliseText('Nico Duarte sent off')).toBe('nico duarte sent off');
    // the canonical form sorts (identity matching) — proves the two differ
    expect(normaliseName('Nico Duarte')).toBe('duarte nico');
    expect(normaliseText('Calvert-Lewin scores')).toBe('calvert lewin scores');
    expect(normaliseText("N'Golo Kanté runs")).toBe('ngolo kante runs');
  });
});
