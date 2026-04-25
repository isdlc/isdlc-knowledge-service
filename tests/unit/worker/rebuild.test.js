// T019: Worker — full_rebuild handler tests.
// Traces: FR-005 (AC-005-01, AC-005-02)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 3

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runFullRebuild } from '../../../src/worker/rebuild.js';

/* ------------------------------------------------------------------ */
/* Fakes                                                              */
/* ------------------------------------------------------------------ */

function makeProject(overrides = {}) {
  return {
    id: 'p1',
    name: 'Project One',
    version: '1.0',
    sources: [
      { type: 'git', url: 'https://example.com/repo', branch: 'main' },
    ],
    model_config: { type: 'local', name: 'fake-model' },
    vectordb_config: { backend: 'sqlite-vec', path: ':memory:' },
    ...overrides,
  };
}

function makeConnector(chunks = []) {
  const calls = { crawl: 0, diff: 0 };
  async function* crawl(_source) {
    calls.crawl++;
    for (const c of chunks) yield c;
  }
  return {
    crawl,
    async *diff() {
      calls.diff++;
    },
    calls,
  };
}

function makeDeps({
  project = makeProject(),
  chunks = [
    { content: 'a', path: 'src/a.js', source_type: 'git', source_url: 'u1', last_modified: 't', metadata: {} },
    { content: 'b', path: 'src/b.js', source_type: 'git', source_url: 'u2', last_modified: 't', metadata: {} },
  ],
  pipelineYields,
} = {}) {
  const calls = {
    getProject: 0, addRefreshRecord: [], correlate: [], deleteAll: 0, store: [], delete: [], audit: [],
  };
  const connector = makeConnector(chunks);

  const correlationEngine = {
    async correlate(input, _projectConfig) {
      calls.correlate.push(input.map((c) => c.path));
      return input.map((c) => ({ ...c, related: [] }));
    },
  };

  const pipeline = {
    async *embed(correlated, _modelAdapter, _opts) {
      const yields = pipelineYields ?? correlated.map((c, i) => ({
        id: `id-${i}-${c.path}`,
        vector: [0.1, 0.2],
        content: `[enriched]${c.content}`,
        metadata: { path: c.path, source_type: c.source_type, source_url: c.source_url, project: 'p1', chunk_index: 0, sub_chunk_start: 0, sub_chunk_end: c.content.length },
        related_sources: [],
      }));
      for (const y of yields) yield y;
    },
  };

  const vdb = {
    async deleteAll() { calls.deleteAll++; },
    async store(batch) { calls.store.push(batch.map((b) => b.id)); },
    async delete(ids) { calls.delete.push(ids); },
  };

  const configStore = {
    async getProject(_id) { calls.getProject++; return project; },
    async addRefreshRecord(_id, r) { calls.addRefreshRecord.push(r); },
  };

  const auditLogger = {
    async log(action, details) { calls.audit.push({ action, details }); },
  };

  const deps = {
    configStore,
    connectorFactory: { get: (_t, _c) => connector },
    correlationEngine,
    pipeline,
    vectorDbFactory: (_cfg) => vdb,
    modelManager: { getAdapter: (_cfg) => ({ name: 'fake' }) },
    auditLogger,
    options: { triggerSource: 'web-ui' },
  };
  return { deps, calls, connector, vdb };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('runFullRebuild() throws when project_id is missing', async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => runFullRebuild({}, deps), /project_id/);
  await assert.rejects(() => runFullRebuild(null, deps), /project_id/);
});

test('runFullRebuild() throws when project not found', async () => {
  const { deps } = makeDeps({ project: null });
  await assert.rejects(() => runFullRebuild({ project_id: 'missing' }, deps), /not found/);
});

/* ------------------------------------------------------------------ */
/* Canonical sequence: crawl → correlate → deleteAll → embed → store  */
/* ------------------------------------------------------------------ */

test('runFullRebuild() invokes crawl → correlate → deleteAll → store in order', async () => {
  const { deps, calls, connector } = makeDeps();
  const sequence = [];
  const origCorrelate = deps.correlationEngine.correlate;
  deps.correlationEngine.correlate = async (chunks, cfg) => {
    sequence.push('correlate');
    return origCorrelate(chunks, cfg);
  };
  const origDeleteAll = deps.vectorDbFactory({}).deleteAll;
  // wrap deleteAll on the singleton vdb returned by factory
  const vdb = deps.vectorDbFactory({});
  vdb.deleteAll = async () => { sequence.push('deleteAll'); calls.deleteAll++; };
  vdb.store = async (batch) => { sequence.push('store'); calls.store.push(batch.map((b) => b.id)); };
  deps.vectorDbFactory = () => vdb;
  // patch connector to record crawl
  const origCrawl = connector.crawl;
  connector.crawl = async function* (s) {
    sequence.push('crawl');
    yield* origCrawl(s);
  };

  await runFullRebuild({ project_id: 'p1' }, deps);
  assert.equal(sequence[0], 'crawl', `expected crawl first, got ${sequence.join(',')}`);
  assert.ok(sequence.indexOf('correlate') > sequence.indexOf('crawl'));
  assert.ok(sequence.indexOf('deleteAll') > sequence.indexOf('correlate'));
  assert.ok(sequence.indexOf('store') > sequence.indexOf('deleteAll'));
  void origDeleteAll;
});

