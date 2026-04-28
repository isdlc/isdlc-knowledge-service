// REQ-GH-3 / FR-007 — config import/export CLI helpers.
//
// Uses an in-memory state store fake so tests don't need a real Postgres.
// Round-trip tests against a real DB live in tests/integration/import-export.test.js
// and skip without KNOWLEDGE_DATABASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigImportError,
  PAYLOAD_VERSION,
  exportConfig,
  importConfig,
  importConfigFromFile,
  validateImportPayload,
  writeExportToFile,
  listScopes,
} from '../../../src/cli/config.js';

function makeMemoryStateStore(seed = {}) {
  const projects = new Map();
  const history = new Map();
  const audit = [];
  const runs = [];
  for (const p of seed.projects || []) projects.set(p.id, { ...p });
  for (const r of seed.refresh_history || []) {
    if (!history.has(r.project_id)) history.set(r.project_id, []);
    history.get(r.project_id).push({ ...r });
  }
  for (const e of seed.audit || []) audit.push({ ...e });
  for (const r of seed.runs || []) runs.push({ ...r });

  const store = {
    projects: {
      async list() { return [...projects.values()]; },
      async get(id) { return projects.get(id) ?? null; },
      async create(p) {
        if (projects.has(p.id)) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        projects.set(p.id, { ...p, created_at: '2026-04-28T00:00:00Z', updated_at: '2026-04-28T00:00:00Z' });
        return projects.get(p.id);
      },
      async update(id, patch) {
        const cur = projects.get(id);
        if (!cur) return null;
        const next = { ...cur, ...patch, updated_at: '2026-04-28T01:00:00Z' };
        projects.set(id, next);
        return next;
      },
      async delete(id) { return projects.delete(id); },
    },
    refreshHistory: {
      async list(id, { limit = 100 } = {}) { return (history.get(id) || []).slice(0, limit); },
      async add(id, rec) {
        if (!history.has(id)) history.set(id, []);
        history.get(id).push({ ...rec, project_id: id });
        return rec;
      },
    },
    audit: {
      async query() { return [...audit]; },
      async log(action, details, meta) {
        const entry = { action, details, ...meta, timestamp: '2026-04-28T01:00:00Z' };
        audit.push(entry);
        return entry;
      },
    },
    importExport: {
      async listRuns() { return [...runs]; },
      async recordRun(run) {
        runs.push({ ...run, timestamp: '2026-04-28T01:00:00Z' });
        return run;
      },
    },
    async transaction(fn) {
      // Memory fake — no real transaction; just invoke.
      return fn(store);
    },
  };
  return { store, projects, history, audit, runs };
}

/* ------------------------------------------------------------------ */
/* listScopes / validateImportPayload                                 */
/* ------------------------------------------------------------------ */

test('listScopes returns project / all / deployment', () => {
  assert.deepEqual([...listScopes()].sort(), ['all', 'deployment', 'project']);
});

test('validateImportPayload rejects null and non-objects', () => {
  assert.deepEqual(validateImportPayload(null), ['Import payload must be a JSON object']);
  assert.deepEqual(validateImportPayload([]), ['Import payload must be a JSON object']);
});

test('validateImportPayload rejects unsupported version + missing fields', () => {
  const errors = validateImportPayload({
    version: 99,
    scope: 'unknown',
    projects: 'not-array',
    refresh_history: undefined,
  });
  assert.ok(errors.some((e) => /Unsupported payload version 99/.test(e)));
  assert.ok(errors.some((e) => /Unknown scope/.test(e)));
  assert.ok(errors.some((e) => /projects must be an array/.test(e)));
  assert.ok(errors.some((e) => /refresh_history must be an array/.test(e)));
});

test('validateImportPayload accepts a well-formed payload', () => {
  assert.deepEqual(
    validateImportPayload({
      version: PAYLOAD_VERSION,
      scope: 'all',
      projects: [],
      refresh_history: [],
    }),
    [],
  );
});

