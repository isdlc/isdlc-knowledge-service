// REQ-GH-3 / FR-005 — Postgres audit logger unit tests.
//
// Tests use the state-store seam directly. DB-level append-only enforcement
// is verified in tests/integration/audit-grants.test.js (skips without DB).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresAuditLogger } from '../../../src/audit/postgres-logger.js';

function makeFakeAuditPort() {
  const calls = [];
  return {
    calls,
    audit: {
      async log(action, details, meta) {
        calls.push({ kind: 'log', action, details, meta });
        return { id: 1, timestamp: '2026-04-28T01:00:00.000Z', action, details, ...(meta || {}) };
      },
      async query(filters) {
        calls.push({ kind: 'query', filters });
        return [];
      },
    },
  };
}

test('createPostgresAuditLogger forwards log() to the state-store audit port', async () => {
  const fake = makeFakeAuditPort();
  const logger = createPostgresAuditLogger({ stateStore: { audit: fake.audit } });
  await logger.log('project.created', { name: 'P' }, { project_id: 'p-1' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].action, 'project.created');
  assert.deepEqual(fake.calls[0].details, { name: 'P' });
  assert.equal(fake.calls[0].meta.project_id, 'p-1');
});

test('createPostgresAuditLogger forwards query() with filters intact', async () => {
  const fake = makeFakeAuditPort();
  const logger = createPostgresAuditLogger({ stateStore: { audit: fake.audit } });
  await logger.query({ action: 'project.created', limit: 10 });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].kind, 'query');
  assert.equal(fake.calls[0].filters.action, 'project.created');
  assert.equal(fake.calls[0].filters.limit, 10);
});

test('createPostgresAuditLogger rejects construction without stateStore or pool', () => {
  assert.throws(
    () => createPostgresAuditLogger({}),
    (err) => err.code === 'ERR-DB-002' && /requires a stateStore or a pg pool/.test(err.message),
  );
});

test('logger exposes ONLY log and query — append-only constitutional constraint', () => {
  const fake = makeFakeAuditPort();
  const logger = createPostgresAuditLogger({ stateStore: { audit: fake.audit } });
  const allowed = new Set(['log', 'query']);
  for (const key of Object.keys(logger)) {
    assert.ok(allowed.has(key), `unexpected exported method: ${key}`);
  }
  assert.equal(typeof logger.log, 'function');
  assert.equal(typeof logger.query, 'function');
  assert.equal(logger.delete, undefined);
  assert.equal(logger.update, undefined);
  assert.equal(logger.truncate, undefined);
  assert.equal(logger.clear, undefined);
});

test('log() defaults details and meta when omitted', async () => {
  const fake = makeFakeAuditPort();
  const logger = createPostgresAuditLogger({ stateStore: { audit: fake.audit } });
  await logger.log('action.only');
  assert.deepEqual(fake.calls[0].details, {});
  assert.deepEqual(fake.calls[0].meta, {});
});
