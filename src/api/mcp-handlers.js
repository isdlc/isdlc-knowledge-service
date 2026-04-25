// T021: MCP Tool Handlers — pure functions (no transport coupling).
// Traces: FR-008 (AC-008-01..04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 1 (API Server)
//      docs/requirements/REQ-GH-263-.../interface-spec.md  (MCP Tools)
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//        - ERR-API-001 INVALID_PROJECT
//        - ERR-API-002 NO_INDEX
//        - ERR-API-003 CONTENT_TOO_LARGE
//
// Each handler is a thin orchestration layer over Query Engine + Config Store
// + Job Queue, with input validation and error mapping. They are deliberately
// transport-agnostic: the same handlers feed both the MCP stdio server
// (mcp.js, T021) and the REST/HTTP layer (T022).
//
// Error contract:
//   Handlers throw McpError instances whose .code is the MCP error code
//   string (INVALID_PROJECT | NO_INDEX | CONTENT_TOO_LARGE | INVALID_INPUT).
//   The MCP server adapter (mcp.js) catches these and translates them into
//   the wire-level error shape; the REST adapter does its own translation.

/**
 * Error class for MCP-tool error mapping. Carries an MCP error code on `.code`
 * (e.g. 'INVALID_PROJECT') and a human-readable message. Optionally carries
 * a `cause` chain so callers can surface the underlying error in logs.
 */
export class McpError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const MAX_QUERY_LENGTH = 1024;
const MAX_CONTENT_BYTES = 1_048_576; // 1 MiB, exact

/**
 * Compute the UTF-8 byte length of `add_content` payload.
 *  - string form: bytes of the string itself
 *  - array form:  sum of bytes of each item.text
 *
 * @param {string|Array<{path?:string,text:string}>} content
 * @returns {number}
 */
function contentByteLength(content) {
  if (typeof content === 'string') {
    return Buffer.byteLength(content, 'utf8');
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) {
      if (item && typeof item.text === 'string') {
        total += Buffer.byteLength(item.text, 'utf8');
      }
    }
    return total;
  }
  return 0;
}

/**
 * Validate and resolve a project id via the Config Store.
 * Throws McpError(INVALID_PROJECT) if the project is unknown.
 *
 * @param {{ getProject: (id: string) => Promise<any> }} configStore
 * @param {string} id
 */
async function assertProjectExists(configStore, id) {
  try {
    return await configStore.getProject(id);
  } catch (err) {
    // Config Store throws InvalidProjectError with code === 'INVALID_PROJECT'.
    const code = err && (err.code || err.name);
    if (code === 'INVALID_PROJECT' || code === 'InvalidProjectError') {
      throw new McpError('INVALID_PROJECT', `Unknown project: ${id}`, err);
    }
    throw err;
  }
}

/**
 * MCP tool: semantic_search
 * Traces: FR-008 AC-008-01
 *
 * @param {{ query: string, projects: string[] }} args
 * @param {{
 *   queryEngine: { search: Function },
 *   configStore: { getProject: Function },
 *   modelAdapter: { embed: Function },
 *   getVectorDb: (projectId: string) => any,
 * }} deps
 * @returns {Promise<{ results: Array<object> }>}
 */
export async function semanticSearch(args, deps) {
  const { query, projects } = args || {};

  // Input validation.
  if (typeof query !== 'string' || query.length === 0) {
    throw new McpError('INVALID_INPUT', 'query must be a non-empty string');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new McpError(
      'INVALID_INPUT',
      `query exceeds maximum length (${MAX_QUERY_LENGTH} chars)`,
    );
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new McpError('INVALID_INPUT', 'projects must be a non-empty array of strings');
  }
  for (const p of projects) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new McpError('INVALID_INPUT', 'projects entries must be non-empty strings');
    }
  }
  if (!deps || !deps.queryEngine || !deps.configStore) {
    throw new TypeError('semanticSearch: deps.queryEngine and deps.configStore are required');
  }

  // Pre-validate every project up front (cleanest INVALID_PROJECT path —
  // see error-taxonomy ERR-API-001). If ANY project is unknown the whole
  // call fails: the caller asked for a specific scope and we do not silently
  // narrow it.
  for (const projectId of projects) {
    await assertProjectExists(deps.configStore, projectId);
  }

  // Fan out via Query Engine. Per-project errors (NO_INDEX / INTERNAL) are
  // collected through the engine's optional `errors` array — search() does
  // not throw them.
  /** @type {Array<{projectId:string,code:string,message:string,cause?:unknown}>} */
  const errors = [];
  const results = await deps.queryEngine.search(
    { query, projects },
    {
      modelAdapter: deps.modelAdapter,
      getVectorDb: deps.getVectorDb,
      errors,
    },
  );

  // If we got zero results AND every error is NO_INDEX, surface NO_INDEX.
  // Mixed conditions (some indexes ok, some empty) → return what we have;
  // the caller sees an empty results page when nothing matched, but does
  // not get blocked by partial NO_INDEX states.
  if ((!results || results.length === 0) && errors.length > 0) {
    const allNoIndex = errors.every((e) => e.code === 'NO_INDEX');
    if (allNoIndex) {
      const ids = errors.map((e) => e.projectId).join(', ');
      throw new McpError(
        'NO_INDEX',
        `No index for project(s): ${ids}`,
      );
    }
    // If some project failed for non-NO_INDEX reasons (and nothing succeeded),
    // surface the first error's code so the caller is not silently stranded.
    const first = errors[0];
    throw new McpError(first.code, first.message, first.cause);
  }

  return { results: results || [] };
}

