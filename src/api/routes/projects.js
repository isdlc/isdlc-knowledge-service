// T022: REST API — Project CRUD + rebuild + status.
// Traces: FR-001 (CRUD), FR-005 (rebuild), FR-007 (web UI surface),
//         FR-014 (audit log), FR-015 (AC-015-08 status endpoint)
// See: docs/requirements/REQ-GH-263-.../interface-spec.md §REST API
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-API-001
//
// Endpoints:
//   GET    /api/projects                    -> { projects: [...] }
//   POST   /api/projects                    -> { project }      201 (409 dup, 400 validation)
//   GET    /api/projects/:id                -> { project }      (404)
//   PUT    /api/projects/:id                -> { project }      (404, 400)
//   DELETE /api/projects/:id                -> { deleted: true} (404)
//   POST   /api/projects/:id/rebuild        -> { job_id, status: "queued" } (404)
//   GET    /api/projects/:id/status         -> { staleness, document_count, ... } (404)
//
// Audit: every mutating endpoint records project_id, action, details, ip_address.

import { getClientIp } from '../rest.js';

/**
 * Map an InvalidProjectError to a 4xx response. Distinguishes "not found" by
 * inspecting the message; all other invalid-project conditions become 400.
 *
 * @param {Error} err
 */
function mapProjectError(err) {
  if (err && err.code === 'ERR-API-004') {
    return { status: 400, body: { error: 'BARE_CREDENTIAL', message: err.message } };
  }
  if (err && err.code === 'INVALID_PROJECT') {
    if (/not found/i.test(err.message)) {
      return { status: 404, body: { error: 'PROJECT_NOT_FOUND', message: err.message } };
    }
    if (/already exists/i.test(err.message)) {
      return { status: 409, body: { error: 'PROJECT_DUPLICATE', message: err.message } };
    }
    return { status: 400, body: { error: 'INVALID_PROJECT', message: err.message } };
  }
  throw err;
}

/**
 * Validate a project create payload. Returns { ok: true } or { ok: false, error }.
 *
 * @param {*} body
 */
function validateCreate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body is required' };
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return { ok: false, error: 'name is required' };
  }
  if (typeof body.version !== 'string' || body.version.trim().length === 0) {
    return { ok: false, error: 'version is required' };
  }
  if (body.sources !== undefined && !Array.isArray(body.sources)) {
    return { ok: false, error: 'sources must be an array' };
  }
  return { ok: true };
}

/**
 * Validate an update payload. Allows partial fields; rejects empty bodies and
 * obviously-bad values (sources not array, name/version empty string).
 *
 * @param {*} body
 */
function validateUpdate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body is required' };
  }
  if (Object.keys(body).length === 0) {
    return { ok: false, error: 'Update body must contain at least one field' };
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
    return { ok: false, error: 'name must be a non-empty string' };
  }
  if (body.version !== undefined && (typeof body.version !== 'string' || body.version.trim().length === 0)) {
    return { ok: false, error: 'version must be a non-empty string' };
  }
  if (body.sources !== undefined && !Array.isArray(body.sources)) {
    return { ok: false, error: 'sources must be an array' };
  }
  return { ok: true };
}

/**
 * Compute staleness label for a project. Strategy here is intentionally simple — the
 * staleness checker (T030) computes the canonical answer, but the API endpoint must
 * still return a usable label even if no checker is wired in deps. Reads `last_refresh`
 * from project; "fresh" if within 24h, "stale" if older, "unknown" if never refreshed.
 *
 * @param {object} project
 * @param {() => string} [now]
 */
function computeStaleness(project, now = () => new Date().toISOString()) {
  if (!project.last_refresh) return 'unknown';
  const age = Date.parse(now()) - Date.parse(project.last_refresh);
  if (Number.isNaN(age)) return 'unknown';
  return age <= 24 * 60 * 60 * 1000 ? 'fresh' : 'stale';
}

/**
 * @param {import('../rest.js').RouteDeps} deps
 */
