// Adapter interface contract tests for VectorDBAdapter abstract class.
// Traces: FR-006, FR-008
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

test('VectorDBAdapter cannot be instantiated directly', () => {
  assert.throws(() => new VectorDBAdapter(), /abstract/i);
});

test('VectorDBAdapter subclass instantiation works when methods provided', () => {
  class TestAdapter extends VectorDBAdapter {
    async store() {}
    async search() { return []; }
    async delete() {}
    async deleteAll() {}
    async stats() { return { count: 0, dimensions: 0, size_bytes: 0 }; }
  }
  const a = new TestAdapter();
  assert.ok(a instanceof VectorDBAdapter);
});

test('Base class methods throw "not implemented" when not overridden', async () => {
  class Empty extends VectorDBAdapter {}
  const a = new Empty();
  await assert.rejects(() => a.store([]), /not implemented/i);
  await assert.rejects(() => a.search([], {}), /not implemented/i);
  await assert.rejects(() => a.delete([]), /not implemented/i);
  await assert.rejects(() => a.deleteAll(), /not implemented/i);
  await assert.rejects(() => a.stats(), /not implemented/i);
});

test('VdbError carries an error code from the taxonomy', () => {
  const err = new VdbError('ERR-VDB-002', 'index corrupted');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'ERR-VDB-002');
  assert.match(err.message, /index corrupted/);
  assert.equal(err.name, 'VdbError');
});

test('VdbError supports cause chaining', () => {
  const root = new Error('disk full');
  const err = new VdbError('ERR-VDB-003', 'write failed', { cause: root });
  assert.equal(err.cause, root);
  assert.equal(err.code, 'ERR-VDB-003');
});
