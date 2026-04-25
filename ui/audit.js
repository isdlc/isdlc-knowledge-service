// ui/audit.js — Web UI: Audit Log tab (T027)
//
// Traces: FR-014 (AC-014-03 searchable/filterable, AC-014-04 append-only)
// Backend contract: GET /api/audit?project=X&action=Y&from=ISO&to=ISO&limit=N&offset=N
//   -> { entries: AuditEntry[], total: number }
// AuditEntry: { timestamp, action, project_id?, details?, ip_address? }
//
// CONSTITUTIONAL CONSTRAINT (FR-014, AC-014-04):
//   The audit log is APPEND-ONLY. This module MUST NOT render any UI
//   affordance that would let a user mutate, edit, delete, or otherwise
//   modify an existing audit entry. The only inputs rendered are the
//   filter controls (read-only against entries) and pagination buttons.
//   Any future change that introduces an entry-bound <input>, an
//   "edit"/"delete"/"remove" button, or a form field whose name targets
//   an entry id violates this contract and will be caught by the
//   accompanying tests in tests/unit/ui/audit.test.js.

const DEFAULT_LIMIT = 100;

/**
 * Mount the Audit Log tab into the given root element.
 *
 * @param {object} options
 * @param {HTMLElement} options.root        Mount point (e.g. #audit-tab).
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch (for tests).
 * @param {Document}     [options.doc]       Injectable document (for tests).
 * @returns {{ refresh: () => Promise<void>, getState: () => object }}
 */
