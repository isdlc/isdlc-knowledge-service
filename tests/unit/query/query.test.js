// Unit tests for src/query/index.js — fan-out, parallel, graceful degradation.
// Traces: FR-006 (AC-006-01..04), FR-008 (AC-008-01)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 2
//      docs/requirements/REQ-GH-263-.../interface-spec.md  semantic_search
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { search } from '../../../src/query/index.js';

const QUERY_VECTOR = [0.1, 0.2, 0.3];

/** Deterministic mock model adapter — returns a fixed vector. */
const mockModel = (vector = QUERY_VECTOR) => ({
  embed: async (_text) => vector,
});

/**
 * Build a mock VectorDBAdapter-like object whose .search returns canned hits.
 * @param {Array<{id:string,score:number,content?:string,metadata?:object}>} hits
 * @param {string} [metric]
 */
const mockVdb = (hits, metric = 'cosine') => ({
  search: async (_q, _opts) =>
    hits.map((h) => ({
      id: h.id,
      score: h.score,
      content: h.content ?? `c-${h.id}`,
      metadata: {
        source_type: 'git',
        source_url: `repo://${h.id}`,
        related_sources: [],
        ...(h.metadata || {}),
      },
    })),
  getMetric: () => metric,
});

test('search: validates query is a non-empty string', async () => {
  await assert.rejects(
    () => search({ query: '', projects: ['a'] }, { modelAdapter: mockModel(), getVectorDb: () => mockVdb([]) }),
    /non-empty string/i,
  );
  await assert.rejects(
    () => search({ projects: ['a'] }, { modelAdapter: mockModel(), getVectorDb: () => mockVdb([]) }),
    /non-empty string/i,
  );
});

test('search: validates projects is an array', async () => {
  await assert.rejects(
    () => search({ query: 'q', projects: 'a' }, { modelAdapter: mockModel(), getVectorDb: () => mockVdb([]) }),
    /projects must be an array/i,
  );
});

test('search: validates required deps', async () => {
  await assert.rejects(
    () => search({ query: 'q', projects: ['a'] }, { getVectorDb: () => mockVdb([]) }),
    /modelAdapter\.embed/i,
  );
  await assert.rejects(
    () => search({ query: 'q', projects: ['a'] }, { modelAdapter: mockModel() }),
    /getVectorDb/i,
  );
});

test('search: empty projects[] returns [] and never calls the model (AC-006-04 boundary)', async () => {
  let embedCalls = 0;
  const model = { embed: async () => { embedCalls++; return QUERY_VECTOR; } };
  const out = await search(
    { query: 'q', projects: [] },
    { modelAdapter: model, getVectorDb: () => { throw new Error('nope'); } },
  );
  assert.deepEqual(out, []);
  assert.equal(embedCalls, 0);
});

test('search: happy path — single project, returns tagged results (AC-006-03)', async () => {
  const out = await search(
    { query: 'q', projects: ['repoA'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: (id) => {
        assert.equal(id, 'repoA');
        return mockVdb([
          { id: '1', score: 0.9 },
          { id: '2', score: 0.5 },
        ]);
      },
    },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].project, 'repoA');
  assert.equal(out[1].project, 'repoA');
  assert.ok(out[0].score >= out[1].score);
});

test('search: AC-006-04 — fans out across multiple projects and merges', async () => {
  const seenIds = [];
  const out = await search(
    { query: 'q', projects: ['repoA', 'repoB', 'repoC'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: (id) => {
        seenIds.push(id);
        if (id === 'repoA') return mockVdb([{ id: 'a1', score: 0.4 }]);
        if (id === 'repoB') return mockVdb([{ id: 'b1', score: 0.95 }]);
        if (id === 'repoC') return mockVdb([{ id: 'c1', score: 0.7 }]);
        throw new Error('unexpected');
      },
    },
  );
  assert.deepEqual(seenIds.sort(), ['repoA', 'repoB', 'repoC']);
  assert.equal(out.length, 3);
  assert.equal(out[0].project, 'repoB');
  assert.equal(out[1].project, 'repoC');
  assert.equal(out[2].project, 'repoA');
  // each tagged with its source project
  for (const r of out) {
    assert.ok(['repoA', 'repoB', 'repoC'].includes(r.project));
  }
});

test('search: fan-out runs in parallel (concurrent in-flight count > 1)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (id) => ({
    search: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
      return [{ id, score: 0.5, content: id, metadata: { source_type: '', source_url: '', related_sources: [] } }];
    },
    getMetric: () => 'cosine',
  });
  await search(
    { query: 'q', projects: ['p1', 'p2', 'p3', 'p4'] },
    { modelAdapter: mockModel(), getVectorDb: (id) => slow(id) },
  );
  assert.ok(maxInFlight > 1, `expected concurrent fan-out, peaked at ${maxInFlight}`);
});

