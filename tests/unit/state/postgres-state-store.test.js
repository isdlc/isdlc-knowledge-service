// REQ-GH-3 / FR-004 — postgres state store unit tests.
//
// Uses a fake Pool that records every SQL it sees and returns canned rows.
// The DB-touching path (real psql + grants + transaction rollback) is
// covered by tests/integration/db/* which skip without KNOWLEDGE_DATABASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPostgresStateStore,
  StateConflictError,
} from '../../../src/state/index.js';

function makeFakePool() {
  const queries = [];
  /** @type {Map<string, () => { rows: any[], rowCount?: number }>} */
  const responders = new Map();
  const pool = {
    queries,
    setResponder(matcher, fn) {
      responders.set(matcher, fn);
    },
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [matcher, fn] of responders.entries()) {
        if (typeof sql === 'string' && sql.includes(matcher)) return fn(sql, params);
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql, params) {
          queries.push({ sql, params, tx: true });
          for (const [matcher, fn] of responders.entries()) {
            if (typeof sql === 'string' && sql.includes(matcher)) return fn(sql, params);
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  return pool;
}

const fixedNow = () => '2026-04-28T01:00:00.000Z';

/* ------------------------------------------------------------------ */
/* projects                                                           */
/* ------------------------------------------------------------------ */

test('projects.list issues a SELECT … FROM ks.projects ORDER BY id and maps rows', async () => {
  const pool = makeFakePool();
  pool.setResponder('FROM ks.projects', () => ({
    rows: [
      {
        id: 'a-1',
        name: 'A',
        version: '1',
        description: null,
        sources: [],
        model_config: {},
        vectordb_config: {},
        metadata_vocabulary: null,
        created_at: new Date('2026-04-28T00:00:00Z'),
        updated_at: new Date('2026-04-28T00:00:00Z'),
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  const list = await store.projects.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'a-1');
  assert.equal(list[0].created_at, '2026-04-28T00:00:00.000Z');
  assert.match(pool.queries[0].sql, /ORDER BY id ASC/);
});

test('projects.create surfaces StateConflictError on Postgres 23505', async () => {
  const pool = makeFakePool();
  pool.setResponder('INSERT INTO ks.projects', () => {
    const err = new Error('duplicate key value violates unique constraint "projects_pkey"');
    err.code = '23505';
    throw err;
  });
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await assert.rejects(
    () =>
      store.projects.create({
        id: 'dup-1',
        name: 'Dup',
        version: '1',
      }),
    (err) => err instanceof StateConflictError && /already exists: dup-1/.test(err.message),
  );
});

test('projects.create stringifies sources/model_config/vectordb_config/metadata_vocabulary as JSONB', async () => {
  const pool = makeFakePool();
  pool.setResponder('INSERT INTO ks.projects', () => ({
    rows: [
      {
        id: 'p-1',
        name: 'P',
        version: '1',
        description: null,
        sources: [{ type: 'git' }],
        model_config: { source: 'local' },
        vectordb_config: { backend: 'sqlite-vec' },
        metadata_vocabulary: { custom_link_fields: ['linked_x'] },
        created_at: '2026-04-28T01:00:00Z',
        updated_at: '2026-04-28T01:00:00Z',
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await store.projects.create({
    id: 'p-1',
    name: 'P',
    version: '1',
    sources: [{ type: 'git' }],
    model_config: { source: 'local' },
    vectordb_config: { backend: 'sqlite-vec' },
    metadata_vocabulary: { custom_link_fields: ['linked_x'] },
  });
  const params = pool.queries.at(-1).params;
  assert.equal(JSON.parse(params[4])[0].type, 'git');
  assert.equal(JSON.parse(params[5]).source, 'local');
  assert.equal(JSON.parse(params[6]).backend, 'sqlite-vec');
  assert.deepEqual(JSON.parse(params[7]).custom_link_fields, ['linked_x']);
});

test('projects.update only writes the fields present in the patch', async () => {
  const pool = makeFakePool();
  pool.setResponder('UPDATE ks.projects', () => ({
    rows: [
      {
        id: 'p-1',
        name: 'P',
        version: '1',
        description: 'updated',
        sources: [],
        model_config: {},
        vectordb_config: {},
        metadata_vocabulary: null,
        created_at: '2026-04-28T01:00:00Z',
        updated_at: '2026-04-28T01:00:00Z',
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await store.projects.update('p-1', { description: 'updated' });
  const sql = pool.queries.at(-1).sql;
  assert.match(sql, /SET description = \$1/);
  // updated_at always bumped
  assert.match(sql, /updated_at = \$2/);
});

test('projects.update returns null when no row matches', async () => {
  const pool = makeFakePool();
  pool.setResponder('UPDATE ks.projects', () => ({ rows: [], rowCount: 0 }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  const out = await store.projects.update('does-not-exist', { description: 'x' });
  assert.equal(out, null);
});

test('projects.delete returns true when a row was deleted', async () => {
  const pool = makeFakePool();
  pool.setResponder('DELETE FROM ks.projects', () => ({ rows: [], rowCount: 1 }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  assert.equal(await store.projects.delete('p-1'), true);
});

/* ------------------------------------------------------------------ */
/* refreshHistory                                                     */
/* ------------------------------------------------------------------ */

test('refreshHistory.add inserts and returns the typed record', async () => {
  const pool = makeFakePool();
  pool.setResponder('INSERT INTO ks.refresh_history', () => ({
    rows: [
      {
        id: 1,
        project_id: 'p-1',
        ts: new Date('2026-04-28T01:00:00Z'),
        type: 'full',
        trigger_source: 'web-ui',
        duration_seconds: 12,
        documents_processed: 42,
        status: 'success',
        error: null,
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  const rec = await store.refreshHistory.add('p-1', {
    type: 'full',
    trigger_source: 'web-ui',
    duration_seconds: 12,
    documents_processed: 42,
    status: 'success',
  });
  assert.equal(rec.project_id, 'p-1');
  assert.equal(rec.timestamp, '2026-04-28T01:00:00.000Z');
  assert.equal(rec.documents_processed, 42);
});

test('refreshHistory.list orders by ts DESC and respects limit', async () => {
  const pool = makeFakePool();
  pool.setResponder('FROM ks.refresh_history', () => ({ rows: [], rowCount: 0 }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await store.refreshHistory.list('p-1', { limit: 25 });
  const last = pool.queries.at(-1);
  assert.match(last.sql, /ORDER BY ts DESC/);
  assert.equal(last.params[1], 25);
});

/* ------------------------------------------------------------------ */
/* audit                                                              */
/* ------------------------------------------------------------------ */

test('audit.log writes an entry with action + project_id + details', async () => {
  const pool = makeFakePool();
  pool.setResponder('INSERT INTO ks.audit_entries', () => ({
    rows: [
      {
        id: 1,
        ts: new Date('2026-04-28T01:00:00Z'),
        action: 'project.created',
        project_id: 'p-1',
        details: { name: 'P' },
        ip_address: null,
        actor: null,
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  const entry = await store.audit.log('project.created', { name: 'P' }, { project_id: 'p-1' });
  assert.equal(entry.action, 'project.created');
  assert.equal(entry.project_id, 'p-1');
  assert.deepEqual(entry.details, { name: 'P' });
});

test('audit.query composes WHERE clauses for action / project_id / since / until', async () => {
  const pool = makeFakePool();
  pool.setResponder('FROM ks.audit_entries', () => ({ rows: [], rowCount: 0 }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await store.audit.query({
    action: 'project.created',
    project_id: 'p-1',
    since: '2026-04-27',
    until: '2026-04-29',
    limit: 50,
    offset: 10,
  });
  const last = pool.queries.at(-1);
  assert.match(last.sql, /action = \$1/);
  assert.match(last.sql, /project_id = \$2/);
  assert.match(last.sql, /ts >= \$3/);
  assert.match(last.sql, /ts <= \$4/);
  assert.match(last.sql, /LIMIT \$5 OFFSET \$6/);
  assert.equal(last.params[0], 'project.created');
  assert.equal(last.params[4], 50);
  assert.equal(last.params[5], 10);
});

test('audit.log rejects non-string action', async () => {
  const pool = makeFakePool();
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await assert.rejects(
    () => store.audit.log(''),
    /action must be a non-empty string/,
  );
});

/* ------------------------------------------------------------------ */
/* importExport                                                       */
/* ------------------------------------------------------------------ */

test('importExport.recordRun inserts and returns the run record', async () => {
  const pool = makeFakePool();
  pool.setResponder('INSERT INTO ks.import_export_runs', () => ({
    rows: [
      {
        id: 1,
        ts: new Date('2026-04-28T01:00:00Z'),
        direction: 'export',
        scope: 'deployment',
        target_id: null,
        status: 'success',
        payload_size: 1024,
        manifest: { projects: ['p-1'] },
        error: null,
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  const run = await store.importExport.recordRun({
    direction: 'export',
    scope: 'deployment',
    status: 'success',
    payload_size: 1024,
    manifest: { projects: ['p-1'] },
  });
  assert.equal(run.direction, 'export');
  assert.equal(run.scope, 'deployment');
  assert.equal(run.payload_size, 1024);
});

/* ------------------------------------------------------------------ */
/* transaction                                                        */
/* ------------------------------------------------------------------ */

test('transaction wraps the callback in BEGIN/COMMIT and exposes a scoped store', async () => {
  const pool = makeFakePool();
  pool.setResponder('INSERT INTO ks.audit_entries', () => ({
    rows: [
      {
        id: 1,
        ts: new Date('2026-04-28T01:00:00Z'),
        action: 'a',
        project_id: null,
        details: {},
        ip_address: null,
        actor: null,
      },
    ],
    rowCount: 1,
  }));
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await store.transaction(async (tx) => {
    await tx.audit.log('a');
  });
  const sqls = pool.queries.map((q) => q.sql);
  assert.ok(sqls.includes('BEGIN'));
  assert.ok(sqls.includes('COMMIT'));
});

test('transaction rolls back on thrown error', async () => {
  const pool = makeFakePool();
  const store = createPostgresStateStore({ pool, now: fixedNow });
  await assert.rejects(
    () =>
      store.transaction(async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  const sqls = pool.queries.map((q) => q.sql);
  assert.ok(sqls.includes('BEGIN'));
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(!sqls.includes('COMMIT'));
});
