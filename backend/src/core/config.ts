import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';

loadEnvFile();

const here = path.dirname(fileURLToPath(import.meta.url));

function findVersionJson(): { version: string; schema: number } {
  // src/core -> backend -> repo root; dist/src/core -> dist -> backend -> root
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'version.json');
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
    dir = path.dirname(dir);
  }
  return { version: '0.0.0', schema: 0 };
}

function findMigrationsDir(): string {
  // dev: backend/migrations (TS); prod: backend/dist/migrations (JS)
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'migrations');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('migrations directory not found');
}

const versionInfo = findVersionJson();

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3080),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl:
    process.env.DATABASE_URL ??
    `postgres://${process.env.PGUSER ?? 'fpl'}:${process.env.PGPASSWORD ?? 'fpl'}@${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/${process.env.PGDATABASE ?? 'fpl_algorithm'}`,
  dataDir: process.env.DATA_DIR ?? path.resolve(here, '../../../shared-dev/data'),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-secret-change-me',
  cookieSecure: (process.env.COOKIE_SECURE ?? 'false') === 'true',
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 12 * 60),
  sessionAbsoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS ?? 7 * 24),
  fplUserAgent:
    process.env.FPL_USER_AGENT ??
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  fplEgressProxy: process.env.FPL_EGRESS_PROXY ?? '',
  version: versionInfo.version,
  schema: versionInfo.schema,
  migrationsDir: findMigrationsDir(),
  // provider keys — never sent to the frontend
  keys: {
    apiFootball: process.env.API_FOOTBALL_KEY ?? '',
    sportmonks: process.env.SPORTMONKS_TOKEN ?? '',
    footballData: process.env.FOOTBALL_DATA_TOKEN ?? '',
    newsdata: process.env.NEWSDATA_KEY ?? '',
    thesportsdb: process.env.THESPORTSDB_KEY ?? '',
    anthropic: process.env.ANTHROPIC_API_KEY ?? '',
    openai: process.env.OPENAI_API_KEY ?? '',
    gemini: process.env.GEMINI_API_KEY ?? '',
    deepseek: process.env.DEEPSEEK_API_KEY ?? '',
    kimi: process.env.KIMI_API_KEY ?? '',
    modalUrl: process.env.MODAL_ENDPOINT_URL ?? '',
    modalKey: process.env.MODAL_KEY ?? '',
    modalSecret: process.env.MODAL_SECRET ?? '',
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ollamaAllowRemote: (process.env.OLLAMA_ALLOW_REMOTE ?? 'false') === 'true',
  },
};

export type AppConfig = typeof config;
