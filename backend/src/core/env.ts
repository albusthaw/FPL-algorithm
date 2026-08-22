import fs from 'node:fs';

function envFileCandidates(p?: string): string[] {
  return [
    p,
    process.env.ENV_FILE,
    // running from a release dir: /opt/app/releases/x.y.z/backend -> ../../shared/.env
    new URL('../../../../shared/.env', import.meta.url).pathname,
  ].filter((c): c is string => !!c);
}

/**
 * X1 (v1.4.1): ONE canonical env file per process, resolved once and logged.
 * The old per-call resolution meant a process started without ENV_FILE could
 * write a DIFFERENT file than the one it loaded from — which presented as
 * "my keys were wiped". realpath-resolved so symlinked release dirs cannot
 * split reads and writes either.
 */
let resolvedEnvFile: string | null = null;

export function writableEnvFile(): string {
  if (resolvedEnvFile) return resolvedEnvFile;
  const candidates = envFileCandidates();
  let chosen: string | null = process.env.ENV_FILE ?? null;
  if (!chosen) {
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        chosen = c;
        break;
      }
    }
  }
  chosen = chosen ?? candidates[candidates.length - 1] ?? '.env';
  try {
    resolvedEnvFile = fs.realpathSync(chosen);
  } catch {
    resolvedEnvFile = chosen; // may not exist yet — created on first write
  }
  return resolvedEnvFile;
}

/** Reset the memoised path (tests only). */
export function resetEnvFileCache(): void {
  resolvedEnvFile = null;
}

/**
 * X1: exclusive-lock guard around the env file's read-modify-write. The old
 * lockless RMW let two writers (server + CLI, or two admin PUTs across
 * processes) resurrect a stale snapshot, silently dropping keys written in
 * between — the recurring "keys vanish" bug. O_EXCL lock file with stale
 * takeover; synchronous with a short bounded spin (writes are rare + tiny).
 */
function withEnvLock<T>(file: string, fn: () => T): T {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  const staleMs = 10_000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fs.unlinkSync(lockPath); // crashed holder — take over
          continue;
        }
      } catch {
        continue; // holder released between stat and now
      }
      if (Date.now() > deadline) throw new Error(`env file lock timeout (${lockPath})`);
      // bounded synchronous backoff — env writes are milliseconds long
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Persist NAME=value into the env file (update-in-place or append) and apply
 * it to the running process immediately — admin-entered API keys must work
 * without a restart. Atomic replace (tmp + rename) under the exclusive lock
 * so a crash mid-write can never truncate the file.
 */
export function upsertEnvVar(name: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid env var name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error('value must be a single line');
  const file = writableEnvFile();
  withEnvLock(file, () => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    const line = `${name}=${value}`;
    const re = new RegExp(`^${name}=.*$`, 'm');
    const next = re.test(text) ? text.replace(re, line) : text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, file);
  });
  if (value === '') delete process.env[name];
  else process.env[name] = value;
}

/**
 * Loads KEY=VALUE pairs from an env file into process.env (existing keys win).
 * The file path comes from ENV_FILE, defaulting to shared/.env conventions.
 * No dependency on dotenv; the format is plain KEY=VALUE with # comments.
 */
export function loadEnvFile(p?: string): void {
  const candidates = envFileCandidates(p);
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

/** Boot-time report: which allowlisted keys are set vs empty (names only). */
export function envKeyReport(names: string[]): { file: string; set: string[]; empty: string[] } {
  const set: string[] = [];
  const empty: string[] = [];
  for (const n of names) {
    if ((process.env[n] ?? '').trim()) set.push(n);
    else empty.push(n);
  }
  return { file: writableEnvFile(), set, empty };
}
