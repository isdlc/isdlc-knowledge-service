// T006: ModelAdapter interface — unit tests
// Traces: FR-002, FR-009, ERR-MODEL-001, ERR-MODEL-003
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      src/models/adapter.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelAdapter,
  ModelError,
  ALLOWED_PRECISIONS,
  validateText,
  validateBatch,
  validatePrecision,
} from '../../../src/models/adapter.js';

test('ModelAdapter is an abstract base — embed/batchEmbed/getInfo throw on the base class', async () => {
  const a = new ModelAdapter();
  await assert.rejects(() => a.embed('x'), /must be implemented/);
  await assert.rejects(() => a.batchEmbed(['x']), /must be implemented/);
  assert.throws(() => a.getInfo(), /must be implemented/);
});

test('contract: a concrete subclass exposing embed, batchEmbed, getInfo satisfies the interface', () => {
  class FakeAdapter extends ModelAdapter {
    async embed() { return [0.1, 0.2]; }
    async batchEmbed() { return [[0.1, 0.2]]; }
    getInfo() {
      return { name: 'fake', type: 'local', dimensions: 2, max_input_tokens: 32, precision: 'fp16' };
    }
  }
  const a = new FakeAdapter();
  assert.equal(typeof a.embed, 'function');
  assert.equal(typeof a.batchEmbed, 'function');
  assert.equal(typeof a.getInfo, 'function');
  const info = a.getInfo();
  assert.equal(info.name, 'fake');
  assert.equal(info.type, 'local');
  assert.equal(info.dimensions, 2);
  assert.equal(info.precision, 'fp16');
});

test('ModelError carries an iSDLC error code and optional cause/details', () => {
  const cause = new Error('underlying');
  const err = new ModelError('ERR-MODEL-001', 'load failed', { cause, details: { foo: 1 } });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ModelError');
  assert.equal(err.code, 'ERR-MODEL-001');
  assert.equal(err.message, 'load failed');
  assert.equal(err.cause, cause);
  assert.deepEqual(err.details, { foo: 1 });
});

test('ALLOWED_PRECISIONS lists exactly fp4, fp16, fp32 (AC-009-02)', () => {
  assert.deepEqual([...ALLOWED_PRECISIONS], ['fp4', 'fp16', 'fp32']);
});

test('validateText rejects non-strings and empty strings', () => {
  assert.equal(validateText('hello'), 'hello');
  assert.throws(() => validateText(''), TypeError);
  assert.throws(() => validateText(null), TypeError);
  assert.throws(() => validateText(42), TypeError);
});

test('validateBatch rejects non-arrays, empty arrays, and non-string elements', () => {
  assert.deepEqual(validateBatch(['a', 'b']), ['a', 'b']);
  assert.throws(() => validateBatch('a'), TypeError);
  assert.throws(() => validateBatch([]), TypeError);
  assert.throws(() => validateBatch(['a', '']), TypeError);
  assert.throws(() => validateBatch(['a', 7]), TypeError);
});

test('validatePrecision accepts fp4/fp16/fp32 and rejects others', () => {
  assert.equal(validatePrecision('fp4'), 'fp4');
  assert.equal(validatePrecision('fp16'), 'fp16');
  assert.equal(validatePrecision('fp32'), 'fp32');
  assert.throws(() => validatePrecision('fp8'), TypeError);
  assert.throws(() => validatePrecision(undefined), TypeError);
});
