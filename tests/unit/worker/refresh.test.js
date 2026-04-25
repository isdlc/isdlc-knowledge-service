// T019: Worker — incremental_refresh handler tests.
// Traces: FR-004 (AC-004-01..04)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runIncrementalRefresh } from '../../../src/worker/refresh.js';
import { stableChunkId } from '../../../src/pipeline/index.js';

/* ------------------------------------------------------------------ */
/* Fakes                                                              */
/* ------------------------------------------------------------------ */

function makeProject(overrides = {}) {
  return {
    id: 'p1',
    sources: [
      { type: 'git', id: 'repo-a', url: 'https://example.com/a', branch: 'main' },
      { type: 'git', id: 'repo-b', url: 'https://example.com/b', branch: 'main' },
    ],
    model_config: { type: 'local', name: 'fake' },
    vectordb_config: { backend: 'sqlite-vec' },
    ...overrides,
  };
}

function makeDeps({ project = makeProject(), repoChunks = {} } = {}) {
  const calls = {
    crawled: [],          // [{ source, paths }]
    correlated: [],
    stored: [],
    deletedIds: [],
    refreshRecords: [],
    audit: [],
  };

  const connector = {
    async *crawl(source, options) {
      // Path-aware crawl support — yield only paths in the filter when given.
      const all = repoChunks[source.id] || [];
      const filter = options && Array.isArray(options.paths) ? new Set(options.paths) : null;
      calls.crawled.push({ source: source.id, paths: filter ? [...filter] : null });
      for (const c of all) {
        if (!filter || filter.has(c.path)) yield c;
      }
    },
    async *diff() {},
  };

  const correlationEngine = {
    async correlate(chunks, _projectConfig) {
      calls.correlated.push(chunks.map((c) => c.path));
      return chunks.map((c) => ({ ...c, related: [] }));
    },
  };

  const pipeline = {
    async *embed(correlated, _adapter, _opts) {
      for (let i = 0; i < correlated.length; i++) {
        const c = correlated[i];
        yield {
          id: `id-${c.path}`,
          vector: [0.1],
          content: c.content,
          metadata: { path: c.path, source_type: 'git', source_url: '', project: 'p1', chunk_index: 0, sub_chunk_start: 0, sub_chunk_end: 1 },
          related_sources: [],
        };
      }
    },
  };

  const vdb = {
    async deleteAll() {},
    async store(batch) { calls.stored.push(batch.map((b) => b.id)); },
    async delete(ids) { calls.deletedIds.push(ids); },
  };

  const configStore = {
    async getProject(_id) { return project; },
    async addRefreshRecord(_id, r) { calls.refreshRecords.push(r); },
  };

  const auditLogger = { async log(action, details) { calls.audit.push({ action, details }); } };

  const deps = {
    configStore,
    connectorFactory: { get: (_t, _c) => connector },
    correlationEngine,
    pipeline,
    vectorDbFactory: () => vdb,
    modelManager: { getAdapter: () => ({ name: 'fake' }) },
    auditLogger,
    options: { triggerSource: 'github-actions' },
  };
  return { deps, calls, connector, vdb };
}

const chunkOf = (path, repoUrl = '') => ({
  content: `content of ${path}`,
  path,
  source_type: 'git',
  source_url: `${repoUrl}/${path}`,
  last_modified: 't',
  metadata: {},
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('runIncrementalRefresh() requires project_id', async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => runIncrementalRefresh({}, deps), /project_id/);
  await assert.rejects(() => runIncrementalRefresh(null, deps), /payload/);
});

test('runIncrementalRefresh() throws on missing project', async () => {
  const { deps } = makeDeps({ project: null });
  await assert.rejects(
    () => runIncrementalRefresh({ project_id: 'gone', changes: [{ path: 'x', action: 'add' }] }, deps),
    /not found/,
  );
});

test('runIncrementalRefresh() throws when no source matches repo_id', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => runIncrementalRefresh({
      project_id: 'p1', repo_id: 'unknown-repo', changes: [{ path: 'x', action: 'add' }],
    }, deps),
    /No matching source/,
  );
});

/* ------------------------------------------------------------------ */
/* Only changed paths are processed                                   */
/* ------------------------------------------------------------------ */

test('runIncrementalRefresh() processes ONLY paths in payload.changes', async () => {
  const { deps, calls } = makeDeps({
    repoChunks: {
      'repo-a': [chunkOf('src/a.js'), chunkOf('src/b.js'), chunkOf('src/c.js')],
    },
  });
  await runIncrementalRefresh({
    project_id: 'p1',
    repo_id: 'repo-a',
    source_type: 'git',
    changes: [
      { path: 'src/a.js', action: 'modify' },
      { path: 'src/c.js', action: 'add' },
    ],
  }, deps);

  // Correlation must have seen exactly the changed paths.
  assert.equal(calls.correlated.length, 1);
  assert.deepEqual(calls.correlated[0].sort(), ['src/a.js', 'src/c.js']);
  // Stored vectors only for the changed paths.
  assert.equal(calls.stored.length, 1);
  assert.deepEqual(calls.stored[0].sort(), ['id-src/a.js', 'id-src/c.js']);
});

