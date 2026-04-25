// T025: Web UI — Monitoring tab unit tests.
// Traces: FR-011 (model pin), FR-015 (operational monitoring)
//
// Approach:
//   - jsdom provides document/window/HTMLElement (node:test has no DOM).
//   - Module is dynamically imported inside tests AFTER jsdom is installed
//     so any module-load-time DOM access resolves correctly.
//   - globalThis.fetch is stubbed per test; mount() calls fetch() three times
//     (/api/projects, /api/models, /api/system/memory), so the stub routes
//     by URL.
//   - intervalMs is set high (e.g. 1_000_000) so the auto-refresh timer
//     never fires during the test; we explicitly trigger re-renders.
//   - unmount() clears the interval so node:test does not hang on exit.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let dom;
let originalFetch;

beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<section id="monitoring-tab" class="tab-content"></section>' +
      '</body></html>',
    { url: 'http://localhost/' },
  );
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.HTMLElement;
  delete globalThis.Event;
  delete globalThis.MouseEvent;
  if (dom) {
    dom.window.close();
    dom = null;
  }
});

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch stub that routes by URL pattern.
 * @param {object} state - mutable state used by tests to update responses
 *   { projects: [...], models: [...], memory: { used_mb, available_mb } }
 * @returns {object} { fetch, calls }
 */
function makeFetch(state) {
  const calls = [];
  async function fetchStub(url, init = {}) {
    calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
    const u = String(url);
    if (u === '/api/projects' && (!init.method || init.method === 'GET')) {
      return jsonResponse(200, { projects: state.projects });
    }
    if (u === '/api/models' && (!init.method || init.method === 'GET')) {
      return jsonResponse(200, { models: state.models });
    }
    if (u === '/api/system/memory') {
      return jsonResponse(200, state.memory);
    }
    const pinMatch = u.match(/^\/api\/models\/([^/]+)\/pin$/);
    if (pinMatch) {
      const name = decodeURIComponent(pinMatch[1]);
      const m = state.models.find((mm) => mm.name === name);
      if (init.method === 'POST') {
        if (m) m.pinned = true;
        return jsonResponse(200, { pinned: true });
      }
      if (init.method === 'DELETE') {
        if (m) m.pinned = false;
        return jsonResponse(200, { pinned: false });
      }
    }
    return jsonResponse(404, { error: 'NOT_FOUND' });
  }
  return { fetch: fetchStub, calls };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Importer — dynamic, so jsdom is in place before module evaluation
// ---------------------------------------------------------------------------

async function loadModule() {
  return await import('../../../ui/monitoring.js');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMonitoring — module shape', () => {
  test('exports createMonitoring factory with mount/unmount', async () => {
    const mod = await loadModule();
    assert.equal(typeof mod.createMonitoring, 'function');
    const instance = mod.createMonitoring({ fetch: () => Promise.resolve(jsonResponse(200, {})) });
    assert.equal(typeof instance.mount, 'function');
    assert.equal(typeof instance.unmount, 'function');
  });
});

describe('Project status rendering — staleness badges', () => {
  test('renders fresh/stale/unknown badges with correct classes', async () => {
    const state = {
      projects: [
        {
          id: 'p1',
          name: 'Project Alpha',
          version: '1.0',
          staleness: 'fresh',
          document_count: 42,
          last_refresh: '2026-04-25T10:00:00Z',
        },
        {
          id: 'p2',
          name: 'Project Beta',
          version: '2.5',
          staleness: 'stale',
          document_count: 7,
          last_refresh: '2026-04-20T08:00:00Z',
        },
        {
          id: 'p3',
          name: 'Project Gamma',
          version: '3.0',
          staleness: 'unknown',
          document_count: 0,
          last_refresh: null,
        },
      ],
      models: [],
      memory: { used_mb: 1024, available_mb: 4096, models: [] },
    };
    const { fetch } = makeFetch(state);
    const { createMonitoring } = await loadModule();
    const inst = createMonitoring({ fetch, intervalMs: 1_000_000 });

    const mountEl = document.getElementById('monitoring-tab');
    await inst.mount(mountEl);

    const fresh = mountEl.querySelector('[data-staleness="fresh"]');
    const stale = mountEl.querySelector('[data-staleness="stale"]');
    const unknown = mountEl.querySelector('[data-staleness="unknown"]');
    assert.ok(fresh, 'fresh badge missing');
    assert.ok(stale, 'stale badge missing');
    assert.ok(unknown, 'unknown badge missing');
    assert.match(fresh.className, /badge-fresh|badge-green/);
    assert.match(stale.className, /badge-stale|badge-amber/);
    assert.match(unknown.className, /badge-unknown|badge-red/);

    // Document counts surfaced
    const text = mountEl.textContent;
    assert.match(text, /42/);
    assert.match(text, /Project Alpha/);
    assert.match(text, /1\.0/);

    inst.unmount();
  });

  test('renders active jobs count when status endpoint returns active_jobs', async () => {
    const state = {
      projects: [
        {
          id: 'p1',
          name: 'P',
          version: '1',
          staleness: 'fresh',
          document_count: 1,
          last_refresh: '2026-04-25T10:00:00Z',
          active_jobs: [{ id: 'job-1' }, { id: 'job-2' }],
        },
      ],
      models: [],
      memory: { used_mb: 100, available_mb: 1000, models: [] },
    };
    const { fetch } = makeFetch(state);
    const { createMonitoring } = await loadModule();
    const inst = createMonitoring({ fetch, intervalMs: 1_000_000 });
    const mountEl = document.getElementById('monitoring-tab');
    await inst.mount(mountEl);

    const card = mountEl.querySelector('[data-project-id="p1"]');
    assert.ok(card);
    assert.match(card.textContent, /2/);
    inst.unmount();
  });
});

