// Unit tests for SqliteVecAdapter — temp DB per test, round-trip, errors.
// Traces: FR-006, FR-008
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-002, ERR-VDB-003
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteVecAdapter } from '../../../src/vectordb/sqlite-vec.js';
import { VectorDBAdapter, VdbError } from '../../../src/vectordb/adapter.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'vdb-'));
  return { path: join(dir, 'index.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

test('SqliteVecAdapter is a VectorDBAdapter', () => {
  const { path, cleanup } = tempDb();
  try {
    const a = new SqliteVecAdapter({ path, dimensions: 4 });
    assert.ok(a instanceof VectorDBAdapter);
    a.close();
  } finally {
    cleanup();
  }
});

test('throws when dimensions is missing or invalid', () => {
  const { path, cleanup } = tempDb();
  try {
    assert.throws(() => new SqliteVecAdapter({ path }), /dimensions/i);
    assert.throws(() => new SqliteVecAdapter({ path, dimensions: 0 }), /dimensions/i);
    assert.throws(() => new SqliteVecAdapter({ path, dimensions: -1 }), /dimensions/i);
    assert.throws(() => new SqliteVecAdapter({ dimensions: 4 }), /path/i);
  } finally {
    cleanup();
  }
});

test('store + search round-trip returns correct nearest neighbour', async () => {
  const { path, cleanup } = tempDb();
  const dim = 8;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    const records = [
      { id: 'a', vector: unitVec(dim, 0), metadata: { content: 'alpha', source_type: 'git', source_url: 'g://a', project: 'p1' } },
      { id: 'b', vector: unitVec(dim, 1), metadata: { content: 'bravo', source_type: 'git', source_url: 'g://b', project: 'p1' } },
      { id: 'c', vector: unitVec(dim, 2), metadata: { content: 'charlie', source_type: 'git', source_url: 'g://c', project: 'p2' } },
    ];
    await a.store(records);

    const results = await a.search(unitVec(dim, 1), { limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'b');
    assert.equal(results[0].content, 'bravo');
    assert.equal(results[0].metadata.project, 'p1');
    assert.equal(typeof results[0].score, 'number');
  } finally {
    a.close();
    cleanup();
  }
});

test('search respects limit', async () => {
  const { path, cleanup } = tempDb();
  const dim = 4;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([
      { id: '1', vector: unitVec(dim, 0), metadata: { content: 'one', source_type: 't', source_url: 'u', project: 'p' } },
      { id: '2', vector: unitVec(dim, 1), metadata: { content: 'two', source_type: 't', source_url: 'u', project: 'p' } },
      { id: '3', vector: unitVec(dim, 2), metadata: { content: 'three', source_type: 't', source_url: 'u', project: 'p' } },
    ]);
    const results = await a.search(unitVec(dim, 0), { limit: 2 });
    assert.equal(results.length, 2);
  } finally {
    a.close();
    cleanup();
  }
});

test('search applies metadata filter', async () => {
  const { path, cleanup } = tempDb();
  const dim = 4;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([
      { id: 'p1-a', vector: unitVec(dim, 0), metadata: { content: 'a', source_type: 'git', source_url: 'u', project: 'p1' } },
      { id: 'p2-a', vector: unitVec(dim, 0), metadata: { content: 'a2', source_type: 'git', source_url: 'u', project: 'p2' } },
    ]);
    const results = await a.search(unitVec(dim, 0), { limit: 5, filter: { project: 'p2' } });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'p2-a');
  } finally {
    a.close();
    cleanup();
  }
});

test('store upserts on duplicate id', async () => {
  const { path, cleanup } = tempDb();
  const dim = 4;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([{ id: 'x', vector: unitVec(dim, 0), metadata: { content: 'old', source_type: 't', source_url: 'u', project: 'p' } }]);
    await a.store([{ id: 'x', vector: unitVec(dim, 1), metadata: { content: 'new', source_type: 't', source_url: 'u', project: 'p' } }]);
    const stats = await a.stats();
    assert.equal(stats.count, 1);
    const results = await a.search(unitVec(dim, 1), { limit: 1 });
    assert.equal(results[0].id, 'x');
    assert.equal(results[0].content, 'new');
  } finally {
    a.close();
    cleanup();
  }
});

