import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { config } from '../core/config.js';
import { migrationStatus } from '../core/db.js';

export async function systemRoutes(app: FastifyInstance, opts: { db: Knex }): Promise<void> {
  const { db } = opts;

  app.get('/api/health', async () => {
    await db.raw('SELECT 1');
    return { status: 'ok', version: config.version };
  });

  app.get('/api/system/info', async () => {
    const status = await migrationStatus(db);
    return {
      app: { version: config.version, schema: config.schema },
      migration: {
        applied: status.applied.length,
        available: status.available.length,
        pending: status.pending.length,
        dbAhead: status.dbAhead.length > 0,
      },
    };
  });
}
