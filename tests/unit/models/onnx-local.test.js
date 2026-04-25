// T006: OnnxLocalAdapter — unit tests
// Traces: FR-002, FR-009 (AC-009-01, AC-009-02), ERR-MODEL-001, ERR-MODEL-003
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      src/models/onnx-local.js
//
// Mock strategy: we never load a real ONNX file. Instead we inject a
// `sessionLoader` that returns a fake session whose .run() returns canned
// output tensors. This keeps the tests fast and CI-deterministic per the
// task spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OnnxLocalAdapter } from '../../../src/models/onnx-local.js';
import { ModelError } from '../../../src/models/adapter.js';

/** Build a fake session whose .run() returns a [batch, dim] tensor. */
function fakeSessionWithPooledOutput(dim) {
  return {
    run: async (feeds) => {
      const batchSize = feeds.input_ids.dims[0];
      const data = new Float32Array(batchSize * dim);
      for (let i = 0; i < batchSize; i++) {
        for (let d = 0; d < dim; d++) data[i * dim + d] = i + d / 100;
      }
      return {
        sentence_embedding: { data, dims: [batchSize, dim] },
      };
    },
  };
}

/** Build a fake session whose .run() returns [batch, seq, dim] (mean-pooled by adapter). */
function fakeSessionWithTokenOutput(seq, dim) {
  return {
    run: async (feeds) => {
      const batchSize = feeds.input_ids.dims[0];
      const data = new Float32Array(batchSize * seq * dim);
      // Fill so each row's mean-pool is predictable: every sequence position equals 0.5
      for (let i = 0; i < data.length; i++) data[i] = 0.5;
      return {
        last_hidden_state: { data, dims: [batchSize, seq, dim] },
      };
    },
  };
}

function tmpModelFile() {
  const dir = mkdtempSync(join(tmpdir(), 'isdlc-onnx-test-'));
  const path = join(dir, 'model.onnx');
  writeFileSync(path, 'fake'); // adapter only checks existsSync; loader is mocked
  return { dir, path };
}

test('constructor: requires modelPath and a valid precision', () => {
  assert.throws(
    () => new OnnxLocalAdapter({ precision: 'fp16' }),
    /modelPath is required/,
  );
  assert.throws(
    () => new OnnxLocalAdapter({ modelPath: '/x.onnx', precision: 'fp8' }),
    TypeError,
  );
});

