// T022 + T028: REST API — System endpoints (health, memory, metrics, audit query).
// Traces: FR-014 (audit query), FR-015 (AC-015-01 metrics, AC-015-07 health)
// See: docs/requirements/REQ-GH-263-.../interface-spec.md GET /api/system/health,
//      GET /api/system/memory, GET /metrics, GET /api/audit
//
// Endpoints:
//   GET /api/system/health   -> { api, worker, projects, total_documents, memory_used_mb, memory_available_mb }
//   GET /api/system/memory   -> { used_mb, available_mb, models: [...] }
//   GET /metrics             -> Prometheus text (T028 wires this to src/observability/metrics.js)
//   GET /api/audit           -> { entries, total } with project/action/from/to/limit/offset filters
//
// `worker` health is observed indirectly: the worker process touches a heartbeat key in the
// queue (or the deps may inject a workerHealth() probe). For T022 we expose either an
// injected probe (deps.workerHealth) or default to "up" when the queue has at least one
// "running" job; otherwise "unknown".

import { totalmem, freemem } from 'node:os';
import { getMetricsText as defaultGetMetricsText } from '../../observability/metrics.js';

const BYTES_PER_MB = 1024 * 1024;

/**
 * Default OS-level memory probe. Returned object mirrors the contract shared with system/memory
 * route handlers and the modelManager-derived numbers used in /api/system/health.
 */
function defaultMemoryUsage() {
  const total = totalmem();
  const free = freemem();
  return {
    used_mb: Math.round((total - free) / BYTES_PER_MB),
    available_mb: Math.round(free / BYTES_PER_MB),
  };
}

/**
 * Probe worker liveness. Heuristic when no explicit probe is provided:
 *   - if `deps.workerHealth` is a function -> call it
 *   - else if queue has a 'running' job -> "up"
 *   - else if queue is reachable and has 'queued' jobs -> "up" (worker assumed running)
 *   - else "unknown"
 *
 * @param {object} deps
 * @returns {string}
 */
function probeWorker(deps) {
  if (typeof deps.workerHealth === 'function') {
    try {
      const v = deps.workerHealth();
      if (v === 'up' || v === 'down' || v === 'unknown') return v;
    } catch {
      return 'down';
    }
  }
  if (typeof deps.queue?.listJobs === 'function') {
    try {
      const running = deps.queue.listJobs({ status: 'running' });
      if (running && running.length > 0) return 'up';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Sum document counts across projects. Falls back to 0 when projects don't carry the field.
 *
 * @param {Array<object>} projects
 */
function totalDocuments(projects) {
  return projects.reduce((sum, p) => sum + (p.document_count ?? 0), 0);
}

/**
 * @param {import('../rest.js').RouteDeps} deps
 */
export function createSystemRoutes(deps) {
  const memoryUsage = deps.memoryUsage || defaultMemoryUsage;
  // T028: deps.getMetricsText is injectable for tests; defaults to the
  // real prom-client-backed implementation in src/observability/metrics.js.
  const getMetricsText = deps.getMetricsText || defaultGetMetricsText;

  return [
    // -------------------------------------------------------------------- HEALTH
    {
      method: 'GET',
      pattern: '/api/system/health',
      handle: async () => {
        const projects = (await deps.configStore.listProjects?.()) ?? [];
        const mem = memoryUsage();
        return {
          status: 200,
          body: {
            api: 'up',
            worker: probeWorker(deps),
            projects: projects.length,
            total_documents: totalDocuments(projects),
            memory_used_mb: mem.used_mb,
            memory_available_mb: mem.available_mb,
          },
        };
      },
    },

    // -------------------------------------------------------------------- MEMORY
    {
      method: 'GET',
      pattern: '/api/system/memory',
      handle: async () => {
        const mem = memoryUsage();
        const models =
          deps.modelManager?.getStatus?.().map((m) => ({
            name: m.name,
            loaded: m.loaded,
            pinned: m.pinned,
            memory_mb: m.memory_mb ?? 0,
          })) ?? [];
        return {
          status: 200,
          body: {
            used_mb: mem.used_mb,
            available_mb: mem.available_mb,
            models,
          },
        };
      },
    },

    // -------------------------------------------------------------------- METRICS (T028)
    {
      method: 'GET',
      pattern: '/metrics',
      handle: async () => {
        // T028: serve the real Prometheus exposition produced by prom-client.
        const text = await getMetricsText();
        return {
          status: 200,
          body: text,
          headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
        };
      },
    },

    // -------------------------------------------------------------------- AUDIT QUERY
    {
      method: 'GET',
      pattern: '/api/audit',
      handle: async (req) => {
        const q = req.query || {};
        /** @type {object} */
        const filters = {};
        if (q.project) filters.project = q.project;
        if (q.action) filters.action = q.action;
        if (q.from) filters.from = q.from;
        if (q.to) filters.to = q.to;
        if (q.limit !== undefined) {
          const n = Number(q.limit);
          if (!Number.isFinite(n) || n < 0) {
            return { status: 400, body: { error: 'INVALID_REQUEST', message: 'limit must be a non-negative number' } };
          }
          filters.limit = n;
        }
        if (q.offset !== undefined) {
          const n = Number(q.offset);
          if (!Number.isFinite(n) || n < 0) {
            return { status: 400, body: { error: 'INVALID_REQUEST', message: 'offset must be a non-negative number' } };
          }
          filters.offset = n;
        }
        const entries = await deps.auditLogger.query(filters);
        return {
          status: 200,
          body: { entries, total: entries.length },
        };
      },
    },
  ];
}
