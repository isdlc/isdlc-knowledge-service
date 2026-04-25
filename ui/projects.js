// T024: Web UI — Projects tab. Vanilla ESM, no framework, no build step (CON-004).
// Traces: FR-001 (CRUD), FR-003 (sources), FR-005 (rebuild), FR-009 (embedding config).
//
// Public API (exported for unit tests via jsdom):
//   - init(doc)                 -> wire DOM events and load projects on page load
//   - loadProjects(doc)         -> GET /api/projects, render the table
//   - openCreateForm(doc)       -> show empty form (Create flow)
//   - openEditForm(doc, project)-> show form pre-filled with project (Edit flow)
//   - submitProjectForm(doc)    -> POST or PUT depending on hidden id field
//   - deleteProject(doc, id)    -> confirm + DELETE /api/projects/:id
//   - rebuildProject(doc, id)   -> POST /api/projects/:id/rebuild
//   - showToast(doc, msg, kind) -> append a toast div (auto-removes after 4s)
//
// All network I/O goes through the browser's `fetch`. Tests stub `globalThis.fetch`.
// All DOM access goes through the `doc` parameter (defaults to `document`) so jsdom
// can drive the module without actually running it as a <script>.

/* eslint-env browser */
/* global window, document, confirm */

// ---------------------------------------------------------------------------
// Toast notifications — small, auto-dismissing.
// ---------------------------------------------------------------------------

export function showToast(doc, message, kind = 'info') {
  const container = doc.getElementById('toast-container');
  if (!container) return null;
  const toast = doc.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  container.appendChild(toast);
  // Best-effort auto-dismiss; tests can read the toast before this fires.
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (win && typeof win.setTimeout === 'function') {
    win.setTimeout(() => toast.remove(), 4000);
  }
  return toast;
}

// ---------------------------------------------------------------------------
// Source rows — dynamic add/remove inside the project form.
// ---------------------------------------------------------------------------

function makeSourceRow(doc, source = { type: 'git', url: '', branch: 'main' }) {
  const row = doc.createElement('div');
  row.className = 'source-row';
  row.innerHTML = `
    <select class="source-type">
      <option value="git">git</option>
      <option value="confluence">confluence</option>
      <option value="gdrive">gdrive</option>
      <option value="filesystem">filesystem</option>
    </select>
    <input class="source-url" type="text" placeholder="URL or path" />
    <input class="source-branch" type="text" placeholder="branch (git only)" />
    <button type="button" class="btn danger source-remove">Remove</button>
  `;
  row.querySelector('.source-type').value = source.type || 'git';
  row.querySelector('.source-url').value = source.url || '';
  row.querySelector('.source-branch').value = source.branch || '';
  row.querySelector('.source-remove').addEventListener('click', () => row.remove());
  return row;
}

