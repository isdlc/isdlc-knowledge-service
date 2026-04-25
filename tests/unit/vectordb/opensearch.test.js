// Unit tests for OpenSearchAdapter — mocked client via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenSearchAdapter } from '../../../src/vectordb/opensearch.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function fakeClient(overrides = {}) {
  return {
    bulk: overrides.bulk || (async () => ({ body: { errors: false, items: [] } })),
    search: overrides.search || (async () => ({ body: { hits: { hits: [] } } })),
    deleteByQuery: overrides.deleteByQuery || (async () => ({ body: { deleted: 0 } })),
    count: overrides.count || (async () => ({ body: { count: 0 } })),
  };
}

const fastDelays = { delays: [1, 1, 1] };

test('OpenSearchAdapter is a VectorDBAdapter', () => {
  const a = new OpenSearchAdapter({
    node: 'https://os.example',
    dimensions: 4,
    index: 'idx',
    _clientFactory: () => fakeClient(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields', () => {
  assert.throws(() => new OpenSearchAdapter({}), /node/i);
  assert.throws(() => new OpenSearchAdapter({ node: 'x' }), /dimensions/i);
  assert.throws(() => new OpenSearchAdapter({ node: 'x', dimensions: 4 }), /index/i);
  assert.throws(
    () => new OpenSearchAdapter({ node: 'x', dimensions: 0, index: 'i' }),
    /dimensions/i,
  );
});

test('store + search round-trip with mocked client', async () => {
  const stored = [];
  const client = fakeClient({
    bulk: async ({ body }) => { stored.push(...body); return { body: { errors: false } }; },
    search: async () => ({
      body: { hits: { hits: [{ _id: 'b', _score: 0.9, _source: { embedding: [0, 1, 0, 0], content: 'bravo', project: 'p1' } }] } },
    }),
  });
  const a = new OpenSearchAdapter({ node: 'https://x', dimensions: 4, index: 'i', _clientFactory: () => client });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1' } },
  ]);
  // Bulk body alternates action+doc; 2 records -> 4 entries.
  assert.equal(stored.length, 4);
  assert.deepEqual(stored[0], { index: { _index: 'i', _id: 'a' } });
  assert.equal(stored[1].content, 'alpha');

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
  assert.equal(results[0].metadata.project, 'p1');
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new OpenSearchAdapter({
    node: 'https://x', dimensions: 4, index: 'i', _clientFactory: () => fakeClient(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1, 2, 3], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete passes ids to bulk delete', async () => {
  const calls = [];
  const client = fakeClient({
    bulk: async ({ body }) => { calls.push(body); return { body: { errors: false } }; },
  });
  const a = new OpenSearchAdapter({ node: 'https://x', dimensions: 4, index: 'i', _clientFactory: () => client });
  await a.delete(['a', 'b']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { delete: { _index: 'i', _id: 'a' } });
  assert.deepEqual(calls[0][1], { delete: { _index: 'i', _id: 'b' } });
});

test('ERR-VDB-001 raised on network error (after retries exhausted)', async () => {
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const client = fakeClient({ search: async () => { throw err; } });
  const a = new OpenSearchAdapter({
    node: 'https://x', dimensions: 4, index: 'i', _clientFactory: () => client,
  });
  // Override retry delays via monkey-patch — short-circuit by counting calls.
  let caught;
  try {
    await a.search(unitVec(4, 0), { limit: 1 });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError, 'expected VdbError');
  assert.equal(caught.code, 'ERR-VDB-001');
}, { timeout: 5000 });

test('ERR-VDB-001 raised on 401 auth failure (no retry)', async () => {
  const err = Object.assign(new Error('unauthorized'), { statusCode: 401, meta: { statusCode: 401 } });
  let calls = 0;
  const client = fakeClient({ search: async () => { calls++; throw err; } });
  const a = new OpenSearchAdapter({
    node: 'https://x', dimensions: 4, index: 'i', _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
  assert.equal(calls, 1, 'auth errors should not be retried');
});

test('retry recovers after 2 transient failures (3rd attempt succeeds)', async () => {
  // Use the retry helper directly with fast delays through the adapter by
  // patching `retry` is harder; instead exercise the underlying helper.
  const { retry } = await import('../../../src/vectordb/retry.js');
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls < 3) {
      const e = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      throw e;
    }
    return 'ok';
  }, fastDelays);
  assert.equal(calls, 3);
  assert.equal(result, 'ok');
});

test('stats returns count from count() endpoint', async () => {
  const client = fakeClient({ count: async () => ({ body: { count: 42 } }) });
  const a = new OpenSearchAdapter({
    node: 'https://x', dimensions: 8, index: 'i', _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 42);
  assert.equal(s.dimensions, 8);
});

test('deleteAll uses delete_by_query match_all', async () => {
  const calls = [];
  const client = fakeClient({
    deleteByQuery: async (req) => { calls.push(req); return { body: { deleted: 5 } }; },
  });
  const a = new OpenSearchAdapter({
    node: 'https://x', dimensions: 4, index: 'i', _clientFactory: () => client,
  });
  await a.deleteAll();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.query, { match_all: {} });
});