export function mountAudit({ root, fetchImpl, doc } = {}) {
  if (!root) throw new Error('mountAudit: root element is required');

  const ownerDocument = doc || root.ownerDocument || globalThis.document;
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new Error('mountAudit: fetch implementation is required');
  }

  const state = {
    project: '',
    action: '',
    from: '',
    to: '',
    limit: DEFAULT_LIMIT,
    offset: 0,
    total: 0,
    entries: [],
    lastUrl: null,
  };

  // ---------- DOM construction (no entry-bound inputs/buttons) ----------
  root.replaceChildren();
  root.classList.add('audit-tab');

  const filters = ownerDocument.createElement('form');
  filters.className = 'audit-filters';
  filters.setAttribute('role', 'search');
  // Prevent native submit — filtering is reactive on change.
  filters.addEventListener('submit', (event) => event.preventDefault());

  const projectSelect = ownerDocument.createElement('select');
  projectSelect.name = 'project';
  projectSelect.setAttribute('aria-label', 'Filter by project');
  const allProjectsOption = ownerDocument.createElement('option');
  allProjectsOption.value = '';
  allProjectsOption.textContent = 'All projects';
  projectSelect.appendChild(allProjectsOption);

  const actionInput = ownerDocument.createElement('input');
  actionInput.type = 'text';
  actionInput.name = 'action';
  actionInput.placeholder = 'Filter by action';
  actionInput.setAttribute('aria-label', 'Filter by action');

  const fromInput = ownerDocument.createElement('input');
  fromInput.type = 'datetime-local';
  fromInput.name = 'from';
  fromInput.setAttribute('aria-label', 'Filter from timestamp');

  const toInput = ownerDocument.createElement('input');
  toInput.type = 'datetime-local';
  toInput.name = 'to';
  toInput.setAttribute('aria-label', 'Filter to timestamp');

  const limitInput = ownerDocument.createElement('input');
  limitInput.type = 'number';
  limitInput.name = 'limit';
  limitInput.min = '1';
  limitInput.value = String(DEFAULT_LIMIT);
  limitInput.setAttribute('aria-label', 'Page size');

  filters.append(
    labelled(ownerDocument, 'Project', projectSelect),
    labelled(ownerDocument, 'Action', actionInput),
    labelled(ownerDocument, 'From', fromInput),
    labelled(ownerDocument, 'To', toInput),
    labelled(ownerDocument, 'Limit', limitInput),
  );

  const table = ownerDocument.createElement('table');
  table.className = 'audit-table';
  const thead = ownerDocument.createElement('thead');
  const headerRow = ownerDocument.createElement('tr');
  for (const heading of ['Timestamp', 'Action', 'Project', 'Details', 'IP Address']) {
    const th = ownerDocument.createElement('th');
    th.scope = 'col';
    th.textContent = heading;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  const tbody = ownerDocument.createElement('tbody');
  table.append(thead, tbody);

  const emptyState = ownerDocument.createElement('p');
  emptyState.className = 'audit-empty';
  emptyState.textContent = 'No audit entries match filters';
  emptyState.hidden = true;

  // Pagination — buttons are NAVIGATIONAL ONLY. They do not bind to any
  // audit entry and cannot mutate state on the server.
  const pagination = ownerDocument.createElement('nav');
  pagination.className = 'audit-pagination';
  pagination.setAttribute('aria-label', 'Audit log pagination');

  const prevButton = ownerDocument.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'audit-prev';
  prevButton.textContent = 'Previous';

  const nextButton = ownerDocument.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'audit-next';
  nextButton.textContent = 'Next';

  const status = ownerDocument.createElement('span');
  status.className = 'audit-status';
  status.setAttribute('aria-live', 'polite');

  pagination.append(prevButton, status, nextButton);
  root.append(filters, table, emptyState, pagination);

  // ---------- Behaviour ----------
  async function loadProjects() {
    try {
      const res = await fetcher('/api/projects');
      if (!res || !res.ok) return;
      const payload = await res.json();
      const projects = Array.isArray(payload) ? payload : payload?.projects || [];
      for (const project of projects) {
        const option = ownerDocument.createElement('option');
        option.value = project.id;
        option.textContent = project.name ? `${project.name} (${project.id})` : project.id;
        projectSelect.appendChild(option);
      }
    } catch {
      /* Project list is best-effort; filter still works as free-form. */
    }
  }

  async function refresh() {
    const params = new URLSearchParams();
    if (state.project) params.set('project', state.project);
    if (state.action) params.set('action', state.action);
    if (state.from) params.set('from', toIsoOrEmpty(state.from));
    if (state.to) params.set('to', toIsoOrEmpty(state.to));
    params.set('limit', String(state.limit));
    if (state.offset > 0) params.set('offset', String(state.offset));

    const url = `/api/audit?${params.toString()}`;
    state.lastUrl = url;

    let payload = { entries: [], total: 0 };
    try {
      const res = await fetcher(url);
      if (res && res.ok) {
        payload = await res.json();
      }
    } catch {
      payload = { entries: [], total: 0 };
    }

    state.entries = Array.isArray(payload.entries) ? payload.entries : [];
    state.total = Number.isFinite(payload.total) ? payload.total : state.entries.length;

    render();
  }

  function render() {
    tbody.replaceChildren();

    if (state.entries.length === 0) {
      emptyState.hidden = false;
      table.hidden = true;
    } else {
      emptyState.hidden = true;
      table.hidden = false;
      for (const entry of state.entries) {
        tbody.appendChild(renderRow(ownerDocument, entry));
      }
    }

    const start = state.offset + (state.entries.length === 0 ? 0 : 1);
    const end = state.offset + state.entries.length;
    status.textContent =
      state.entries.length === 0
        ? `0 of ${state.total}`
        : `${start}–${end} of ${state.total}`;

    prevButton.disabled = state.offset <= 0;
    nextButton.disabled = state.offset + state.entries.length >= state.total;
  }

  // ---------- Wiring ----------
  projectSelect.addEventListener('change', () => {
    state.project = projectSelect.value;
    state.offset = 0;
    refresh();
  });
  actionInput.addEventListener('change', () => {
    state.action = actionInput.value.trim();
    state.offset = 0;
    refresh();
  });
  fromInput.addEventListener('change', () => {
    state.from = fromInput.value;
    state.offset = 0;
    refresh();
  });
  toInput.addEventListener('change', () => {
    state.to = toInput.value;
    state.offset = 0;
    refresh();
  });
  limitInput.addEventListener('change', () => {
    const next = Number.parseInt(limitInput.value, 10);
    state.limit = Number.isFinite(next) && next > 0 ? next : DEFAULT_LIMIT;
    state.offset = 0;
    refresh();
  });

  prevButton.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    refresh();
  });
  nextButton.addEventListener('click', () => {
    state.offset = state.offset + state.limit;
    refresh();
  });

  // Initial load: projects (best-effort) then audit entries.
  const ready = (async () => {
    await loadProjects();
    await refresh();
  })();

  return {
    refresh,
    getState: () => ({ ...state }),
    ready,
  };
}

// ---------- helpers ----------

function labelled(doc, text, control) {
  const label = doc.createElement('label');
  const span = doc.createElement('span');
  span.textContent = text;
  label.append(span, control);
  return label;
}

function toIsoOrEmpty(value) {
  if (!value) return '';
  // datetime-local values are local-naive; treat as UTC for the API filter.
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

function renderRow(doc, entry) {
  const row = doc.createElement('tr');
  row.className = 'audit-row';

  const cells = [
    entry.timestamp || '',
    entry.action || '',
    entry.project_id || '',
    summariseDetails(entry.details),
    entry.ip_address || '',
  ];

  for (const value of cells) {
    const td = doc.createElement('td');
    td.textContent = value;
    row.appendChild(td);
  }
  return row;
}

function summariseDetails(details) {
  if (details === undefined || details === null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

// Auto-mount when running in a browser with the expected placeholder.
// Tests import mountAudit directly and bypass this branch.
if (typeof globalThis.document !== 'undefined' && !globalThis.__ISDLC_AUDIT_NO_AUTOMOUNT) {
  const mount = globalThis.document.getElementById('audit-tab');
  if (mount && !mount.dataset.mounted) {
    mount.dataset.mounted = '1';
    try {
      mountAudit({ root: mount });
    } catch {
      // Auto-mount is best-effort; failures must not break other tabs.
    }
  }
}
