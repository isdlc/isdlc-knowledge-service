// Unit tests for src/query/merger.js
// Traces: FR-006 (AC-006-03 tag by project, AC-006-04 merge across projects),
//         FR-008
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 2
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { merge, normalize } from '../../../src/query/merger.js';

const vr = (id, score, extra = {}) => ({
  id,
  score,
  content: extra.content ?? `c-${id}`,
  metadata: {
    source_type: extra.source_type ?? 'git',
    source_url: extra.source_url ?? `repo://${id}`,
    related_sources: extra.related_sources ?? [],
    ...extra.metadata,
  },
});

test('normalize: cosine in [0,1] is identity (clamped)', () => {
  assert.equal(normalize(0.0, 'cosine'), 0);
  assert.equal(normalize(0.5, 'cosine'), 0.5);
  assert.equal(normalize(1.0, 'cosine'), 1);
  assert.equal(normalize(1.5, 'cosine'), 1); // clamp
});

test('normalize: cosine in [-1,0) maps into [0,0.5)', () => {
  assert.equal(normalize(-1, 'cosine'), 0);
  assert.equal(normalize(-0.5, 'cosine'), 0.25);
});

test('normalize: l2 distance — smaller is better (0 → 1, larger → smaller)', () => {
  assert.equal(normalize(0, 'l2'), 1);
  assert.equal(normalize(1, 'l2'), 0.5);
  // monotonic decreasing
  assert.ok(normalize(2, 'l2') < normalize(1, 'l2'));
  assert.ok(normalize(10, 'l2') > 0);
});

test('normalize: dot product squashed via logistic, monotonic', () => {
  assert.equal(normalize(0, 'dot'), 0.5);
  assert.ok(normalize(5, 'dot') > normalize(1, 'dot'));
  assert.ok(normalize(-5, 'dot') < normalize(-1, 'dot'));
  // bounded into [0, 1]
  assert.ok(normalize(1000, 'dot') <= 1);
  assert.ok(normalize(-1000, 'dot') >= 0);
  assert.ok(normalize(1000, 'dot') > 0.99);
  assert.ok(normalize(-1000, 'dot') < 0.01);
});

test('normalize: unknown / missing metric falls back to cosine clamp', () => {
  assert.equal(normalize(0.7), 0.7);
  assert.equal(normalize(2, 'unknown'), 1);
  assert.equal(normalize(NaN, 'cosine'), 0);
});

test('merge: empty input returns []', () => {
  assert.deepEqual(merge({}), []);
  assert.deepEqual(merge(null), []);
  assert.deepEqual(merge(undefined), []);
});

test('merge: single project — tags every result with the project id (AC-006-03)', () => {
  const out = merge({
    repoA: { results: [vr('a1', 0.9), vr('a2', 0.5)], metric: 'cosine' },
  });
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.project, 'repoA');
    assert.ok(typeof r.score === 'number');
    assert.ok('related_sources' in r);
  }
});

test('merge: multi-project — every result tagged by source project (AC-006-03, AC-006-04)', () => {
  const out = merge({
    repoA: { results: [vr('a1', 0.9), vr('a2', 0.6)], metric: 'cosine' },
    repoB: { results: [vr('b1', 0.8)], metric: 'cosine' },
    repoC: { results: [vr('c1', 0.7)], metric: 'cosine' },
  });
  assert.equal(out.length, 4);
  const projectsSeen = new Set(out.map((r) => r.project));
  assert.deepEqual([...projectsSeen].sort(), ['repoA', 'repoB', 'repoC']);
});

test('merge: ranks by normalized score, descending', () => {
  const out = merge({
    repoA: { results: [vr('a1', 0.5), vr('a2', 0.9)], metric: 'cosine' },
    repoB: { results: [vr('b1', 0.7)], metric: 'cosine' },
  });
  const scores = out.map((r) => r.score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], `expected desc, got ${scores}`);
  }
  assert.equal(out[0].project, 'repoA');
  assert.equal(out[0].content, 'c-a2');
});

test('merge: trims to total_limit', () => {
  const many = Array.from({ length: 50 }, (_, i) => vr(`x${i}`, 1 - i * 0.01));
  const out = merge({ repoA: { results: many, metric: 'cosine' } }, { total_limit: 5 });
  assert.equal(out.length, 5);
});

test('merge: default total_limit is 30', () => {
  const many = Array.from({ length: 50 }, (_, i) => vr(`x${i}`, 1 - i * 0.01));
  const out = merge({ repoA: { results: many, metric: 'cosine' } });
  assert.equal(out.length, 30);
});

test('merge: normalises across heterogeneous metrics so a closer L2 outranks a low-cosine', () => {
  // L2 distance 0 should be the strongest match (normalized to 1.0); a cosine
  // 0.4 result should rank below it.
  const out = merge({
    repoL2: { results: [vr('l1', 0)], metric: 'l2' },
    repoCos: { results: [vr('c1', 0.4)], metric: 'cosine' },
  });
  assert.equal(out[0].project, 'repoL2');
  assert.ok(out[0].score >= out[1].score);
});

test('merge: preserves related_sources from metadata', () => {
  const out = merge({
    repoA: {
      results: [
        vr('a1', 0.9, {
          related_sources: [{ path: 'spec.md', relationship: 'spec' }],
        }),
      ],
      metric: 'cosine',
    },
  });
  assert.deepEqual(out[0].related_sources, [
    { path: 'spec.md', relationship: 'spec' },
  ]);
});

test('merge: result shape matches SearchResult contract', () => {
  const out = merge({
    repoA: {
      results: [
        vr('a1', 0.9, { source_type: 'confluence', source_url: 'https://x/y' }),
      ],
      metric: 'cosine',
    },
  });
  const r = out[0];
  for (const k of ['content', 'score', 'project', 'source_type', 'source_url', 'related_sources']) {
    assert.ok(k in r, `missing field ${k}`);
  }
  assert.equal(r.source_type, 'confluence');
  assert.equal(r.source_url, 'https://x/y');
});

test('merge: skips null/missing results entries gracefully', () => {
  const out = merge({
    repoA: { results: [vr('a1', 0.9), null, undefined], metric: 'cosine' },
    repoB: null,
    repoC: { results: null },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].project, 'repoA');
});
