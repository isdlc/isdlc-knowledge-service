// T025: Web UI — Monitoring tab.
// Traces: FR-011 (model pin/unpin), FR-015 (operational monitoring)
// See: docs/requirements/REQ-GH-263-.../interface-spec.md
//
// Renders three sections into a host element (typically #monitoring-tab):
//   1. Project status cards — name+version, staleness badge, doc count,
//      last refresh, active jobs.
//   2. Models — name, type (local|cloud), loaded badge, pinned badge,
//      memory_mb, Pin/Unpin buttons (local only).
//   3. Memory bar — used / total visualization.
//
// Auto-refreshes every `intervalMs` (default 10_000). `unmount()` clears
// the timer to prevent leaks.
//
// Module shape (factory):
//   const m = createMonitoring({ fetch?, intervalMs? });
//   await m.mount(hostElement);
//   m.unmount();
//
// Exposing `fetch` as an injectable dependency keeps the module unit-testable
// under jsdom + node:test without monkey-patching globals.

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * @param {object} [opts]
 * @param {typeof globalThis.fetch} [opts.fetch]
 * @param {number} [opts.intervalMs]
 * @returns {{ mount(el: HTMLElement): Promise<void>, unmount(): void }}
 */
export function createMonitoring(opts = {}) {
  const fetchImpl = opts.fetch || (typeof globalThis !== 'undefined' && globalThis.fetch);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  if (typeof fetchImpl !== 'function') {
    throw new Error('createMonitoring requires a fetch implementation');
  }

  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let mounted = false;

  async function loadAndRender() {
    if (!host || !mounted) return;
    const [projectsRes, modelsRes, memoryRes] = await Promise.all([
      fetchImpl('/api/projects').then(safeJson).catch(() => ({ projects: [] })),
      fetchImpl('/api/models').then(safeJson).catch(() => ({ models: [] })),
      fetchImpl('/api/system/memory').then(safeJson).catch(() => ({
        used_mb: 0,
        available_mb: 0,
        models: [],
      })),
    ]);
    if (!mounted) return; // a late unmount during fetch
    render(host, {
      projects: projectsRes.projects || [],
      models: modelsRes.models || [],
      memory: memoryRes || { used_mb: 0, available_mb: 0 },
    });
  }

  function render(target, data) {
    target.innerHTML = '';
    target.appendChild(buildMemorySection(data.memory));
    target.appendChild(buildProjectsSection(data.projects));
    target.appendChild(buildModelsSection(data.models, onPinAction));
  }

  async function onPinAction(name, action) {
    const url = `/api/models/${encodeURIComponent(name)}/pin`;
    const method = action === 'pin' ? 'POST' : 'DELETE';
    try {
      await fetchImpl(url, { method, headers: { 'content-type': 'application/json' } });
    } catch {
      // Surface failures via re-render — the model list will show the
      // current authoritative state from /api/models.
    }
    await loadAndRender();
  }

  return {
    async mount(el) {
      if (!el) throw new Error('mount target is required');
      host = el;
      mounted = true;
      await loadAndRender();
      if (intervalMs > 0 && Number.isFinite(intervalMs)) {
        timer = setInterval(() => {
          // Fire-and-forget; render is idempotent.
          loadAndRender().catch(() => {});
        }, intervalMs);
      }
    },
    unmount() {
      mounted = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (host) {
        host.innerHTML = '';
        host = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeJson(res) {
  if (!res) return {};
  if (typeof res.json === 'function') {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }
  return {};
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, String(v));
    else if (k === 'onClick') node.addEventListener('click', v);
    else node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Memory section
// ---------------------------------------------------------------------------

function buildMemorySection(memory) {
  const used = Number(memory?.used_mb) || 0;
  const available = Number(memory?.available_mb) || 0;
  const total = used + available;
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;

  const fill = el('div', {
    class: 'memory-bar-fill',
    style: `width: ${percent}%`,
  });
  const bar = el('div', {
    class: 'memory-bar',
    'data-memory-bar': 'true',
    'data-percent': String(percent),
  }, [fill]);

  const label = el('div', { class: 'memory-label' }, [
    `Memory: ${used} MB used / ${total} MB total (${percent}%)`,
  ]);

  return el('section', { class: 'memory-section', 'data-section': 'memory' }, [
    el('h2', { text: 'System Memory' }),
    bar,
    label,
  ]);
}

// ---------------------------------------------------------------------------
// Projects section
// ---------------------------------------------------------------------------

function buildProjectsSection(projects) {
  const cards = projects.map(buildProjectCard);
  return el('section', { class: 'projects-section', 'data-section': 'projects' }, [
    el('h2', { text: 'Projects' }),
    el('div', { class: 'project-cards' }, cards.length
      ? cards
      : [el('p', { class: 'empty-state', text: 'No projects configured.' })]),
  ]);
}

function buildProjectCard(p) {
  const staleness = p.staleness || 'unknown';
  const badgeClass = stalenessClass(staleness);
  const badge = el('span', {
    class: `badge ${badgeClass}`,
    'data-staleness': staleness,
    text: staleness,
  });

  const docCount = p.document_count ?? 0;
  const lastRefresh = p.last_refresh || 'never';
  const activeJobsCount = Array.isArray(p.active_jobs) ? p.active_jobs.length : 0;

  return el('article', {
    class: 'project-card',
    'data-project-id': p.id || '',
  }, [
    el('header', { class: 'project-card-header' }, [
      el('h3', { text: `${p.name || p.id} ${p.version ? `(v${p.version})` : ''}` }),
      badge,
    ]),
    el('dl', { class: 'project-stats' }, [
      el('dt', { text: 'Documents' }),
      el('dd', { 'data-field': 'document-count', text: String(docCount) }),
      el('dt', { text: 'Last refresh' }),
      el('dd', { 'data-field': 'last-refresh', text: String(lastRefresh) }),
      el('dt', { text: 'Active jobs' }),
      el('dd', { 'data-field': 'active-jobs', text: String(activeJobsCount) }),
    ]),
  ]);
}

function stalenessClass(value) {
  switch (value) {
    case 'fresh': return 'badge-fresh badge-green';
    case 'stale': return 'badge-stale badge-amber';
    case 'unknown':
    default:
      return 'badge-unknown badge-red';
  }
}

// ---------------------------------------------------------------------------
// Models section
// ---------------------------------------------------------------------------

function buildModelsSection(models, onPinAction) {
  const rows = models.map((m) => buildModelRow(m, onPinAction));
  return el('section', { class: 'models-section', 'data-section': 'models' }, [
    el('h2', { text: 'Models' }),
    el('div', { class: 'model-rows' }, rows.length
      ? rows
      : [el('p', { class: 'empty-state', text: 'No models registered.' })]),
  ]);
}

function buildModelRow(m, onPinAction) {
  const isLocal = m.type === 'local';
  const memoryMb = m.memory_mb != null ? `${m.memory_mb} MB` : '—';

  const children = [
    el('span', { class: 'model-name', text: m.name }),
    el('span', { class: 'model-type', 'data-type': m.type, text: m.type }),
    el('span', {
      class: `badge ${m.loaded ? 'badge-loaded' : 'badge-unloaded'}`,
      'data-loaded': String(!!m.loaded),
      text: m.loaded ? 'loaded' : 'unloaded',
    }),
    el('span', {
      class: `badge ${m.pinned ? 'badge-pinned' : 'badge-unpinned'}`,
      'data-pinned': String(!!m.pinned),
      text: m.pinned ? 'pinned' : 'unpinned',
    }),
    el('span', { class: 'model-memory', text: memoryMb }),
  ];

  if (isLocal) {
    if (m.pinned) {
      children.push(
        el('button', {
          type: 'button',
          'data-action': 'unpin',
          'data-model': m.name,
          text: 'Unpin',
          onClick: () => onPinAction(m.name, 'unpin'),
        }),
      );
    } else {
      children.push(
        el('button', {
          type: 'button',
          'data-action': 'pin',
          'data-model': m.name,
          text: 'Pin',
          onClick: () => onPinAction(m.name, 'pin'),
        }),
      );
    }
  }

  return el('div', {
    class: 'model-row',
    'data-model': m.name,
    'data-type': m.type,
  }, children);
}
