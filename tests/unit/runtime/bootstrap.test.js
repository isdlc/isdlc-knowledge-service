// REQ-GH-3 — runtime bootstrap factory unit tests.
//
// The bootstrap is a thin composition: load service config → resolve URL
// → open pool → health check → run migrations → build state store +
// audit logger. We verify the wiring with seam-injected stubs so a real
// Postgres isn't required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapRuntime, ServiceConfigError } from '../../../src/runtime/bootstrap.js';
import { defaultServiceConfig } from '../../../src/config/service-config.js';

function makeFakePool() {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (typeof sql === 'string' && sql.startsWith('SELECT 1')) {
        return { rows: [{ ping: 1 }] };
      }
      if (typeof sql === 'string' && sql.startsWith('SHOW server_version')) {
        return { rows: [{ server_version: '16.0 (test)' }] };
      }
      if (typeof sql === 'string' && sql.includes("to_regclass('ks.schema_migrations')")) {
        return { rows: [{ reg: 'ks.schema_migrations' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM ks.schema_migrations')) {
        // Pretend the migration is already applied so runMigrations
        // returns quickly without trying to execute SQL.
        return { rows: [{ id: '001_state_substrate' }] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        query: this.query.bind(this),
        release: () => {},
      };
    },
    async end() {},
  };
}

const ORIGINAL_DB_URL = process.env.KNOWLEDGE_DATABASE_URL;
process.on('exit', () => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.KNOWLEDGE_DATABASE_URL;
  else process.env.KNOWLEDGE_DATABASE_URL = ORIGINAL_DB_URL;
});

test('bootstrapRuntime wires serviceConfig + pool + stateStore + auditLogger', async () => {
  const fakePool = makeFakePool();
  const env = { KNOWLEDGE_DATABASE_URL: 'postgres://test@host/db' };

  const deps = await bootstrapRuntime({
    env,
    _loadServiceConfig: async () => defaultServiceConfig(),
    _createPool: () => fakePool,
  });

  assert.equal(deps.serviceConfig.database.urlEnv, 'KNOWLEDGE_DATABASE_URL');
  assert.equal(deps.pool, fakePool);
  assert.ok(deps.stateStore.projects);
  assert.ok(deps.stateStore.audit);
  assert.equal(typeof deps.auditLogger.log, 'function');
  assert.equal(typeof deps.controls.close, 'function');
  assert.equal(typeof deps.controls.healthCheck, 'function');

  // Health check ran (SELECT 1 + SHOW server_version were issued).
  assert.ok(fakePool.queries.includes('SELECT 1 AS ping'));
});

test('bootstrapRuntime surfaces ERR-CONFIG-001 when service config is missing', async () => {
  await assert.rejects(
    () =>
      bootstrapRuntime({
        env: {},
        _loadServiceConfig: async () => {
          throw new ServiceConfigError(
            'ERR-CONFIG-001',
            'Service config not found at /tmp/x/.ks/config.json',
          );
        },
      }),
    (err) => err instanceof ServiceConfigError && err.code === 'ERR-CONFIG-001',
  );
});

test('bootstrapRuntime surfaces ERR-DB-001 when env var is unset', async () => {
  await assert.rejects(
    () =>
      bootstrapRuntime({
        env: {},
        _loadServiceConfig: async () => defaultServiceConfig(),
      }),
    (err) => err.code === 'ERR-DB-001',
  );
});

test('bootstrapRuntime can skip migrations on demand', async () => {
  const fakePool = makeFakePool();
  await bootstrapRuntime({
    env: { KNOWLEDGE_DATABASE_URL: 'postgres://h' },
    _loadServiceConfig: async () => defaultServiceConfig(),
    _createPool: () => fakePool,
    runMigrationsOnStart: false,
  });
  // SELECT 1 ran (health check), but NO query against schema_migrations
  // because migrations were skipped.
  assert.ok(fakePool.queries.includes('SELECT 1 AS ping'));
  assert.ok(!fakePool.queries.some((q) => q.includes('FROM ks.schema_migrations')));
});

test('controls.close calls pool.end', async () => {
  let endCalls = 0;
  const fakePool = {
    ...makeFakePool(),
    async end() {
      endCalls += 1;
    },
  };
  const deps = await bootstrapRuntime({
    env: { KNOWLEDGE_DATABASE_URL: 'postgres://h' },
    _loadServiceConfig: async () => defaultServiceConfig(),
    _createPool: () => fakePool,
  });
  await deps.controls.close();
  assert.equal(endCalls, 1);
});