/* ------------------------------------------------------------------ */
/* exportConfig                                                       */
/* ------------------------------------------------------------------ */

test('AC-007-01 — exportConfig scope=project returns one project + its refresh history', async () => {
  const fixture = makeMemoryStateStore({
    projects: [{ id: 'a-1', name: 'A', version: '1' }, { id: 'b-1', name: 'B', version: '1' }],
    refresh_history: [
      { project_id: 'a-1', type: 'full', status: 'success' },
      { project_id: 'b-1', type: 'full', status: 'success' },
    ],
  });
  const out = await exportConfig({
    stateStore: fixture.store,
    scope: 'project',
    target_id: 'a-1',
  });
  assert.equal(out.scope, 'project');
  assert.equal(out.target_id, 'a-1');
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].id, 'a-1');
  assert.equal(out.refresh_history.length, 1);
  assert.equal(out.refresh_history[0].project_id, 'a-1');
});

test('AC-007-01 — exportConfig scope=all includes every project', async () => {
  const fixture = makeMemoryStateStore({
    projects: [{ id: 'a-1', name: 'A', version: '1' }, { id: 'b-1', name: 'B', version: '1' }],
  });
  const out = await exportConfig({ stateStore: fixture.store, scope: 'all' });
  assert.equal(out.projects.length, 2);
  assert.equal(out.audit_entries, undefined, 'scope=all does not include deployment-wide audit');
});

test('AC-007-03 — exportConfig scope=deployment includes audit + runs + jobs', async () => {
  const fixture = makeMemoryStateStore({
    projects: [{ id: 'a-1', name: 'A', version: '1' }],
    audit: [{ action: 'project.created', project_id: 'a-1', details: {} }],
    runs: [{ direction: 'export', scope: 'all', status: 'success' }],
  });
  const fakeQueue = { async listJobs() { return [{ id: 'job-1', type: 'full_rebuild' }]; } };
  const out = await exportConfig({
    stateStore: fixture.store,
    scope: 'deployment',
    queue: fakeQueue,
  });
  assert.equal(out.audit_entries.length, 1);
  assert.equal(out.import_export_runs.length, 1);
  assert.equal(out.jobs.length, 1);
});

test('AC-007-03 — queue.listJobs failure is best-effort, recorded as warning', async () => {
  const fixture = makeMemoryStateStore({ projects: [], audit: [], runs: [] });
  const flakyQueue = {
    async listJobs() {
      throw new Error('queue temporarily unavailable');
    },
  };
  const out = await exportConfig({
    stateStore: fixture.store,
    scope: 'deployment',
    queue: flakyQueue,
  });
  assert.deepEqual(out.jobs, []);
  assert.match(out.jobs_export_warning, /queue temporarily unavailable/);
});

test('exportConfig surfaces ERR-EXPORT-001 for unknown scope', async () => {
  const fixture = makeMemoryStateStore();
  await assert.rejects(
    () => exportConfig({ stateStore: fixture.store, scope: 'bogus' }),
    (err) => err instanceof ConfigImportError && err.code === 'ERR-EXPORT-001',
  );
});

test('exportConfig requires target_id for scope=project', async () => {
  const fixture = makeMemoryStateStore();
  await assert.rejects(
    () => exportConfig({ stateStore: fixture.store, scope: 'project' }),
    /requires target_id/,
  );
});

/* ------------------------------------------------------------------ */
/* importConfig                                                       */
/* ------------------------------------------------------------------ */

test('AC-007-02 — importConfig validates payload version BEFORE any DB mutation', async () => {
  const fixture = makeMemoryStateStore();
  await assert.rejects(
    () =>
      importConfig({
        stateStore: fixture.store,
        payload: { version: 99, scope: 'all', projects: [], refresh_history: [] },
      }),
    (err) =>
      err instanceof ConfigImportError &&
      err.code === 'ERR-IMPORT-001' &&
      /Unsupported payload version 99/.test(err.message),
  );
  assert.equal(fixture.projects.size, 0, 'no projects should have been written');
  // The failed-import run record should still be recorded for audit.
  assert.equal(fixture.runs.length, 0, 'pre-flight failure does not record a run');
});

