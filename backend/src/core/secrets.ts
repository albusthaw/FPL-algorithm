/**
 * Admin-entered API keys. The rule from CLAUDE.md stands: secrets live in
 * shared/.env, never in the database, never sent to the frontend. The admin
 * panel WRITES keys through this module (persisted to the env file, applied
 * to the running process immediately) and READS only status + a masked hint.
 */
import { upsertEnvVar } from './env.js';

export interface KeyField {
  env: string; // allowlisted env var this field maps to
  label: string; // what the admin panel shows
  secret: boolean; // false = plain setting (e.g. a URL) — still never echoed once saved
}

/** Every settable field per provider — the ONLY env vars the API may write. */
export const PROVIDER_KEY_FIELDS: Record<string, KeyField[]> = {
  // football data
  api_football: [{ env: 'API_FOOTBALL_KEY', label: 'API key (dashboard.api-football.com)', secret: true }],
  sportmonks: [{ env: 'SPORTMONKS_TOKEN', label: 'API token', secret: true }],
  football_data: [{ env: 'FOOTBALL_DATA_TOKEN', label: 'API token', secret: true }],
  newsdata: [{ env: 'NEWSDATA_KEY', label: 'API key', secret: true }],
  thesportsdb: [{ env: 'THESPORTSDB_KEY', label: 'API key (optional — demo key without one)', secret: true }],
  // AI
  anthropic: [{ env: 'ANTHROPIC_API_KEY', label: 'API key', secret: true }],
  openai: [{ env: 'OPENAI_API_KEY', label: 'API key', secret: true }],
  gemini: [{ env: 'GEMINI_API_KEY', label: 'API key', secret: true }],
  deepseek: [{ env: 'DEEPSEEK_API_KEY', label: 'API key', secret: true }],
  kimi: [{ env: 'KIMI_API_KEY', label: 'API key', secret: true }],
  ollama: [{ env: 'OLLAMA_URL', label: 'Server URL (default http://127.0.0.1:11434)', secret: false }],
  modal: [
    { env: 'MODAL_ENDPOINT_URL', label: 'Endpoint URL', secret: false },
    { env: 'MODAL_KEY', label: 'Modal key', secret: true },
    { env: 'MODAL_SECRET', label: 'Modal secret', secret: true },
  ],
};

const ALLOWED_ENV_VARS = new Set(Object.values(PROVIDER_KEY_FIELDS).flat().map((f) => f.env));

/** Providers that can be enabled/activated WITHOUT any key. */
const NO_KEY_NEEDED = new Set(['fpl', 'understat', 'thesportsdb', 'ollama', 'mock']);

export function requiresKey(providerKey: string): boolean {
  return !NO_KEY_NEEDED.has(providerKey);
}

/** The env var whose presence gates enabling this provider. */
function gatingEnvVar(providerKey: string): string | null {
  if (!requiresKey(providerKey)) return null;
  const fields = PROVIDER_KEY_FIELDS[providerKey];
  if (!fields || fields.length === 0) return null;
  return fields[0]!.env; // first field is the gate (modal: the endpoint URL)
}

export function keyConfigured(providerKey: string): boolean {
  const env = gatingEnvVar(providerKey);
  if (!env) return true;
  return !!(process.env[env] ?? '').trim();
}

/** Masked hint for display: last 4 characters only, never the value. */
export function keyHint(providerKey: string): string | null {
  const env = gatingEnvVar(providerKey);
  if (!env) return null;
  const v = (process.env[env] ?? '').trim();
  if (!v) return null;
  return `…${v.slice(-4)}`;
}

export class SecretValidationError extends Error {}

/** Persist one admin-entered key. Empty value clears it. */
export function setProviderSecret(envVar: string, value: string): void {
  if (!ALLOWED_ENV_VARS.has(envVar)) {
    throw new SecretValidationError('unknown key field');
  }
  const v = value.trim();
  if (v.length > 500) throw new SecretValidationError('value too long');
  // keys/URLs are printable single-line ASCII; anything else is a paste error
  if (!/^[\x20-\x7e]*$/.test(v)) throw new SecretValidationError('value contains unsupported characters');
  upsertEnvVar(envVar, v);
}
