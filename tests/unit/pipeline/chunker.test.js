// T018: Embedding Pipeline — chunker unit tests.
// Traces: FR-002 (AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6
//      docs/requirements/REQ-GH-263-.../test-strategy.md (UT-013)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkContent } from '../../../src/pipeline/chunker.js';

/* ------------------------------------------------------------------ */
/* Empty / trivial inputs                                             */
/* ------------------------------------------------------------------ */

test('chunkContent yields zero sub-chunks for empty content', () => {
  const out = [...chunkContent('', { max_tokens: 16, overlap_tokens: 2 })];
  assert.deepEqual(out, []);
});

test('chunkContent yields zero sub-chunks for whitespace-only content', () => {
  const out = [...chunkContent('   \n\n  \t', { max_tokens: 16, overlap_tokens: 2 })];
  assert.deepEqual(out, []);
});

test('chunkContent treats undefined / null content as empty', () => {
  assert.deepEqual([...chunkContent(undefined, { max_tokens: 16 })], []);
  assert.deepEqual([...chunkContent(null, { max_tokens: 16 })], []);
});

/* ------------------------------------------------------------------ */
/* Single-chunk path (content fits inside one window)                 */
/* ------------------------------------------------------------------ */

test('chunkContent yields a single sub-chunk when content fits the window', () => {
  const text = 'hello world';
  const out = [...chunkContent(text, { max_tokens: 1000, overlap_tokens: 10 })];
  assert.equal(out.length, 1);
  assert.equal(out[0].text, text);
  assert.equal(out[0].index, 0);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, text.length);
});

test('chunkContent assigns sequential indices starting at 0', () => {
  // Construct content long enough to require multiple windows even with
  // generous overlap.
  const para = 'a'.repeat(100);
  const text = `${para}\n\n${para}\n\n${para}\n\n${para}`;
  const out = [...chunkContent(text, { max_tokens: 30, overlap_tokens: 4 })];
  assert.ok(out.length > 1, `expected >1 chunks, got ${out.length}`);
  for (let i = 0; i < out.length; i++) assert.equal(out[i].index, i);
});

/* ------------------------------------------------------------------ */
/* Boundary preference: \n\n > \n > sentence end > hard cut           */
/* ------------------------------------------------------------------ */

test('chunkContent prefers paragraph boundary (\\n\\n) over line boundary (\\n)', () => {
  // Lay out content so a paragraph break is reachable inside the window.
  // max_tokens=20 → maxChars=80. Place \n\n at char ~50 and \n at char ~70.
  const left = 'a'.repeat(45);
  const middle = 'b'.repeat(20);
  const right = 'c'.repeat(60);
  const content = `${left}\n\n${middle}\nrest\n${right}`;
  const out = [...chunkContent(content, { max_tokens: 20, overlap_tokens: 2 })];
  assert.ok(out.length >= 2);
  // First chunk should end at (or just past) the \n\n at position 45,
  // not stretch through the \n at position 67.
  const firstEnd = out[0].end;
  assert.ok(
    firstEnd <= 50,
    `first chunk should split at \\n\\n (≤50), got end=${firstEnd}`,
  );
  // Boundary cut: the first chunk's text should not contain the second \n.
  assert.equal(out[0].text.includes('rest'), false);
});

test('chunkContent prefers sentence end (".") over hard cut when no newline available', () => {
  // 'aaa...aaa. bbb...bbb' — exactly one period in the middle.
  const left = 'a'.repeat(40);
  const right = 'b'.repeat(40);
  const content = `${left}. ${right}`; // length = 82
  const out = [...chunkContent(content, { max_tokens: 15, overlap_tokens: 1 })];
  // maxChars = 60; should split at the period (offset 40), not at offset 60.
  assert.ok(out.length >= 2);
  assert.ok(
    out[0].end <= 45,
    `expected sentence-boundary split (≤45), got ${out[0].end}`,
  );
  assert.ok(out[0].text.endsWith('.') || out[0].text.endsWith('. '));
});

test('chunkContent hard-cuts when no boundary available in the window', () => {
  // No newlines, no punctuation — pure dense content.
  const content = 'x'.repeat(500);
  const out = [...chunkContent(content, { max_tokens: 25, overlap_tokens: 5 })];
  assert.ok(out.length >= 2);
  // Each non-final chunk should be at most maxChars (=100).
  for (let i = 0; i < out.length - 1; i++) {
    assert.ok(
      out[i].text.length <= 100,
      `chunk ${i} length ${out[i].text.length} exceeded maxChars`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Overlap correctness                                                */
/* ------------------------------------------------------------------ */

test('chunkContent produces overlapping windows with the requested overlap', () => {
  // Use letters so we can verify by-character overlap.
  const content = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(4); // 144 chars, no newlines
  const max_tokens = 10; // → maxChars = 40
  const overlap_tokens = 2; // → overlapChars = 8
  const out = [...chunkContent(content, { max_tokens, overlap_tokens })];
  assert.ok(out.length >= 3);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    // Current chunk must start at-or-before prev.end (overlap >= 0)
    // and at-or-after prev.start (forward progress).
    assert.ok(cur.start <= prev.end, `chunk ${i} must overlap chunk ${i - 1}`);
    assert.ok(cur.start > prev.start, `chunk ${i} must move forward`);
  }
});

test('chunkContent default overlap is ~10% of max_tokens when not specified', () => {
  const content = 'x'.repeat(400);
  const out = [...chunkContent(content, { max_tokens: 20 })];
  // With max_tokens=20 → maxChars=80, default overlap 10% → ~8 chars
  assert.ok(out.length >= 2);
  const overlap = out[0].end - out[1].start;
  assert.ok(overlap >= 4 && overlap <= 16, `expected ~8 char overlap, got ${overlap}`);
});

/* ------------------------------------------------------------------ */
/* Exact-fit edge case                                                */
/* ------------------------------------------------------------------ */

test('chunkContent emits a single chunk when content length equals maxChars exactly', () => {
  const max_tokens = 10; // maxChars = 40
  const content = 'y'.repeat(40);
  const out = [...chunkContent(content, { max_tokens, overlap_tokens: 2 })];
  assert.equal(out.length, 1);
  assert.equal(out[0].text, content);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 40);
});

/* ------------------------------------------------------------------ */
/* Large content                                                      */
/* ------------------------------------------------------------------ */

test('chunkContent handles large content without missing characters', () => {
  // Build a 5,000-char document with paragraph breaks every ~200 chars.
  const para = 'lorem ipsum dolor sit amet '.repeat(8); // ~216 chars
  const blocks = [];
  for (let i = 0; i < 25; i++) blocks.push(para);
  const content = blocks.join('\n\n');
  const out = [...chunkContent(content, { max_tokens: 100, overlap_tokens: 10 })];
  assert.ok(out.length > 5);
  // The union of all chunk ranges must cover the full content.
  // (Minus any whitespace-trim at the very edges, but our chunker keeps
  // start=0 for the first chunk and end=length for the last.)
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, content.length);
  // Sanity: each chunk's text matches the slice it claims.
  for (const c of out) {
    assert.equal(c.text, content.slice(c.start, c.end));
  }
});

/* ------------------------------------------------------------------ */
/* Defensive defaults                                                 */
/* ------------------------------------------------------------------ */

test('chunkContent uses a sensible default max_tokens when omitted', () => {
  // Just assert it doesn't blow up and yields at least one chunk for
  // non-trivial content.
  const out = [...chunkContent('hello world')];
  assert.ok(out.length >= 1);
  assert.equal(out[0].start, 0);
});
