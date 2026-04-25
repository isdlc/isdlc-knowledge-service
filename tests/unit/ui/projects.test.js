// Unit tests for ui/projects.js — drives the module against a jsdom DOM
// constructed from ui/index.html. Stubs `globalThis.fetch` to assert call shape.
//
// Traces: T024 / FR-001, FR-003, FR-005, FR-009.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = path.resolve(__dirname, '../../../ui/index.html');
const html = readFileSync(UI_HTML, 'utf8');

// We'll dynamically import the module after the DOM is in place so
// browser-detection branches behave correctly.
const PROJECTS_MODULE_PATH = path.resolve(__dirname, '../../../ui/projects.js');
const moduleUrl = new URL(`file://${PROJECTS_MODULE_PATH}`).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDom() {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/' });
  // Make the jsdom window's globals visible to the module under test.
  // The module references `window` and `document` directly in a few spots.
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.FormData = dom.window.FormData;
  return dom;
}

function teardownDom() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.Element;
  delete globalThis.FormData;
  delete globalThis.fetch;
  delete globalThis.confirm;
}

/** Build a fetch stub that records calls and returns canned responses. */
function makeFetchStub(plan) {
  const calls = [];
  const handler = async (url, init = {}) => {
    calls.push({ url, init });
    const key = `${(init.method || 'GET').toUpperCase()} ${url}`;
    const matcher = plan.find((p) => p.match(key, url, init));
    if (!matcher) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'NO_MATCH', message: `No stub for ${key}` }),
      };
    }
    const res = matcher.response();
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => (res.body == null ? '' : JSON.stringify(res.body)),
    };
  };
  handler.calls = calls;
  return handler;
}

