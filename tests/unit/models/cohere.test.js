// T007: Cohere Cloud Adapter unit tests
// Traces: FR-009, AC-009-03, ERR-MODEL-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md (ERR-MODEL-002)
//
// Mocking seam: the adapter constructor accepts `_clientFactory({ apiKey })`
// returning an object whose `embed({ texts, model, inputType }) → { embeddings: float[][] }`
// matches the Cohere v7 SDK client shape. Tests stub the factory.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CohereAdapter } from '../../../src/models/cohere.js';

function makeAdapter({ embed, model = 'embed-english-v3.0', backoffMs = [0, 0, 0] } = {}) {
  const client = { embed };
  return new CohereAdapter({
    apiKey: 'test-key',
    model,
    _clientFactory: () => client,
    _backoffMs: backoffMs,
  });
}

test('CohereAdapter.embed returns a single embedding vector', async () => {
  const adapter = makeAdapter({
    embed: async ({ texts, model }) => {
      assert.deepEqual(texts, ['hello']);
      assert.equal(model, 'embed-english-v3.0');
      return { embeddings: [[0.1, 0.2, 0.3]] };
    },
  });

  const vec = await adapter.embed('hello');
  assert.deepEqual(vec, [0.1, 0.2, 0.3]);
});

test('CohereAdapter.batchEmbed returns one vector per input', async () => {
  const adapter = makeAdapter({
    embed: async ({ texts }) => {
      assert.deepEqual(texts, ['a', 'b']);
      return {
        embeddings: [
          [1, 0],
          [0, 1],
        ],
      };
    },
  });

  const vecs = await adapter.batchEmbed(['a', 'b']);
  assert.deepEqual(vecs, [
    [1, 0],
    [0, 1],
  ]);
});

test('CohereAdapter retries on 429 then succeeds (2 failures + 1 success)', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    embed: async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('throttled');
        err.statusCode = 429;
        throw err;
      }
      return { embeddings: [[5, 5, 5]] };
    },
  });

  const vec = await adapter.embed('x');
  assert.deepEqual(vec, [5, 5, 5]);
  assert.equal(calls, 3);
});

test('CohereAdapter retries on 5xx then succeeds', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    embed: async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('server boom');
        err.statusCode = 502;
        throw err;
      }
      return { embeddings: [[1, 1, 1]] };
    },
  });

  const vec = await adapter.embed('x');
  assert.deepEqual(vec, [1, 1, 1]);
  assert.equal(calls, 3);
});

test('CohereAdapter throws ModelError ERR-MODEL-002 after 3 failures', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    embed: async () => {
      calls += 1;
      const err = new Error('throttled');
      err.statusCode = 429;
      throw err;
    },
  });

  await assert.rejects(
    () => adapter.embed('x'),
    (err) => {
      assert.equal(err.code, 'ERR-MODEL-002');
      assert.equal(err.name, 'ModelError');
      assert.match(err.message, /cohere/i);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('CohereAdapter does NOT retry on non-retryable 401', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    embed: async () => {
      calls += 1;
      const err = new Error('unauthorized');
      err.statusCode = 401;
      throw err;
    },
  });

  await assert.rejects(() => adapter.embed('x'), { code: 'ERR-MODEL-002' });
  assert.equal(calls, 1);
});

test('CohereAdapter.getInfo returns correct dimensions for embed-english-v3.0', () => {
  const adapter = makeAdapter({ model: 'embed-english-v3.0', embed: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.name, 'embed-english-v3.0');
  assert.equal(info.type, 'cloud');
  assert.equal(info.provider, 'cohere');
  assert.equal(info.dimensions, 1024);
});

test('CohereAdapter.getInfo returns correct dimensions for embed-multilingual-v3.0', () => {
  const adapter = makeAdapter({ model: 'embed-multilingual-v3.0', embed: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.dimensions, 1024);
});

test('CohereAdapter throws on construction with missing apiKey', () => {
  assert.throws(
    () => new CohereAdapter({ model: 'embed-english-v3.0' }),
    /apiKey/i,
  );
});

test('CohereAdapter throws on construction with unknown model', () => {
  assert.throws(
    () => new CohereAdapter({ apiKey: 'k', model: 'embed-french-v0.0' }),
    /unknown.*model/i,
  );
});
