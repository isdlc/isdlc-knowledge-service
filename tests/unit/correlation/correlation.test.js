// T017: Correlation Engine — unit tests for strategies and engine.
// Traces: FR-002 (AC-002-01, AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 5

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correlate, CONFIDENCE } from '../../../src/correlation/index.js';
import {
  pathNameStrategy,
  importGraphStrategy,
  traceCommentStrategy,
  confluenceTitleStrategy,
  ALL_STRATEGIES,
} from '../../../src/correlation/strategies.js';

/**
 * Build a NormalisedChunk-shaped fixture with sensible defaults.
 */
function chunk(overrides = {}) {
  return {
    content: '',
    path: '',
    source_type: 'git',
    source_url: 'https://example.com/x',
    last_modified: '2026-04-25T00:00:00Z',
    metadata: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Public API contract                                                */
/* ------------------------------------------------------------------ */

test('correlate() returns [] for empty input', async () => {
  const out = await correlate([]);
  assert.deepEqual(out, []);
});

test('correlate() tolerates non-array input by returning []', async () => {
  const out = await correlate(/** @type {any} */ (null));
  assert.deepEqual(out, []);
});

test('correlate() preserves input order and adds empty related[] when no matches', async () => {
  const input = [
    chunk({ path: 'src/alpha.js', content: 'export const a = 1;' }),
    chunk({ path: 'docs/unrelated.md', content: '# Nothing here' }),
  ];
  const out = await correlate(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].path, 'src/alpha.js');
  assert.equal(out[1].path, 'docs/unrelated.md');
  assert.deepEqual(out[0].related, []);
  assert.deepEqual(out[1].related, []);
});

test('correlate() exposes CONFIDENCE constants for downstream tuning', () => {
  assert.equal(typeof CONFIDENCE.PATH_NAME, 'number');
  assert.equal(CONFIDENCE.TRACE_COMMENT, 0.95);
  assert.equal(CONFIDENCE.PATH_NAME, 0.9);
  assert.equal(CONFIDENCE.IMPORT_GRAPH, 0.8);
  assert.equal(CONFIDENCE.CONFLUENCE_TITLE, 0.6);
});

test('ALL_STRATEGIES exports four pluggable strategies', () => {
  assert.equal(ALL_STRATEGIES.length, 4);
  for (const s of ALL_STRATEGIES) assert.equal(typeof s, 'function');
});

/* ------------------------------------------------------------------ */
/* Strategy: path/name matching                                       */
/* ------------------------------------------------------------------ */

test('pathNameStrategy links foo.js ↔ foo.test.js', () => {
  const chunks = [
    chunk({ path: 'src/foo.js' }),
    chunk({ path: 'tests/foo.test.js' }),
  ];
  const links = pathNameStrategy(chunks);
  // Bidirectional: 0→1 and 1→0
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.equal(l.confidence, 0.9);
  }
  // The link pointing at the .test.js file is classified as 'test'.
  const toTest = links.find((l) => l.to_id === 1);
  assert.equal(toTest.relationship, 'test');
});

test('pathNameStrategy links payment.md ↔ payment.js (doc/impl)', () => {
  const chunks = [
    chunk({ path: 'docs/payment.md' }),
    chunk({ path: 'src/payment.js' }),
  ];
  const links = pathNameStrategy(chunks);
  assert.equal(links.length, 2);
  const docToImpl = links.find((l) => l.from_id === 0 && l.to_id === 1);
  const implToDoc = links.find((l) => l.from_id === 1 && l.to_id === 0);
  assert.equal(docToImpl.relationship, 'impl');
  assert.equal(implToDoc.relationship, 'doc');
});

test('pathNameStrategy handles test_ prefix and -spec suffix variants', () => {
  const chunks = [
    chunk({ path: 'src/widget.py' }),
    chunk({ path: 'tests/test_widget.py' }),
    chunk({ path: 'src/widget-spec.py' }),
  ];
  const links = pathNameStrategy(chunks);
  // All three share canonical stem 'widget' → 3*2 = 6 directed links.
  assert.equal(links.length, 6);
});

test('pathNameStrategy emits no link when only one chunk shares a stem', () => {
  const chunks = [chunk({ path: 'src/lonely.js' })];
  assert.deepEqual(pathNameStrategy(chunks), []);
});

/* ------------------------------------------------------------------ */
/* Strategy: import graph                                             */
/* ------------------------------------------------------------------ */

test('importGraphStrategy links a JS module to its relative ES import', () => {
  const chunks = [
    chunk({
      path: 'src/a.js',
      content: "import { b } from './b.js';\nexport const a = () => b();",
    }),
    chunk({ path: 'src/b.js', content: 'export const b = () => 42;' }),
  ];
  const links = importGraphStrategy(chunks);
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], {
    from_id: 0,
    to_id: 1,
    relationship: 'impl',
    confidence: 0.8,
  });
});

