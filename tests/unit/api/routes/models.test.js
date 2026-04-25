// Unit tests for src/api/routes/models.js
// Traces: FR-011 (AC-011-01..05), FR-014 (audit log)

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createModelRoutes } from '../../../../src/api/routes/models.js';

let deps;
let auditCalls;
let pinCalls;
let unpinCalls;
let modelStatuses;
let projectsList;

function fakeReq(params = {}) {
  return { params, query: {}, socket: { remoteAddress: '10.0.0.9' }, headers: {} };
}

function findRoute(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} must be registered`);
  return r.handle;
}

beforeEach(() => {
  auditCalls = [];
  pinCalls = [];
  unpinCalls = [];
  modelStatuses = [
    { name: 'jina-v2-base-code', loaded: true, pinned: false, memory_mb: 280, last_used: 1000 },
    { name: 'all-MiniLM-L6-v2', loaded: false, pinned: true, memory_mb: 0, last_used: null },
  ];
  projectsList = [
    {
      id: 'finance-3.0',
      model_config: { source: 'cloud', provider: 'openai', model_name: 'text-embedding-3-small' },
    },
    {
      id: 'risk-2.0',
      model_config: { source: 'local', model_name: 'jina-v2-base-code', precision: 'fp16' },
    },
  ];
  deps = {
    configStore: {
      listProjects: async () => projectsList,
    },
    modelManager: {
      getStatus: () => modelStatuses,
      pin: (name) => pinCalls.push(name),
      unpin: (name) => unpinCalls.push(name),
    },
    auditLogger: { log: async (action, details) => auditCalls.push({ action, details }) },
  };
});

// ----------------------------------------------------------------- LIST
describe('GET /api/models (FR-011 AC-011-03..05)', () => {
  test('returns local models from manager + cloud models from project configs', async () => {
    const handle = findRoute(createModelRoutes(deps), 'GET', '/api/models');
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 200);
    const names = result.body.models.map((m) => m.name).sort();
    assert.deepEqual(names, ['all-MiniLM-L6-v2', 'jina-v2-base-code', 'text-embedding-3-small']);
    const cloud = result.body.models.find((m) => m.name === 'text-embedding-3-small');
    assert.equal(cloud.type, 'cloud');
    assert.equal(cloud.provider, 'openai');
    const local = result.body.models.find((m) => m.name === 'jina-v2-base-code');
    assert.equal(local.type, 'local');
    assert.equal(local.loaded, true);
  });

  test('empty when neither manager nor projects know any models', async () => {
    deps.modelManager.getStatus = () => [];
    deps.configStore.listProjects = async () => [];
    const handle = findRoute(createModelRoutes(deps), 'GET', '/api/models');
    const result = await handle(fakeReq(), null, deps);
    assert.deepEqual(result.body, { models: [] });
  });
});

// ----------------------------------------------------------------- PIN
describe('POST /api/models/:name/pin (FR-011 AC-011-01)', () => {
  test('happy path: pin a local model + audit', async () => {
    const handle = findRoute(createModelRoutes(deps), 'POST', '/api/models/:name/pin');
    const result = await handle(fakeReq({ name: 'jina-v2-base-code' }), null, deps);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { pinned: true });
    assert.deepEqual(pinCalls, ['jina-v2-base-code']);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action, 'model.pinned');
    assert.equal(auditCalls[0].details.model_name, 'jina-v2-base-code');
  });

  test('400 cloud-cannot-pin', async () => {
    const handle = findRoute(createModelRoutes(deps), 'POST', '/api/models/:name/pin');
    const result = await handle(fakeReq({ name: 'text-embedding-3-small' }), null, deps);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'CLOUD_CANNOT_PIN');
    assert.equal(pinCalls.length, 0);
    assert.equal(auditCalls.length, 0);
  });

  test('404 model not found', async () => {
    const handle = findRoute(createModelRoutes(deps), 'POST', '/api/models/:name/pin');
    const result = await handle(fakeReq({ name: 'unknown-model' }), null, deps);
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'MODEL_NOT_FOUND');
    assert.equal(pinCalls.length, 0);
  });
});

// ----------------------------------------------------------------- UNPIN
describe('DELETE /api/models/:name/pin (FR-011 AC-011-02)', () => {
  test('happy path: unpin a local model + audit', async () => {
    const handle = findRoute(createModelRoutes(deps), 'DELETE', '/api/models/:name/pin');
    const result = await handle(fakeReq({ name: 'all-MiniLM-L6-v2' }), null, deps);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { pinned: false });
    assert.deepEqual(unpinCalls, ['all-MiniLM-L6-v2']);
    assert.equal(auditCalls[0].action, 'model.unpinned');
  });

  test('404 model not found', async () => {
    const handle = findRoute(createModelRoutes(deps), 'DELETE', '/api/models/:name/pin');
    const result = await handle(fakeReq({ name: 'unknown' }), null, deps);
    assert.equal(result.status, 404);
    assert.equal(unpinCalls.length, 0);
  });

  test('400 when target is a cloud model', async () => {
    const handle = findRoute(createModelRoutes(deps), 'DELETE', '/api/models/:name/pin');
    const result = await handle(fakeReq({ name: 'text-embedding-3-small' }), null, deps);
    assert.equal(result.status, 400);
    assert.equal(unpinCalls.length, 0);
  });
});