test('importConfig creates new projects and updates existing ones (merge strategy)', async () => {
  const fixture = makeMemoryStateStore({
    projects: [{ id: 'existing', name: 'Existing', version: '1' }],
  });
  const stats = await importConfig({
    stateStore: fixture.store,
    payload: {
      version: PAYLOAD_VERSION,
      scope: 'all',
      projects: [
        { id: 'existing', name: 'Existing', version: '1', description: 'updated' },
        { id: 'new', name: 'New', version: '1' },
      ],
      refresh_history: [
        { project_id: 'existing', type: 'full', status: 'success' },
      ],
    },
  });
  assert.equal(stats.projects_imported, 2);
  assert.equal(stats.refresh_records_imported, 1);
  assert.equal(fixture.projects.get('existing').description, 'updated');
  assert.ok(fixture.projects.has('new'));
});

test('AC-007-04 — importConfig records a run with direction=import (success path)', async () => {
  const fixture = makeMemoryStateStore();
  await importConfig({
    stateStore: fixture.store,
    payload: {
      version: PAYLOAD_VERSION,
      scope: 'all',
      projects: [],
      refresh_history: [],
    },
  });
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0].direction, 'import');
  assert.equal(fixture.runs[0].status, 'success');
});

test('AC-007-04 — importConfig records a run with status=failure on partial failure', async () => {
  const fixture = makeMemoryStateStore();
  // Inject a failure: a project with no id should fail validation inside the tx.
  await assert.rejects(
    () =>
      importConfig({
        stateStore: fixture.store,
        payload: {
          version: PAYLOAD_VERSION,
          scope: 'all',
          projects: [{ name: 'No ID', version: '1' }],
          refresh_history: [],
        },
      }),
    /Invalid project entry/,
  );
  assert.equal(fixture.runs.length, 1, 'a failure run should still be recorded');
  assert.equal(fixture.runs[0].status, 'failure');
  assert.match(fixture.runs[0].error, /Invalid project entry/);
});

/* ------------------------------------------------------------------ */
/* file round trip                                                    */
/* ------------------------------------------------------------------ */

test('writeExportToFile + importConfigFromFile round-trip a payload', async () => {
  const fixture = makeMemoryStateStore({
    projects: [{ id: 'rt-1', name: 'RT', version: '1' }],
  });
  const dir = await mkdtemp(join(tmpdir(), 'kn-config-rt-'));
  try {
    const payload = await exportConfig({ stateStore: fixture.store, scope: 'all' });
    const file = join(dir, 'export.json');
    await writeExportToFile({ payload, file });
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.projects.length, 1);

    const dest = makeMemoryStateStore();
    const stats = await importConfigFromFile({ stateStore: dest.store, file });
    assert.equal(stats.projects_imported, 1);
    assert.ok(dest.projects.has('rt-1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importConfigFromFile surfaces ERR-IMPORT-001 on missing file', async () => {
  const fixture = makeMemoryStateStore();
  await assert.rejects(
    () => importConfigFromFile({ stateStore: fixture.store, file: '/no/such/file.json' }),
    (err) => err instanceof ConfigImportError && err.code === 'ERR-IMPORT-001',
  );
});

test('importConfigFromFile surfaces ERR-IMPORT-001 on invalid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kn-config-bad-'));
  try {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{not-json');
    const fixture = makeMemoryStateStore();
    await assert.rejects(
      () => importConfigFromFile({ stateStore: fixture.store, file }),
      (err) => err.code === 'ERR-IMPORT-001' && /not valid JSON/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
