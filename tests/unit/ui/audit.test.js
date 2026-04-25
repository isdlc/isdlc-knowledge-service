// Unit tests for ui/audit.js — Audit Log tab UI module (T027).
//
// Traces: FR-014 (AC-014-03 searchable/filterable, AC-014-04 append-only).
//
// Uses jsdom + injectable fetch mock. The module under test exports a
// mountAudit({ root, fetchImpl, doc }) helper that does not depend on a
// browser window — tests inject all globals so the module loads cleanly
// under node:test without polluting other suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(__dirname, '../../../ui/audit.js');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function setupDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <section id="audit-tab"></section>
     </body></html>`,
    { url: 'http://localhost/' },
  );
  // Disable auto-mount; tests drive mountAudit explicitly.
  globalThis.__ISDLC_AUDIT_NO_AUTOMOUNT = true;
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
  delete globalThis.__ISDLC_AUDIT_NO_AUTOMOUNT;
}

/**
 * Create a fetch double that records every call and dispatches by URL prefix.
 * Returns { fetch, calls } where calls is an array of fetched URL strings.
 */
function makeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    // Match by prefix (path + query). Tests assert on calls[].
    const path = url.split('?')[0];
    const matcher = routes[path] ?? routes[url];
    if (!matcher) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const body = typeof matcher === 'function' ? matcher(url) : matcher;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

async function importFresh() {
  const url = `file://${MODULE_PATH}?t=${Date.now()}_${Math.random()}`;
  return await import(url);
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

const sampleProjects = [
  { id: 'payments-2.7', name: 'Payments', version: '2.7' },
  { id: 'orders-1.0', name: 'Orders', version: '1.0' },
];

const sampleEntries = [
  {
    timestamp: '2026-04-25T10:00:00Z',
    action: 'project.create',
    project_id: 'payments-2.7',
    details: { source: 'ui' },
    ip_address: '127.0.0.1',
  },
  {
    timestamp: '2026-04-25T10:05:00Z',
    action: 'project.refresh',
    project_id: 'payments-2.7',
    details: { docs: 5 },
    ip_address: '10.0.0.4',
  },
];

// ---------------------------------------------------------------------------
// AC-014-03: searchable + filterable
// ---------------------------------------------------------------------------

test('initial render fetches /api/audit?limit=100 and renders entry rows', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch, calls } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: sampleEntries.length }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  // Initial fetch URL contains limit=100 and no offset (offset=0 omitted).
  const auditCall = calls.find((u) => u.startsWith('/api/audit'));
  assert.ok(auditCall, 'expected /api/audit call');
  assert.ok(auditCall.includes('limit=100'), `URL must include limit=100, got ${auditCall}`);
  assert.ok(!/offset=/.test(auditCall), 'initial call must omit offset (defaults to 0)');

  // Two rows rendered.
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2, '2 audit rows rendered');
  assert.match(rows[0].textContent, /project\.create/);
  assert.match(rows[1].textContent, /project\.refresh/);
});

test('filtering by action sets action= query param and refetches', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch, calls } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: 2 }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const actionInput = root.querySelector('input[name="action"]');
  assert.ok(actionInput, 'action input rendered');
  actionInput.value = 'project.refresh';
  actionInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await flush();

  const filteredCall = calls.find(
    (u) => u.startsWith('/api/audit') && u.includes('action=project.refresh'),
  );
  assert.ok(filteredCall, `expected /api/audit URL containing action=project.refresh, got: ${calls.join(', ')}`);
});

test('filtering by from/to date range puts both in the query string', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch, calls } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: [], total: 0 }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const fromInput = root.querySelector('input[name="from"]');
  const toInput = root.querySelector('input[name="to"]');
  assert.ok(fromInput && toInput, 'from/to inputs rendered');

  fromInput.value = '2026-04-25T00:00';
  fromInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await flush();

  toInput.value = '2026-04-26T00:00';
  toInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await flush();

  // Find the latest call that has both from and to.
  const filteredCall = [...calls]
    .reverse()
    .find((u) => u.startsWith('/api/audit') && u.includes('from=') && u.includes('to='));
  assert.ok(filteredCall, `expected /api/audit URL with from= and to=, got: ${calls.join(', ')}`);
});

