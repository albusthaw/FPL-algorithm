import type { Knex } from 'knex';

/**
 * Provider registry rows. FPL is the always-on anchor and NOT counted by the
 * max-2 switch; the pluggable providers ship disabled — the admin enables at
 * most two (server-side transactional guard in gateway.ts).
 */
export const PROVIDERS = [
  { key: 'fpl', name: 'FPL Official API', anchor: true, capabilities: ['fixtures', 'stats', 'injuries'] },
  // C1 (v1.4.3): keyless news anchor — always on, zero credits, not counted
  // by the max-2 switch (feeds ⚙ rss_feeds; BBC/Sky/Guardian by default)
  { key: 'rss', name: 'RSS feeds (BBC / Sky / Guardian)', anchor: true, capabilities: ['news'] },
  { key: 'api_football', name: 'API-Football (api-sports.io)', anchor: false, capabilities: ['injuries', 'lineups', 'fixtures', 'stats', 'odds'] },
  { key: 'sportmonks', name: 'Sportmonks Football', anchor: false, capabilities: ['injuries', 'lineups', 'stats'] },
  { key: 'football_data', name: 'football-data.org', anchor: false, capabilities: ['fixtures'] },
  { key: 'newsdata', name: 'NewsData.io', anchor: false, capabilities: ['news'] },
  { key: 'thesportsdb', name: 'TheSportsDB', anchor: false, capabilities: ['media'] },
  { key: 'understat', name: 'Understat (scraper)', anchor: false, capabilities: ['stats'] },
] as const;

export async function seedProviders(db: Knex): Promise<void> {
  for (const p of PROVIDERS) {
    await db.raw(
      `INSERT INTO api_providers (key, name, enabled, capabilities, config)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
      [p.key, p.name, p.anchor, p.capabilities as unknown as string[], JSON.stringify({ anchor: p.anchor })],
    );
  }
  // AI providers (max-1 alive; mock ships alive in development only)
  const aiProviders = [
    { key: 'anthropic', name: 'Claude (Anthropic)', vision: true },
    { key: 'openai', name: 'ChatGPT (OpenAI)', vision: true },
    { key: 'gemini', name: 'Gemini (Google)', vision: true },
    { key: 'deepseek', name: 'DeepSeek', vision: false },
    { key: 'kimi', name: 'Kimi (Moonshot)', vision: false },
    { key: 'ollama', name: 'Ollama (self-hosted)', vision: false },
    { key: 'modal', name: 'Modal.com endpoint', vision: false },
    { key: 'mock', name: 'Mock provider (dev/CI)', vision: true },
  ];
  for (const p of aiProviders) {
    await db.raw(
      `INSERT INTO ai_providers (key, name, alive, supports_vision)
       VALUES (?, ?, false, ?)
       ON CONFLICT (key) DO NOTHING`,
      [p.key, p.name, p.vision],
    );
  }
}