test('getInfo records the configured precision (AC-009-02) for fp4/fp16/fp32', () => {
  const { dir, path } = tmpModelFile();
  try {
    for (const p of ['fp4', 'fp16', 'fp32']) {
      const a = new OnnxLocalAdapter({
        modelPath: path,
        precision: p,
        dimensions: 4,
        sessionLoader: async () => fakeSessionWithPooledOutput(4),
      });
      const info = a.getInfo();
      assert.equal(info.type, 'local');
      assert.equal(info.precision, p);
      assert.equal(info.dimensions, 4);
      assert.equal(typeof info.memory_mb, 'number');
      assert.equal(typeof info.max_input_tokens, 'number');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embed: returns a vector of the model dimensions and lazy-loads the session once', async () => {
  const { dir, path } = tmpModelFile();
  let loadCalls = 0;
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp16',
    dimensions: 8,
    sessionLoader: async () => {
      loadCalls++;
      return fakeSessionWithPooledOutput(8);
    },
  });
  try {
    const v1 = await adapter.embed('hello world');
    assert.equal(Array.isArray(v1), true);
    assert.equal(v1.length, 8);
    assert.equal(typeof v1[0], 'number');

    // Second call must reuse the loaded session.
    const v2 = await adapter.embed('again');
    assert.equal(v2.length, 8);
    assert.equal(loadCalls, 1, 'session loader must be called exactly once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batchEmbed: returns N vectors in a single session.run call', async () => {
  const { dir, path } = tmpModelFile();
  let runCalls = 0;
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp32',
    dimensions: 4,
    sessionLoader: async () => ({
      run: async (feeds) => {
        runCalls++;
        const batchSize = feeds.input_ids.dims[0];
        const data = new Float32Array(batchSize * 4);
        return { sentence_embedding: { data, dims: [batchSize, 4] } };
      },
    }),
  });
  try {
    const out = await adapter.batchEmbed(['a', 'bb', 'ccc']);
    assert.equal(out.length, 3);
    assert.equal(out[0].length, 4);
    assert.equal(out[1].length, 4);
    assert.equal(out[2].length, 4);
    assert.equal(runCalls, 1, 'batchEmbed must use a single session.run call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batchEmbed: handles [batch, seq, dim] outputs by mean-pooling tokens', async () => {
  const { dir, path } = tmpModelFile();
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp16',
    dimensions: 3,
    sessionLoader: async () => fakeSessionWithTokenOutput(5, 3),
  });
  try {
    const out = await adapter.batchEmbed(['x', 'y']);
    assert.equal(out.length, 2);
    assert.equal(out[0].length, 3);
    // Mean-pool of 0.5 across the sequence is 0.5.
    for (const row of out) for (const v of row) assert.equal(v, 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embed/batchEmbed: validate inputs (non-empty string / array)', async () => {
  const { dir, path } = tmpModelFile();
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp16',
    sessionLoader: async () => fakeSessionWithPooledOutput(4),
  });
  try {
    await assert.rejects(() => adapter.embed(''), TypeError);
    await assert.rejects(() => adapter.embed(123), TypeError);
    await assert.rejects(() => adapter.batchEmbed([]), TypeError);
    await assert.rejects(() => adapter.batchEmbed('x'), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERR-MODEL-003: missing model file throws ModelError with code ERR-MODEL-003', async () => {
  const adapter = new OnnxLocalAdapter({
    modelPath: '/no/such/path/missing.onnx',
    precision: 'fp16',
    sessionLoader: async () => {
      throw new Error('should not be called when file is missing');
    },
  });
  await assert.rejects(
    () => adapter.embed('hi'),
    (err) => {
      assert.ok(err instanceof ModelError, 'must be ModelError');
      assert.equal(err.code, 'ERR-MODEL-003');
      return true;
    },
  );
});

test('ERR-MODEL-001: corrupt session load throws ModelError with code ERR-MODEL-001 and preserves cause', async () => {
  const { dir, path } = tmpModelFile();
  const cause = new Error('protobuf parse error');
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp32',
    sessionLoader: async () => {
      throw cause;
    },
  });
  try {
    await assert.rejects(
      () => adapter.embed('hi'),
      (err) => {
        assert.ok(err instanceof ModelError);
        assert.equal(err.code, 'ERR-MODEL-001');
        assert.equal(err.cause, cause);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERR-MODEL-001: session.run failure also surfaces as ERR-MODEL-001', async () => {
  const { dir, path } = tmpModelFile();
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp16',
    dimensions: 4,
    sessionLoader: async () => ({
      run: async () => {
        throw new Error('runtime crash');
      },
    }),
  });
  try {
    await assert.rejects(
      () => adapter.batchEmbed(['x']),
      (err) => {
        assert.equal(err.code, 'ERR-MODEL-001');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getMemoryUsage: returns precision-based estimate before load, RSS-based after load', async () => {
  const { dir, path } = tmpModelFile();
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp16',
    dimensions: 4,
    sessionLoader: async () => fakeSessionWithPooledOutput(4),
  });
  try {
    const before = adapter.getMemoryUsage();
    assert.equal(typeof before, 'number');
    assert.ok(before > 0);

    await adapter.embed('warm');
    const after = adapter.getMemoryUsage();
    assert.equal(typeof after, 'number');
    assert.ok(after > 0);

    const info = adapter.getInfo();
    assert.equal(info.memory_mb, after, 'getInfo.memory_mb must match getMemoryUsage when loaded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom tokenizer fn is called per-text and shapes the model feed', async () => {
  const { dir, path } = tmpModelFile();
  const calls = [];
  const tokenizer = (t) => {
    calls.push(t);
    return { input_ids: [1, 2, 3], attention_mask: [1, 1, 1] };
  };
  const adapter = new OnnxLocalAdapter({
    modelPath: path,
    precision: 'fp16',
    dimensions: 2,
    tokenizer,
    sessionLoader: async () => ({
      run: async (feeds) => {
        // Adapter should have built BigInt64Array feeds with dims [batch, 3].
        assert.deepEqual(feeds.input_ids.dims, [2, 3]);
        const data = new Float32Array(2 * 2);
        return { sentence_embedding: { data, dims: [2, 2] } };
      },
    }),
  });
  try {
    await adapter.batchEmbed(['alpha', 'beta']);
    assert.deepEqual(calls, ['alpha', 'beta']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
