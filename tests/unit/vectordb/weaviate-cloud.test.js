// Unit tests for WeaviateCloudAdapter — mocked weaviate client via _clientFactory.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WeaviateCloudAdapter } from '../../../src/vectordb/weaviate-cloud.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

// Build a minimal fluent fake of the weaviate-ts-client v2 API.
function fakeWeaviate(impls = {}) {
  const stored = [];
  const deleted = [];
  let aggregateCount = impls.aggregateCount ?? 0;

  const batcher = {
    _objs: [],
    withObject(o) { this._objs.push(o); return this; },
    async do() {
      if (impls.batchDo) return impls.batchDo(this._objs);
      stored.push(...this._objs);
      this._objs = [];
      return [{ result: { status: 'SUCCESS' } }];
    },
  };

  const get = {
    _state: {},
    withClassName(c) { this._state.class = c; return this; },
    withNearVector(nv) { this._state.nv = nv; return this; },
    withLimit(n) { this._state.limit = n; return this; },
    withFields(f) { this._state.fields = f; return this; },
    do: impls.getDo || (async () => ({ data: { Get: {} } })),
  };

  const aggregate = {
    _state: {},
    withClassName(c) { this._state.class = c; return this; },
    withFields(f) { this._state.fields = f; return this; },
    do: impls.aggregateDo
      || (async function () {
        return { data: { Aggregate: { [this._state.class]: [{ meta: { count: aggregateCount } }] } } };
      }),
  };

  const deleter = {
    _state: {},
    withClassName(c) { this._state.class = c; return this; },
    withId(i) { this._state.id = i; return this; },
    do: impls.deleterDo
      || (async function () { deleted.push(this._state.id); return {}; }),
  };

  const classDeleter = {
    _state: {},
    withClassName(c) { this._state.class = c; return this; },
    do: impls.classDeleterDo || (async () => ({})),
  };

  return {
    _stored: stored,
    _deleted: deleted,
    batch: { objectsBatcher: () => Object.create(batcher, { _objs: { value: [], writable: true } }) },
    graphql: {
      get: () => Object.create(get, { _state: { value: {}, writable: true } }),
      aggregate: () => Object.create(aggregate, { _state: { value: {}, writable: true } }),
    },
    data: { deleter: () => Object.create(deleter, { _state: { value: {}, writable: true } }) },
    schema: { classDeleter: () => Object.create(classDeleter, { _state: { value: {}, writable: true } }) },
  };
}

test('WeaviateCloudAdapter is a VectorDBAdapter', () => {
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'C', dimensions: 4,
    _clientFactory: () => fakeWeaviate(),
  });
  assert.ok(a instanceof VectorDBAdapter);
});

test('constructor validates required fields', () => {
  assert.throws(() => new WeaviateCloudAdapter({}), /host/i);
  assert.throws(() => new WeaviateCloudAdapter({ host: 'h' }), /apiKey/i);
  assert.throws(() => new WeaviateCloudAdapter({ host: 'h', apiKey: 'k' }), /className/i);
});

test('store + search round-trip with mocked client', async () => {
  const client = fakeWeaviate({
    getDo: async () => ({
      data: { Get: { Doc: [{ content: 'bravo', project: 'p1', _additional: { id: 'b', distance: 0.1 } }] } },
    }),
  });
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'Doc', dimensions: 4,
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

test('store rejects vectors with wrong dimensions', async () => {
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'C', dimensions: 4,
    _clientFactory: () => fakeWeaviate(),
  });
  await assert.rejects(
    a.store([{ id: 'x', vector: [1], metadata: {} }]),
    (e) => e instanceof VdbError && /dimension/i.test(e.message),
  );
});

test('delete uses data deleter per id', async () => {
  const client = fakeWeaviate();
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'C', dimensions: 4,
    _clientFactory: () => client,
  });
  await a.delete(['a', 'b']);
  assert.deepEqual(client._deleted, ['a', 'b']);
});

test('ERR-VDB-001 on network error', async () => {
  const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  const client = fakeWeaviate({ getDo: async () => { throw err; } });
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'C', dimensions: 4,
    _clientFactory: () => client,
  });
  let caught;
  try { await a.search(unitVec(4, 0), { limit: 1 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VdbError);
  assert.equal(caught.code, 'ERR-VDB-001');
});

test('ERR-VDB-001 on 401 auth failure single attempt', async () => {
  const err = Object.assign(new Error('unauthorized'), { statusCode: 401 });
  let calls = 0;
  const client = fakeWeaviate({ getDo: async () => { calls++; throw err; } });
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'C', dimensions: 4,
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
    if (calls < 3) throw Object.assign(new Error('5xx'), { statusCode: 503 });
    return 'ok';
  }, { delays: [1, 1, 1] });
  assert.equal(calls, 3);
  assert.equal(out, 'ok');
});

test('stats returns aggregate count', async () => {
  const client = fakeWeaviate({ aggregateCount: 33 });
  const a = new WeaviateCloudAdapter({
    host: 'h', apiKey: 'k', className: 'C', dimensions: 6,
    _clientFactory: () => client,
  });
  const s = await a.stats();
  assert.equal(s.count, 33);
  assert.equal(s.dimensions, 6);
});
