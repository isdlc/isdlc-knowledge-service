// ui/refresh-history.js — Refresh History tab (per-project timeline, filterable).
// Traces: FR-007 AC-007-05.
//
// Public API:
//   mount(rootElement) -> Promise<void>
//
// Behaviour:
//   - Loads project list from GET /api/projects.
//   - On project selection, fetches GET /api/projects/:id/status and renders
//     the refresh_history[] array as a timeline table.
//   - Supports client-side filters: type (full|incremental|all),
//     status (success|partial|failure|all), trigger_source (substring match).
//   - Empty state: "No refresh history yet".

const TYPE_BADGE_COLOR = {
  full: 'badge-blue',
  incremental: 'badge-green',
};

const STATUS_BADGE_COLOR = {
  success: 'badge-green',
  partial: 'badge-yellow',
  failure: 'badge-red',
  failed: 'badge-red',
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badge(value, colorMap) {
  const cls = colorMap[value] || 'badge-grey';
  return `<span class="badge ${cls}">${escapeHtml(value)}</span>`;
}

function renderShell(root) {
  root.innerHTML = `
    <div class="refresh-history-panel">
      <h2>Refresh History</h2>
      <div class="refresh-history-controls">
        <label>
          Project:
          <select id="refresh-history-project">
            <option value="">-- select project --</option>
          </select>
        </label>
        <label>
          Type:
          <select id="refresh-history-filter-type">
            <option value="all">all</option>
            <option value="full">full</option>
            <option value="incremental">incremental</option>
          </select>
        </label>
        <label>
          Status:
          <select id="refresh-history-filter-status">
            <option value="all">all</option>
            <option value="success">success</option>
            <option value="partial">partial</option>
            <option value="failure">failure</option>
          </select>
        </label>
        <label>
          Trigger:
          <input id="refresh-history-filter-trigger" type="text" placeholder="filter trigger source"/>
        </label>
      </div>
      <table id="refresh-history-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Type</th>
            <th>Trigger</th>
            <th>Duration (s)</th>
            <th>Documents</th>
            <th>Status</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <div id="refresh-history-empty" style="display: none;">
        No refresh history yet
      </div>
    </div>
  `;
}

async function loadProjects() {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error(`GET /api/projects -> ${res.status}`);
  const body = await res.json();
  return body.projects || [];
}

function populateProjectPicker(select, projects) {
  // Preserve the placeholder (first option), append the rest.
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name
      ? `${p.name}${p.version ? ` (${p.version})` : ''}`
      : p.id;
    select.appendChild(opt);
  }
}

async function loadStatus(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/status`);
  if (!res.ok) throw new Error(`GET status -> ${res.status}`);
  return await res.json();
}

function renderRows(tbody, history) {
  tbody.innerHTML = '';
  for (const rec of history) {
    const tr = document.createElement('tr');
    tr.dataset.type = rec.type || '';
    tr.dataset.status = rec.status || '';
    tr.dataset.trigger = (rec.trigger_source || '').toLowerCase();
    tr.innerHTML = `
      <td>${escapeHtml(rec.timestamp || '')}</td>
      <td>${badge(rec.type || '', TYPE_BADGE_COLOR)}</td>
      <td>${escapeHtml(rec.trigger_source || '')}</td>
      <td>${escapeHtml(
        rec.duration_seconds === undefined || rec.duration_seconds === null
          ? ''
          : rec.duration_seconds,
      )}</td>
      <td>${escapeHtml(
        rec.documents_processed === undefined ||
          rec.documents_processed === null
          ? ''
          : rec.documents_processed,
      )}</td>
      <td>${badge(rec.status || '', STATUS_BADGE_COLOR)}</td>
      <td>${escapeHtml(rec.error || '')}</td>
    `;
    tbody.appendChild(tr);
  }
}

function applyFilters(root) {
  const typeVal = root.querySelector('#refresh-history-filter-type').value;
  const statusVal = root.querySelector('#refresh-history-filter-status').value;
  const triggerVal = root
    .querySelector('#refresh-history-filter-trigger')
    .value.trim()
    .toLowerCase();

  const rows = root.querySelectorAll('#refresh-history-table tbody tr');
  for (const row of rows) {
    const okType = typeVal === 'all' || row.dataset.type === typeVal;
    const okStatus = statusVal === 'all' || row.dataset.status === statusVal;
    const okTrigger =
      triggerVal === '' || row.dataset.trigger.includes(triggerVal);
    row.style.display = okType && okStatus && okTrigger ? '' : 'none';
  }
}

function updateEmptyState(root, hasRecords) {
  const empty = root.querySelector('#refresh-history-empty');
  const table = root.querySelector('#refresh-history-table');
  if (hasRecords) {
    empty.style.display = 'none';
    table.style.display = '';
  } else {
    empty.style.display = '';
    table.style.display = 'none';
  }
}

export async function mount(root) {
  if (!root) throw new Error('mount: root element required');
  renderShell(root);

  const select = root.querySelector('#refresh-history-project');
  const tbody = root.querySelector('#refresh-history-table tbody');
  const typeFilter = root.querySelector('#refresh-history-filter-type');
  const statusFilter = root.querySelector('#refresh-history-filter-status');
  const triggerFilter = root.querySelector('#refresh-history-filter-trigger');

  // Initial state: no project selected -> show empty state.
  updateEmptyState(root, false);

  // Load projects.
  try {
    const projects = await loadProjects();
    populateProjectPicker(select, projects);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to load projects', err);
  }

  // Project selection -> fetch status and render history.
  select.addEventListener('change', async () => {
    const projectId = select.value;
    if (!projectId) {
      tbody.innerHTML = '';
      updateEmptyState(root, false);
      return;
    }
    try {
      const status = await loadStatus(projectId);
      const history = Array.isArray(status.refresh_history)
        ? status.refresh_history
        : [];
      renderRows(tbody, history);
      updateEmptyState(root, history.length > 0);
      applyFilters(root);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load refresh history', err);
      tbody.innerHTML = '';
      updateEmptyState(root, false);
    }
  });

  // Filter wiring.
  typeFilter.addEventListener('change', () => applyFilters(root));
  statusFilter.addEventListener('change', () => applyFilters(root));
  triggerFilter.addEventListener('input', () => applyFilters(root));
}

export default { mount };