test('search: graceful degradation — one project fails, others still return', async () => {
  /** @type {any[]} */
  const errors = [];
  const out = await search(
    { query: 'q', projects: ['ok', 'broken', 'ok2'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: (id) => {
        if (id === 'broken') throw new Error('unknown project: broken');
        if (id === 'ok') return mockVdb([{ id: 'o1', score: 0.8 }]);
        if (id === 'ok2') return mockVdb([{ id: 'o2', score: 0.6 }]);
      },
      errors,
    },
  );
  assert.equal(out.length, 2);
  const projects = out.map((r) => r.project).sort();
  assert.deepEqual(projects, ['ok', 'ok2']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].projectId, 'broken');
  assert.equal(errors[0].code, 'INVALID_PROJECT');
});

test('search: maps ERR-API-001 to INVALID_PROJECT', async () => {
  const errors = [];
  const out = await search(
    { query: 'q', projects: ['p'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: () => {
        const err = new Error('boom');
        /** @type {any} */ (err).code = 'ERR-API-001';
        throw err;
      },
      errors,
    },
  );
  assert.deepEqual(out, []);
  assert.equal(errors[0].code, 'INVALID_PROJECT');
});

test('search: maps ERR-API-002 to NO_INDEX', async () => {
  const errors = [];
  const out = await search(
    { query: 'q', projects: ['p'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: () => {
        const err = new Error('no embeddings yet');
        /** @type {any} */ (err).code = 'ERR-API-002';
        throw err;
      },
      errors,
    },
  );
  assert.deepEqual(out, []);
  assert.equal(errors[0].code, 'NO_INDEX');
});

test('search: passes already-MCP error codes through unchanged', async () => {
  const errors = [];
  await search(
    { query: 'q', projects: ['p'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: () => {
        const err = new Error('x');
        /** @type {any} */ (err).code = 'INVALID_PROJECT';
        throw err;
      },
      errors,
    },
  );
  assert.equal(errors[0].code, 'INVALID_PROJECT');
});

test('search: errors collector is optional — engine still degrades gracefully without it', async () => {
  const out = await search(
    { query: 'q', projects: ['ok', 'broken'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: (id) => {
        if (id === 'broken') throw new Error('no index for project');
        return mockVdb([{ id: 'o1', score: 0.8 }]);
      },
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].project, 'ok');
});

test('search: respects limit_per_project when calling vdb.search', async () => {
  let seenLimit;
  await search(
    { query: 'q', projects: ['repoA'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: () => ({
        search: async (_q, opts) => {
          seenLimit = opts.limit;
          return [];
        },
        getMetric: () => 'cosine',
      }),
      options: { limit_per_project: 5 },
    },
  );
  assert.equal(seenLimit, 5);
});

test('search: respects total_limit when trimming merged results', async () => {
  const out = await search(
    { query: 'q', projects: ['a', 'b'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: () => mockVdb(
        Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, score: 1 - i * 0.05 })),
      ),
      options: { total_limit: 3 },
    },
  );
  assert.equal(out.length, 3);
});

test('search: embeds the query text once and reuses the vector across projects', async () => {
  let embedCalls = 0;
  let vdbCalls = 0;
  const model = { embed: async () => { embedCalls++; return QUERY_VECTOR; } };
  await search(
    { query: 'how do I login', projects: ['p1', 'p2', 'p3'] },
    {
      modelAdapter: model,
      getVectorDb: () => ({
        search: async (q) => {
          vdbCalls++;
          assert.deepEqual(q, QUERY_VECTOR);
          return [];
        },
        getMetric: () => 'cosine',
      }),
    },
  );
  assert.equal(embedCalls, 1);
  assert.equal(vdbCalls, 3);
});

test('search: handles vdb without getMetric (defaults to cosine)', async () => {
  const out = await search(
    { query: 'q', projects: ['p'] },
    {
      modelAdapter: mockModel(),
      getVectorDb: () => ({
        search: async () => [
          { id: '1', score: 0.7, content: 'x', metadata: { source_type: '', source_url: '', related_sources: [] } },
        ],
        // no getMetric
      }),
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 0.7); // cosine 0.7 → 0.7
});