export function createProjectRoutes(deps) {
  return [
    // -------------------------------------------------------------------- LIST
    {
      method: 'GET',
      pattern: '/api/projects',
      handle: async () => {
        const projects = await deps.configStore.listProjects();
        const enriched = projects.map((p) => ({
          ...p,
          status: p.status ?? 'ready',
          document_count: p.document_count ?? 0,
          last_refresh: p.last_refresh ?? null,
          staleness: computeStaleness(p, deps.now),
        }));
        return { status: 200, body: { projects: enriched } };
      },
    },

    // -------------------------------------------------------------------- CREATE
    {
      method: 'POST',
      pattern: '/api/projects',
      handle: async (req, body) => {
        const v = validateCreate(body);
        if (!v.ok) {
          return { status: 400, body: { error: 'INVALID_REQUEST', message: v.error } };
        }
        try {
          const project = await deps.configStore.createProject(body);
          await deps.auditLogger.log('project.created', {
            project_id: project.id,
            name: project.name,
            version: project.version,
            ip_address: getClientIp(req),
          });
          return { status: 201, body: { project } };
        } catch (err) {
          return mapProjectError(err);
        }
      },
    },

    // -------------------------------------------------------------------- GET
    {
      method: 'GET',
      pattern: '/api/projects/:id',
      handle: async (req) => {
        try {
          const project = await deps.configStore.getProject(req.params.id);
          return { status: 200, body: { project } };
        } catch (err) {
          return mapProjectError(err);
        }
      },
    },

    // -------------------------------------------------------------------- UPDATE
    {
      method: 'PUT',
      pattern: '/api/projects/:id',
      handle: async (req, body) => {
        const v = validateUpdate(body);
        if (!v.ok) {
          return { status: 400, body: { error: 'INVALID_REQUEST', message: v.error } };
        }
        try {
          const project = await deps.configStore.updateProject(req.params.id, body);
          await deps.auditLogger.log('project.updated', {
            project_id: project.id,
            fields: Object.keys(body),
            ip_address: getClientIp(req),
          });
          return { status: 200, body: { project } };
        } catch (err) {
          return mapProjectError(err);
        }
      },
    },

    // -------------------------------------------------------------------- DELETE
    {
      method: 'DELETE',
      pattern: '/api/projects/:id',
      handle: async (req) => {
        try {
          await deps.configStore.deleteProject(req.params.id);
          await deps.auditLogger.log('project.deleted', {
            project_id: req.params.id,
            ip_address: getClientIp(req),
          });
          return { status: 200, body: { deleted: true } };
        } catch (err) {
          return mapProjectError(err);
        }
      },
    },

    // -------------------------------------------------------------------- REBUILD
    {
      method: 'POST',
      pattern: '/api/projects/:id/rebuild',
      handle: async (req) => {
        let project;
        try {
          project = await deps.configStore.getProject(req.params.id);
        } catch (err) {
          return mapProjectError(err);
        }
        const jobId = await Promise.resolve(
          deps.queue.enqueue('full_rebuild', { project_id: project.id }),
        );
        await deps.auditLogger.log('project.rebuild_triggered', {
          project_id: project.id,
          job_id: jobId,
          ip_address: getClientIp(req),
        });
        return { status: 200, body: { job_id: jobId, status: 'queued' } };
      },
    },

    // -------------------------------------------------------------------- STATUS
    {
      method: 'GET',
      pattern: '/api/projects/:id/status',
      handle: async (req) => {
        let project;
        try {
          project = await deps.configStore.getProject(req.params.id);
        } catch (err) {
          return mapProjectError(err);
        }
        // Active jobs — listJobs filtered by project_id when the queue supports it,
        // otherwise we fall back to filtering in memory.
        let activeJobs = [];
        try {
          const queued = deps.queue.listJobs ? deps.queue.listJobs({ status: 'queued' }) : [];
          const running = deps.queue.listJobs ? deps.queue.listJobs({ status: 'running' }) : [];
          activeJobs = [...queued, ...running].filter(
            (j) => j && j.payload && j.payload.project_id === project.id,
          );
        } catch {
          activeJobs = [];
        }
        let refreshHistory = [];
        try {
          if (deps.configStore.getRefreshHistory) {
            refreshHistory = await deps.configStore.getRefreshHistory(project.id);
          }
        } catch {
          refreshHistory = [];
        }
        return {
          status: 200,
          body: {
            staleness: computeStaleness(project, deps.now),
            document_count: project.document_count ?? 0,
            last_refresh: project.last_refresh ?? null,
            active_jobs: activeJobs,
            refresh_history: refreshHistory,
          },
        };
      },
    },
  ];
}
