// T018: Embedding Pipeline — end-to-end orchestration tests.
// Traces: FR-002 (AC-002-01, AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6
//      docs/requirements/REQ-GH-263-.../test-strategy.md (UT-100, FR-002 mapping)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { embed } from '../../../src/pipeline/index.js';

/* ------------------------------------------------------------------ */
/* Test seam: a fake ModelAdapter with deterministic vectors          */
/* ------------------------------------------------------------------ */

function deterministicVector(text, dim = 8) {
  const h = createHash('sha256').update(String(text)).digest();
  const vec = new Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = h[i] / 255;
  return vec;
}

function makeFakeAdapter(opts = {}) {
  const dim = opts.dimensions ?? 8;
  const max_input_tokens = opts.max_input_tokens ?? 32;
  const calls = { embed: [], batchEmbed: [] };
  return {
    calls,
    async embed(text) {
      calls.embed.push(text);
      return deterministicVector(text, dim);
    },
    async batchEmbed(texts) {
      calls.batchEmbed.push(texts.slice());
      return texts.map((t) => deterministicVector(t, dim));
    },
    getInfo() {
      return {
        name: 'fake',
        type: 'local',
        dimensions: dim,
        max_input_tokens,
      };
    },
  };
}

function makeCorrelatedChunk(overrides = {}) {
  return {
    content:
      'Payment processing module. Handles charge, refund, and reconcile flows. ' +
      'Integrates with the audit log and the notification service.',
    path: 'src/payments.js',
    source_type: 'git',
    source_url: 'https://example.com/repo/src/payments.js',
    last_modified: '2026-04-25T00:00:00Z',
    metadata: { project: 'payments-2.7' },
    related: [
      { path: 'docs/payments.md', source_type: 'git', relationship: 'doc', confidence: 0.9 },
    ],
    ...overrides,
  };
}

async function collect(asyncIter) {
  const out = [];
  for await (const x of asyncIter) out.push(x);
  return out;
}

/* ------------------------------------------------------------------ */
/* Empty / trivial inputs                                             */
/* ------------------------------------------------------------------ */

test('embed() yields nothing for empty input array', async () => {
  const adapter = makeFakeAdapter();
  const out = await collect(embed([], adapter));
  assert.deepEqual(out, []);
});

test('embed() tolerates non-array input by yielding nothing', async () => {
  const adapter = makeFakeAdapter();
  const out = await collect(embed(/** @type {any} */ (null), adapter));
  assert.deepEqual(out, []);
});

test('embed() skips chunks with empty content', async () => {
  const adapter = makeFakeAdapter();
  const chunks = [makeCorrelatedChunk({ content: '' }), makeCorrelatedChunk({ content: '   ' })];
  const out = await collect(embed(chunks, adapter));
  assert.deepEqual(out, []);
  assert.equal(adapter.calls.batchEmbed.length, 0);
});

/* ------------------------------------------------------------------ */
/* Output shape                                                       */
/* ------------------------------------------------------------------ */

test('embed() yields EmbeddedChunks with the documented shape', async () => {
  const adapter = makeFakeAdapter({ max_input_tokens: 4096 });
  const chunks = [makeCorrelatedChunk()];
  const out = await collect(embed(chunks, adapter));
  assert.equal(out.length, 1);
  const e = out[0];
  assert.equal(typeof e.id, 'string');
  assert.ok(e.id.length > 0);
  assert.ok(Array.isArray(e.vector));
  assert.equal(e.vector.length, 8);
  assert.equal(typeof e.content, 'string');
  assert.ok(e.content.length > 0);
  assert.equal(typeof e.metadata, 'object');
  assert.ok(Array.isArray(e.related_sources));
});

test('EmbeddedChunk preserves related_sources from CorrelatedChunk.related[]', async () => {
  const adapter = makeFakeAdapter({ max_input_tokens: 4096 });
  const related = [
    { path: 'docs/x.md', source_type: 'git', relationship: 'doc', confidence: 0.9 },
    { path: 'tests/x.test.js', source_type: 'git', relationship: 'test', confidence: 0.95 },
  ];
  const chunks = [makeCorrelatedChunk({ related })];
  const out = await collect(embed(chunks, adapter));
  assert.equal(out.length, 1);
  // related_sources is a faithful pass-through (same length, same paths).
  assert.equal(out[0].related_sources.length, related.length);
  const paths = out[0].related_sources.map((r) => r.path).sort();
  assert.deepEqual(paths, related.map((r) => r.path).sort());
});

test('EmbeddedChunk metadata includes path, source_type, and source_url from the parent chunk', async () => {
  const adapter = makeFakeAdapter();
  const chunks = [makeCorrelatedChunk()];
  const out = await collect(embed(chunks, adapter));
  assert.equal(out[0].metadata.path, 'src/payments.js');
  assert.equal(out[0].metadata.source_type, 'git');
  assert.equal(out[0].metadata.source_url, 'https://example.com/repo/src/payments.js');
});

/* ------------------------------------------------------------------ */
/* Stable IDs (idempotency keystone — Constitution Article VI.2)      */
/* ------------------------------------------------------------------ */

test('embed() produces stable IDs across multiple runs on the same input', async () => {
  const adapter1 = makeFakeAdapter();
  const adapter2 = makeFakeAdapter();
  const a = await collect(embed([makeCorrelatedChunk()], adapter1));
  const b = await collect(embed([makeCorrelatedChunk()], adapter2));
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].id, b[i].id, `chunk ${i} ID mismatch`);
  }
});

