// Integration: Git connector → Correlation → Pipeline → SqliteVecAdapter → Query fan-out.
// Traces: FR-002 (AC-002-01, AC-002-02), FR-003 (AC-003-01), FR-006 (AC-006-02..04),
//         FR-008 (AC-008-01)
// Test IDs (test-strategy.md): IT-100 (pipeline-git), IT-050/IT-051/IT-052 (query scope).
//
// Why this exists:
//   Per-module unit tests verified each module on its own. This file glues
//   them together end-to-end on a real local Vector DB to catch contract
//   mismatches that unit-test doubles smooth over (vector dimension, ID
//   stability, related_sources propagation, project tagging on results).
//
// Determinism:
//   - Temp git repo built with `git init` + commits in a tmpdir per test.
//   - Deterministic embed fake (hashes input → 384-dim L2-normalised vector).
//   - Local sqlite-vec backend in a tmpdir.
//   - No real network.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { GitConnector } from '../../src/connectors/git.js';
import { correlate } from '../../src/correlation/index.js';
import { embed as pipelineEmbed } from '../../src/pipeline/index.js';
import { SqliteVecAdapter } from '../../src/vectordb/sqlite-vec.js';
import { search as queryEngineSearch } from '../../src/query/index.js';
import { createFakeModelAdapter, FAKE_DIMENSIONS } from '../fakes/embed-fake.js';

// --- helpers --------------------------------------------------------------

/**
 * Initialise a bare-bones git repo in `dir` with the supplied files. Returns
 * the dir. Files are created relative to `dir`. Each entry: { path, content }.
 */
function initGitRepo(dir, files, { authorName = 'IT Test', authorEmail = 'it@test.local' } = {}) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', authorName], { cwd: dir });
  execFileSync('git', ['config', 'user.email', authorEmail], { cwd: dir });
  // Avoid GPG signing if the global config requires it.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

let tmpDirs = [];
function makeTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// --- tests ----------------------------------------------------------------

describe('Pipeline integration: Git → Correlation → Pipeline → SqliteVec → Query', () => {
  test('IT-100: full pipeline indexes correlated chunks and they are searchable', async () => {
    // Source repo: deliberately picks a stem ("payments") that exercises the
    // path-name correlation strategy (impl + test + doc share basename).
    const repoDir = makeTmp('isdlc-it-pipe-repo-');
    initGitRepo(repoDir, [
      {
        path: 'src/payments.js',
        content: [
          'export function processPayment(amount) {',
          '  if (amount <= 0) throw new Error("amount must be positive");',
          '  return { ok: true, amount };',
          '}',
        ].join('\n'),
      },
      {
        path: 'tests/payments.test.js',
        content: [
          "import { processPayment } from '../src/payments.js';",
          "test('processPayment rejects zero', () => processPayment(0));",
        ].join('\n'),
      },
      {
        path: 'docs/payments.md',
        content: '# Payments module\n\nDocumentation for the payments processor.',
      },
      {
        path: 'README.md',
        content: '# Top-level README — unrelated content.',
      },
    ]);

    // 1. Crawl
    const cloneDir = makeTmp('isdlc-it-pipe-clone-');
    const connector = new GitConnector({ url: repoDir, localPath: cloneDir });
    const rawChunks = [];
    for await (const c of connector.crawl({})) rawChunks.push(c);
    // 4 files committed, all should be picked up (no .gitignore / binaries).
    assert.equal(rawChunks.length, 4, 'crawl should yield 4 chunks');
    for (const c of rawChunks) {
      assert.ok(c.path && c.content && c.source_type === 'git' && c.source_url);
    }

    // 2. Correlate — the path-name strategy should link payments.js ↔ payments.test.js
    //    and payments.js ↔ payments.md.
    const correlated = await correlate(rawChunks);
    const impl = correlated.find((c) => c.path === 'src/payments.js');
    assert.ok(impl, 'impl chunk present');
    assert.ok(impl.related.length >= 2, 'impl should link to test+doc');
    const relPaths = impl.related.map((r) => r.path).sort();
    assert.ok(relPaths.includes('tests/payments.test.js'));
    assert.ok(relPaths.includes('docs/payments.md'));

    // 3. Embed (pipeline) using the deterministic fake. The pipeline yields
    //    EmbeddedChunks which we feed to the Vector DB.
    const model = createFakeModelAdapter();
    const dbPath = join(makeTmp('isdlc-it-pipe-db-'), 'index.db');
    const vdb = new SqliteVecAdapter({ path: dbPath, dimensions: FAKE_DIMENSIONS });

    const embeddedAccum = [];
    const batch = [];
    for await (const e of pipelineEmbed(correlated, model, { project: 'payments-2.7' })) {
      embeddedAccum.push(e);
      batch.push({ id: e.id, vector: e.vector, metadata: { ...e.metadata, content: e.content, related_sources: e.related_sources } });
    }
    assert.ok(embeddedAccum.length >= 4, 'pipeline yields at least one chunk per source file');
    // Every embedded chunk must carry the project tag.
    for (const e of embeddedAccum) {
      assert.equal(e.metadata.project, 'payments-2.7');
      assert.equal(e.vector.length, FAKE_DIMENSIONS);
    }

    // 4. Store
    await vdb.store(batch);
    const stats = await vdb.stats();
    assert.equal(stats.count, batch.length);
    assert.equal(stats.dimensions, FAKE_DIMENSIONS);

    // 5. Idempotent re-store: storing the same vectors again must not
    //    inflate count (Constitution Article VI.2 — stable IDs).
    await vdb.store(batch);
    const statsAfterRestore = await vdb.stats();
    assert.equal(statsAfterRestore.count, batch.length, 'idempotent upsert');

    // 6. Query Engine fan-out (single-project trivial case): use the same
    //    vdb instance via a getVectorDb(projectId) thunk. The query text
    //    "processPayment" deterministically hashes; we only assert that
    //    we got back the chunks tagged with the project.
    const errors = [];
    const results = await queryEngineSearch(
      { query: 'processPayment', projects: ['payments-2.7'] },
      {
        modelAdapter: model,
        getVectorDb: () => vdb,
        errors,
        options: { limit_per_project: 5, total_limit: 10 },
      },
    );
    assert.ok(Array.isArray(results), 'results returned');
    assert.equal(errors.length, 0, 'no per-project errors');
    assert.ok(results.length > 0, 'fan-out returned at least one result');
    for (const r of results) {
      // merger.js attaches `project` from the perProject key.
      assert.equal(r.project, 'payments-2.7');
    }

    vdb.close();
  });
});
