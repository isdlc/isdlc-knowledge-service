// Integration: MCP tool handlers driven against real Config Store, real
// Query Engine, and a real local Vector DB.
// Traces: FR-008 (AC-008-01..04), FR-006 (AC-006-02..04)
// Test IDs (test-strategy.md): ET-040..047 — but at the integration layer
//   (we drive handlers directly via JS calls; the wire transport is unit-
//   tested separately in src/api/server.test.js).
//
// Why this exists at IT and not E2E:
//   The MCP handlers (mcp-handlers.js) are transport-free. Wiring them to
//   real data stores at the integration tier proves the handler ↔ store
//   contracts hold without paying for an HTTP round-trip on every assertion.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  semanticSearch,
  addContent,
  listProjects,
  listModules,
  McpError,
} from '../../src/api/mcp-handlers.js';
import { search as queryEngineSearch } from '../../src/query/index.js';
import { createConfigStore } from '../../src/config/index.js';
import { createQueue } from '../../src/queue/queue.js';
import { SqliteVecAdapter } from '../../src/vectordb/sqlite-vec.js';
import { embed as pipelineEmbed } from '../../src/pipeline/index.js';
import { correlate } from '../../src/correlation/index.js';
import { createFakeModelAdapter, FAKE_DIMENSIONS } from '../fakes/embed-fake.js';

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

async function seedProjectIndex(dataDir, dbPath, projectMeta, sampleChunks) {
  const configStore = createConfigStore({ dataDir });
  const project = await configStore.createProject(projectMeta);

  const vdb = new SqliteVecAdapter({ path: dbPath, dimensions: FAKE_DIMENSIONS });
  const model = createFakeModelAdapter();
  const correlated = await correlate(sampleChunks);
  const batch = [];
  for await (const e of pipelineEmbed(correlated, model, { project: project.id })) {
    batch.push({ id: e.id, vector: e.vector, metadata: { ...e.metadata, content: e.content } });
  }
  await vdb.store(batch);
  return { project, vdb, configStore };
}

// --- tests ----------------------------------------------------------------

describe('MCP tools: integration with real Config Store + Query Engine + Vector DB', () => {
  test('list_projects returns the stored projects with shape { id, name, version, ... }', async () => {
    const dataDir = makeTmp('isdlc-it-mcp-data-');
    const configStore = createConfigStore({ dataDir });
    await configStore.createProject({ name: 'AlphaSvc', version: '1.0', sources: [], model_config: {}, vectordb_config: {} });
    await configStore.createProject({ name: 'BetaSvc', version: '2.1', sources: [{ type: 'git', url: 'g/b', repo_id: 'b' }], model_config: {}, vectordb_config: {} });

    const out = await listProjects({}, { configStore });
    assert.ok(Array.isArray(out.projects));
    assert.equal(out.projects.length, 2);
    const ids = out.projects.map((p) => p.id).sort();
    assert.deepEqual(ids, ['alphasvc-1.0', 'betasvc-2.1']);
    for (const p of out.projects) {
      assert.ok(typeof p.name === 'string' && p.name.length > 0);
      assert.ok(typeof p.version === 'string');
      assert.ok('status' in p);
      assert.ok('document_count' in p);
      assert.ok('last_refresh' in p);
    }
  });

  test('list_modules returns sources for a known project; INVALID_PROJECT for unknown', async () => {
    const dataDir = makeTmp('isdlc-it-mcp-data-2-');
    const configStore = createConfigStore({ dataDir });
    await configStore.createProject({
      name: 'Gamma',
      version: '0.1',
      sources: [
        { type: 'git', url: 'https://github.com/example/gamma', repo_id: 'gamma/main' },
        { type: 'web', url: 'https://example.com/docs' },
      ],
      model_config: {},
      vectordb_config: {},
    });
    const out = await listModules({ project: 'gamma-0.1' }, { configStore });
    assert.equal(out.sources.length, 2);
    assert.equal(out.sources[0].type, 'git');
    assert.equal(out.sources[0].url, 'https://github.com/example/gamma');

    await assert.rejects(
      () => listModules({ project: 'no-such-1.0' }, { configStore }),
      (e) => e instanceof McpError && e.code === 'INVALID_PROJECT',
    );
  });

  test('add_content enqueues a job for a known project', async () => {
    const dataDir = makeTmp('isdlc-it-mcp-data-3-');
    const queuePath = join(makeTmp('isdlc-it-mcp-queue-'), 'queue.db');
    const configStore = createConfigStore({ dataDir });
    await configStore.createProject({ name: 'Delta', version: '1.0', sources: [], model_config: {}, vectordb_config: {} });
    const queue = createQueue({ dbPath: queuePath });
    try {
      const result = await addContent(
        { project: 'delta-1.0', content: 'a paragraph of indexable content.' },
        { configStore, queue },
      );
      assert.equal(result.status, 'queued');
      assert.ok(result.job_id);
      const job = queue.getStatus(result.job_id);
      assert.equal(job.type, 'add_content');
      assert.equal(job.payload.project, 'delta-1.0');
    } finally {
      queue.close();
    }
  });

  test('semantic_search across a real per-project sqlite-vec index returns project-tagged results', async () => {
    const dataDir = makeTmp('isdlc-it-mcp-data-4-');
    const dbPath = join(makeTmp('isdlc-it-mcp-vdb-'), 'idx.db');

    const sample = [
      {
        content: 'function processPayment(amount){ ... }',
        path: 'src/payments.js',
        source_type: 'git',
        source_url: 'g/p/src/payments.js',
        last_modified: '2026-04-25T00:00:00Z',
        metadata: {},
      },
      {
        content: 'Payments module documentation explaining the API.',
        path: 'docs/payments.md',
        source_type: 'git',
        source_url: 'g/p/docs/payments.md',
        last_modified: '2026-04-25T00:00:00Z',
        metadata: {},
      },
    ];
    const { project, vdb, configStore } = await seedProjectIndex(
      dataDir,
      dbPath,
      { name: 'Pay', version: '1.0', sources: [], model_config: {}, vectordb_config: {} },
      sample,
    );

    const model = createFakeModelAdapter();
    try {
      const out = await semanticSearch(
        { query: 'how to process a payment', projects: [project.id] },
        {
          queryEngine: { search: queryEngineSearch },
          configStore,
          modelAdapter: model,
          getVectorDb: () => vdb,
        },
      );
      assert.ok(out.results.length > 0, 'got at least one result');
      for (const r of out.results) {
        assert.equal(r.project, project.id, 'every result tagged with project');
      }
    } finally {
      vdb.close();
    }
  });

  test('semantic_search rejects unknown project with INVALID_PROJECT', async () => {
    const dataDir = makeTmp('isdlc-it-mcp-data-5-');
    const configStore = createConfigStore({ dataDir });
    await configStore.createProject({ name: 'Epsilon', version: '0.1', sources: [], model_config: {}, vectordb_config: {} });
    await assert.rejects(
      () =>
        semanticSearch(
          { query: 'anything', projects: ['no-such-1.0'] },
          {
            queryEngine: { search: queryEngineSearch },
            configStore,
            modelAdapter: createFakeModelAdapter(),
            getVectorDb: () => ({ search: async () => [] }),
          },
        ),
      (e) => e instanceof McpError && e.code === 'INVALID_PROJECT',
    );
  });
});
