// E2E: Web UI + REST smoke — boot the real API server on an ephemeral port,
// fetch the static UI, then exercise the live REST surface.
// Traces: FR-007 (AC-007-01), FR-001 (AC-001-01)
// Test IDs (test-strategy.md): ET-030 (web-ui-smoke), ET-001/ET-002 (REST)
// Task: T035 — E2E tests.
//
// Real HTTP via fetch to a real Node `http` server. No headless browser; the
// UI is plain HTML so a status + content-type smoke is sufficient
// (constitutional Article XI.2: no frontend framework, no Playwright).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../src/api/server.js';
import { createConfigStore } from '../../src/config/index.js';
import { createQueue } from '../../src/queue/queue.js';
import { createAuditLogger } from '../../src/audit/logger.js';
import { search as queryEngineSearch } from '../../src/query/index.js';
import { createFakeModelAdapter } from '../fakes/embed-fake.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_UI_ROOT = resolve(__dirname, '..', '..', 'ui');

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

async function bootRealServer({ staticRoot } = {}) {
  const dataDir = makeTmp('isdlc-e2e-data-');
  const auditPath = join(makeTmp('isdlc-e2e-audit-'), 'audit.jsonl');
  const queuePath = join(makeTmp('isdlc-e2e-queue-'), 'queue.db');

  const configStore = createConfigStore({ dataDir });
  const queue = createQueue({ dbPath: queuePath });
  const auditLogger = createAuditLogger({ path: auditPath });

  const deps = {
    configStore,
    queue,
    auditLogger,
    modelManager: {
      listModels: async () => [],
      pin: async () => {},
      unpin: async () => {},
    },
    queryEngine: { search: queryEngineSearch },
    modelAdapter: createFakeModelAdapter(),
    getVectorDb: () => ({ search: async () => [], getMetric: () => 'cosine' }),
  };

  const handle = await startServer({
    port: 0,
    host: '127.0.0.1',
    deps,
    options: { staticRoot: staticRoot ?? REPO_UI_ROOT },
  });
  const addr = handle.address();
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await handle.close();
      queue.close();
    },
  };
}

// --- tests ----------------------------------------------------------------

describe('E2E: Web UI + REST smoke', () => {
  test('GET / serves the index HTML with text/html content-type (ET-030)', async () => {
    const { base, close } = await bootRealServer();
    try {
      const r = await fetch(`${base}/`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /text\/html/i);
      const body = await r.text();
      // Smoke check: the dashboard mentions its own title.
      assert.match(body, /iSDLC Knowledge Service Admin/);
      // No SPA framework; plain HTML.
      assert.doesNotMatch(body, /\bReact\b|\bVue\b|\bSvelte\b/);
    } finally {
      await close();
    }
  });

  test('GET /styles.css and /projects.js are served by the same process', async () => {
    const { base, close } = await bootRealServer();
    try {
      const css = await fetch(`${base}/styles.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type') || '', /text\/css/i);

      const js = await fetch(`${base}/projects.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type') || '', /javascript/i);
    } finally {
      await close();
    }
  });

  test('GET /no-such-asset → 404 with NOT_FOUND envelope', async () => {
    const { base, close } = await bootRealServer();
    try {
      const r = await fetch(`${base}/totally-missing.xyz`);
      assert.equal(r.status, 404);
      const body = await r.json();
      assert.equal(body.error, 'NOT_FOUND');
    } finally {
      await close();
    }
  });

  test('GET /api/projects → 200 with empty list when no projects', async () => {
    const { base, close } = await bootRealServer();
    try {
      const r = await fetch(`${base}/api/projects`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /application\/json/i);
      const body = await r.json();
      assert.deepEqual(body, { projects: [] });
    } finally {
      await close();
    }
  });

  test('REST CRUD round-trip: POST /api/projects → GET → DELETE', async () => {
    const { base, close } = await bootRealServer();
    try {
      // CREATE
      const create = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'E2E', version: '1.0', sources: [], model_config: {}, vectordb_config: {} }),
      });
      assert.equal(create.status, 201);
      const { project } = await create.json();
      assert.equal(project.id, 'e2e-1.0');

      // READ (list)
      const list = await fetch(`${base}/api/projects`).then((r) => r.json());
      assert.equal(list.projects.length, 1);
      assert.equal(list.projects[0].id, 'e2e-1.0');

      // READ (single)
      const single = await fetch(`${base}/api/projects/e2e-1.0`);
      assert.equal(single.status, 200);

      // DELETE
      const del = await fetch(`${base}/api/projects/e2e-1.0`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      const delBody = await del.json();
      assert.equal(delBody.deleted, true);

      // DELETE again → 404 (idempotent error)
      const delAgain = await fetch(`${base}/api/projects/e2e-1.0`, { method: 'DELETE' });
      assert.equal(delAgain.status, 404);
    } finally {
      await close();
    }
  });
});
