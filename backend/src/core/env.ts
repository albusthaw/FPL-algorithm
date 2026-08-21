import fs from 'node:fs';

function envFileCandidates(path?: string): string[] {
  return [
    path,
    process.env.ENV_FILE,
    // running from a release dir: /opt/app/releases/x.y.z/backend -> ../../shared/.env
    new URL('../../../../shared/.env', import.meta.url).pathname,
  ].filter((p): p is string => !!p);
}

/** The env file admin-entered keys persist to (ENV_FILE first, then the first existing candidate). */
export function writableEnvFile(): string {
  const candidates = envFileCandidates();
  if (process.env.ENV_FILE) return process.env.ENV_FILE;
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[candidates.length - 1] ?? '.env';
}

/**
 * Persist NAME=value into the env file (update-in-place or append) and apply
 * it to the running process immediately — admin-entered API keys must work
 * without a restart. The value must be a single line; callers validate.
 */
export function upsertEnvVar(name: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid env var name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error('value must be a single line');
  const file = writableEnvFile();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, line) : text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  fs.writeFileSync(file, next, { mode: 0o600 });
  if (value === '') delete process.env[name];
  else process.env[name] = value;
}

/**
 * Loads KEY=VALUE pairs from an env file into process.env (existing keys win).
 * The file path comes from ENV_FILE, defaulting to shared/.env conventions.
 * No dependency on dotenv; the format is plain KEY=VALUE with # comments.
 */
export function loadEnvFile(path?: string): void {
  const candidates = envFileCandidates(path);
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
