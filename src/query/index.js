// T020: Module 2: Query Engine
// Traces: FR-006 (AC-006-01..04), FR-008 (AC-008-01)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 2
//      docs/requirements/REQ-GH-263-.../requirements-spec.md FR-006, FR-008
//      docs/requirements/REQ-GH-263-.../interface-spec.md  semantic_search
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md  ERR-API-001 (INVALID_PROJECT),
//                                                          ERR-API-002 (NO_INDEX)
//
// Responsibility: fan out a single semantic-search query across the per-project
// Vector DB indexes named by the caller, merge + rank the results, and tag
// each result with its source project. Cross-project ranking is performed by
// the merger via per-metric score normalization (see merger.js).
//
// Public interface:
//   search({ query, projects }, deps) → Promise<SearchResult[]>
//
// deps shape:
//   - modelAdapter            — used to embed the query text once
//   - getVectorDb(projectId)  — async or sync function returning a
//                               VectorDBAdapter for the named project. May
//                               throw INVALID_PROJECT (unknown id) or
//                               NO_INDEX (project has no embeddings yet).
//   - options? = {
//       limit_per_project: 10,
//       total_limit: 30,
//     }
//
// Graceful degradation (per FR-006 + error-taxonomy ERR-API-001/002):
//   If a single project's getVectorDb() or .search() throws, we DO NOT fail
//   the whole query. Instead we record a per-project error and continue with
//   the remaining projects. This matches the MCP semantic_search contract:
//   the caller still gets useful results from indexes that are healthy.
//   Per-project errors are exposed via the optional `errors` argument
//   collector, when supplied. With no collector the errors are silently
//   skipped (the caller gets just the successful projects' results), and the
//   API/MCP layer is responsible for surfacing them.
//
// The Query Engine itself does not throw INVALID_PROJECT / NO_INDEX errors —
// those are surfaced through the `errors` collector so the API layer can map
// them to MCP error codes. This keeps the engine pure (deterministic w/r/t
// successful results) while preserving the error contract.

import { merge } from './merger.js';

/**
 * @typedef {import('./merger.js').SearchResult} SearchResult
 * @typedef {{ projectId: string, code: string, message: string, cause?: unknown }} ProjectError
 */

const DEFAULT_LIMIT_PER_PROJECT = 10;
const DEFAULT_TOTAL_LIMIT = 30;

/**
 * Map an exception thrown from getVectorDb() / .search() onto an MCP error
 * code (INVALID_PROJECT | NO_INDEX | INTERNAL).
 * Heuristics on `code` and message keep the engine free of taxonomy imports.
 *
 * @param {string} projectId
 * @param {unknown} err
 * @returns {ProjectError}
 */
function mapProjectError(projectId, err) {
  const e = /** @type {any} */ (err);
  const code = (e && (e.code || e.name)) || '';
  const msg = (e && e.message) || String(err);

  // Explicit MCP codes pass through verbatim.
  if (code === 'INVALID_PROJECT' || code === 'NO_INDEX') {
    return { projectId, code, message: msg, cause: err };
  }
  // Taxonomy codes from error-taxonomy.md.
  if (code === 'ERR-API-001') {
    return { projectId, code: 'INVALID_PROJECT', message: msg, cause: err };
  }
  if (code === 'ERR-API-002') {
    return { projectId, code: 'NO_INDEX', message: msg, cause: err };
  }
  // Heuristic: typical "not found" / "unknown project" wording.
  if (/unknown project|project .* not found|no such project/i.test(msg)) {
    return { projectId, code: 'INVALID_PROJECT', message: msg, cause: err };
  }
  if (/no index|empty index|no embeddings/i.test(msg)) {
    return { projectId, code: 'NO_INDEX', message: msg, cause: err };
  }
  return { projectId, code: 'INTERNAL', message: msg, cause: err };
}

/**
 * Run a fan-out semantic search across the listed projects.
 *
 * @param {{ query: string, projects: string[] }} args
 * @param {{
 *   modelAdapter: { embed: (text: string) => Promise<number[]> | number[] },
 *   getVectorDb: (projectId: string) => any,
 *   options?: { limit_per_project?: number, total_limit?: number },
 *   errors?: ProjectError[],
 * }} deps
 * @returns {Promise<SearchResult[]>}
 */
export async function search({ query, projects } = {}, deps = {}) {
  const { modelAdapter, getVectorDb, options = {}, errors } = deps;

  if (typeof query !== 'string' || query.length === 0) {
    throw new TypeError('search: query must be a non-empty string');
  }
  if (!Array.isArray(projects)) {
    throw new TypeError('search: projects must be an array of project ids');
  }
  if (!modelAdapter || typeof modelAdapter.embed !== 'function') {
    throw new TypeError('search: deps.modelAdapter.embed is required');
  }
  if (typeof getVectorDb !== 'function') {
    throw new TypeError('search: deps.getVectorDb is required');
  }

  // AC-006-04 + AC-008-01: empty projects list → no results.
  if (projects.length === 0) return [];

  const limitPerProject =
    typeof options.limit_per_project === 'number' && options.limit_per_project > 0
      ? options.limit_per_project
      : DEFAULT_LIMIT_PER_PROJECT;
  const totalLimit =
    typeof options.total_limit === 'number' && options.total_limit > 0
      ? options.total_limit
      : DEFAULT_TOTAL_LIMIT;

  // Embed the query text once — re-used across all project indexes.
  const queryVector = await modelAdapter.embed(query);

  // Fan out IN PARALLEL: one task per project. Settle all so a single failure
  // does not abort sibling project queries.
  const tasks = projects.map(async (projectId) => {
    try {
      const vdb = await getVectorDb(projectId);
      if (!vdb || typeof vdb.search !== 'function') {
        throw new Error(`unknown project: ${projectId}`);
      }
      const results = await vdb.search(queryVector, { limit: limitPerProject });
      const metric =
        typeof vdb.getMetric === 'function' ? vdb.getMetric() : 'cosine';
      return { projectId, ok: true, results: Array.isArray(results) ? results : [], metric };
    } catch (err) {
      return { projectId, ok: false, error: mapProjectError(projectId, err) };
    }
  });

  const settled = await Promise.all(tasks);

  /** @type {Record<string, { results: any[], metric?: string }>} */
  const perProject = {};
  for (const r of settled) {
    if (r.ok) {
      perProject[r.projectId] = { results: r.results, metric: r.metric };
    } else if (Array.isArray(errors)) {
      errors.push(r.error);
    }
  }

  return merge(perProject, { total_limit: totalLimit });
}
