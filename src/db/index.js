// REQ-GH-3 / FR-003 — public entry point for the Postgres foundation.
//
// Re-exports the pool, migration, and config helpers so callers in
// src/state, src/audit, src/queue, src/cli, and src/worker import from
// one place.

export {
  createPool,
  closePool,
  healthCheck,
  DatabaseError,
} from './pool.js';

export {
  listMigrations,
  runMigrations,
  listAppliedMigrations,
} from './migrations.js';

export { resolveDbConfig, ServiceConfigError } from './config.js';