test('runFullRebuild() crawls every source on the project', async () => {
  const project = makeProject({
    sources: [
      { type: 'git', url: 'r1' },
      { type: 'git', url: 'r2' },
    ],
  });
  const { deps, calls } = makeDeps({ project });
  // separate connector instances per source
  let getCalls = 0;
  deps.connectorFactory = {
    get(_type, _config) {
      getCalls++;
      return makeConnector([
        { content: `c${getCalls}`, path: `src/${getCalls}.js`, source_type: 'git', source_url: 'u', last_modified: 't', metadata: {} },
      ]);
    },
  };
  await runFullRebuild({ project_id: 'p1' }, deps);
  assert.equal(getCalls, 2, 'connectorFactory.get should be called once per source');
  assert.equal(calls.deleteAll, 1, 'deleteAll called exactly once');
  assert.equal(calls.store.length, 1, 'one store batch (small batch <= batchSize)');
});

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

test('runFullRebuild() batches store calls at options.batchSize', async () => {
  const { deps, calls } = makeDeps();
  const yields = Array.from({ length: 5 }, (_, i) => ({
    id: `id-${i}`,
    vector: [i],
    content: `c${i}`,
    metadata: { path: `p${i}`, source_type: 'git', source_url: '', project: 'p1', chunk_index: 0, sub_chunk_start: 0, sub_chunk_end: 1 },
    related_sources: [],
  }));
  deps.pipeline = {
    async *embed() { for (const y of yields) yield y; },
  };
  deps.options.batchSize = 2;
  await runFullRebuild({ project_id: 'p1' }, deps);
  assert.deepEqual(calls.store, [
    ['id-0', 'id-1'],
    ['id-2', 'id-3'],
    ['id-4'],
  ]);
});

/* ------------------------------------------------------------------ */
/* Refresh record + audit                                              */
/* ------------------------------------------------------------------ */

test('runFullRebuild() adds a success refresh record on completion', async () => {
  const { deps, calls } = makeDeps();
  await runFullRebuild({ project_id: 'p1' }, deps);
  assert.equal(calls.addRefreshRecord.length, 1);
  const r = calls.addRefreshRecord[0];
  assert.equal(r.type, 'full');
  assert.equal(r.status, 'success');
  assert.equal(r.error, null);
  assert.equal(r.trigger_source, 'web-ui');
  assert.ok(typeof r.timestamp === 'string');
  assert.ok(typeof r.duration_seconds === 'number');
  assert.ok(r.documents_processed >= 1);
});

test('runFullRebuild() emits audit log on success', async () => {
  const { deps, calls } = makeDeps();
  await runFullRebuild({ project_id: 'p1' }, deps);
  const completed = calls.audit.find((e) => e.action === 'rebuild.completed');
  assert.ok(completed, 'rebuild.completed must be logged');
  assert.equal(completed.details.project_id, 'p1');
  assert.ok(typeof completed.details.documents_processed === 'number');
});

/* ------------------------------------------------------------------ */
/* Failure path                                                        */
/* ------------------------------------------------------------------ */

test('runFullRebuild() records failure and re-throws on pipeline error', async () => {
  const { deps, calls } = makeDeps();
  deps.pipeline = {
    async *embed() {
      throw new Error('embed exploded');
    },
  };
  await assert.rejects(() => runFullRebuild({ project_id: 'p1' }, deps), /embed exploded/);
  assert.equal(calls.addRefreshRecord.length, 1);
  const r = calls.addRefreshRecord[0];
  assert.equal(r.status, 'failed');
  assert.match(r.error, /embed exploded/);
  const failed = calls.audit.find((e) => e.action === 'rebuild.failed');
  assert.ok(failed, 'rebuild.failed audit must be logged');
});

test('runFullRebuild() supports a function-style connectorFactory', async () => {
  const { deps, calls } = makeDeps();
  const conn = makeConnector([
    { content: 'fn', path: 'src/fn.js', source_type: 'git', source_url: 'u', last_modified: 't', metadata: {} },
  ]);
  deps.connectorFactory = (_type, _cfg) => conn;
  await runFullRebuild({ project_id: 'p1' }, deps);
  assert.equal(calls.store.length, 1);
});

test('runFullRebuild() returns stats', async () => {
  const { deps } = makeDeps();
  const stats = await runFullRebuild({ project_id: 'p1' }, deps);
  assert.ok(typeof stats.documents_processed === 'number');
  assert.ok(typeof stats.duration_seconds === 'number');
  assert.equal(stats.sources, 1);
});
