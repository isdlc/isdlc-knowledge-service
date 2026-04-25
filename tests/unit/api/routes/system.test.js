// Unit tests for src/api/routes/system.js
// Traces: FR-014 (audit query), FR-015 (AC-015-01 metrics, AC-015-07 health)

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSystemRoutes } from '../../../../src/api/routes/system.js';

let deps;
let auditEntries;
let projects;
let runningJobs;

function fakeReq(query = {}) {
  return { params: {}, query, socket: { remoteAddress: '10.0.0.2' }, headers: {} };
}

function findRoute(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} must be registered`);
  return r.handle;
}

beforeEach(() => {
  auditEntries = [];
  projects = [];
  runningJobs = [];
  deps = {
    configStore: { listProjects: async () => projects },
    queue: {
      listJobs: (filters) => (filters.status === 'running' ? runningJobs : []),
    },
    modelManager: {
      getStatus: () => [
        { name: 'jina-v2-base-code', loaded: true, pinned: true, memory_mb: 280, last_used: 1000 },
      ],
    },
    auditLogger: {
      query: async (filters) => {
        return auditEntries.filter((e) => {
          if (filters.project && e.project_id !== filters.project) return false;
          if (filters.action && e.action !== filters.action) return false;
          if (filters.from && e.timestamp < filters.from) return false;
          if (filters.to && e.timestamp > filters.to) return false;
          return true;
        }).slice(filters.offset || 0, filters.limit !== undefined ? (filters.offset || 0) + filters.limit : undefined);
      },
    },
    memoryUsage: () => ({ used_mb: 1024, available_mb: 8192 }),
  };
});

// ----------------------------------------------------------------- HEALTH
describe('GET /api/system/health (FR-015 / AC-015-07)', () => {
  test('returns api+worker status, project count, total documents, memory', async () => {
    projects = [
      { id: 'a-1', document_count: 100 },
      { id: 'b-2', document_count: 250 },
    ];
    runningJobs = [{ id: '1' }];
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/system/health');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.api, 'up');
    assert.equal(result.body.worker, 'up');
    assert.equal(result.body.projects, 2);
    assert.equal(result.body.total_documents, 350);
    assert.equal(result.body.memory_used_mb, 1024);
    assert.equal(result.body.memory_available_mb, 8192);
  });

  test('worker = "unknown" when no running jobs and no probe', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/system/health');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.body.worker, 'unknown');
  });

  test('worker probe override is respected', async () => {
    deps.workerHealth = () => 'down';
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/system/health');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.body.worker, 'down');
  });

  test('zero projects yields 0 documents', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/system/health');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.body.projects, 0);
    assert.equal(result.body.total_documents, 0);
  });
});

// ----------------------------------------------------------------- MEMORY
describe('GET /api/system/memory', () => {
  test('returns used + available + per-model footprint', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/system/memory');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.used_mb, 1024);
    assert.equal(result.body.available_mb, 8192);
    assert.equal(result.body.models.length, 1);
    assert.equal(result.body.models[0].name, 'jina-v2-base-code');
    assert.equal(result.body.models[0].memory_mb, 280);
  });
});

// ----------------------------------------------------------------- METRICS (T028)
describe('GET /metrics (FR-015 / AC-015-01)', () => {
  test('returns 200 with Prometheus content-type and body from getMetricsText()', async () => {
    // Mock the metrics module at the deps boundary so we do not depend on
    // prom-client's internal output here.
    deps.getMetricsText = async () =>
      '# HELP test_metric Test metric.\n# TYPE test_metric gauge\ntest_metric 7\n';
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/metrics');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.match(result.headers['Content-Type'], /text\/plain; version=0\.0\.4/);
    assert.match(result.body, /test_metric 7/);
  });

  test('default getMetricsText (no override) returns real prom-client output', async () => {
    // No deps.getMetricsText override → wiring resolves to the real
    // src/observability/metrics.js implementation.
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/metrics');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.match(result.headers['Content-Type'], /text\/plain/);
    // The real registry exposes at least the metric definitions even with
    // no recorded values.
    assert.match(result.body, /job_queue_depth|api_request_duration_seconds/);
  });
});

// ----------------------------------------------------------------- AUDIT QUERY
describe('GET /api/audit (FR-014)', () => {
  beforeEach(() => {
    auditEntries = [
      { timestamp: '2026-04-25T10:00:00.000Z', action: 'project.created', project_id: 'a-1', details: {} },
      { timestamp: '2026-04-25T11:00:00.000Z', action: 'project.updated', project_id: 'a-1', details: {} },
      { timestamp: '2026-04-25T12:00:00.000Z', action: 'project.created', project_id: 'b-2', details: {} },
    ];
  });

  test('returns all entries when no filters', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/audit');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.entries.length, 3);
    assert.equal(result.body.total, 3);
  });

  test('filters by project', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/audit');
    const result = await handle(fakeReq({ project: 'a-1' }), null, deps);
    assert.equal(result.body.entries.length, 2);
    for (const e of result.body.entries) assert.equal(e.project_id, 'a-1');
  });

  test('filters by action', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/audit');
    const result = await handle(fakeReq({ action: 'project.created' }), null, deps);
    assert.equal(result.body.entries.length, 2);
  });

  test('honours limit + offset', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/audit');
    const result = await handle(fakeReq({ limit: '2', offset: '1' }), null, deps);
    assert.equal(result.body.entries.length, 2);
    assert.equal(result.body.entries[0].timestamp, '2026-04-25T11:00:00.000Z');
  });

  test('400 on invalid limit', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/audit');
    const result = await handle(fakeReq({ limit: 'oops' }), null, deps);
    assert.equal(result.status, 400);
  });

  test('400 on negative offset', async () => {
    const handle = findRoute(createSystemRoutes(deps), 'GET', '/api/audit');
    const result = await handle(fakeReq({ offset: '-1' }), null, deps);
    assert.equal(result.status, 400);
  });
});
