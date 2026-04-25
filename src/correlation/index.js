// Module 5: Correlation Engine
// Responsibility: Create relationship links between chunks from multiple sources within a project.
// Strategies: path/name matching, iSDLC artifact trace matching,
//             Confluence-title ↔ module matching, import-graph analysis.
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 5

/**
 * @typedef {object} RelatedSource
 * @property {string} path
 * @property {string} source_type
 * @property {"spec"|"test"|"doc"|"impl"} relationship
 * @property {number} confidence
 */

/**
 * @typedef {import('../connectors/index.js').NormalisedChunk & { related: RelatedSource[] }} CorrelatedChunk
 */

/**
 * Correlate chunks across sources within a single project.
 * @param {import('../connectors/index.js').NormalisedChunk[]} chunks
 * @param {object} projectConfig
 * @returns {Promise<CorrelatedChunk[]>}
 */
export async function correlate(chunks, projectConfig) {
  throw new Error('Not implemented — see T017');
}
