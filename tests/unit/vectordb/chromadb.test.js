// Unit tests for ChromaDbAdapter — mocked ChromaClient via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChromaDbAdapter } from '../../../src/vectordb/chromadb.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function fakeCollection(overrides = {}) {
  return {
    add: overrides.add || (async () => {}),
    query: overrides.query || (async () => ({ ids: [[]], distances: [[]], metadatas: [[]], documents: [[]] })),
    delete: overrides.delete || (async () => {}),
    count: overrides.count || (async () => 0),
  };
}

function fakeChroma(overrides = {}) {
  return {
    getOrCreateCollection: overrides.getOrCreateCollection
      || (async () => fakeCollection(overrides.collection || {})),
  };
}

test('ChromaDbAdapter is a VectorDBAdapter', () => {
  const a = new ChromaDbAdapter({
    url: 'http://localhost:8000', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields', () => {
  assert.throws(() => new ChromaDbAdapter({}), /url|path/i);
  assert.throws(() => new ChromaDbAdapter({ url: 'u' }), /dimensions/i);
  assert.throws(() => new ChromaDbAdapter({ url: 'u', dimensions: 4 }), /collection/i);
});

test('accepts either url or path', () => {
  const a1 = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'c', _clientFactory: () => fakeChroma(),
  });
  const a2 = new ChromaDbAdapter({
    path: '/tmp/db', dimensions: 4, collection: 'c', _clientFactory: () => fakeChroma(),
  });
  assert.ok(a1 && a2);
});

test('store + search round-trip with mocked client', async () => {
  const adds = [];
  const collection = fakeCollection({
    add: async (args) => { adds.push(args); },
    query: async () => ({
      ids: [['b']],
      distances: [[0.12]],
      metadatas: [[{ content: 'bravo', project: 'p1' }]],
      documents: [['bravo']],
    }),
  });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1' } },
  ]);
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].ids, ['a', 'b']);
  assert.deepEqual(adds[0].embeddings[0], unitVec(4, 0));

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
  assert.equal(results[0].metadata.project, 'p1');
});

test('search filter is forwarded as Chroma where clause', async () => {
  let captured;
  const collection = fakeCollection({
    query: async (args) => { captured = args; return { ids: [[]], distances: [[]], metadatas: [[]], documents: [[]] }; },
  });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  await a.search(unitVec(4, 0), { limit: 5, filter: { project: 'p1' } });
  assert.deepEqual(captured.where, { project: 'p1' });
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1, 2], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete forwards ids to collection', async () => {
  const calls = [];
  const collection = fakeCollection({
    delete: async (args) => { calls.push(args); },
  });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  await a.delete(['a', 'b']);
  assert.deepEqual(calls[0].ids, ['a', 'b']);
});

test('ERR-VDB-001 on simulated network error', async () => {
  const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const collection = fakeCollection({ query: async () => { throw err; } });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 on 401 auth failure', async () => {
  const err = Object.assign(new Error('unauthorized'), { status: 401 });
  const collection = fakeCollection({ add: async () => { throw err; } });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  let caught;
  try {
    await a.store([{ id: 'a', vector: unitVec(4, 0), metadata: {} }]);
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-003 on simulated write failure', async () => {
  const err = new Error('write failed');
  const collection = fakeCollection({ add: async () => { throw err; } });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 4, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  let caught;
  try {
    await a.store([{ id: 'a', vector: unitVec(4, 0), metadata: {} }]);
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-003');
});

test('stats returns count and dimensions', async () => {
  const collection = fakeCollection({ count: async () => 5 });
  const a = new ChromaDbAdapter({
    url: 'http://x', dimensions: 6, collection: 'docs',
    _clientFactory: () => fakeChroma({ getOrCreateCollection: async () => collection }),
  });
  const s = await a.stats();
  assert.equal(s.count, 5);
  assert.equal(s.dimensions, 6);
});
