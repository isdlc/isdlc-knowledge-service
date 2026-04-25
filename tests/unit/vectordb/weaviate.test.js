// Unit tests for WeaviateAdapter — mocked four-method client via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WeaviateAdapter } from '../../../src/vectordb/weaviate.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function fakeWeaviate(overrides = {}) {
  const stored = [];
  const deleted = [];
  return {
    _stored: stored,
    _deleted: deleted,
    storeBatch: overrides.storeBatch
      || (async (objs) => { stored.push(...objs); return [{ result: { status: 'SUCCESS' } }]; }),
    runSearch: overrides.runSearch || (async () => ({ results: [] })),
    runDelete: overrides.runDelete || (async ({ ids }) => { deleted.push(...ids); return []; }),
    runDeleteAll: overrides.runDeleteAll || (async () => ({})),
    runStats: overrides.runStats || (async () => ({ count: 0 })),
  };
}

test('WeaviateAdapter is a VectorDBAdapter', () => {
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'localhost:8080', dimensions: 4, className: 'Doc',
    _clientFactory: () => fakeWeaviate(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields', () => {
  assert.throws(() => new WeaviateAdapter({}), /scheme|host/i);
  assert.throws(() => new WeaviateAdapter({ scheme: 'http' }), /scheme|host/i);
  assert.throws(() => new WeaviateAdapter({ scheme: 'http', host: 'h' }), /dimensions/i);
  assert.throws(
    () => new WeaviateAdapter({ scheme: 'http', host: 'h', dimensions: 4 }),
    /className/i,
  );
});

test('store + search round-trip with mocked client', async () => {
  const client = fakeWeaviate({
    runSearch: async () => ({
      results: [{ _additional: { id: 'b', distance: 0.1 }, content: 'bravo', metadata: { project: 'p1' } }],
    }),
  });
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => client,
  });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1' } },
  ]);
  assert.equal(client._stored.length, 2);
  assert.equal(client._stored[0].class, 'Doc');
  assert.equal(client._stored[0].id, 'a');
  assert.deepEqual(client._stored[0].vector, unitVec(4, 0));

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
  assert.equal(results[0].metadata.project, 'p1');
});

test('search builds Weaviate filter for single key', async () => {
  let captured;
  const client = fakeWeaviate({
    runSearch: async (args) => { captured = args; return { results: [] }; },
  });
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => client,
  });
  await a.search(unitVec(4, 0), { limit: 5, filter: { project: 'p1' } });
  assert.equal(captured.limit, 5);
  assert.deepEqual(captured.filter, { path: ['project'], operator: 'Equal', valueText: 'p1' });
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => fakeWeaviate(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete forwards ids', async () => {
  const client = fakeWeaviate();
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => client,
  });
  await a.delete(['a', 'b']);
  assert.deepEqual(client._deleted, ['a', 'b']);
});

test('ERR-VDB-001 on simulated network error', async () => {
  const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  const client = fakeWeaviate({ runSearch: async () => { throw err; } });
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 on 403 forbidden', async () => {
  const err = Object.assign(new Error('forbidden'), { status: 403 });
  const client = fakeWeaviate({ storeBatch: async () => { throw err; } });
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => client,
  });
  let caught;
  try {
    await a.store([{ id: 'a', vector: unitVec(4, 0), metadata: {} }]);
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-003 on simulated write failure', async () => {
  const err = new Error('storage error');
  const client = fakeWeaviate({ storeBatch: async () => { throw err; } });
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 4, className: 'Doc',
    _clientFactory: () => client,
  });
  let caught;
  try {
    await a.store([{ id: 'a', vector: unitVec(4, 0), metadata: {} }]);
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-003');
});

test('stats reports count and dimensions', async () => {
  const client = fakeWeaviate({ runStats: async () => ({ count: 11 }) });
  const a = new WeaviateAdapter({
    scheme: 'http', host: 'h', dimensions: 6, className: 'Doc',
    _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 11);
  assert.equal(s.dimensions, 6);
});
