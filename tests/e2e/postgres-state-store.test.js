// REQ-GH-3 — E2E placeholder for the Postgres-backed state store.
// Real coverage lands in T005-T009. For now this file exercises only the
// skip contract from FR-009/AC-009-01: when DB config is absent, every test
// here must skip with an explicit reason, never fail or error.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dbConfig, NO_DB_SKIP_REASON, skipIfNoDb } from '../helpers/postgres.js';

test('AC-009-01 — DB E2E suite skips with explicit reason when KNOWLEDGE_DATABASE_URL is absent', () => {
  // This test always runs. It documents and verifies the skip contract.
  const { configured } = dbConfig();
  if (!configured) {
    assert.match(NO_DB_SKIP_REASON, /KNOWLEDGE_DATABASE_URL is not set/);
    assert.match(NO_DB_SKIP_REASON, /Set KNOWLEDGE_DATABASE_URL=postgres/);
  } else {
    // When configured, the skip reason still exists but is not active.
    assert.equal(typeof NO_DB_SKIP_REASON, 'string');
  }
});

test('project create/read round trip', skipIfNoDb, async () => {
  // Filled in under T005. Skipped today with NO_DB_SKIP_REASON.
  assert.fail('Pending T005 — this test must not run without DB config.');
});

test('audit insert/select round trip', skipIfNoDb, async () => {
  // Filled in under T006.
  assert.fail('Pending T006 — this test must not run without DB config.');
});

test('queue enqueue/process round trip', skipIfNoDb, async () => {
  // Filled in under T007/T008.
  assert.fail('Pending T007/T008 — this test must not run without DB config.');
});

test('config export/import round trip', skipIfNoDb, async () => {
  // Filled in under T009.
  assert.fail('Pending T009 — this test must not run without DB config.');
});
