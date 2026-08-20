import type { Knex } from 'knex';

export interface FeatureManifest {
  name: string;
  toggleable: boolean;
  defaultEnabled: boolean;
  description?: string;
}

/**
 * Feature kernel (howupgradeshouldwork-1.md §9): features self-register with
 * a manifest; boot upserts feature_states with ON CONFLICT DO NOTHING so
 * admin toggles survive upgrades. New features arrive through the normal
 * upgrade pipe, defaulting on/off as declared.
 */
export const FEATURE_MANIFESTS: FeatureManifest[] = [
  { name: 'ingest.fpl', toggleable: false, defaultEnabled: true, description: 'FPL official API anchor (always on)' },
  { name: 'ingest.api_football', toggleable: true, defaultEnabled: false, description: 'API-Football adapter' },
  { name: 'ingest.sportmonks', toggleable: true, defaultEnabled: false, description: 'Sportmonks adapter' },
  { name: 'ingest.football_data', toggleable: true, defaultEnabled: false, description: 'football-data.org adapter' },
  { name: 'ingest.newsdata', toggleable: true, defaultEnabled: false, description: 'NewsData.io adapter' },
  { name: 'ingest.thesportsdb', toggleable: true, defaultEnabled: false, description: 'TheSportsDB media adapter' },
  { name: 'ingest.understat', toggleable: true, defaultEnabled: false, description: 'Understat scraper (ships disabled)' },
  { name: 'mode.initial', toggleable: true, defaultEnabled: true, description: 'Initial Team Selection mode' },
  { name: 'mode.chips', toggleable: true, defaultEnabled: true, description: 'Free Hit / Wildcard mode' },
  { name: 'mode.weekly', toggleable: true, defaultEnabled: true, description: 'Weekly mode' },
  { name: 'teams.vision', toggleable: true, defaultEnabled: true, description: 'Team screenshot vision pipeline' },
  { name: 'engine.simulation', toggleable: true, defaultEnabled: false, description: 'L11 Monte Carlo simulation layer' },
];

export async function registerFeatures(db: Knex): Promise<void> {
  for (const manifest of FEATURE_MANIFESTS) {
    await db.raw(
      `INSERT INTO feature_states (name, enabled, manifest)
       VALUES (?, ?, ?)
       ON CONFLICT (name) DO NOTHING`,
      [manifest.name, manifest.defaultEnabled, JSON.stringify(manifest)],
    );
  }
}

export async function isEnabled(db: Knex, name: string): Promise<boolean> {
  const row = await db('feature_states').where({ name }).first('enabled');
  return row?.enabled ?? false;
}

export async function setEnabled(db: Knex, name: string, enabled: boolean): Promise<void> {
  const row = await db('feature_states').where({ name }).first();
  if (!row) throw new Error(`unknown feature: ${name}`);
  const manifest = row.manifest as FeatureManifest;
  if (!manifest.toggleable) throw new Error(`feature ${name} is not toggleable`);
  await db('feature_states').where({ name }).update({ enabled, updated_at: db.fn.now() });
}
