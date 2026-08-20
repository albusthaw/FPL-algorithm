import fs from 'node:fs';

/**
 * Loads KEY=VALUE pairs from an env file into process.env (existing keys win).
 * The file path comes from ENV_FILE, defaulting to shared/.env conventions.
 * No dependency on dotenv; the format is plain KEY=VALUE with # comments.
 */
export function loadEnvFile(path?: string): void {
  const candidates = [
    path,
    process.env.ENV_FILE,
    // running from a release dir: /opt/app/releases/x.y.z/backend -> ../../shared/.env
    new URL('../../../../shared/.env', import.meta.url).pathname,
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return; // first existing file wins
  }
}