function readSources(doc) {
  const rows = doc.querySelectorAll('#sources-list .source-row');
  const out = [];
  rows.forEach((row) => {
    const type = row.querySelector('.source-type').value;
    const url = row.querySelector('.source-url').value.trim();
    const branch = row.querySelector('.source-branch').value.trim();
    if (!url) return;
    const entry = { type, url };
    if (type === 'git' && branch) entry.branch = branch;
    out.push(entry);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Render — table + form helpers.
// ---------------------------------------------------------------------------

export function renderProjectsTable(doc, projects) {
  const tbody = doc.querySelector('#projects-table tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  if (!projects || projects.length === 0) {
    const tr = doc.createElement('tr');
    tr.innerHTML = '<td colspan="6" class="placeholder">No projects yet.</td>';
    tbody.appendChild(tr);
    return;
  }
  for (const p of projects) {
    const tr = doc.createElement('tr');
    tr.dataset.projectId = p.id;
    const sourcesCount = Array.isArray(p.sources) ? p.sources.length : 0;
    tr.innerHTML = `
      <td>${escapeHtml(p.name || '')}</td>
      <td>${escapeHtml(p.version || '')}</td>
      <td>${sourcesCount}</td>
      <td>${escapeHtml(p.status || 'ready')}</td>
      <td>${Number(p.document_count || 0)}</td>
      <td class="btn-row">
        <button class="btn secondary btn-edit">Edit</button>
        <button class="btn secondary btn-rebuild">Rebuild</button>
        <button class="btn danger btn-delete">Delete</button>
      </td>
    `;
    // Stash the full record for edit pre-fill — avoids a re-fetch.
    tr._project = p;
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Networking — all calls share a small helper for error mapping.
// ---------------------------------------------------------------------------

async function apiCall(doc, method, url, body) {
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    showToast(doc, `Network error: ${err.message || err}`, 'error');
    throw err;
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    showToast(doc, msg, 'error');
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Public actions.
// ---------------------------------------------------------------------------

export async function loadProjects(doc = document) {
  try {
    const data = await apiCall(doc, 'GET', '/api/projects');
    renderProjectsTable(doc, (data && data.projects) || []);
    return data;
  } catch {
    renderProjectsTable(doc, []);
    return null;
  }
}

export function openCreateForm(doc = document) {
  const modal = doc.getElementById('project-form-modal');
  const form = doc.getElementById('project-form');
  const title = doc.getElementById('project-form-title');
  if (!modal || !form) return;
  title.textContent = 'New Project';
  form.reset();
  form.elements.id.value = '';
  const sourcesList = doc.getElementById('sources-list');
  sourcesList.replaceChildren();
  modal.classList.remove('hidden');
}

export function openEditForm(doc = document, project) {
  const modal = doc.getElementById('project-form-modal');
  const form = doc.getElementById('project-form');
  const title = doc.getElementById('project-form-title');
  if (!modal || !form || !project) return;
  title.textContent = `Edit Project: ${project.name}`;
  form.reset();
  form.elements.id.value = project.id || '';
  form.elements.name.value = project.name || '';
  form.elements.version.value = project.version || '';
  form.elements.description.value = project.description || '';
  if (project.model_config) {
    form.elements.model_source.value = project.model_config.source || 'local';
    form.elements.model_name.value = project.model_config.model || '';
    form.elements.model_precision.value = project.model_config.precision || 'fp32';
    form.elements.model_api_key.value = project.model_config.api_key || '';
  }
  if (project.vectordb_config) {
    form.elements.vectordb_backend.value = project.vectordb_config.backend || 'sqlite-vec';
    form.elements.vectordb_target.value =
      project.vectordb_config.path || project.vectordb_config.url || '';
  }
  const sourcesList = doc.getElementById('sources-list');
  sourcesList.replaceChildren();
  for (const src of project.sources || []) {
    sourcesList.appendChild(makeSourceRow(doc, src));
  }
  modal.classList.remove('hidden');
}

export function closeForm(doc = document) {
  const modal = doc.getElementById('project-form-modal');
  if (modal) modal.classList.add('hidden');
}

export function buildProjectPayload(doc) {
  const form = doc.getElementById('project-form');
  const fd = new FormData(form);
  const payload = {
    name: (fd.get('name') || '').toString().trim(),
    version: (fd.get('version') || '').toString().trim(),
    description: (fd.get('description') || '').toString(),
    sources: readSources(doc),
    model_config: {
      source: fd.get('model_source') || 'local',
      model: (fd.get('model_name') || '').toString().trim(),
    },
    vectordb_config: {
      backend: fd.get('vectordb_backend') || 'sqlite-vec',
    },
  };
  const modelSource = payload.model_config.source;
  if (modelSource === 'local') {
    payload.model_config.precision = fd.get('model_precision') || 'fp32';
  } else {
    const key = (fd.get('model_api_key') || '').toString();
    if (key) payload.model_config.api_key = key;
  }
  const target = (fd.get('vectordb_target') || '').toString().trim();
  if (target) {
    if (payload.vectordb_config.backend === 'sqlite-vec') {
      payload.vectordb_config.path = target;
    } else {
      payload.vectordb_config.url = target;
    }
  }
  return payload;
}

export async function submitProjectForm(doc = document) {
  const form = doc.getElementById('project-form');
  if (!form) return null;
  const id = (form.elements.id.value || '').trim();
  const payload = buildProjectPayload(doc);
  try {
    if (id) {
      await apiCall(doc, 'PUT', `/api/projects/${encodeURIComponent(id)}`, payload);
      showToast(doc, `Project "${payload.name}" updated`, 'success');
    } else {
      await apiCall(doc, 'POST', '/api/projects', payload);
      showToast(doc, `Project "${payload.name}" created`, 'success');
    }
    closeForm(doc);
    await loadProjects(doc);
    return true;
  } catch {
    return false;
  }
}

export async function deleteProject(doc = document, id) {
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const confirmFn = (win && win.confirm) || (typeof confirm === 'function' ? confirm : null);
  if (confirmFn && !confirmFn(`Delete project ${id}? This cannot be undone.`)) return false;
  try {
    await apiCall(doc, 'DELETE', `/api/projects/${encodeURIComponent(id)}`);
    showToast(doc, `Project ${id} deleted`, 'success');
    await loadProjects(doc);
    return true;
  } catch {
    return false;
  }
}

export async function rebuildProject(doc = document, id) {
  try {
    const res = await apiCall(doc, 'POST', `/api/projects/${encodeURIComponent(id)}/rebuild`);
    showToast(doc, `Rebuild queued (job ${res && res.job_id})`, 'success');
    return res;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wiring — attach event listeners to the static DOM.
// ---------------------------------------------------------------------------

export function init(doc = document) {
  const newBtn = doc.getElementById('btn-new-project');
  if (newBtn) newBtn.addEventListener('click', () => openCreateForm(doc));

  const cancelBtn = doc.getElementById('btn-cancel-form');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeForm(doc));

  const addSrcBtn = doc.getElementById('btn-add-source');
  if (addSrcBtn) {
    addSrcBtn.addEventListener('click', () => {
      doc.getElementById('sources-list').appendChild(makeSourceRow(doc));
    });
  }

  const form = doc.getElementById('project-form');
  if (form) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submitProjectForm(doc);
    });
  }

  // Delegated actions on table rows.
  const tbody = doc.querySelector('#projects-table tbody');
  if (tbody) {
    tbody.addEventListener('click', (ev) => {
      const btn = ev.target;
      if (!(btn instanceof Element)) return;
      const tr = btn.closest('tr');
      if (!tr) return;
      const id = tr.dataset.projectId;
      if (!id) return;
      if (btn.classList.contains('btn-edit')) openEditForm(doc, tr._project || { id });
      else if (btn.classList.contains('btn-rebuild')) rebuildProject(doc, id);
      else if (btn.classList.contains('btn-delete')) deleteProject(doc, id);
    });
  }

  loadProjects(doc);
}

// Auto-init when loaded as a module in the browser. Skip during tests
// (tests import the module before constructing the DOM, then call init()).
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
const isTestEnv = typeof process !== 'undefined' && process.env && process.env.NODE_TEST_CONTEXT;
if (isBrowser && !isTestEnv) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(document));
  } else {
    init(document);
  }
}
