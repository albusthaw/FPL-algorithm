import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import knexFactory, { type Knex } from 'knex';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Custom migration source: lists migrations by BARE name (no extension) so
 * the knex_migrations table records identical names whether the runner is
 * executing TypeScript (dev, via tsx) or compiled JavaScript (production).
 * Editing a released migration is forbidden (CLAUDE.md Rule #1).
 */
class BareNameMigrationSource implements Knex.MigrationSource<string> {
  constructor(private dir: string) {}

  async getMigrations(): Promise<string[]> {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^\d{4}_.+\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
      .sort();
    return files.map((f) => f.replace(/\.(ts|js)$/, ''));
  }

  getMigrationName(migration: string): string {
    return migration;
  }

  async getMigration(name: string): Promise<Knex.Migration> {
    for (const ext of ['.js', '.ts']) {
      const file = path.join(this.dir, name + ext);
      if (fs.existsSync(file)) {
        return (await import(pathToFileURL(file).href)) as Knex.Migration;
      }
    }
    throw new Error(`migration ${name} not found in ${this.dir}`);
  }
}

export function createDb(databaseUrl: string = config.databaseUrl): Knex {
  return knexFactory({
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 1, max: 10 },
    migrations: {
      migrationSource: new BareNameMigrationSource(config.migrationsDir),
      tableName: 'knex_migrations',
    },
  });
}

export const db = createDb();

export interface MigrationStatus {
  applied: string[];
  available: string[];
  pending: string[];
  dbAhead: string[];
}

export async function migrationStatus(k: Knex = db): Promise<MigrationStatus> {
  const source = new BareNameMigrationSource(config.migrationsDir);
  const available = await source.getMigrations();
  const hasTable = await k.schema.hasTable('knex_migrations');
  const applied: string[] = hasTable
    ? (await k('knex_migrations').orderBy('id').pluck('name')).map((n: string) =>
        n.replace(/\.(ts|js)$/, ''),
      )
    : [];
  const availableSet = new Set(available);
  const appliedSet = new Set(applied);
  return {
    applied,
    available,
    pending: available.filter((m) => !appliedSet.has(m)),
    dbAhead: applied.filter((m) => !availableSet.has(m)),
  };
}

/**
 * The mismatch guard (exit 78 / EX_CONFIG): refuses to run when the database
 * contains applied migrations the installed code does not know about.
 * Fires from both the CLI (`cli.js migrate`) and server boot.
 */
export async function assertDbNotAhead(k: Knex = db): Promise<MigrationStatus> {
  const status = await migrationStatus(k);
  if (status.dbAhead.length > 0) {
    log.fatal(
      { missing: status.dbAhead },
      'database is ahead of the installed code — install the matching or newer release',
    );
    process.exit(78);
  }
  return status;
}

export async function runMigrations(k: Knex = db): Promise<string[]> {
  const status = await assertDbNotAhead(k);
  if (status.pending.length === 0) return [];
  const [, applied] = (await k.migrate.latest()) as [number, string[]];
  return applied;
}
