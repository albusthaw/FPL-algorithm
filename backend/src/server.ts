import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import type { Knex } from 'knex';
import { config } from './core/config.js';
import { db as defaultDb, assertDbNotAhead } from './core/db.js';
import { log } from './core/logger.js';
import { registerFeatures } from './core/kernel.js';
import { seedModelConfig } from './core/model-config.js';
import { seedProviders } from './ingest/registry.js';
import { authRoutes } from './routes/auth.js';
import { systemRoutes } from './routes/system.js';
import { playerRoutes } from './routes/players.js';
import { adminRoutes } from './routes/admin.js';
import { runRoutes } from './routes/runs.js';
import { teamRoutes } from './routes/teams.js';
import { modeRoutes } from './routes/modes.js';
import { startScheduler } from './run/scheduler.js';

export async function buildServer(db: Knex = defaultDb): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

  // security headers (helmet-style, no extra dependency)
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'",
    );
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) log.error({ err: err.message, stack: err.stack }, 'request failed');
    reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message });
  });

  await app.register(authRoutes, { db });
  await app.register(systemRoutes, { db });
  await app.register(playerRoutes, { db });
  await app.register(adminRoutes, { db });
  await app.register(runRoutes, { db });
  await app.register(teamRoutes, { db });
  await app.register(modeRoutes, { db });

  // static frontend (frontend/dist next to backend/ per the release layout)
  const frontendDist = [
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../frontend/dist'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../frontend/dist'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../frontend/dist'),
  ].find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (frontendDist) {
    await app.register(fastifyStatic, { root: frontendDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

async function main(): Promise<void> {
  // Boot guard: refuse to run when the DB is ahead of this code (exit 78).
  await assertDbNotAhead(defaultDb);
  await seedModelConfig(defaultDb);
  await registerFeatures(defaultDb);
  await seedProviders(defaultDb);

  const app = await buildServer(defaultDb);
  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, version: config.version }, 'fpl-algorithm backend up');

  // Scheduler: STATISTICAL ONLY. Constructed without any AI gateway
  // dependency — scheduled code structurally cannot invoke AI (§7.0).
  startScheduler(defaultDb);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain || process.env.FPL_SERVER_AUTOSTART === 'true') {
  main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.stack : err }, 'server failed to start');
    process.exit(1);
  });
}
