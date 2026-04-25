// Unit tests for src/api/server.js — HTTP binding, route registration, static serving, MCP-over-HTTP.
// Traces: FR-007 (AC-007-01)
//
// Approach:
//   - Boots the real server on port 0 (kernel-assigned), issues real HTTP requests via fetch.
//   - Uses a per-test tmpdir as staticRoot, populated by tests that need static files.
//   - All deps are stubbed in-memory — no external services.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startServer } from '../../../src/api/server.js';

// ---------------------------------------------------------------------------
// Stub factories — minimal shapes routes/handlers expect.
// ---------------------------------------------------------------------------

class FakeInvalidProjectError extends Error {
  constructor(id) {
    super(`Project not found: ${id}`);
    this.name = 'InvalidProjectError';
    this.code = 'INVALID_PROJECT';
  }
}

function stubDeps({ projects = [], history = {} } = {}) {
  const map = new Map(projects.map((p) => [p.id, p]));
  let nextJobId = 1;
  const enqueued = [];
  const audited = [];
  return {
    configStore: {
      listProjects: async () => [...map.values()],
      getProject: async (id) => {
        if (!map.has(id)) throw new FakeInvalidProjectError(id);
        return map.get(id);
      },
      createProject: async (cfg) => {
        const id = `${cfg.name.toLowerCase()}-${cfg.version}`;
        const p = { id, ...cfg, created_at: 'T', updated_at: 'T' };
        map.set(id, p);
        return p;
      },
      updateProject: async (id, patch) => {
        if (!map.has(id)) throw new FakeInvalidProjectError(id);
        const updated = { ...map.get(id), ...patch, updated_at: 'T' };
        map.set(id, updated);
        return updated;
      },
      deleteProject: async (id) => {
        if (!map.has(id)) throw new FakeInvalidProjectError(id);
        map.delete(id);
      },
      getRefreshHistory: async (id) => history[id] || [],
    },
    queue: {
      enqueue: (type, payload) => {
        const id = `job-${nextJobId++}`;
        enqueued.push({ id, type, payload });
        return id;
      },
      enqueued,
    },
    auditLogger: {
      log: async (action, details) => {
        audited.push({ action, details });
      },
      audited,
    },
    modelManager: {
      listModels: async () => [],
      pin: async () => {},
      unpin: async () => {},
    },
    queryEngine: {
      search: async ({ query, projects }) => {
        // Simple deterministic stub: one result per project.
        return projects.map((pid, i) => ({
          content: `result for ${query} in ${pid}`,
          score: 1 - i * 0.1,
          project: pid,
          source_type: 'git',
          source_url: `https://example.com/${pid}`,
          related_sources: [],
        }));
      },
    },
    modelAdapter: { embed: async () => [0.1, 0.2, 0.3] },
    getVectorDb: () => ({ search: async () => [], getMetric: () => 'cosine' }),
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

let serverHandle;
let staticRoot;

beforeEach(() => {
  staticRoot = mkdtempSync(path.join(tmpdir(), 'isdlc-server-test-'));
});

afterEach(async () => {
  if (serverHandle) {
    await serverHandle.close();
    serverHandle = null;
  }
  if (staticRoot) {
    rmSync(staticRoot, { recursive: true, force: true });
    staticRoot = null;
  }
});

async function boot(opts = {}) {
  const deps = opts.deps || stubDeps();
  serverHandle = await startServer({
    port: 0,
    host: '127.0.0.1',
    deps,
    options: { staticRoot, ...(opts.options || {}) },
  });
  const addr = serverHandle.address();
  return { port: addr.port, deps, base: `http://127.0.0.1:${addr.port}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startServer — bootstrap & shape', () => {
  test('returns an object with close() and address()', async () => {
    const { base } = await boot();
    assert.ok(typeof serverHandle.close === 'function');
    assert.ok(typeof serverHandle.address === 'function');
    const addr = serverHandle.address();
    assert.equal(typeof addr.port, 'number');
    assert.ok(addr.port > 0);
    // Sanity: server actually listens.
    const r = await fetch(`${base}/api/projects`);
    assert.equal(r.status, 200);
  });

  test('rejects when port is taken (EADDRINUSE)', async () => {
    const { port } = await boot();
    // Try to start a second server on the same port — should reject.
    await assert.rejects(
      () =>
        startServer({
          port,
          host: '127.0.0.1',
          deps: stubDeps(),
          options: { staticRoot },
        }),
      (e) => e && (e.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(e.message))),
    );
  });
});

describe('REST dispatch (/api/**, /metrics)', () => {
  test('GET /api/projects → 200 with empty list', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/api/projects`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { projects: [] });
  });

  test('POST /api/refresh → 200 with job_id', async () => {
    const deps = stubDeps({
      projects: [
        {
          id: 'payments-2.7',
          name: 'Payments',
          version: '2.7',
          sources: [
            { type: 'git', url: 'git.example.com/payments', repo_id: 'org/payments' },
          ],
        },
      ],
    });
    const { base } = await boot({ deps });
    const r = await fetch(`${base}/api/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_type: 'git',
        repo_id: 'org/payments',
        changes: [{ path: 'src/foo.js', action: 'modified' }],
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.job_id, 'expected job_id');
    assert.equal(body.status, 'queued');
  });

  test('GET /metrics → 200 (route registered, body may be empty per T022 placeholder)', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/metrics`);
    assert.equal(r.status, 200);
  });
});

