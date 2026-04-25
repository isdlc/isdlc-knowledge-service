// T018: Embedding Pipeline — enricher unit tests.
// Traces: FR-002 (AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6
//      docs/requirements/REQ-GH-263-.../test-strategy.md (UT-012)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrich } from '../../../src/pipeline/enricher.js';

function makeChunk(overrides = {}) {
  return {
    content: 'export function pay() { return 1; }',
    path: 'src/payments.js',
    source_type: 'git',
    source_url: 'https://example.com/repo/src/payments.js',
    last_modified: '2026-04-25T00:00:00Z',
    metadata: { project: 'payments-2.7' },
    related: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Preamble inclusion (AC-002-02 / AC-002-04)                         */
/* ------------------------------------------------------------------ */

test('enrich() prepends a relationship preamble to chunk text', () => {
  const chunk = makeChunk();
  const out = enrich(chunk, 'export function pay() { return 1; }');
  assert.ok(typeof out === 'string');
  assert.ok(out.startsWith('['), 'preamble should start with `[`');
  assert.ok(out.includes(']\n\n'), 'preamble should be terminated by `]\\n\\n`');
  assert.ok(out.endsWith('export function pay() { return 1; }'));
});

test('enrich() includes project, source_type, and path tokens in the preamble', () => {
  const chunk = makeChunk();
  const out = enrich(chunk, chunk.content);
  assert.ok(out.includes('Project: payments-2.7'), 'project missing');
  assert.ok(out.includes('Source: git'), 'source_type missing');
  assert.ok(out.includes('Path: src/payments.js'), 'path missing');
});

test('enrich() omits the project field when not provided (uses "unknown")', () => {
  const chunk = makeChunk({ metadata: {} });
  const out = enrich(chunk, chunk.content);
  // The preamble must still be valid; project falls back to a sentinel.
  assert.ok(out.startsWith('['));
  assert.ok(out.includes('Project: unknown'));
});

test('enrich() respects an explicit project option over chunk.metadata.project', () => {
  const chunk = makeChunk({ metadata: { project: 'payments-2.7' } });
  const out = enrich(chunk, chunk.content, { project: 'payments-3.0' });
  assert.ok(out.includes('Project: payments-3.0'));
  assert.ok(!out.includes('Project: payments-2.7'));
});

/* ------------------------------------------------------------------ */
/* Related sources rendering                                          */
/* ------------------------------------------------------------------ */

test('enrich() handles missing related[] gracefully', () => {
  const chunk = makeChunk({ related: undefined });
  const out = enrich(chunk, chunk.content);
  // Either no Related token, or one with an empty body — both are acceptable.
  assert.ok(out.startsWith('['));
  assert.ok(out.endsWith(chunk.content));
});

test('enrich() handles empty related[] gracefully', () => {
  const chunk = makeChunk({ related: [] });
  const out = enrich(chunk, chunk.content);
  // No Related: section needed; the preamble must still be well-formed.
  assert.ok(out.startsWith('['));
  assert.ok(out.endsWith(chunk.content));
});

test('enrich() lists multiple related sources in the preamble', () => {
  const chunk = makeChunk({
    related: [
      { path: 'docs/payments.md', source_type: 'git', relationship: 'doc', confidence: 0.9 },
      {
        path: 'tests/payments.test.js',
        source_type: 'git',
        relationship: 'test',
        confidence: 0.95,
      },
    ],
  });
  const out = enrich(chunk, chunk.content);
  assert.ok(out.includes('Related:'), 'Related: token should appear');
  assert.ok(out.includes('docs/payments.md'));
  assert.ok(out.includes('tests/payments.test.js'));
});

test('enrich() orders related sources by confidence descending', () => {
  const chunk = makeChunk({
    related: [
      { path: 'docs/low.md', source_type: 'git', relationship: 'doc', confidence: 0.6 },
      { path: 'tests/high.test.js', source_type: 'git', relationship: 'test', confidence: 0.95 },
      { path: 'docs/mid.md', source_type: 'git', relationship: 'doc', confidence: 0.8 },
    ],
  });
  const out = enrich(chunk, chunk.content);
  // The high-confidence path should appear before the low-confidence one.
  const idxHigh = out.indexOf('tests/high.test.js');
  const idxMid = out.indexOf('docs/mid.md');
  const idxLow = out.indexOf('docs/low.md');
  assert.ok(idxHigh > 0, 'high path missing');
  assert.ok(idxMid > 0, 'mid path missing');
  assert.ok(idxLow > 0, 'low path missing');
  assert.ok(idxHigh < idxMid && idxMid < idxLow, 'related list must be sorted by confidence desc');
});

test('enrich() includes the relationship and confidence next to each related path', () => {
  const chunk = makeChunk({
    related: [
      { path: 'docs/payments.md', source_type: 'git', relationship: 'doc', confidence: 0.9 },
    ],
  });
  const out = enrich(chunk, chunk.content);
  assert.ok(out.includes('doc'), 'relationship label missing');
  assert.ok(out.includes('0.9'), 'confidence value missing');
});

/* ------------------------------------------------------------------ */
/* Subchunk text vs full content                                      */
/* ------------------------------------------------------------------ */

test('enrich() uses the supplied sub-chunk text, not the parent chunk content', () => {
  const chunk = makeChunk({ content: 'PARENT_FULL_CONTENT' });
  const out = enrich(chunk, 'JUST_A_SLICE');
  assert.ok(out.endsWith('JUST_A_SLICE'));
  assert.ok(!out.includes('PARENT_FULL_CONTENT'));
});
