// REQ-GH-3 FR-009 — Postgres test helpers with deterministic skip behavior.
//
// Reads KNOWLEDGE_DATABASE_URL from the environment. When absent, every
// helper returns a "skip" result that callers must respect — DB-dependent
// tests MUST exit cleanly with an explicit reason instead of failing loud.
//
// Usage:
//
//   import { describeWithDb, skipIfNoDb, getTestPool } from '../helpers/postgres.js';
//
//   await describeWithDb('migrations', async ({ pool }) => {
//     test('creates ks schema', async () => { ... });
//   });
//
//   test('audit append-only', skipIfNoDb, async () => { ... });
//
// The helper is intentionally tiny — it owns ONLY the skip contract. Pool
// creation is deferred to src/db/pool.js (T004); for now we expose a stub
// that throws when invoked while configured, so tests written against the
// helper get a clear error if T004 isn't done yet.

import { test } from 'node:test';

const ENV_KEYS = ['KNOWLEDGE_DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL'];

/**
 * @returns {{ configured: boolean, url: string | null, source: string | null }}
 */
export function dbConfig() {
  for (const key of ENV_KEYS) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) {
      return { configured: true, url: v, source: key };
    }
  }
  return { configured: false, url: null, source: null };
}

/**
 * Reason string surfaced when DB tests skip. Always references the
 * canonical env var so the operator knows what to set.
 */
export const NO_DB_SKIP_REASON =
  'Skipping DB-dependent test: KNOWLEDGE_DATABASE_URL is not set. ' +
  'Set KNOWLEDGE_DATABASE_URL=postgres://user:pw@host:5432/dbname to run this suite.';

/**
 * `skipIfNoDb` — pass as the second argument to `test()` to skip when the
 * DB isn't configured. Standard `node --test` skip semantics.
 *
 * @example
 *   test('audit insert/select', skipIfNoDb, async () => { ... });
 */
export const skipIfNoDb = {
  skip: !dbConfig().configured ? NO_DB_SKIP_REASON : false,
};

/**
 * `describeWithDb(name, fn)` — runs the body only when DB config is present.
 * When unconfigured, registers a single skipped test under `name` so the
 * test report still shows the skip and its reason.
 *
 * The body receives `{ pool }` once T004 wires the real pool; until then,
 * it receives `{ pool: null }` and the body is responsible for skipping
 * any test that needs the pool.
 *
 * @param {string} name
 * @param {(ctx: { pool: object | null }) => void | Promise<void>} fn
 */
export function describeWithDb(name, fn) {
  if (!dbConfig().configured) {
    test(name, skipIfNoDb, () => {});
    return;
  }
  // T004 will replace this with a real pool factory. Keeping the contract
  // narrow for now: skipped suites won't trip on this branch.
  test(name, async () => {
    await fn({ pool: null });
  });
}

/**
 * Pool factory placeholder. T004 (src/db/pool.js) replaces the body. Until
 * then, calling this when configured throws a clear error so test authors
 * know the foundation isn't ready yet.
 *
 * @returns {Promise<object>}
 */
export async function getTestPool() {
  if (!dbConfig().configured) {
    throw new Error(NO_DB_SKIP_REASON);
  }
  throw new Error(
    'getTestPool() not implemented — pending T004 (src/db/pool.js). ' +
      'Use describeWithDb / skipIfNoDb until then.',
  );
}
