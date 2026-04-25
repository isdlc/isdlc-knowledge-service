// T022: REST API — POST /api/refresh (incremental refresh trigger).
// Traces: FR-004 (AC-004-01..04), FR-014 (audit log)
// See: docs/requirements/REQ-GH-263-.../interface-spec.md POST /api/refresh
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-API-001
//
// Pure-handler contract: each entry exports `handle(req, body, deps) -> { status, body }`.
// The dispatcher in rest.js owns transport concerns.
//
// Behaviour:
//   - 400 INVALID_REQUEST  — payload missing source_type / repo_id / changes,
//                            or wrong types (changes must be array)
//   - 404 PROJECT_NOT_FOUND — no project's sources reference this repo_id
//   - 200 — enqueues an `incremental_refresh` job, returns { job_id, status: "queued" }
//
// Audit: records `refresh.triggered` with project_id, repo_id, change count, ip.

import { getClientIp } from '../rest.js';

const VALID_SOURCE_TYPES = new Set(['git', 'svn']);

/**
 * Find the project whose sources reference the given repo identifier.
 * "repo_id" is matched against either source.url or an explicit source.repo_id, depending
 * on what the project config carries. We accept both for flexibility — Git connectors
 * tend to use repo_id; older configs use url.
 *
 * @param {Array<object>} projects
 * @param {string} sourceType
 * @param {string} repoId
 * @returns {object|null}
 */
function findProjectByRepo(projects, sourceType, repoId) {
  for (const project of projects) {
    if (!Array.isArray(project.sources)) continue;
    for (const source of project.sources) {
      if (source.type !== sourceType) continue;
      if (source.repo_id === repoId) return project;
      if (source.url === repoId) return project;
    }
  }
  return null;
}

/**
 * Validate the incoming refresh payload. Returns { ok: true } or { ok: false, error }.
 *
 * @param {*} body
 */
function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body is required' };
  }
  const { source_type, repo_id, changes } = body;
  if (typeof source_type !== 'string' || !VALID_SOURCE_TYPES.has(source_type)) {
    return { ok: false, error: 'source_type must be "git" or "svn"' };
  }
  if (typeof repo_id !== 'string' || repo_id.length === 0) {
    return { ok: false, error: 'repo_id is required' };
  }
  if (!Array.isArray(changes)) {
    return { ok: false, error: 'changes must be an array' };
  }
  for (const ch of changes) {
    if (!ch || typeof ch !== 'object' || typeof ch.path !== 'string' || typeof ch.action !== 'string') {
      return { ok: false, error: 'each change must have { path: string, action: string }' };
    }
  }
  return { ok: true };
}

/**
 * @param {import('../rest.js').RouteDeps} deps
 * @returns {Array<{method: string, pattern: string, handle: Function}>}
 */
export function createRefreshRoutes(deps) {
  return [
    {
      method: 'POST',
      pattern: '/api/refresh',
      handle: async (req, body) => {
        const v = validatePayload(body);
        if (!v.ok) {
          return { status: 400, body: { error: 'INVALID_REQUEST', message: v.error } };
        }

        const projects = await deps.configStore.listProjects();
        const project = findProjectByRepo(projects, body.source_type, body.repo_id);
        if (!project) {
          return {
            status: 404,
            body: {
              error: 'PROJECT_NOT_FOUND',
              message: `No project uses repo "${body.repo_id}" (source_type=${body.source_type})`,
            },
          };
        }

        const jobId = await Promise.resolve(
          deps.queue.enqueue('incremental_refresh', {
            project_id: project.id,
            source_type: body.source_type,
            repo_id: body.repo_id,
            changes: body.changes,
          }),
        );

        // Audit log — AC-014-02: every CI/CD refresh trigger is logged.
        await deps.auditLogger.log('refresh.triggered', {
          project_id: project.id,
          repo_id: body.repo_id,
          source_type: body.source_type,
          change_count: body.changes.length,
          ip_address: getClientIp(req),
        });

        return { status: 200, body: { job_id: jobId, status: 'queued' } };
      },
    },
  ];
}
