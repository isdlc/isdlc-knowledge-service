// Unit tests for ui/refresh-history.js — Refresh History tab UI module.
// Traces: FR-007 AC-007-05.
// Uses jsdom + fetch mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(__dirname, '../../../ui/refresh-history.js');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function setupDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="refresh-history-tab"></div>
     </body></html>`,
    { url: 'http://localhost/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  return dom;
}

function teardownDom() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.Event;
  delete globalThis.fetch;
}

function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    const handler = routes[url];
    if (!handler) throw new Error(`No mock for ${url}`);
    const body = typeof handler === 'function' ? handler() : handler;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
}

async function importFresh() {
  // Bust the module cache by appending a timestamp query string.
  const url = `file://${MODULE_PATH}?t=${Date.now()}_${Math.random()}`;
  return await import(url);
}

function flush() {
  // Resolve any pending microtasks / promises.
  return new Promise((r) => setImmediate(r));
}

const sampleProjects = [
  { id: 'payments-2.7', name: 'Payments', version: '2.7' },
  { id: 'orders-1.0', name: 'Orders', version: '1.0' },
];

const sampleHistory = [
  {
    timestamp: '2026-04-25T10:00:00Z',
    type: 'full',
    trigger_source: 'ui',
    duration_seconds: 120,
    documents_processed: 50,
    status: 'success',
    error: null,
  },
  {
    timestamp: '2026-04-25T11:00:00Z',
    type: 'incremental',
    trigger_source: 'github-actions',
    duration_seconds: 30,
    documents_processed: 5,
    status: 'failure',
    error: 'Network timeout',
  },
  {
    timestamp: '2026-04-25T12:00:00Z',
    type: 'incremental',
    trigger_source: 'cli',
    duration_seconds: 12,
    documents_processed: 2,
    status: 'success',
    error: null,
  },
];

function statusResponse(history) {
  return {
    staleness: 'fresh',
    document_count: 100,
    last_refresh: '2026-04-25T12:00:00Z',
    active_jobs: [],
    refresh_history: history,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('mount renders project picker populated from /api/projects', async (t) => {
  setupDom();
  t.after(teardownDom);
  mockFetch({
    '/api/projects': { projects: sampleProjects },
  });

  const mod = await importFresh();
  await mod.mount(document.getElementById('refresh-history-tab'));
  await flush();

  const select = document.querySelector('#refresh-history-project');
  assert.ok(select, 'project picker rendered');
  // First option is the placeholder; followed by 2 projects.
  const options = Array.from(select.querySelectorAll('option'));
  const projectOptions = options.filter((o) => o.value !== '');
  assert.equal(projectOptions.length, 2);
  assert.equal(projectOptions[0].value, 'payments-2.7');
  assert.equal(projectOptions[1].value, 'orders-1.0');
});

test('selecting a project fetches status and renders timeline rows', async (t) => {
  setupDom();
  t.after(teardownDom);
  mockFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/projects/payments-2.7/status': statusResponse(sampleHistory),
  });

  const mod = await importFresh();
  await mod.mount(document.getElementById('refresh-history-tab'));
  await flush();

  const select = document.querySelector('#refresh-history-project');
  select.value = 'payments-2.7';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();

  const rows = document.querySelectorAll('#refresh-history-table tbody tr');
  assert.equal(rows.length, 3);
  // Verify a known column value rendered.
  const firstRowText = rows[0].textContent;
  assert.ok(
    firstRowText.includes('full') || firstRowText.includes('incremental'),
    'type column rendered',
  );
  assert.ok(firstRowText.includes('ui') || firstRowText.includes('github-actions') || firstRowText.includes('cli'),
    'trigger_source column rendered');
});

test('filter by type=incremental shows only incremental rows', async (t) => {
  setupDom();
  t.after(teardownDom);
  mockFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/projects/payments-2.7/status': statusResponse(sampleHistory),
  });

  const mod = await importFresh();
  await mod.mount(document.getElementById('refresh-history-tab'));
  await flush();

  const select = document.querySelector('#refresh-history-project');
  select.value = 'payments-2.7';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();

  const typeFilter = document.querySelector('#refresh-history-filter-type');
  typeFilter.value = 'incremental';
  typeFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();

  const visibleRows = Array.from(
    document.querySelectorAll('#refresh-history-table tbody tr'),
  ).filter((r) => r.style.display !== 'none');
  assert.equal(visibleRows.length, 2, 'only 2 incremental rows visible');
  for (const row of visibleRows) {
    assert.ok(row.textContent.includes('incremental'));
    assert.ok(!row.textContent.match(/\bfull\b/));
  }
});

test('filter by status=failure shows only failed rows', async (t) => {
  setupDom();
  t.after(teardownDom);
  mockFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/projects/payments-2.7/status': statusResponse(sampleHistory),
  });

  const mod = await importFresh();
  await mod.mount(document.getElementById('refresh-history-tab'));
  await flush();

  const select = document.querySelector('#refresh-history-project');
  select.value = 'payments-2.7';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();

  const statusFilter = document.querySelector('#refresh-history-filter-status');
  statusFilter.value = 'failure';
  statusFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();

  const visibleRows = Array.from(
    document.querySelectorAll('#refresh-history-table tbody tr'),
  ).filter((r) => r.style.display !== 'none');
  assert.equal(visibleRows.length, 1, 'only 1 failure row visible');
  assert.ok(visibleRows[0].textContent.includes('failure'));
});

test('filter by trigger_source substring matches case-insensitively', async (t) => {
  setupDom();
  t.after(teardownDom);
  mockFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/projects/payments-2.7/status': statusResponse(sampleHistory),
  });

  const mod = await importFresh();
  await mod.mount(document.getElementById('refresh-history-tab'));
  await flush();

  const select = document.querySelector('#refresh-history-project');
  select.value = 'payments-2.7';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();

  const triggerFilter = document.querySelector(
    '#refresh-history-filter-trigger',
  );
  triggerFilter.value = 'github';
  triggerFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();

  const visibleRows = Array.from(
    document.querySelectorAll('#refresh-history-table tbody tr'),
  ).filter((r) => r.style.display !== 'none');
  assert.equal(visibleRows.length, 1);
  assert.ok(visibleRows[0].textContent.includes('github-actions'));
});

test('empty state: "No refresh history yet" rendered when project has none', async (t) => {
  setupDom();
  t.after(teardownDom);
  mockFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/projects/orders-1.0/status': statusResponse([]),
  });

  const mod = await importFresh();
  await mod.mount(document.getElementById('refresh-history-tab'));
  await flush();

  const select = document.querySelector('#refresh-history-project');
  select.value = 'orders-1.0';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();

  const empty = document.querySelector('#refresh-history-empty');
  assert.ok(empty, 'empty state element exists');
  assert.equal(empty.style.display === 'none', false);
  assert.match(empty.textContent, /No refresh history yet/i);
  // No data rows rendered.
  const rows = document.querySelectorAll('#refresh-history-table tbody tr');
  assert.equal(rows.length, 0);
});
