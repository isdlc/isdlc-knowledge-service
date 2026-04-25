// Unit tests for PineconeAdapter — mocked Pinecone index via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PineconeAdapter } from '../../../src/vectordb/pinecone.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function fakePinecone(indexImpl) {
  const idx = {
    upsert: indexImpl?.upsert || (async () => ({})),
    query: indexImpl?.query || (async () => ({ matches: [] })),
    deleteMany: indexImpl?.deleteMany || (async () => ({})),
    deleteAll: indexImpl?.deleteAll || (async () => ({})),
    describeIndexStats: indexImpl?.describeIndexStats || (async () => ({ totalRecordCount: 0 })),
    namespace: () => idx,
  };
  return { index: () => idx, _idx: idx };
}

test('PineconeAdapter is a VectorDBAdapter', () => {
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 4, _clientFactory: () => fakePinecone(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields', () => {
  assert.throws(() => new PineconeAdapter({}), /apiKey/i);
  assert.throws(() => new PineconeAdapter({ apiKey: 'k' }), /indexName/i);
  assert.throws(() => new PineconeAdapter({ apiKey: 'k', indexName: 'i' }), /dimensions/i);
});

test('store + search round-trip with mocked Pinecone index', async () => {
  const stored = [];
  const client = fakePinecone({
    upsert: async (records) => { stored.push(...records); },
    query: async () => ({
      matches: [{ id: 'b', score: 0.91, metadata: { content: 'bravo', project: 'p1' } }],
    }),
  });
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 4, _clientFactory: () => client,
  });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1' } },
  ]);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].id, 'a');
  assert.deepEqual(stored[0].values, unitVec(4, 0));
  assert.equal(stored[0].metadata.content, 'alpha');

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
  assert.equal(results[0].score, 0.91);
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 4, _clientFactory: () => fakePinecone(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1, 2], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete forwards ids to deleteMany', async () => {
  const calls = [];
  const client = fakePinecone({ deleteMany: async (ids) => { calls.push(ids); } });
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 4, _clientFactory: () => client,
  });
  await a.delete(['a', 'b']);
  assert.deepEqual(calls[0], ['a', 'b']);
});

test('ERR-VDB-001 raised on network error', async () => {
  const err = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const client = fakePinecone({ query: async () => { throw err; } });
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 4, _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 raised on 401 auth failure (single attempt)', async () => {
  const err = Object.assign(new Error('unauthorized'), { status: 401 });
  let calls = 0;
  const client = fakePinecone({ query: async () => { calls++; throw err; } });
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 4, _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
  assert.equal(calls, 1);
});

test('retry recovers from 2 transient failures (mocked retry helper)', async () => {
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

test('stats reports total record count and dimensions', async () => {
  const client = fakePinecone({ describeIndexStats: async () => ({ totalRecordCount: 17 }) });
  const a = new PineconeAdapter({
    apiKey: 'k', indexName: 'i', dimensions: 12, _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 17);
  assert.equal(s.dimensions, 12);
});
