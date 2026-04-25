// T007: OpenAI Cloud Adapter unit tests
// Traces: FR-009, AC-009-03, ERR-MODEL-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md (ERR-MODEL-002)
//
// Mocking seam: the adapter constructor accepts an optional `_clientFactory`
// option. When supplied, the adapter calls `_clientFactory({ apiKey, organization })`
// to obtain a client object whose shape matches `openai.OpenAI` (specifically
// `client.embeddings.create({ model, input }) → { data: [{ embedding }] }`).
// Tests stub this factory to avoid real HTTP calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiAdapter } from '../../../src/models/openai.js';

function stubClient(impl) {
  return {
    embeddings: {
      create: impl,
    },
  };
}

function makeAdapter({ create, model = 'text-embedding-3-small', backoffMs = [0, 0, 0] } = {}) {
  const client = stubClient(create);
  return new OpenAiAdapter({
    apiKey: 'test-key',
    model,
    _clientFactory: () => client,
    _backoffMs: backoffMs, // override for fast tests
  });
}

test('OpenAiAdapter.embed returns the embedding vector', async () => {
  const adapter = makeAdapter({
    create: async ({ model, input }) => {
      assert.equal(model, 'text-embedding-3-small');
      assert.equal(input, 'hello world');
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    },
  });

  const vec = await adapter.embed('hello world');
  assert.deepEqual(vec, [0.1, 0.2, 0.3]);
});

test('OpenAiAdapter.batchEmbed returns one vector per input, in order', async () => {
  const adapter = makeAdapter({
    create: async ({ input }) => {
      assert.deepEqual(input, ['a', 'b', 'c']);
      return {
        data: [
          { embedding: [1, 0, 0], index: 0 },
          { embedding: [0, 1, 0], index: 1 },
          { embedding: [0, 0, 1], index: 2 },
        ],
      };
    },
  });

  const vecs = await adapter.batchEmbed(['a', 'b', 'c']);
  assert.deepEqual(vecs, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
});

test('OpenAiAdapter.batchEmbed reorders by `index` when provider returns out of order', async () => {
  const adapter = makeAdapter({
    create: async () => ({
      data: [
        { embedding: [0, 0, 1], index: 2 },
        { embedding: [1, 0, 0], index: 0 },
        { embedding: [0, 1, 0], index: 1 },
      ],
    }),
  });

  const vecs = await adapter.batchEmbed(['a', 'b', 'c']);
  assert.deepEqual(vecs, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
});

test('OpenAiAdapter retries on 429 and recovers (2 failures + 1 success)', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    create: async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('rate limit');
        err.status = 429;
        throw err;
      }
      return { data: [{ embedding: [9, 9, 9] }] };
    },
  });

  const vec = await adapter.embed('x');
  assert.deepEqual(vec, [9, 9, 9]);
  assert.equal(calls, 3, 'should retry twice then succeed');
});

test('OpenAiAdapter retries on 5xx and recovers', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    create: async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('server boom');
        err.status = 503;
        throw err;
      }
      return { data: [{ embedding: [1, 2, 3] }] };
    },
  });

  const vec = await adapter.embed('x');
  assert.deepEqual(vec, [1, 2, 3]);
  assert.equal(calls, 3);
});

test('OpenAiAdapter throws ModelError ERR-MODEL-002 after 3 failures', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    create: async () => {
      calls += 1;
      const err = new Error('rate limit');
      err.status = 429;
      throw err;
    },
  });

  await assert.rejects(
    () => adapter.embed('x'),
    (err) => {
      assert.equal(err.code, 'ERR-MODEL-002');
      assert.equal(err.name, 'ModelError');
      assert.match(err.message, /openai/i);
      assert.ok(err.cause, 'should preserve cause');
      return true;
    },
  );
  assert.equal(calls, 3, 'should attempt exactly 3 times');
});

test('OpenAiAdapter does NOT retry on non-retryable errors (e.g., 400)', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    create: async () => {
      calls += 1;
      const err = new Error('bad input');
      err.status = 400;
      throw err;
    },
  });

  await assert.rejects(
    () => adapter.embed('x'),
    (err) => {
      assert.equal(err.code, 'ERR-MODEL-002');
      return true;
    },
  );
  assert.equal(calls, 1, 'should not retry on 400');
});

test('OpenAiAdapter.getInfo returns correct dimensions for text-embedding-3-small', () => {
  const adapter = makeAdapter({ model: 'text-embedding-3-small', create: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.name, 'text-embedding-3-small');
  assert.equal(info.type, 'cloud');
  assert.equal(info.provider, 'openai');
  assert.equal(info.dimensions, 1536);
});

test('OpenAiAdapter.getInfo returns correct dimensions for text-embedding-3-large', () => {
  const adapter = makeAdapter({ model: 'text-embedding-3-large', create: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.dimensions, 3072);
});

test('OpenAiAdapter.getInfo returns correct dimensions for text-embedding-ada-002', () => {
  const adapter = makeAdapter({ model: 'text-embedding-ada-002', create: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.dimensions, 1536);
});

test('OpenAiAdapter throws on construction with missing apiKey', () => {
  assert.throws(
    () => new OpenAiAdapter({ model: 'text-embedding-3-small' }),
    /apiKey/i,
  );
});

test('OpenAiAdapter throws on construction with unknown model', () => {
  assert.throws(
    () => new OpenAiAdapter({ apiKey: 'k', model: 'no-such-model' }),
    /unknown.*model/i,
  );
});
