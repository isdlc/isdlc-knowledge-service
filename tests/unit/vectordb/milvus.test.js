// Unit tests for MilvusAdapter — mocked MilvusClient via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MilvusAdapter } from '../../../src/vectordb/milvus.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function fakeMilvus(overrides = {}) {
  return {
    insert: overrides.insert || (async () => ({ status: { error_code: 'Success' } })),
    search: overrides.search || (async () => ({ results: [] })),
    deleteEntities: overrides.deleteEntities || (async () => ({ status: { error_code: 'Success' } })),
    getCollectionStatistics: overrides.getCollectionStatistics
      || (async () => ({ stats: [{ key: 'row_count', value: '0' }] })),
  };
}

test('MilvusAdapter is a VectorDBAdapter', () => {
  const a = new MilvusAdapter({
    address: 'localhost:19530', dimensions: 4, collection: 'c',
    _clientFactory: () => fakeMilvus(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields', () => {
  assert.throws(() => new MilvusAdapter({}), /address/i);
  assert.throws(() => new MilvusAdapter({ address: 'a' }), /dimensions/i);
  assert.throws(() => new MilvusAdapter({ address: 'a', dimensions: 4 }), /collection/i);
});

test('store + search round-trip with mocked client', async () => {
  const inserts = [];
  const client = fakeMilvus({
    insert: async (args) => { inserts.push(args); return { status: { error_code: 'Success' } }; },
    search: async () => ({
      results: [{ id: 'b', score: 0.91, metadata: JSON.stringify({ content: 'bravo', project: 'p1' }) }],
    }),
  });
  const a = new MilvusAdapter({
    address: 'localhost:19530', collection: 'docs', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1' } },
  ]);
  assert.equal(inserts[0].collection_name, 'docs');
  assert.equal(inserts[0].fields_data.length, 2);
  assert.equal(inserts[0].fields_data[0].id, 'a');

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
  assert.equal(results[0].metadata.project, 'p1');
});

test('search builds filter expression from options.filter', async () => {
  let captured;
  const client = fakeMilvus({
    search: async (args) => { captured = args; return { results: [] }; },
  });
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.search(unitVec(4, 0), { limit: 5, filter: { project: 'p1' } });
  assert.equal(captured.collection_name, 'c');
  assert.equal(captured.topk, 5);
  assert.match(captured.filter, /project == "p1"/);
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
    _clientFactory: () => fakeMilvus(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete builds id-in expression', async () => {
  let captured;
  const client = fakeMilvus({
    deleteEntities: async (args) => { captured = args; return { status: { error_code: 'Success' } }; },
  });
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.delete(['a', 'b']);
  assert.equal(captured.collection_name, 'c');
  assert.match(captured.expr, /id in \["a","b"\]/);
});

test('ERR-VDB-001 on simulated network error', async () => {
  const err = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
  const client = fakeMilvus({ search: async () => { throw err; } });
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 on UNAUTHENTICATED gRPC code', async () => {
  const err = Object.assign(new Error('UNAUTHENTICATED'), { code: 16 });
  const client = fakeMilvus({ insert: async () => { throw err; } });
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
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
  const err = new Error('write failed');
  const client = fakeMilvus({ insert: async () => { throw err; } });
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try {
    await a.store([{ id: 'a', vector: unitVec(4, 0), metadata: {} }]);
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-003');
});

test('stats reads row_count from getCollectionStatistics', async () => {
  const client = fakeMilvus({
    getCollectionStatistics: async () => ({ stats: [{ key: 'row_count', value: '42' }] }),
  });
  const a = new MilvusAdapter({
    address: 'a:1', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 42);
  assert.equal(s.dimensions, 4);
});