test('importGraphStrategy resolves a relative import without explicit extension', () => {
  const chunks = [
    chunk({
      path: 'src/a.js',
      content: "import { b } from './b';",
    }),
    chunk({ path: 'src/b.js', content: 'export const b = 1;' }),
  ];
  const links = importGraphStrategy(chunks);
  assert.equal(links.length, 1);
  assert.equal(links[0].to_id, 1);
});

test('importGraphStrategy handles CJS require() and bare side-effect imports', () => {
  const chunks = [
    chunk({
      path: 'src/a.js',
      content: "const x = require('./x');\nimport './side-effect.js';",
    }),
    chunk({ path: 'src/x.js', content: 'module.exports = 1;' }),
    chunk({ path: 'src/side-effect.js', content: 'globalThis.foo = 1;' }),
  ];
  const links = importGraphStrategy(chunks);
  const targets = links.map((l) => l.to_id).sort();
  assert.deepEqual(targets, [1, 2]);
});

test('importGraphStrategy handles Python from/import', () => {
  const chunks = [
    chunk({ path: 'pkg/a.py', content: 'from .b import thing\nimport pkg.c' }),
    chunk({ path: 'pkg/b.py', content: 'thing = 1' }),
  ];
  const links = importGraphStrategy(chunks);
  assert.equal(links.length, 1);
  assert.equal(links[0].to_id, 1);
});

test('importGraphStrategy ignores package imports and self-imports', () => {
  const chunks = [
    chunk({
      path: 'src/a.js',
      content: "import React from 'react';\nimport x from './a.js';",
    }),
  ];
  const links = importGraphStrategy(chunks);
  // 'react' has no chunk; './a.js' would be a self-import → skipped.
  assert.deepEqual(links, []);
});

/* ------------------------------------------------------------------ */
/* Strategy: trace comments                                           */
/* ------------------------------------------------------------------ */

test('traceCommentStrategy links code commenting "traces: FR-002" to a spec doc', () => {
  const chunks = [
    chunk({
      path: 'src/pipeline.js',
      content: '// traces: FR-002\nexport const pipeline = () => null;',
    }),
    chunk({
      path: 'docs/requirements/FR-002-pipeline.md',
      content: '# FR-002 spec',
    }),
  ];
  const links = traceCommentStrategy(chunks);
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], {
    from_id: 0,
    to_id: 1,
    relationship: 'spec',
    confidence: 0.95,
  });
});

test('traceCommentStrategy detects REQ-IDs in Python and HTML comment styles', () => {
  const chunks = [
    chunk({
      path: 'src/x.py',
      content: '# traces: REQ-GH-263\nx = 1',
    }),
    chunk({
      path: 'docs/requirements/REQ-GH-263-spec.md',
      content: '<!-- traces: REQ-GH-263 -->\n# Spec',
    }),
  ];
  const links = traceCommentStrategy(chunks);
  // Both chunks mention REQ-GH-263 in content. Only the doc is a definer.
  // src/x.py mentions it → links to doc.
  // doc mentions it too but cannot link to itself.
  assert.equal(links.length, 1);
  assert.equal(links[0].from_id, 0);
  assert.equal(links[0].to_id, 1);
});

test('traceCommentStrategy emits no link when no spec defines the id', () => {
  const chunks = [
    chunk({
      path: 'src/x.js',
      content: '// traces: FR-999',
    }),
  ];
  assert.deepEqual(traceCommentStrategy(chunks), []);
});

/* ------------------------------------------------------------------ */
/* Strategy: Confluence title ↔ module                                */
/* ------------------------------------------------------------------ */

test('confluenceTitleStrategy links a page titled "Payments Service" to src/payments/* code', () => {
  const chunks = [
    chunk({
      source_type: 'confluence',
      path: 'space/Payments-Service',
      content: 'Page body',
      metadata: { title: 'Payments Service' },
    }),
    chunk({ path: 'src/payments/charge.js', content: 'export const charge = () => 0;' }),
    chunk({ path: 'src/payments/refund.js', content: 'export const refund = () => 0;' }),
    chunk({ path: 'src/auth/login.js', content: 'export const login = () => 0;' }),
  ];
  const links = confluenceTitleStrategy(chunks);
  // Bidirectional links page ↔ each of the two payments files = 4 links.
  assert.equal(links.length, 4);
  for (const l of links) {
    assert.equal(l.confidence, 0.6);
    assert.equal(l.relationship, 'doc');
  }
  // No link should target src/auth/* (id 3).
  assert.equal(
    links.some((l) => l.from_id === 3 || l.to_id === 3),
    false,
  );
});

test('confluenceTitleStrategy uses word boundaries (no "auth" matching "author")', () => {
  const chunks = [
    chunk({
      source_type: 'confluence',
      path: 'space/Author-Guide',
      metadata: { title: 'Author Guide' },
    }),
    chunk({ path: 'src/auth/login.js', content: '' }),
  ];
  assert.deepEqual(confluenceTitleStrategy(chunks), []);
});

