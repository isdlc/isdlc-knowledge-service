// Unit tests for MilvusCloudAdapter — mocked Zilliz client via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MilvusCloudAdapter } from '../../../src/vectordb/milvus-cloud.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

const ok = { error_code: 'Success' };
function fakeMilvus(overrides = {}) {
  return {
    insert: overrides.insert || (async () => ({ status: ok })),
    search: overrides.search
      || (async () => ({ status: ok, results: [] })),
    delete_entities: overrides.delete_entities || (async () => ({ status: ok })),
    getCollectionStatistics: overrides.getCollectionStatistics
      || (async () => ({ status: ok, stats: [{ key: 'row_count', value: '0' }] })),
  };
}

test('MilvusCloudAdapter is a VectorDBAdapter', () => {
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'c', dimensions: 4,
    _clientFactory: () => fakeMilvus(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields including token', () => {
  assert.throws(() => new MilvusCloudAdapter({}), /endpoint/i);
  assert.throws(() => new MilvusCloudAdapter({ endpoint: 'e' }), /token/i);
  assert.throws(
    () => new MilvusCloudAdapter({ endpoint: 'e', token: 't' }),
    /collection/i,
  );
  assert.throws(
    () => new MilvusCloudAdapter({ endpoint: 'e', token: 't', collection: 'c' }),
    /dimensions/i,
  );
});

test('store + search round-trip with mocked client', async () => {
  const stored = [];
  const client = fakeMilvus({
    insert: async (req) => { stored.push(req); return { status: ok }; },
    search: async () => ({
      status: ok,
      results: [{ id: 'b', score: 0.7, content: 'bravo', project: 'p1', source_type: 'git', source_url: 'u', metadata: '{"tag":"x"}' }],
    }),
  });
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'col', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1', source_type: 'git', source_url: 'u' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1', source_type: 'git', source_url: 'u' } },
  ]);
  assert.equal(stored[0].collection_name, 'col');
  assert.equal(stored[0].fields_data.length, 2);
  assert.equal(stored[0].fields_data[0].id, 'a');
  assert.deepEqual(stored[0].fields_data[0].vector, unitVec(4, 0));
  assert.equal(stored[0].fields_data[0].content, 'alpha');

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
  assert.equal(results[0].metadata.project, 'p1');
  assert.equal(results[0].metadata.tag, 'x');
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'c', dimensions: 4,
    _clientFactory: () => fakeMilvus(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('store maps non-Success status to ERR-VDB-003', async () => {
  const client = fakeMilvus({
    insert: async () => ({ status: { error_code: 'CollectionNotExists', reason: 'no col' } }),
  });
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try {
    await a.store([{ id: 'x', vector: unitVec(4, 0), metadata: {} }]);
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-003');
});

test('delete builds expr "id in [...]"', async () => {
  const calls = [];
  const client = fakeMilvus({
    delete_entities: async (req) => { calls.push(req); return { status: ok }; },
  });
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'col', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.delete(['a', 'b']);
  assert.equal(calls[0].collection_name, 'col');
  assert.equal(calls[0].expr, 'id in ["a","b"]');
});

test('ERR-VDB-001 on network error', async () => {
  const err = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  const client = fakeMilvus({ search: async () => { throw err; } });
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 on auth failure ("invalid token") single attempt', async () => {
  let calls = 0;
  const client = fakeMilvus({
    search: async () => { calls++; throw new Error('invalid token'); },
  });
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
  assert.equal(calls, 1);
});

test('retry recovers from 2 transient failures via shared helper', async () => {
  const { retry } = await import('../../../src/vectordb/retry.js');
  let calls = 0;
  const out = await retry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    return 'ok';
  }, { delays: [1, 1, 1] });
  assert.equal(calls, 3);
  assert.equal(out, 'ok');
});

test('stats parses row_count from getCollectionStatistics', async () => {
  const client = fakeMilvus({
    getCollectionStatistics: async () => ({ status: ok, stats: [{ key: 'row_count', value: '21' }] }),
  });
  const a = new MilvusCloudAdapter({
    endpoint: 'https://e', token: 't', collection: 'c', dimensions: 8,
    _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 21);
  assert.equal(s.dimensions, 8);
});