test('embed() produces distinct IDs for distinct (project, path, chunkIndex)', async () => {
  const adapter = makeFakeAdapter();
  const a = await collect(embed([makeCorrelatedChunk({ path: 'src/a.js' })], adapter));
  const b = await collect(embed([makeCorrelatedChunk({ path: 'src/b.js' })], adapter));
  assert.notEqual(a[0].id, b[0].id, 'different paths → different IDs');

  const c = await collect(
    embed([makeCorrelatedChunk({ metadata: { project: 'other' } })], adapter),
  );
  assert.notEqual(a[0].id, c[0].id, 'different projects → different IDs');
});

test('embed() ID format is 16 lowercase hex characters', async () => {
  const adapter = makeFakeAdapter();
  const out = await collect(embed([makeCorrelatedChunk()], adapter));
  assert.ok(/^[a-f0-9]{16}$/.test(out[0].id), `unexpected id format: ${out[0].id}`);
});

/* ------------------------------------------------------------------ */
/* Multi-chunk content & batchEmbed wiring                            */
/* ------------------------------------------------------------------ */

test('embed() splits long content into multiple sub-chunks each with its own ID', async () => {
  // max_input_tokens=8 → maxChars=32 → forces splitting.
  const adapter = makeFakeAdapter({ max_input_tokens: 8 });
  const long = 'x'.repeat(200);
  const chunks = [makeCorrelatedChunk({ content: long })];
  const out = await collect(embed(chunks, adapter));
  assert.ok(out.length >= 4, `expected multiple sub-chunks, got ${out.length}`);
  // IDs are unique within a single parent chunk.
  const ids = new Set(out.map((e) => e.id));
  assert.equal(ids.size, out.length);
});

test('embed() forwards enriched (preamble-prefixed) text to modelAdapter.batchEmbed', async () => {
  const adapter = makeFakeAdapter();
  const chunks = [
    makeCorrelatedChunk({
      related: [
        { path: 'docs/payments.md', source_type: 'git', relationship: 'doc', confidence: 0.9 },
      ],
    }),
  ];
  await collect(embed(chunks, adapter));
  assert.equal(adapter.calls.batchEmbed.length, 1, 'batchEmbed should be called once per chunk');
  const batch = adapter.calls.batchEmbed[0];
  assert.ok(Array.isArray(batch) && batch.length >= 1);
  for (const t of batch) {
    assert.ok(t.startsWith('['), 'batchEmbed text should start with the preamble bracket');
    assert.ok(t.includes('Project: payments-2.7'));
    assert.ok(t.includes('Path: src/payments.js'));
    assert.ok(t.includes('docs/payments.md'), 'related sources must be in the enriched text');
  }
});

test('embed() preserves the enriched text in EmbeddedChunk.content', async () => {
  const adapter = makeFakeAdapter();
  const chunks = [makeCorrelatedChunk()];
  const out = await collect(embed(chunks, adapter));
  // The stored content is the enriched text the model saw — this is what the
  // vector "represents" and what downstream display/citation will surface.
  assert.ok(out[0].content.startsWith('['));
  assert.ok(out[0].content.includes('Project: payments-2.7'));
});

test('embed() drives chunker max_tokens from modelAdapter.getInfo().max_input_tokens', async () => {
  // Tiny input limit → many sub-chunks.
  const tinyAdapter = makeFakeAdapter({ max_input_tokens: 4 });
  const looseAdapter = makeFakeAdapter({ max_input_tokens: 4096 });
  const content = 'y'.repeat(400);
  const chunks = [makeCorrelatedChunk({ content })];

  const tinyOut = await collect(embed([{ ...chunks[0] }], tinyAdapter));
  const looseOut = await collect(embed([{ ...chunks[0] }], looseAdapter));

  assert.ok(tinyOut.length > looseOut.length, 'smaller max_input_tokens → more sub-chunks');
  assert.equal(looseOut.length, 1, 'large window → single sub-chunk');
});

/* ------------------------------------------------------------------ */
/* Multi-input ordering                                               */
/* ------------------------------------------------------------------ */

test('embed() processes input chunks in order, in series', async () => {
  const adapter = makeFakeAdapter();
  const inputs = [
    makeCorrelatedChunk({ path: 'src/a.js', content: 'aaa first' }),
    makeCorrelatedChunk({ path: 'src/b.js', content: 'bbb second' }),
    makeCorrelatedChunk({ path: 'src/c.js', content: 'ccc third' }),
  ];
  const out = await collect(embed(inputs, adapter));
  assert.equal(out.length, 3);
  assert.equal(out[0].metadata.path, 'src/a.js');
  assert.equal(out[1].metadata.path, 'src/b.js');
  assert.equal(out[2].metadata.path, 'src/c.js');
});

/* ------------------------------------------------------------------ */
/* options.project override                                           */
/* ------------------------------------------------------------------ */

test('embed() honours options.project, overriding chunk.metadata.project', async () => {
  const adapter = makeFakeAdapter();
  const chunks = [makeCorrelatedChunk({ metadata: { project: 'should-be-overridden' } })];
  const out = await collect(embed(chunks, adapter, { project: 'payments-2.7' }));
  assert.ok(out[0].content.includes('Project: payments-2.7'));
  // ID is keyed on project — overriding should change it.
  const otherAdapter = makeFakeAdapter();
  const other = await collect(
    embed(chunks, otherAdapter, { project: 'payments-3.0' }),
  );
  assert.notEqual(out[0].id, other[0].id);
});

test('embed() falls back to "unknown" project when neither option nor metadata supplies one', async () => {
  const adapter = makeFakeAdapter();
  const chunks = [makeCorrelatedChunk({ metadata: {} })];
  const out = await collect(embed(chunks, adapter));
  assert.ok(out[0].content.includes('Project: unknown'));
});