test('delete removes specific ids', async () => {
  const { path, cleanup } = tempDb();
  const dim = 4;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([
      { id: '1', vector: unitVec(dim, 0), metadata: { content: 'x', source_type: 't', source_url: 'u', project: 'p' } },
      { id: '2', vector: unitVec(dim, 1), metadata: { content: 'y', source_type: 't', source_url: 'u', project: 'p' } },
    ]);
    await a.delete(['1']);
    const stats = await a.stats();
    assert.equal(stats.count, 1);
    const results = await a.search(unitVec(dim, 1), { limit: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, '2');
  } finally {
    a.close();
    cleanup();
  }
});

test('deleteAll clears the index', async () => {
  const { path, cleanup } = tempDb();
  const dim = 4;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([
      { id: '1', vector: unitVec(dim, 0), metadata: { content: 'x', source_type: 't', source_url: 'u', project: 'p' } },
      { id: '2', vector: unitVec(dim, 1), metadata: { content: 'y', source_type: 't', source_url: 'u', project: 'p' } },
    ]);
    await a.deleteAll();
    const stats = await a.stats();
    assert.equal(stats.count, 0);
    const results = await a.search(unitVec(dim, 0), { limit: 5 });
    assert.equal(results.length, 0);
  } finally {
    a.close();
    cleanup();
  }
});

test('stats reports count, dimensions, and size_bytes', async () => {
  const { path, cleanup } = tempDb();
  const dim = 6;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([
      { id: '1', vector: unitVec(dim, 0), metadata: { content: 'x', source_type: 't', source_url: 'u', project: 'p' } },
    ]);
    const stats = await a.stats();
    assert.equal(stats.count, 1);
    assert.equal(stats.dimensions, dim);
    assert.ok(stats.size_bytes > 0);
  } finally {
    a.close();
    cleanup();
  }
});

test('store rejects vector with wrong dimensions', async () => {
  const { path, cleanup } = tempDb();
  const a = new SqliteVecAdapter({ path, dimensions: 4 });
  try {
    await assert.rejects(
      a.store([{ id: 'x', vector: [1, 2, 3], metadata: { content: 'c', source_type: 't', source_url: 'u', project: 'p' } }]),
      (e) => e instanceof VdbError && /dimension/i.test(e.message),
    );
  } finally {
    a.close();
    cleanup();
  }
});

test('ERR-VDB-002 raised on corrupt index file', async () => {
  const { path, cleanup } = tempDb();
  // Create a non-sqlite garbage file at the path so opening fails.
  writeFileSync(path, 'this is not a sqlite database file at all');
  try {
    let caught;
    try {
      const a = new SqliteVecAdapter({ path, dimensions: 4 });
      await a.search([0, 0, 0, 0], { limit: 1 });
      a.close();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof VdbError, 'expected VdbError');
    assert.equal(caught.code, 'ERR-VDB-002');
  } finally {
    cleanup();
  }
});

test('ERR-VDB-003 raised on write failure (read-only path)', async () => {
  const { path, cleanup } = tempDb();
  const a = new SqliteVecAdapter({ path, dimensions: 4 });
  try {
    // Force a write failure by corrupting the schema after init.
    a._dbForTest().exec('DROP TABLE vectors_meta');
    await assert.rejects(
      a.store([{ id: 'x', vector: [1, 0, 0, 0], metadata: { content: 'c', source_type: 't', source_url: 'u', project: 'p' } }]),
      (e) => e instanceof VdbError && e.code === 'ERR-VDB-003',
    );
  } finally {
    try { a.close(); } catch { /* already broken */ }
    cleanup();
  }
});

test('extra metadata fields are preserved through round-trip', async () => {
  const { path, cleanup } = tempDb();
  const dim = 4;
  const a = new SqliteVecAdapter({ path, dimensions: dim });
  try {
    await a.store([
      {
        id: 'k1',
        vector: unitVec(dim, 0),
        metadata: {
          content: 'hello',
          source_type: 'git',
          source_url: 'g://repo#abc',
          project: 'iSDLC',
          extra: { commit: 'abc123', tags: ['core'] },
        },
      },
    ]);
    const results = await a.search(unitVec(dim, 0), { limit: 1 });
    assert.equal(results[0].metadata.extra.commit, 'abc123');
    assert.deepEqual(results[0].metadata.extra.tags, ['core']);
  } finally {
    a.close();
    cleanup();
  }
});