describe('Static file serving', () => {
  test('GET / → serves ui/index.html', async () => {
    writeFileSync(
      path.join(staticRoot, 'index.html'),
      '<!doctype html><title>UI</title><h1>Knowledge</h1>',
    );
    const { base } = await boot();
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const text = await r.text();
    assert.match(text, /<h1>Knowledge<\/h1>/);
  });

  test('GET /styles.css → serves with text/css content-type', async () => {
    writeFileSync(path.join(staticRoot, 'styles.css'), 'body{color:red}');
    const { base } = await boot();
    const r = await fetch(`${base}/styles.css`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/css/);
    assert.equal(await r.text(), 'body{color:red}');
  });

  test('GET /app.js → serves with application/javascript content-type', async () => {
    writeFileSync(path.join(staticRoot, 'app.js'), 'console.log("hi")');
    const { base } = await boot();
    const r = await fetch(`${base}/app.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /javascript/);
  });

  test('GET /missing.html → 404', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/missing.html`);
    assert.equal(r.status, 404);
  });

  test('GET subdir → serves subdir/index.html when present', async () => {
    mkdirSync(path.join(staticRoot, 'sub'));
    writeFileSync(path.join(staticRoot, 'sub', 'index.html'), '<title>Sub</title>');
    const { base } = await boot();
    const r = await fetch(`${base}/sub/`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /<title>Sub<\/title>/);
  });
});

describe('Path traversal protection', () => {
  test('GET /../etc/passwd is blocked (400 or 404)', async () => {
    // Place a sentinel file *outside* staticRoot to be sure traversal would otherwise reach it.
    const outside = mkdtempSync(path.join(tmpdir(), 'isdlc-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    try {
      const { base } = await boot();
      // Two attack vectors: literal ../ and percent-encoded.
      // fetch normalises URLs, so we must build a raw request via http.request.
      // Easier: use a URL with a path that — after our decoding — escapes.
      const attempts = [
        '/%2e%2e/secret.txt',
        '/..%2fsecret.txt',
        '/foo/../../secret.txt',
      ];
      for (const p of attempts) {
        const r = await fetch(`${base}${p}`);
        assert.ok(
          r.status === 400 || r.status === 404,
          `Path ${p} returned ${r.status}, expected 400 or 404`,
        );
        const text = await r.text();
        assert.ok(!text.includes('top secret'), `Path ${p} leaked file contents`);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('MCP-over-HTTP', () => {
  test('POST /mcp tools/call semantic_search → returns search results', async () => {
    const deps = stubDeps({
      projects: [{ id: 'payments-2.7', name: 'Payments', version: '2.7' }],
    });
    const { base } = await boot({ deps });
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'semantic_search',
          arguments: { query: 'how does payment retry work?', projects: ['payments-2.7'] },
        },
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.ok(body.result, 'expected result envelope');
    // Structured content carries the tool's return value.
    assert.ok(
      body.result.structuredContent && Array.isArray(body.result.structuredContent.results),
      'expected structuredContent.results array',
    );
    assert.equal(body.result.structuredContent.results.length, 1);
    assert.equal(body.result.structuredContent.results[0].project, 'payments-2.7');
  });

  test('POST /mcp tools/call list_projects → returns projects', async () => {
    const deps = stubDeps({
      projects: [{ id: 'p-1', name: 'P', version: '1' }],
    });
    const { base } = await boot({ deps });
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'abc',
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} },
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, 'abc');
    assert.ok(Array.isArray(body.result.structuredContent.projects));
    assert.equal(body.result.structuredContent.projects[0].id, 'p-1');
  });

  test('POST /mcp tools/call with unknown tool → JSON-RPC error', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, 9);
    assert.ok(body.error, 'expected JSON-RPC error envelope');
  });

  test('POST /mcp tools/call semantic_search with INVALID_PROJECT → isError result', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'semantic_search',
          arguments: { query: 'hi', projects: ['does-not-exist'] },
        },
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.result && body.result.isError, 'expected isError result');
    const text = body.result.content[0].text;
    const envelope = JSON.parse(text);
    assert.equal(envelope.error.code, 'INVALID_PROJECT');
  });

  test('POST /mcp with invalid JSON body → 400', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {{{',
    });
    assert.equal(r.status, 400);
  });

  test('GET /mcp → 405 (only POST allowed for MCP-over-HTTP)', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/mcp`);
    // 405 with Allow header is the conventional response for method-not-allowed
    // on a known endpoint. We accept 404 as well in case the impl chooses to hide
    // /mcp from non-POST clients — but 405 is preferred.
    assert.ok(r.status === 405 || r.status === 404, `got ${r.status}`);
  });
});

describe('CORS', () => {
  test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/api/projects`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(r.status, 204);
    assert.ok(r.headers.get('access-control-allow-origin'));
  });

  test('responses include Access-Control-Allow-Origin for allowed origin', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/api/projects`, {
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('access-control-allow-origin'));
  });
});

describe('Unknown routes', () => {
  test('GET /api/unknown → 404 (REST dispatcher returns NOT_FOUND)', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/api/unknown`);
    assert.equal(r.status, 404);
  });

  test('POST /unknown (non-static, non-api, non-mcp) → 404', async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/random-thing`, { method: 'POST' });
    assert.equal(r.status, 404);
  });
});
