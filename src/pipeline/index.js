// Module 6: Embedding Pipeline
// Responsibility: Enrich correlated chunks with relationship context, generate vectors.
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6

/**
 * @typedef {object} EmbeddedChunk
 * @property {Float32Array | number[]} vector
 * @property {string} content
 * @property {object} metadata
 * @property {Array<object>} related_sources
 */

/**
 * Enrich + chunk + embed the correlated chunks via the supplied model adapter.
 * @param {import('../correlation/index.js').CorrelatedChunk[]} chunks
 * @param {import('../models/index.js').ModelAdapter} modelAdapter
 * @returns {Promise<EmbeddedChunk[]>}
 */
export async function embed(chunks, modelAdapter) {
  throw new Error('Not implemented — see T018');
}