test('filtering by project sets project= query param', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch, calls } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: 2 }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const projectSelect = root.querySelector('select[name="project"]');
  assert.ok(projectSelect, 'project select rendered');
  projectSelect.value = 'payments-2.7';
  projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await flush();

  const filteredCall = calls.find(
    (u) => u.startsWith('/api/audit') && /project=payments-2\.7/.test(u),
  );
  assert.ok(filteredCall, `expected /api/audit URL with project=payments-2.7, got: ${calls.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('next button increments offset by limit and clamps prev at 0', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  // total=250 so multiple pages are available.
  const { fetch, calls } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: 250 }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const nextBtn = root.querySelector('.audit-next');
  const prevBtn = root.querySelector('.audit-prev');
  assert.ok(nextBtn && prevBtn, 'pagination buttons rendered');
  assert.equal(prevBtn.disabled, true, 'prev disabled on first page');

  nextBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();

  const offset100Call = calls.find(
    (u) => u.startsWith('/api/audit') && /offset=100\b/.test(u),
  );
  assert.ok(offset100Call, `expected /api/audit URL with offset=100, got: ${calls.join(', ')}`);

  // Second next -> offset=200.
  nextBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
  const offset200Call = calls.find(
    (u) => u.startsWith('/api/audit') && /offset=200\b/.test(u),
  );
  assert.ok(offset200Call, `expected /api/audit URL with offset=200, got: ${calls.join(', ')}`);

  // Prev twice should clamp at 0 (which omits offset query param entirely).
  prevBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
  prevBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
  prevBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();

  const finalState = view.getState();
  assert.equal(finalState.offset, 0, 'offset clamps at 0');
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test('empty state is shown when API returns no entries', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: [], total: 0 }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const empty = root.querySelector('.audit-empty');
  assert.ok(empty, 'empty state element rendered');
  assert.equal(empty.hidden, false, 'empty state visible');
  assert.match(empty.textContent, /No audit entries match filters/);

  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 0, 'no rows rendered');
});

// ---------------------------------------------------------------------------
// AC-014-04: APPEND-ONLY VERIFICATION
// ---------------------------------------------------------------------------
// The audit log is append-only at storage (FR-014). The UI MUST NOT expose
// any affordance that would imply mutation of an existing entry. These
// tests assert the rendered DOM contains:
//   1. Zero <button> elements with mutation-suggestive labels.
//   2. Zero <input> elements bound to an audit entry (e.g. inside a row).
//   3. No <form> elements that POST/PUT/DELETE/PATCH to /api/audit.
// ---------------------------------------------------------------------------

test('AC-014-04: rendered DOM has zero mutation buttons (edit/delete/remove/update/modify)', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: sampleEntries.length }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const buttons = Array.from(root.querySelectorAll('button'));
  const offending = buttons.filter((b) =>
    /edit|delete|remove|update|modify|destroy|drop|truncate/i.test(
      `${b.textContent} ${b.className} ${b.id} ${b.getAttribute('aria-label') || ''}`,
    ),
  );
  assert.equal(
    offending.length,
    0,
    `audit UI must not render mutation buttons; found: ${offending
      .map((b) => `<button>${b.textContent}</button>`)
      .join(', ')}`,
  );
});

test('AC-014-04: no <input> inside any audit entry row (entries are read-only)', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: sampleEntries.length }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const rowInputs = root.querySelectorAll('tbody tr input, tbody tr textarea, tbody tr select');
  assert.equal(rowInputs.length, 0, 'no editable controls bound to audit entries');

  // Also ensure no form action targets /api/audit with a mutation method.
  const forms = Array.from(root.querySelectorAll('form'));
  for (const form of forms) {
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    const action = form.getAttribute('action') || '';
    if (action.includes('/api/audit')) {
      assert.equal(method, 'get', `form targeting /api/audit must use GET, found ${method}`);
    }
  }
});

test('AC-014-04: no contenteditable cells in the audit table', async (t) => {
  const dom = setupDom();
  t.after(teardownDom);

  const { fetch } = makeFetch({
    '/api/projects': { projects: sampleProjects },
    '/api/audit': () => ({ entries: sampleEntries, total: sampleEntries.length }),
  });

  const { mountAudit } = await importFresh();
  const root = dom.window.document.getElementById('audit-tab');
  const view = mountAudit({ root, fetchImpl: fetch, doc: dom.window.document });
  await view.ready;
  await flush();

  const editableCells = root.querySelectorAll(
    'tbody [contenteditable=""], tbody [contenteditable="true"]',
  );
  assert.equal(editableCells.length, 0, 'audit table cells must not be contenteditable');
});

// ---------------------------------------------------------------------------
// Module hygiene — the public surface does not include mutation entry points
// ---------------------------------------------------------------------------

test('module exports do not include mutation functions', async () => {
  const mod = await importFresh();
  const allowed = new Set(['mountAudit', 'default']);
  const banned = /delete|remove|update|edit|patch|modify|destroy|truncate/i;
  for (const name of Object.keys(mod)) {
    assert.ok(allowed.has(name) || !banned.test(name),
      `unexpected mutation-named export: ${name}`);
  }
});
