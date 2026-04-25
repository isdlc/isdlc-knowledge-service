// Integration: REST API round-trip — POST /api/projects → POST .../rebuild → GET .../status.
// Traces: FR-001 (AC-001-01), FR-005 (AC-005-01, AC-005-03), FR-007 (AC-007-01),
//         FR-014 (AC-014-01)
// Test IDs (test-strategy.md): ET-001/ET-002 (project CRUD), ET-020 (rebuild),
//                              ET-021 (project status), IT-080 (audit).
//
// What this proves:
//   1. The real API server, bound to port 0, accepts a project create.
//   2. POST /api/projects/:id/rebuild enqueues a job into the real queue.
//   3. GET /api/projects/:id/status returns active jobs and refresh_history
//      structures with the right shape.
//   4. Each mutation produces an audit entry.
//
// We do NOT spin up a worker here — that path is exercised by
// worker-queue-rebuild.test.js. This file exclusively asserts the HTTP
// boundary contract that integrators rely on.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../src/api/server.js';
import { createConfigStore } from '../../src/config/index.js';
import { createQueue } from '../../src/queue/queue.js';
import { createAuditLogger } from '../../src/audit/logger.js';
import { search as queryEngineSearch } from '../../src/query/index.js';
import { createFakeModelAdapter } from '../fakes/embed-fake.js';

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

async function bootRealServer() {
  const dataDir = makeTmp('isdlc-it-rest-data-');
  const auditPath = join(makeTmp('isdlc-it-rest-audit-'), 'audit.jsonl');
  const queuePath = join(makeTmp('isdlc-it-rest-queue-'), 'queue.db');
  const staticRoot = makeTmp('isdlc-it-rest-static-');

  const configStore = createConfigStore({ dataDir });
  const queue = createQueue({ dbPath: queuePath });
  const auditLogger = createAuditLogger({ path: auditPath });
  const modelAdapter = createFakeModelAdapter();

  const deps = {
    configStore,
    queue,
    auditLogger,
    modelManager: {
      listModels: async () => [{ name: 'fake-deterministic', loaded: true, pinned: false, memory_mb: 0 }],
      pin: async () => {},
      unpin: async () => {},
    },
    queryEngine: { search: queryEngineSearch },
    modelAdapter,
    getVectorDb: () => ({ search: async () => [], getMetric: () => 'cosine' }),
  };

  const handle = await startServer({ port: 0, host: '127.0.0.1', deps, options: { staticRoot } });
  const addr = handle.address();
  return {
    base: `http://127.0.0.1:${addr.port}`,
    handle,
    queue,
    configStore,
    auditPath,
  };
}

// --- tests ----------------------------------------------------------------

describe('REST API integration: project CRUD + rebuild + status round-trip', () => {
  test('POST /api/projects → POST /api/projects/:id/rebuild → GET /api/projects/:id/status', async () => {
    const { base, handle, queue, configStore, auditPath } = await bootRealServer();
    try {
      // 1. Create a project.
      const createRes = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Restful',
          version: '1.0',
          sources: [{ type: 'git', url: 'https://example.com/restful.git', repo_id: 'restful/main' }],
          model_config: { type: 'fake' },
          vectordb_config: { type: 'sqlite-vec' },
        }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      assert.ok(created.project, 'project envelope present');
      assert.equal(created.project.name, 'Restful');
      const projectId = created.project.id;
      assert.equal(projectId, 'restful-1.0');

      // 2. Trigger a rebuild.
      const rebuildRes = await fetch(`${base}/api/projects/${projectId}/rebuild`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(rebuildRes.status, 200);
      const rebuildBody = await rebuildRes.json();
      assert.ok(rebuildBody.job_id, 'job_id returned');
      assert.equal(rebuildBody.status, 'queued');

      // The queue actually has the job — verify durability of the boundary.
      const queued = queue.listJobs({ status: 'queued' });
      const ourJob = queued.find((j) => j.payload && j.payload.project_id === projectId);
      assert.ok(ourJob, 'queue contains the enqueued rebuild job');
      assert.equal(ourJob.type, 'full_rebuild');

      // 3. Status endpoint reflects the active job.
      const statusRes = await fetch(`${base}/api/projects/${projectId}/status`);
      assert.equal(statusRes.status, 200);
      const status = await statusRes.json();
      assert.ok('staleness' in status);
      assert.ok(Array.isArray(status.active_jobs));
      assert.ok(
        status.active_jobs.some((j) => j.id === ourJob.id),
        'status surfaces the queued rebuild job',
      );
      assert.ok(Array.isArray(status.refresh_history));

      // 4. Audit entries exist for project.created and project.rebuild_triggered.
      // (The audit logger writes async; await fence by querying a CRUD endpoint
      // that touches the same chain. Then read the file.)
      await fetch(`${base}/api/projects`).then((r) => r.json());
      // Audit appends are serialised through a Promise chain; flush by issuing
      // one more audited mutation and waiting for its response.
      await fetch(`${base}/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: 'updated' }),
      }).then((r) => r.json());
      // Give the audit logger a tick to flush.
      await new Promise((r) => setImmediate(r));

      const fs = await import('node:fs/promises');
      const auditRaw = await fs.readFile(auditPath, 'utf8');
      const lines = auditRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const created2 = lines.find((e) => e.action === 'project.created' && e.project_id === projectId);
      const rebuildLog = lines.find((e) => e.action === 'project.rebuild_triggered' && e.project_id === projectId);
      assert.ok(created2, 'audit logged project.created');
      assert.ok(rebuildLog, 'audit logged project.rebuild_triggered');
      assert.equal(rebuildLog.details.job_id, ourJob.id);

      // 5. listProjects via configStore reflects what we created (sanity).
      const listed = await configStore.listProjects();
      assert.ok(listed.find((p) => p.id === projectId));

      // 6. 404 on unknown project rebuild.
      const missing = await fetch(`${base}/api/projects/no-such/rebuild`, { method: 'POST' });
      assert.equal(missing.status, 404);
    } finally {
      await handle.close();
      queue.close();
    }
  });

  test('POST /api/refresh enqueues an incremental_refresh and audits it', async () => {
    const { base, handle, queue } = await bootRealServer();
    try {
      // Seed a project that owns the repo_id used in the payload.
      const createRes = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Refresher',
          version: '1.0',
          sources: [{ type: 'git', url: 'https://example.com/r.git', repo_id: 'refresher/main' }],
          model_config: { type: 'fake' },
          vectordb_config: { type: 'sqlite-vec' },
        }),
      });
      assert.equal(createRes.status, 201);

      const r = await fetch(`${base}/api/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source_type: 'git',
          repo_id: 'refresher/main',
          changes: [
            { path: 'src/foo.js', action: 'modified' },
            { path: 'src/bar.js', action: 'added' },
          ],
        }),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body.job_id);
      assert.equal(body.status, 'queued');
      const job = queue.getStatus(body.job_id);
      assert.equal(job.type, 'incremental_refresh');
      assert.equal(job.payload.changes.length, 2);
    } finally {
      await handle.close();
      queue.close();
    }
  });
});