test('confluenceTitleStrategy ignores non-confluence chunks', () => {
  const chunks = [
    chunk({
      source_type: 'git',
      path: 'docs/payments.md',
      metadata: { title: 'Payments Service' },
    }),
    chunk({ path: 'src/payments/charge.js' }),
  ];
  assert.deepEqual(confluenceTitleStrategy(chunks), []);
});

/* ------------------------------------------------------------------ */
/* Engine: dedup, confidence ranking, related[] attachment            */
/* ------------------------------------------------------------------ */

test('correlate() dedupes overlapping links from multiple strategies, keeping highest confidence', async () => {
  // foo.js ↔ foo.test.js will be matched by pathNameStrategy (0.9).
  // The test file also imports foo.js → importGraphStrategy emits 0.8.
  // Final dedup must keep 0.9 (higher confidence).
  const chunks = [
    chunk({ path: 'src/foo.js', content: 'export const foo = () => 1;' }),
    chunk({
      path: 'tests/foo.test.js',
      content: "import { foo } from '../src/foo.js';\nfoo();",
    }),
  ];
  const out = await correlate(chunks);
  // Each related entry is unique per (target_path, relationship); the
  // 1→0 edge appears as both path-name (impl, 0.9) and import-graph
  // (impl, 0.8) → dedup keeps the 0.9 version exactly once.
  const fromTest = out[1].related.filter(
    (r) => r.path === 'src/foo.js' && r.relationship === 'impl',
  );
  assert.equal(fromTest.length, 1);
  assert.equal(fromTest[0].confidence, 0.9);
});

test('correlate() ranks related[] by descending confidence', async () => {
  // src/x.js will pick up two distinct related sources:
  //   - tests/x.test.js via path-name (0.9)
  //   - confluence "X Module" page via title strategy (0.6, but x.js is in
  //     module 'x'? — its directory is 'src', not 'src/x'. Use a clearer
  //     example below.)
  //
  // Construct: src/payments/charge.js
  //   • path-name match → tests/charge.test.js  (0.9)
  //   • trace-comment   → docs/requirements/FR-002.md (0.95)
  //   • confluence      → "Payments Service" page (0.6)
  const chunks = [
    chunk({
      path: 'src/payments/charge.js',
      content: '// traces: FR-002\nexport const charge = () => 1;',
    }),
    chunk({ path: 'tests/charge.test.js', content: 'test charge' }),
    chunk({
      path: 'docs/requirements/FR-002-pipeline.md',
      content: '# FR-002 spec',
    }),
    chunk({
      source_type: 'confluence',
      path: 'space/Payments',
      metadata: { title: 'Payments Service' },
    }),
  ];
  const out = await correlate(chunks);
  const charge = out[0];
  assert.ok(charge.related.length >= 3);
  // Confidences must be in non-increasing order.
  for (let i = 1; i < charge.related.length; i++) {
    assert.ok(
      charge.related[i - 1].confidence >= charge.related[i].confidence,
      `related[${i - 1}] (${charge.related[i - 1].confidence}) should be >= related[${i}] (${charge.related[i].confidence})`,
    );
  }
  // Top result must be the trace-comment match (0.95).
  assert.equal(charge.related[0].confidence, 0.95);
  assert.equal(charge.related[0].relationship, 'spec');
});

test('correlate() output shape — each chunk has spread fields plus related[]', async () => {
  const input = [
    chunk({ path: 'src/a.js', source_url: 'git://repo/a' }),
    chunk({ path: 'src/a.test.js', source_url: 'git://repo/a.test' }),
  ];
  const out = await correlate(input);
  assert.equal(out[0].path, 'src/a.js');
  assert.equal(out[0].source_url, 'git://repo/a');
  assert.equal(typeof out[0].metadata, 'object');
  assert.ok(Array.isArray(out[0].related));
  // related entries carry the four required fields.
  for (const r of out[0].related) {
    assert.equal(typeof r.path, 'string');
    assert.equal(typeof r.source_type, 'string');
    assert.match(r.relationship, /^(spec|test|doc|impl)$/);
    assert.equal(typeof r.confidence, 'number');
  }
});

test('correlate() does not emit self-links and ignores invalid link ids', async () => {
  // Two distinct chunks with the same canonical stem but identical paths
  // should NOT generate a self-link (the strategy guards against that).
  const chunks = [
    chunk({ path: 'src/foo.js', source_url: 'a' }),
    chunk({ path: 'src/foo.js', source_url: 'b', source_type: 'svn' }),
  ];
  const out = await correlate(chunks);
  // Different source_type → still cross-linked exactly once each direction.
  assert.equal(out[0].related.length, 1);
  assert.equal(out[1].related.length, 1);
  assert.notEqual(out[0].related[0].source_type, out[0].source_type);
});