test('runIncrementalRefresh() picks the source whose id matches repo_id', async () => {
  const { deps, calls } = makeDeps({
    repoChunks: {
      'repo-a': [chunkOf('src/a.js')],
      'repo-b': [chunkOf('docs/b.md')],
    },
  });
  await runIncrementalRefresh({
    project_id: 'p1',
    repo_id: 'repo-b',
    changes: [{ path: 'docs/b.md', action: 'modify' }],
  }, deps);
  assert.equal(calls.crawled.length, 1);
  assert.equal(calls.crawled[0].source, 'repo-b');
});

/* ------------------------------------------------------------------ */
/* Deletes are honored                                                 */
/* ------------------------------------------------------------------ */

test('runIncrementalRefresh() honors delete actions by calling vdb.delete with synthesized IDs', async () => {
  const { deps, calls } = makeDeps({
    repoChunks: { 'repo-a': [] },
  });
  await runIncrementalRefresh({
    project_id: 'p1',
    repo_id: 'repo-a',
    changes: [
      { path: 'src/old.js', action: 'delete' },
    ],
  }, deps);
  assert.equal(calls.deletedIds.length, 1);
  // Should include candidate IDs derived from path + chunk_index
  const ids = calls.deletedIds[0];
  assert.ok(ids.length >= 1);
  // The first candidate should match the pipeline's stable ID for chunk_index=0
  assert.equal(ids[0], stableChunkId('p1', 'src/old.js', 0));
});

test('runIncrementalRefresh() handles mixed add/modify/delete in one payload', async () => {
  const { deps, calls } = makeDeps({
    repoChunks: { 'repo-a': [chunkOf('src/new.js'), chunkOf('src/changed.js')] },
  });
  await runIncrementalRefresh({
    project_id: 'p1',
    repo_id: 'repo-a',
    changes: [
      { path: 'src/new.js', action: 'add' },
      { path: 'src/changed.js', action: 'modify' },
      { path: 'src/old.js', action: 'delete' },
    ],
  }, deps);
  // Upserts went through embed/store
  assert.equal(calls.stored.length, 1);
  assert.deepEqual(calls.stored[0].sort(), ['id-src/changed.js', 'id-src/new.js']);
  // Deletes called separately
  assert.equal(calls.deletedIds.length, 1);
});

/* ------------------------------------------------------------------ */
/* Refresh record + audit                                              */
/* ------------------------------------------------------------------ */

test('runIncrementalRefresh() writes type=incremental refresh record on success', async () => {
  const { deps, calls } = makeDeps({
    repoChunks: { 'repo-a': [chunkOf('src/a.js')] },
  });
  await runIncrementalRefresh({
    project_id: 'p1',
    repo_id: 'repo-a',
    changes: [{ path: 'src/a.js', action: 'modify' }],
  }, deps);
  assert.equal(calls.refreshRecords.length, 1);
  const r = calls.refreshRecords[0];
  assert.equal(r.type, 'incremental');
  assert.equal(r.status, 'success');
  assert.equal(r.trigger_source, 'github-actions');
  assert.equal(r.error, null);
});

test('runIncrementalRefresh() records failure on error', async () => {
  const { deps, calls } = makeDeps({
    repoChunks: { 'repo-a': [chunkOf('src/a.js')] },
  });
  deps.pipeline = {
    async *embed() { throw new Error('embed broke'); },
  };
  await assert.rejects(
    () => runIncrementalRefresh({
      project_id: 'p1', repo_id: 'repo-a',
      changes: [{ path: 'src/a.js', action: 'modify' }],
    }, deps),
    /embed broke/,
  );
  const r = calls.refreshRecords[0];
  assert.equal(r.status, 'failed');
  assert.match(r.error, /embed broke/);
});

test('runIncrementalRefresh() ignores non-string paths in changes', async () => {
  const { deps, calls } = makeDeps({ repoChunks: { 'repo-a': [chunkOf('src/a.js')] } });
  await runIncrementalRefresh({
    project_id: 'p1',
    repo_id: 'repo-a',
    changes: [
      { path: 'src/a.js', action: 'modify' },
      { path: null, action: 'modify' },
      null,
      { action: 'delete' },
    ],
  }, deps);
  assert.equal(calls.stored.length, 1);
  assert.deepEqual(calls.stored[0], ['id-src/a.js']);
});

test('runIncrementalRefresh() with empty changes still completes (no-op)', async () => {
  const { deps, calls } = makeDeps();
  const stats = await runIncrementalRefresh({
    project_id: 'p1', repo_id: 'repo-a', changes: [],
  }, deps);
  assert.equal(stats.documents_processed, 0);
  assert.equal(calls.stored.length, 0);
  assert.equal(calls.deletedIds.length, 0);
  assert.equal(calls.refreshRecords.length, 1);
  assert.equal(calls.refreshRecords[0].status, 'success');
});
