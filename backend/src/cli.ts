/**
 * CLI entry: node dist/src/cli.js <command>
 * Commands: migrate | status | create-admin | seed-providers | sync-fpl | probe
 * The migrate command carries the exit-78 dbAhead guard (CLAUDE.md Rule #1).
 */
import { db, runMigrations, migrationStatus, assertDbNotAhead } from './core/db.js';
import { seedModelConfig } from './core/model-config.js';
import { registerFeatures } from './core/kernel.js';
import { hashPassword } from './auth/auth.js';
import { seedProviders } from './ingest/registry.js';
import { log } from './core/logger.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'migrate': {
      const applied = await runMigrations();
      await seedModelConfig(db);
      await registerFeatures(db);
      await seedProviders(db);
      log.info({ applied }, applied.length ? 'migrations applied' : 'database up to date');
      break;
    }
    case 'status': {
      const status = await migrationStatus();
      const dbAhead = status.dbAhead.length > 0;
      console.log(JSON.stringify({ ...status, dbAhead }, null, 2));
      if (dbAhead) process.exit(78);
      break;
    }
    case 'guard': {
      await assertDbNotAhead();
      console.log('ok');
      break;
    }
    case 'create-admin': {
      const email = args[0];
      const name = args[1] ?? 'Administrator';
      const password = args[2] ?? process.env.ADMIN_PASSWORD;
      if (!email || !password) {
        console.error('usage: cli create-admin <email> [name] [password] (or ADMIN_PASSWORD env)');
        process.exit(2);
      }
      const existing = await db('users').where({ email }).first();
      if (existing) {
        log.info({ email }, 'admin already exists — leaving untouched (idempotent)');
        break;
      }
      const password_hash = await hashPassword(password);
      await db('users').insert({ email, name, password_hash, role: 'admin', status: 'active', token_balance: 0 });
      log.info({ email }, 'admin created');
      break;
    }
    case 'import-historical': {
      const season = args[0] ?? '2025-26';
      const { importHistoricalSeason } = await import('./ingest/historical.js');
      const result = await importHistoricalSeason(db, season);
      log.info(result, `historical import ${season} done`);
      break;
    }
    case 'sync-fpl': {
      const { syncFplBootstrap, syncFplFixtures } = await import('./ingest/adapters/fpl.js');
      const boot = await syncFplBootstrap(db);
      const fx = await syncFplFixtures(db);
      log.info({ players: boot.players, teams: boot.teams, events: boot.events, fixtures: fx.fixtures }, 'FPL sync complete');
      break;
    }
    default:
      console.error('usage: cli <migrate|status|guard|create-admin|sync-fpl>');
      process.exit(2);
  }
  await db.destroy();
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : err }, 'cli failed');
  process.exit(1);
});
