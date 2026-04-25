// T007: Amazon Bedrock Cloud Adapter unit tests
// Traces: FR-009, AC-009-03, ERR-MODEL-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md (ERR-MODEL-002)
//
// Mocking seam: the adapter constructor accepts `_clientFactory({ region, credentials })`
// returning an object whose `send(InvokeModelCommand) → { body: Uint8Array }` matches
// `@aws-sdk/client-bedrock-runtime` BedrockRuntimeClient. The body is a UTF-8 JSON
// payload whose shape depends on the model:
//   - amazon.titan-embed-* → { embedding: float[] }
//   - cohere.embed-*       → { embeddings: float[][] }
// Tests stub the factory and emit synthetic JSON bodies.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BedrockAdapter } from '../../../src/models/bedrock.js';

function bodyOf(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function makeAdapter({
  send,
  model = 'amazon.titan-embed-text-v2:0',
  backoffMs = [0, 0, 0],
} = {}) {
  const client = { send };
  return new BedrockAdapter({
    region: 'us-east-1',
    model,
    _clientFactory: () => client,
    _backoffMs: backoffMs,
  });
}

test('BedrockAdapter.embed (Titan) returns the embedding vector', async () => {
  const adapter = makeAdapter({
    send: async (command) => {
      assert.equal(command.input.modelId, 'amazon.titan-embed-text-v2:0');
      const body = JSON.parse(new TextDecoder().decode(command.input.body));
      assert.equal(body.inputText, 'hello');
      return { body: bodyOf({ embedding: [0.1, 0.2, 0.3] }) };
    },
  });

  const vec = await adapter.embed('hello');
  assert.deepEqual(vec, [0.1, 0.2, 0.3]);
});

test('BedrockAdapter.batchEmbed (Titan) issues one Invoke per input', async () => {
  let calls = 0;
  const responses = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const adapter = makeAdapter({
    send: async () => {
      const v = responses[calls];
      calls += 1;
      return { body: bodyOf({ embedding: v }) };
    },
  });

  const vecs = await adapter.batchEmbed(['a', 'b', 'c']);
  assert.equal(calls, 3);
  assert.deepEqual(vecs, responses);
});

test('BedrockAdapter.embed (Cohere on Bedrock) returns embeddings[0]', async () => {
  const adapter = makeAdapter({
    model: 'cohere.embed-english-v3',
    send: async (command) => {
      assert.equal(command.input.modelId, 'cohere.embed-english-v3');
      const body = JSON.parse(new TextDecoder().decode(command.input.body));
      assert.deepEqual(body.texts, ['hello']);
      return { body: bodyOf({ embeddings: [[7, 7, 7]] }) };
    },
  });

  const vec = await adapter.embed('hello');
  assert.deepEqual(vec, [7, 7, 7]);
});

test('BedrockAdapter retries on ThrottlingException then succeeds', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    send: async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('throttled');
        err.name = 'ThrottlingException';
        err.$metadata = { httpStatusCode: 429 };
        throw err;
      }
      return { body: bodyOf({ embedding: [9, 9, 9] }) };
    },
  });

  const vec = await adapter.embed('x');
  assert.deepEqual(vec, [9, 9, 9]);
  assert.equal(calls, 3);
});

test('BedrockAdapter retries on 5xx then succeeds', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    send: async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('server boom');
        err.$metadata = { httpStatusCode: 503 };
        throw err;
      }
      return { body: bodyOf({ embedding: [2, 2, 2] }) };
    },
  });

  const vec = await adapter.embed('x');
  assert.deepEqual(vec, [2, 2, 2]);
  assert.equal(calls, 3);
});

test('BedrockAdapter throws ModelError ERR-MODEL-002 after 3 failures', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    send: async () => {
      calls += 1;
      const err = new Error('throttled');
      err.name = 'ThrottlingException';
      err.$metadata = { httpStatusCode: 429 };
      throw err;
    },
  });

  await assert.rejects(
    () => adapter.embed('x'),
    (err) => {
      assert.equal(err.code, 'ERR-MODEL-002');
      assert.equal(err.name, 'ModelError');
      assert.match(err.message, /bedrock/i);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('BedrockAdapter does NOT retry on AccessDeniedException (4xx non-429)', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    send: async () => {
      calls += 1;
      const err = new Error('denied');
      err.name = 'AccessDeniedException';
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    },
  });

  await assert.rejects(() => adapter.embed('x'), { code: 'ERR-MODEL-002' });
  assert.equal(calls, 1);
});

test('BedrockAdapter.getInfo for amazon.titan-embed-text-v1 → 1536 dim', () => {
  const adapter = makeAdapter({ model: 'amazon.titan-embed-text-v1', send: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.name, 'amazon.titan-embed-text-v1');
  assert.equal(info.type, 'cloud');
  assert.equal(info.provider, 'bedrock');
  assert.equal(info.dimensions, 1536);
});

test('BedrockAdapter.getInfo for amazon.titan-embed-text-v2:0 → 1024 dim', () => {
  const adapter = makeAdapter({ model: 'amazon.titan-embed-text-v2:0', send: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.dimensions, 1024);
});

test('BedrockAdapter.getInfo for cohere.embed-english-v3 → 1024 dim', () => {
  const adapter = makeAdapter({ model: 'cohere.embed-english-v3', send: async () => ({}) });
  const info = adapter.getInfo();
  assert.equal(info.dimensions, 1024);
});

test('BedrockAdapter throws on construction with missing region', () => {
  assert.throws(
    () => new BedrockAdapter({ model: 'amazon.titan-embed-text-v2:0' }),
    /region/i,
  );
});

test('BedrockAdapter throws on construction with unknown model', () => {
  assert.throws(
    () => new BedrockAdapter({ region: 'us-east-1', model: 'no-such' }),
    /unknown.*model/i,
  );
});
