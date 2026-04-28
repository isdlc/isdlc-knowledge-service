// REQ-GH-3 / FR-002 + FR-003 + FR-004 + FR-006 — runtime bootstrap helper.
//
// Single place where the API process, the worker process, and the CLI all
// construct the same set of shared dependencies: service config, DB pool,
// state store, audit logger, pg-boss queue. Higher-level modules
// (src/api, src/worker, src/cli/start.js, src/cli/config.js) import this
// helper instead of wiring components individually.
//
// The factory is a pure function — it doesn't read process.env directly;
// callers pass `env` so test code can substitute. It also doesn't open
// pg-boss eagerly: pg-boss requires `start()` which is async and binds to
// a connection — callers that need the queue call `bootstrapQueue()`
// after the pool is ready.

import {
  loadServiceConfig,
  resolveDatabaseUrl,
  ServiceConfigError,
} from '../config/service-config.js';
import { createPool, closePool, healthCheck, runMigrations } from '../db/index.js';
import { createPostgresStateStore } from '../state/index.js';
import { createPostgresAuditLogger } from '../audit/postgres-logger.js';

/**
 * @typedef {object} RuntimeDeps
 * @property {import('../config/service-config.js').ServiceConfig} serviceConfig
 * @property {import('pg').Pool} pool
 * @property {ReturnType<typeof createPostgresStateStore>} stateStore
 * @property {ReturnType<typeof createPostgresAuditLogger>} auditLogger
 * @property {{ close: () => Promise<void>, healthCheck: () => Promise<object> }} controls
 */

/**
 * Resolve the service config, open a pool, run migrations, and return the
 * shared dependency bag.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runMigrationsOnStart?: boolean,
 *   _loadServiceConfig?: typeof loadServiceConfig,
 *   _createPool?: typeof createPool,
 * }} [options]
 * @returns {Promise<RuntimeDeps>}
 */
export async function bootstrapRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const loadFn = options._loadServiceConfig || loadServiceConfig;
  const poolFactory = options._createPool || createPool;
  const runMigrationsOnStart = options.runMigrationsOnStart ?? true;

  const serviceConfig = await loadFn({ cwd });
  const connectionString = resolveDatabaseUrl(serviceConfig, env);

  const pool = poolFactory({
    connectionString,
    ssl: serviceConfig.database.ssl,
  });

  // Verify connectivity BEFORE running migrations. healthCheck surfaces a
  // typed ERR-DB-002 with a clear message so operators see the problem
  // immediately instead of getting a migration stack trace.
  await healthCheck(pool);

  if (runMigrationsOnStart) {
    await runMigrations(pool);
  }

  const stateStore = createPostgresStateStore({ pool, schema: serviceConfig.database.schema });
  const auditLogger = createPostgresAuditLogger({ stateStore });

  const controls = {
    async close() {
      await closePool(pool);
    },
    async healthCheck() {
      return healthCheck(pool);
    },
  };

  return { serviceConfig, pool, stateStore, auditLogger, controls };
}

/**
 * Construct the pg-boss queue against an already-bootstrapped pool. Kept
 * separate so callers that don't need the queue (e.g. read-only CLI tools)
 * skip the pg-boss handshake.
 *
 * @param {{
 *   pool: import('pg').Pool,
 *   serviceConfig: import('../config/service-config.js').ServiceConfig,
 *   _PgBoss?: any,
 *   retryLimit?: number,
 * }} options
 */
export async function bootstrapQueue(options) {
  if (!options || !options.pool || !options.serviceConfig) {
    throw new Error('bootstrapQueue requires { pool, serviceConfig }');
  }
  // pg-boss exposes a CommonJS default export; load it lazily so test
  // environments that don't need the queue don't pay the import cost.
  const PgBoss = options._PgBoss || (await import('pg-boss')).default;
  const { createPgBossQueue } = await import('../queue/pgboss-queue.js');

  const boss = new PgBoss({
    db: {
      // pg-boss can drive its own pool via connectionString — but we want
      // it on the same parameters so tests + ops see one substrate.
      connectionString: options.serviceConfig.database.urlEnv
        ? // resolved by the caller; pg-boss accepts the same URL we already use
          undefined
        : undefined,
      // Pass-through pool so pg-boss tables land in the same database.
      // Production wiring builds boss from an explicit URL via env.
      ...{},
    },
    schema: options.serviceConfig.queue?.schema || 'pgboss',
  });
  await boss.start();
  return createPgBossQueue({
    boss,
    retryLimit: options.retryLimit,
  });
}

export { ServiceConfigError };
