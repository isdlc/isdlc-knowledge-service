// Module 2: Query Engine
// Responsibility: Fan-out search across per-project Vector DB indexes, merge, rank, tag.
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 2

/**
 * @typedef {object} SearchResult
 * @property {string} content
 * @property {number} score
 * @property {string} project
 * @property {string} source_type
 * @property {string} source_url
 * @property {Array<{ path: string, relationship: string }>} related_sources
 */

/**
 * Run a fan-out semantic search across the listed projects.
 * @param {{ query: string, projects: string[] }} args
 * @returns {Promise<SearchResult[]>}
 */
export async function search({ query, projects }) {
  throw new Error('Not implemented — see T020');
}
