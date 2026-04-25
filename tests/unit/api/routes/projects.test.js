// Unit tests for src/api/routes/projects.js
// Traces: FR-001 (CRUD), FR-005 (rebuild), FR-007, FR-014 (audit), FR-015 (status)

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createProjectRoutes } from '../../../../src/api/routes/projects.js';

class FakeInvalidProjectError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_PROJECT';
  }
}

let deps;
let auditCalls;
let enqueueCalls;
let store;

function fakeReq(params = {}, query = {}) {
  return { params, query, socket: { remoteAddress: '10.0.0.5' }, headers: {} };
}

function findRoute(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} must be registered`);
  return r.handle;
}

beforeEach(() => {
  auditCalls = [];
  enqueueCalls = [];
  // In-memory project store
  const map = new Map();
  store = {
    listProjects: async () => [...map.values()],
    getProject: async (id) => {
      if (!map.has(id)) throw new FakeInvalidProjectError(`Project not found: ${id}`);
      return map.get(id);
    },
    createProject: async (cfg) => {
      const id = `${cfg.name.toLowerCase()}-${cfg.version}`;
      if (map.has(id)) throw new FakeInvalidProjectError(`Project already exists: ${id}`);
      const project = { id, ...cfg, created_at: 'T', updated_at: 'T' };
      map.set(id, project);
      return project;
    },
    updateProject: async (id, patch) => {
      if (!map.has(id)) throw new FakeInvalidProjectError(`Project not found: ${id}`);
      const next = { ...map.get(id), ...patch, id, updated_at: 'U' };
      map.set(id, next);
      return next;
    },
    deleteProject: async (id) => {
      if (!map.has(id)) throw new FakeInvalidProjectError(`Project not found: ${id}`);
      map.delete(id);
    },
    getRefreshHistory: async () => [{ timestamp: 'T', type: 'full', status: 'success' }],
  };
  deps = {
    configStore: store,
    queue: {
      enqueue: (type, payload) => {
        enqueueCalls.push({ type, payload });
        return 'job-7';
      },
      listJobs: () => [],
    },
    auditLogger: { log: async (action, details) => auditCalls.push({ action, details }) },
    now: () => '2026-04-25T12:00:00.000Z',
  };
});

// ----------------------------------------------------------------- LIST
describe('GET /api/projects (FR-001)', () => {
  test('empty list', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { projects: [] });
  });

  test('non-empty list with computed staleness', async () => {
    await store.createProject({ name: 'Payments', version: '2.7', sources: [] });
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.projects.length, 1);
    assert.equal(result.body.projects[0].id, 'payments-2.7');
    assert.equal(result.body.projects[0].staleness, 'unknown');
    assert.equal(result.body.projects[0].document_count, 0);
  });

  test('staleness "fresh" when last_refresh is recent', async () => {
    await store.createProject({ name: 'P', version: '1', sources: [] });
    // Mutate the in-memory record.
    const p = await store.getProject('p-1');
    p.last_refresh = '2026-04-25T11:30:00.000Z';
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.body.projects[0].staleness, 'fresh');
  });

  test('staleness "stale" when last_refresh is older than 24h', async () => {
    await store.createProject({ name: 'P', version: '1', sources: [] });
    const p = await store.getProject('p-1');
    p.last_refresh = '2026-04-23T12:00:00.000Z';
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.body.projects[0].staleness, 'stale');
  });
});

// ----------------------------------------------------------------- CREATE
describe('POST /api/projects (FR-001, FR-014)', () => {
  test('happy path returns 201 + audits project.created', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects');
    const result = await handle(
      fakeReq(),
      { name: 'Payments', version: '2.7', sources: [] },
      deps,
    );
    assert.equal(result.status, 201);
    assert.equal(result.body.project.id, 'payments-2.7');
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action, 'project.created');
    assert.equal(auditCalls[0].details.ip_address, '10.0.0.5');
  });

  test('400 when name is missing', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects');
    const result = await handle(fakeReq(), { version: '2.7' }, deps);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_REQUEST');
    assert.equal(auditCalls.length, 0);
  });

  test('400 when version is missing', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects');
    const result = await handle(fakeReq(), { name: 'P' }, deps);
    assert.equal(result.status, 400);
  });

  test('400 when sources is not an array', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects');
    const result = await handle(fakeReq(), { name: 'P', version: '1', sources: 'oops' }, deps);
    assert.equal(result.status, 400);
  });

  test('409 when name+version is duplicate', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects');
    await handle(fakeReq(), { name: 'Payments', version: '2.7' }, deps);
    const result = await handle(fakeReq(), { name: 'Payments', version: '2.7' }, deps);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'PROJECT_DUPLICATE');
  });

  test('400 BARE_CREDENTIAL when store rejects with ERR-API-004 (BLOCKING-1)', async () => {
    // Stub the store to throw ERR-API-004 like the real validator does.
    deps.configStore.createProject = async () => {
      const err = new Error('model_config.api_key must be a secret reference');
      err.code = 'ERR-API-004';
      throw err;
    };
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects');
    const result = await handle(
      fakeReq(),
      {
        name: 'BadProj',
        version: '1.0',
        sources: [],
        model_config: { source: 'cloud', backend: 'openai', api_key: 'sk-bare' },
        vectordb_config: {},
      },
      deps,
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'BARE_CREDENTIAL');
    assert.match(result.body.message, /api_key/);
  });
});

// ----------------------------------------------------------------- GET
describe('GET /api/projects/:id', () => {
  test('happy path returns the project', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'payments-2.7' }), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.project.id, 'payments-2.7');
  });

  test('404 on unknown id', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'nope' }), null, deps);
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'PROJECT_NOT_FOUND');
  });
});

// ----------------------------------------------------------------- UPDATE
describe('PUT /api/projects/:id', () => {
  test('happy path updates and audits', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    const handle = findRoute(createProjectRoutes(deps), 'PUT', '/api/projects/:id');
    const result = await handle(
      fakeReq({ id: 'payments-2.7' }),
      { description: 'updated' },
      deps,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.project.description, 'updated');
    assert.equal(auditCalls[0].action, 'project.updated');
    assert.deepEqual(auditCalls[0].details.fields, ['description']);
  });

  test('404 on unknown id', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'PUT', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'nope' }), { description: 'x' }, deps);
    assert.equal(result.status, 404);
  });

  test('400 on empty body', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    const handle = findRoute(createProjectRoutes(deps), 'PUT', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'payments-2.7' }), {}, deps);
    assert.equal(result.status, 400);
  });

  test('400 on invalid name (empty string)', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    const handle = findRoute(createProjectRoutes(deps), 'PUT', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'payments-2.7' }), { name: '' }, deps);
    assert.equal(result.status, 400);
  });
});

// ----------------------------------------------------------------- DELETE
describe('DELETE /api/projects/:id', () => {
  test('happy path returns 200 + audits', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    const handle = findRoute(createProjectRoutes(deps), 'DELETE', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'payments-2.7' }), null, deps);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { deleted: true });
    assert.equal(auditCalls[0].action, 'project.deleted');
    assert.equal(auditCalls[0].details.project_id, 'payments-2.7');
  });

  test('404 on unknown id', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'DELETE', '/api/projects/:id');
    const result = await handle(fakeReq({ id: 'nope' }), null, deps);
    assert.equal(result.status, 404);
    assert.equal(auditCalls.length, 0);
  });
});

// ----------------------------------------------------------------- REBUILD
describe('POST /api/projects/:id/rebuild (FR-005, FR-014)', () => {
  test('happy path enqueues full_rebuild + audits', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects/:id/rebuild');
    const result = await handle(fakeReq({ id: 'payments-2.7' }), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'queued');
    assert.equal(result.body.job_id, 'job-7');
    assert.equal(enqueueCalls[0].type, 'full_rebuild');
    assert.equal(enqueueCalls[0].payload.project_id, 'payments-2.7');
    assert.equal(auditCalls[0].action, 'project.rebuild_triggered');
  });

  test('404 on unknown id (no enqueue, no audit)', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'POST', '/api/projects/:id/rebuild');
    const result = await handle(fakeReq({ id: 'nope' }), null, deps);
    assert.equal(result.status, 404);
    assert.equal(enqueueCalls.length, 0);
    assert.equal(auditCalls.length, 0);
  });
});

// ----------------------------------------------------------------- STATUS
describe('GET /api/projects/:id/status (FR-015 / AC-015-08)', () => {
  test('returns staleness, document count, refresh history, active jobs', async () => {
    await store.createProject({ name: 'Payments', version: '2.7' });
    deps.queue.listJobs = (filters) => {
      if (filters.status === 'queued') return [];
      if (filters.status === 'running') {
        return [
          { id: '1', type: 'full_rebuild', status: 'running', payload: { project_id: 'payments-2.7' } },
          { id: '2', type: 'full_rebuild', status: 'running', payload: { project_id: 'other-1.0' } },
        ];
      }
      return [];
    };
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects/:id/status');
    const result = await handle(fakeReq({ id: 'payments-2.7' }), null, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.staleness, 'unknown');
    assert.equal(result.body.document_count, 0);
    assert.equal(result.body.active_jobs.length, 1);
    assert.equal(result.body.active_jobs[0].payload.project_id, 'payments-2.7');
    assert.equal(result.body.refresh_history.length, 1);
  });

  test('404 on unknown id', async () => {
    const handle = findRoute(createProjectRoutes(deps), 'GET', '/api/projects/:id/status');
    const result = await handle(fakeReq({ id: 'nope' }), null, deps);
    assert.equal(result.status, 404);
  });
});