/**
 * MCP tool: add_content
 * Traces: FR-008 AC-008-02
 *
 * @param {{ content: string|Array<{path?:string,text:string}>, project: string }} args
 * @param {{
 *   configStore: { getProject: Function },
 *   queue: { enqueue: (type: string, payload: object) => string },
 * }} deps
 * @returns {Promise<{ job_id: string, status: 'queued' }>}
 */
export async function addContent(args, deps) {
  const { content, project } = args || {};

  if (typeof project !== 'string' || project.length === 0) {
    throw new McpError('INVALID_INPUT', 'project must be a non-empty string');
  }
  if (content === undefined || content === null) {
    throw new McpError('INVALID_INPUT', 'content is required');
  }
  if (typeof content !== 'string' && !Array.isArray(content)) {
    throw new McpError(
      'INVALID_INPUT',
      'content must be a string or an array of { path, text } items',
    );
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        throw new McpError('INVALID_INPUT', 'content array entries must be objects');
      }
      if (typeof item.text !== 'string') {
        throw new McpError('INVALID_INPUT', 'content array entries must have a string text field');
      }
    }
  }
  if (!deps || !deps.configStore || !deps.queue) {
    throw new TypeError('addContent: deps.configStore and deps.queue are required');
  }

  // Size check BEFORE project lookup — fail fast, do not enqueue.
  // ERR-API-003: 1 MiB hard limit, measured in UTF-8 bytes.
  const bytes = contentByteLength(content);
  if (bytes > MAX_CONTENT_BYTES) {
    throw new McpError(
      'CONTENT_TOO_LARGE',
      `content exceeds maximum size (${bytes} bytes > ${MAX_CONTENT_BYTES} bytes)`,
    );
  }

  // Project must exist BEFORE we enqueue (don't queue dead jobs).
  await assertProjectExists(deps.configStore, project);

  const jobId = deps.queue.enqueue('add_content', { project, content });
  return { job_id: jobId, status: 'queued' };
}

/**
 * MCP tool: list_projects
 * Traces: FR-008 AC-008-03
 *
 * @param {object} _args  unused — list_projects takes no input
 * @param {{
 *   configStore: { listProjects: Function, getRefreshHistory?: Function },
 * }} deps
 * @returns {Promise<{ projects: Array<object> }>}
 */
export async function listProjects(_args, deps) {
  if (!deps || !deps.configStore) {
    throw new TypeError('listProjects: deps.configStore is required');
  }

  const projects = await deps.configStore.listProjects();
  const out = [];
  for (const p of projects || []) {
    // ProjectConfig today does not carry status/document_count/last_refresh.
    // We surface defaults (deviation flagged in implementation notes) and
    // hydrate last_refresh from the refresh-history if available.
    let lastRefresh = null;
    let status = 'unknown';
    try {
      if (deps.configStore.getRefreshHistory) {
        const history = await deps.configStore.getRefreshHistory(p.id);
        if (Array.isArray(history) && history.length > 0) {
          lastRefresh = history[0].timestamp || null;
          status = history[0].status === 'success' ? 'fresh' : 'stale';
        }
      }
    } catch {
      // Ignore — best-effort hydration.
    }
    out.push({
      id: p.id,
      name: p.name,
      version: p.version,
      status,
      document_count: typeof p.document_count === 'number' ? p.document_count : 0,
      last_refresh: lastRefresh,
    });
  }
  return { projects: out };
}

/**
 * MCP tool: list_modules
 * Traces: FR-008 AC-008-04
 *
 * @param {{ project: string }} args
 * @param {{
 *   configStore: { getProject: Function },
 * }} deps
 * @returns {Promise<{ sources: Array<object> }>}
 */
export async function listModules(args, deps) {
  const { project } = args || {};

  if (typeof project !== 'string' || project.length === 0) {
    throw new McpError('INVALID_INPUT', 'project must be a non-empty string');
  }
  if (!deps || !deps.configStore) {
    throw new TypeError('listModules: deps.configStore is required');
  }

  const cfg = await assertProjectExists(deps.configStore, project);
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  return {
    sources: sources.map((s) => ({
      type: s.type || '',
      url: s.url || '',
      // document_count and last_crawled are not yet tracked per-source in the
      // config schema; default to 0 / null. (Deviation noted in T021.)
      document_count: typeof s.document_count === 'number' ? s.document_count : 0,
      last_crawled: s.last_crawled || null,
    })),
  };
}

// Constants exported for tests + REST layer.
export const LIMITS = {
  MAX_QUERY_LENGTH,
  MAX_CONTENT_BYTES,
};
