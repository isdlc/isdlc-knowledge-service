// REQ-GH-3 — db config + pool factory unit tests.
//
// These run without a live Postgres. The pool constructor is stubbed to
// observe the resolved options; integration tests that exercise a real
// connection live in tests/integration/db/ and skip when DB config is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPool,
  DatabaseError,
  resolveDbConfig,
} from '../../../src/db/index.js';
import { defaultServiceConfig } from '../../../src/config/service-config.js';

test('resolveDbConfig returns connectionString + schema + ssl from service config', () => {
  const cfg = defaultServiceConfig();
  const env = { KNOWLEDGE_DATABASE_URL: 'postgres://user:pw@host:5432/db' };
  const out = resolveDbConfig(cfg, env);
  assert.equal(out.connectionString, 'postgres://user:pw@host:5432/db');
  assert.equal(out.schema, 'ks');
  assert.equal(out.ssl, false);
});

test('resolveDbConfig honors database.schema and database.ssl overrides', () => {
  const cfg = defaultServiceConfig();
  cfg.database.schema = 'app_state';
  cfg.database.ssl = true;
  const env = { KNOWLEDGE_DATABASE_URL: 'postgres://x' };
  const out = resolveDbConfig(cfg, env);
  assert.equal(out.schema, 'app_state');
  assert.equal(out.ssl, true);
});

test('resolveDbConfig surfaces ERR-DB-001 when env var is unset', () => {
  const cfg = defaultServiceConfig();
  assert.throws(
    () => resolveDbConfig(cfg, {}),
    (err) => err.code === 'ERR-DB-001' && /KNOWLEDGE_DATABASE_URL/.test(err.message),
  );
});

test('createPool rejects empty connectionString with ERR-DB-001', () => {
  assert.throws(
    () => createPool({ connectionString: '' }),
    (err) => err instanceof DatabaseError && err.code === 'ERR-DB-001',
  );
});

test('createPool forwards options to the pg.Pool constructor (via _PoolImpl seam)', () => {
  let captured = null;
  class FakePool {
    constructor(opts) {
      captured = opts;
    }
  }
  createPool({
    connectionString: 'postgres://h',
    ssl: true,
    max: 5,
    idleTimeoutMillis: 1000,
    _PoolImpl: FakePool,
  });
  assert.equal(captured.connectionString, 'postgres://h');
  assert.equal(captured.ssl, true);
  assert.equal(captured.max, 5);
  assert.equal(captured.idleTimeoutMillis, 1000);
});

test('createPool defaults max=10 and idleTimeoutMillis=30000', () => {
  let captured = null;
  class FakePool {
    constructor(opts) {
      captured = opts;
    }
  }
  createPool({ connectionString: 'postgres://h', _PoolImpl: FakePool });
  assert.equal(captured.max, 10);
  assert.equal(captured.idleTimeoutMillis, 30_000);
});