const sampleProjects = [
  {
    id: 'enactor-1.0.0',
    name: 'enactor',
    version: '1.0.0',
    sources: [{ type: 'git', url: 'https://example.com/repo.git', branch: 'main' }],
    status: 'ready',
    document_count: 42,
    model_config: { source: 'local', model: 'all-MiniLM', precision: 'fp16' },
    vectordb_config: { backend: 'sqlite-vec', path: '/data/idx.sqlite' },
  },
  {
    id: 'docs-2.0.0',
    name: 'docs',
    version: '2.0.0',
    sources: [],
    status: 'ready',
    document_count: 0,
    model_config: { source: 'openai', model: 'text-embedding-3-small' },
    vectordb_config: { backend: 'qdrant', url: 'http://qdrant:6333' },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ui/projects.js', () => {
  let mod;
  let dom;

  beforeEach(async () => {
    dom = buildDom();
    // Re-import per test so any module-level state stays clean.
    // Add a cache-busting query string to defeat the loader cache.
    mod = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    teardownDom();
  });

  test('loadProjects fetches /api/projects and renders table rows', async () => {
    const stub = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 200, body: { projects: sampleProjects } }),
      },
    ]);
    globalThis.fetch = stub;

    await mod.loadProjects(document);

    const rows = document.querySelectorAll('#projects-table tbody tr');
    assert.equal(rows.length, 2, 'expected 2 project rows');
    assert.match(rows[0].textContent, /enactor/);
    assert.match(rows[0].textContent, /1\.0\.0/);
    assert.match(rows[1].textContent, /docs/);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, '/api/projects');
  });

  test('loadProjects renders empty-state when no projects', async () => {
    globalThis.fetch = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 200, body: { projects: [] } }),
      },
    ]);
    await mod.loadProjects(document);
    const tbody = document.querySelector('#projects-table tbody');
    assert.match(tbody.textContent, /No projects yet/);
  });

  test('Create flow: POST /api/projects with form payload, then refresh', async () => {
    let projects = [];
    const stub = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 200, body: { projects } }),
      },
      {
        match: (key) => key === 'POST /api/projects',
        response: () => {
          const created = {
            id: 'newproj-1.0',
            name: 'newproj',
            version: '1.0',
            sources: [],
            status: 'ready',
            document_count: 0,
          };
          projects = [created];
          return { status: 201, body: { project: created } };
        },
      },
    ]);
    globalThis.fetch = stub;

    mod.openCreateForm(document);
    const form = document.getElementById('project-form');
    form.elements.name.value = 'newproj';
    form.elements.version.value = '1.0';
    form.elements.description.value = 'demo';
    form.elements.model_source.value = 'local';
    form.elements.model_precision.value = 'fp32';
    form.elements.vectordb_backend.value = 'sqlite-vec';
    form.elements.vectordb_target.value = '/tmp/idx.sqlite';

    const ok = await mod.submitProjectForm(document);
    assert.equal(ok, true);

    const post = stub.calls.find((c) => (c.init.method || '').toUpperCase() === 'POST');
    assert.ok(post, 'expected a POST call');
    const body = JSON.parse(post.init.body);
    assert.equal(body.name, 'newproj');
    assert.equal(body.version, '1.0');
    assert.equal(body.model_config.source, 'local');
    assert.equal(body.model_config.precision, 'fp32');
    assert.equal(body.vectordb_config.backend, 'sqlite-vec');
    assert.equal(body.vectordb_config.path, '/tmp/idx.sqlite');

    // After create, table refreshed via second GET.
    const gets = stub.calls.filter((c) => !c.init.method || c.init.method === 'GET');
    assert.ok(gets.length >= 1);
    const rows = document.querySelectorAll('#projects-table tbody tr');
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent, /newproj/);
  });

  test('Edit flow: form pre-fills, PUT submitted with project id', async () => {
    const stub = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 200, body: { projects: sampleProjects } }),
      },
      {
        match: (key) => /^PUT \/api\/projects\//.test(key),
        response: () => ({ status: 200, body: { project: sampleProjects[0] } }),
      },
    ]);
    globalThis.fetch = stub;

    mod.openEditForm(document, sampleProjects[0]);
    const form = document.getElementById('project-form');
    assert.equal(form.elements.id.value, 'enactor-1.0.0');
    assert.equal(form.elements.name.value, 'enactor');
    assert.equal(form.elements.version.value, '1.0.0');
    assert.equal(form.elements.model_source.value, 'local');
    assert.equal(form.elements.model_precision.value, 'fp16');
    assert.equal(form.elements.vectordb_backend.value, 'sqlite-vec');
    assert.equal(form.elements.vectordb_target.value, '/data/idx.sqlite');
    // Source row pre-filled.
    const sources = document.querySelectorAll('#sources-list .source-row');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].querySelector('.source-url').value, 'https://example.com/repo.git');

    // Tweak description and submit.
    form.elements.description.value = 'updated';
    const ok = await mod.submitProjectForm(document);
    assert.equal(ok, true);
    const put = stub.calls.find((c) => (c.init.method || '').toUpperCase() === 'PUT');
    assert.ok(put);
    assert.equal(put.url, '/api/projects/enactor-1.0.0');
    const body = JSON.parse(put.init.body);
    assert.equal(body.description, 'updated');
  });

  test('Delete flow: confirms then DELETEs the project', async () => {
    const stub = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 200, body: { projects: [] } }),
      },
      {
        match: (key) => /^DELETE \/api\/projects\//.test(key),
        response: () => ({ status: 200, body: { deleted: true } }),
      },
    ]);
    globalThis.fetch = stub;
    let confirmCalled = false;
    window.confirm = (msg) => { confirmCalled = true; assert.match(msg, /Delete project/); return true; };

    const ok = await mod.deleteProject(document, 'enactor-1.0.0');
    assert.equal(ok, true);
    assert.equal(confirmCalled, true);
    const del = stub.calls.find((c) => (c.init.method || '').toUpperCase() === 'DELETE');
    assert.ok(del);
    assert.equal(del.url, '/api/projects/enactor-1.0.0');
  });

  test('Delete cancelled when confirm returns false — no DELETE issued', async () => {
    const stub = makeFetchStub([]);
    globalThis.fetch = stub;
    window.confirm = () => false;
    const ok = await mod.deleteProject(document, 'enactor-1.0.0');
    assert.equal(ok, false);
    assert.equal(stub.calls.length, 0);
  });

  test('Rebuild button: POST /api/projects/:id/rebuild and toast queued', async () => {
    const stub = makeFetchStub([
      {
        match: (key) => /^POST \/api\/projects\/[^/]+\/rebuild$/.test(key),
        response: () => ({ status: 200, body: { job_id: 'job-99', status: 'queued' } }),
      },
    ]);
    globalThis.fetch = stub;

    const res = await mod.rebuildProject(document, 'enactor-1.0.0');
    assert.deepEqual(res, { job_id: 'job-99', status: 'queued' });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, '/api/projects/enactor-1.0.0/rebuild');
    const toasts = document.querySelectorAll('#toast-container .toast.success');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].textContent, /Rebuild queued/);
    assert.match(toasts[0].textContent, /job-99/);
  });

  test('Error handling: API 500 renders an error toast', async () => {
    const stub = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 500, body: { error: 'INTERNAL', message: 'boom' } }),
      },
    ]);
    globalThis.fetch = stub;

    await mod.loadProjects(document);
    const errors = document.querySelectorAll('#toast-container .toast.error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].textContent, /boom/);
    // Table falls back to empty state.
    const tbody = document.querySelector('#projects-table tbody');
    assert.match(tbody.textContent, /No projects yet/);
  });

  test('init wires the New Project button and tbody event delegation', async () => {
    const stub = makeFetchStub([
      {
        match: (key) => key === 'GET /api/projects',
        response: () => ({ status: 200, body: { projects: sampleProjects } }),
      },
      {
        match: (key) => /^POST \/api\/projects\/[^/]+\/rebuild$/.test(key),
        response: () => ({ status: 200, body: { job_id: 'job-1', status: 'queued' } }),
      },
    ]);
    globalThis.fetch = stub;

    mod.init(document);
    // loadProjects fired by init — wait a microtask for the await chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Click "New Project" → modal becomes visible.
    document.getElementById('btn-new-project').click();
    assert.ok(!document.getElementById('project-form-modal').classList.contains('hidden'));

    // Click rebuild on first row.
    const firstRebuildBtn = document.querySelector('#projects-table tbody tr .btn-rebuild');
    assert.ok(firstRebuildBtn, 'expected a rebuild button');
    firstRebuildBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const rebuildCall = stub.calls.find((c) => /\/rebuild$/.test(c.url));
    assert.ok(rebuildCall, 'expected rebuild fetch call');
  });

  test('Add Source button appends a source row; sources serialised in payload', async () => {
    globalThis.fetch = makeFetchStub([
      { match: (key) => key === 'GET /api/projects', response: () => ({ status: 200, body: { projects: [] } }) },
      { match: (key) => key === 'POST /api/projects', response: () => ({ status: 201, body: { project: { id: 'x-1', name: 'x', version: '1' } } }) },
    ]);
    mod.init(document);

    mod.openCreateForm(document);
    document.getElementById('btn-add-source').click();
    document.getElementById('btn-add-source').click();
    const rows = document.querySelectorAll('#sources-list .source-row');
    assert.equal(rows.length, 2);
    rows[0].querySelector('.source-url').value = 'https://github.com/a/b.git';
    rows[0].querySelector('.source-branch').value = 'main';
    rows[1].querySelector('.source-type').value = 'confluence';
    rows[1].querySelector('.source-url').value = 'https://wiki.example.com';

    const form = document.getElementById('project-form');
    form.elements.name.value = 'x';
    form.elements.version.value = '1';

    const payload = mod.buildProjectPayload(document);
    assert.equal(payload.sources.length, 2);
    assert.deepEqual(payload.sources[0], { type: 'git', url: 'https://github.com/a/b.git', branch: 'main' });
    assert.deepEqual(payload.sources[1], { type: 'confluence', url: 'https://wiki.example.com' });
  });

  test('Cloud model source omits precision and includes api_key', async () => {
    mod.openCreateForm(document);
    const form = document.getElementById('project-form');
    form.elements.name.value = 'cloud';
    form.elements.version.value = '1';
    form.elements.model_source.value = 'openai';
    form.elements.model_name.value = 'text-embedding-3-small';
    form.elements.model_api_key.value = 'sk-secret';
    form.elements.vectordb_backend.value = 'qdrant';
    form.elements.vectordb_target.value = 'http://qdrant:6333';

    const payload = mod.buildProjectPayload(document);
    assert.equal(payload.model_config.source, 'openai');
    assert.equal(payload.model_config.api_key, 'sk-secret');
    assert.equal(payload.model_config.precision, undefined);
    assert.equal(payload.vectordb_config.backend, 'qdrant');
    assert.equal(payload.vectordb_config.url, 'http://qdrant:6333');
    assert.equal(payload.vectordb_config.path, undefined);
  });
});