describe('Models section rendering', () => {
  test('local models get Pin/Unpin buttons; cloud models do not', async () => {
    const state = {
      projects: [],
      models: [
        { name: 'all-MiniLM-L6-v2', type: 'local', loaded: true, pinned: false, memory_mb: 90 },
        { name: 'titan-embed', type: 'local', loaded: true, pinned: true, memory_mb: 200 },
        { name: 'text-embedding-3-small', type: 'cloud', loaded: true, pinned: false },
      ],
      memory: { used_mb: 1000, available_mb: 7000, models: [] },
    };
    const { fetch } = makeFetch(state);
    const { createMonitoring } = await loadModule();
    const inst = createMonitoring({ fetch, intervalMs: 1_000_000 });
    const mountEl = document.getElementById('monitoring-tab');
    await inst.mount(mountEl);

    const localUnpinned = mountEl.querySelector('[data-model="all-MiniLM-L6-v2"]');
    const localPinned = mountEl.querySelector('[data-model="titan-embed"]');
    const cloudModel = mountEl.querySelector('[data-model="text-embedding-3-small"]');

    assert.ok(localUnpinned);
    assert.ok(localUnpinned.querySelector('button[data-action="pin"]'),
      'local unpinned model must have a Pin button');

    assert.ok(localPinned);
    assert.ok(localPinned.querySelector('button[data-action="unpin"]'),
      'local pinned model must have an Unpin button');

    assert.ok(cloudModel);
    assert.equal(cloudModel.querySelector('button[data-action="pin"]'), null,
      'cloud model must NOT have a Pin button');
    assert.equal(cloudModel.querySelector('button[data-action="unpin"]'), null,
      'cloud model must NOT have an Unpin button');

    inst.unmount();
  });

  test('clicking Pin button POSTs /api/models/:name/pin and re-renders with pinned=true', async () => {
    const state = {
      projects: [],
      models: [
        { name: 'mini-lm', type: 'local', loaded: true, pinned: false, memory_mb: 90 },
      ],
      memory: { used_mb: 100, available_mb: 1000, models: [] },
    };
    const { fetch, calls } = makeFetch(state);
    const { createMonitoring } = await loadModule();
    const inst = createMonitoring({ fetch, intervalMs: 1_000_000 });
    const mountEl = document.getElementById('monitoring-tab');
    await inst.mount(mountEl);

    const initialFetchCount = calls.length;
    const pinBtn = mountEl.querySelector('[data-model="mini-lm"] button[data-action="pin"]');
    assert.ok(pinBtn);

    pinBtn.click();
    // Allow the click handler's microtask chain to settle.
    await new Promise((r) => setTimeout(r, 10));

    const postCall = calls.find(
      (c) => c.method === 'POST' && c.url === '/api/models/mini-lm/pin',
    );
    assert.ok(postCall, 'expected POST to /api/models/mini-lm/pin');
    assert.ok(calls.length > initialFetchCount, 'expected re-render fetches');

    const unpinBtn = mountEl.querySelector('[data-model="mini-lm"] button[data-action="unpin"]');
    assert.ok(unpinBtn, 'after pin, button should switch to Unpin');

    inst.unmount();
  });
});

describe('Memory bar', () => {
  test('shows correct percentage of used vs total', async () => {
    const state = {
      projects: [],
      models: [],
      memory: { used_mb: 2000, available_mb: 6000, models: [] },
    };
    const { fetch } = makeFetch(state);
    const { createMonitoring } = await loadModule();
    const inst = createMonitoring({ fetch, intervalMs: 1_000_000 });
    const mountEl = document.getElementById('monitoring-tab');
    await inst.mount(mountEl);

    const bar = mountEl.querySelector('[data-memory-bar]');
    assert.ok(bar, 'memory bar element missing');

    // total = 8000, used = 2000 => 25%
    const pct = bar.getAttribute('data-percent');
    assert.equal(pct, '25');

    // Numeric labels visible
    assert.match(mountEl.textContent, /2000/);
    assert.match(mountEl.textContent, /8000|6000/);

    inst.unmount();
  });
});

describe('Lifecycle — auto-refresh and unmount', () => {
  test('unmount clears the auto-refresh interval', async () => {
    const state = {
      projects: [],
      models: [],
      memory: { used_mb: 0, available_mb: 1000, models: [] },
    };
    const { fetch } = makeFetch(state);
    const { createMonitoring } = await loadModule();
    const inst = createMonitoring({ fetch, intervalMs: 1_000_000 });
    const mountEl = document.getElementById('monitoring-tab');
    await inst.mount(mountEl);

    // Should not throw, and should be safe to call twice.
    inst.unmount();
    inst.unmount();
    // After unmount, the mount point is cleared.
    assert.equal(mountEl.children.length, 0);
  });
});
