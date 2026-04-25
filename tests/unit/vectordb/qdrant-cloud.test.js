// Unit tests for QdrantCloudAdapter — mocked QdrantClient via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QdrantCloudAdapter } from '../../../src/vectordb/qdrant-cloud.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function fakeQdrant(overrides = {}) {
  return {
    upsert: overrides.upsert || (async () => ({ status: 'ok' })),
    search: overrides.search || (async () => []),
    delete: overrides.delete || (async () => ({ status: 'ok' })),
    getCollection: overrides.getCollection || (async () => ({ points_count: 0 })),
  };
}

test('QdrantCloudAdapter is a VectorDBAdapter', () => {
  const a = new QdrantCloudAdapter({
    url: 'https://x.cloud.qdrant.io', apiKey: 'k', collection: 'c', dimensions: 4,
    _clientFactory: () => fakeQdrant(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields including apiKey', () => {
  assert.throws(() => new QdrantCloudAdapter({}), /url/i);
  assert.throws(() => new QdrantCloudAdapter({ url: 'u' }), /apiKey/i);
  assert.throws(() => new QdrantCloudAdapter({ url: 'u', apiKey: 'k' }), /collection/i);
  assert.throws(
    () => new QdrantCloudAdapter({ url: 'u', apiKey: 'k', collection: 'c' }),
    /dimensions/i,
  );
});

test('store + search round-trip with mocked client', async () => {
  const stored = [];
  const client = fakeQdrant({
    upsert: async (col, body) => { stored.push({ col, points: body.points }); return { status: 'ok' }; },
    search: async () => ([
      { id: 'b', score: 0.85, payload: { content: 'bravo', project: 'p1' } },
    ]),
  });
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'col', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.store([
    { id: 'a', vector: unitVec(4, 0), metadata: { content: 'alpha', project: 'p1' } },
    { id: 'b', vector: unitVec(4, 1), metadata: { content: 'bravo', project: 'p1' } },
  ]);
  assert.equal(stored[0].col, 'col');
  assert.equal(stored[0].points.length, 2);
  assert.equal(stored[0].points[0].id, 'a');
  assert.deepEqual(stored[0].points[0].vector, unitVec(4, 0));

  const results = await a.search(unitVec(4, 1), { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].content, 'bravo');
});

test('search applies metadata filter via Qdrant must clause', async () => {
  let captured;
  const client = fakeQdrant({
    search: async (col, body) => { captured = body; return []; },
  });
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'col', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.search(unitVec(4, 0), { limit: 1, filter: { project: 'p2' } });
  assert.deepEqual(captured.filter, {
    must: [{ key: 'project', match: { value: 'p2' } }],
  });
});

test('store rejects vectors with wrong dimensions', async () => {
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'c', dimensions: 4,
    _clientFactory: () => fakeQdrant(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1, 2, 3], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete forwards ids', async () => {
  const calls = [];
  const client = fakeQdrant({
    delete: async (col, body) => { calls.push({ col, body }); return { status: 'ok' }; },
  });
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'col', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.delete(['a', 'b']);
  assert.equal(calls[0].col, 'col');
  assert.deepEqual(calls[0].body.points, ['a', 'b']);
});

test('ERR-VDB-001 on network error', async () => {
  const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const client = fakeQdrant({ search: async () => { throw err; } });
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 on 403 auth failure with single attempt', async () => {
  const err = Object.assign(new Error('forbidden'), { status: 403 });
  let calls = 0;
  const client = fakeQdrant({ search: async () => { calls++; throw err; } });
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
  assert.equal(calls, 1);
});

test('retry recovers after 2 transient failures via shared helper', async () => {
  const { retry } = await import('../../../src/vectordb/retry.js');
  let calls = 0;
  const out = await retry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    return 'ok';
  }, { delays: [1, 1, 1] });
  assert.equal(calls, 3);
  assert.equal(out, 'ok');
});

test('stats reports points_count', async () => {
  const client = fakeQdrant({ getCollection: async () => ({ points_count: 9 }) });
  const a = new QdrantCloudAdapter({
    url: 'https://x', apiKey: 'k', collection: 'c', dimensions: 4,
    _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 9);
  assert.equal(s.dimensions, 4);
});
