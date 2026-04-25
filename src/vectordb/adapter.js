// Module 9: Vector DB Adapters — abstract interface + error type.
// Traces: FR-006, FR-008, FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001..003
//
// All concrete adapters (sqlite-vec, qdrant, chromadb, milvus, weaviate,
// faiss, opensearch, pinecone, cloud variants) must subclass VectorDBAdapter
// and implement: store, search, delete, deleteAll, stats. Concrete adapters
// are wired in T010/T011.

/**
 * @typedef {object} VectorRecord
 * @property {string} id
 * @property {number[]} vector
 * @property {{
 *   content: string,
 *   source_type: string,
 *   source_url: string,
 *   project: string,
 *   [extra: string]: any
 * }} metadata
 */

/**
 * @typedef {object} VectorResult
 * @property {string} id
 * @property {number} score
 * @property {string} content
 * @property {object} metadata
 */

/**
 * @typedef {object} IndexStats
 * @property {number} count
 * @property {number} dimensions
 * @property {number} size_bytes
 */

/**
 * @typedef {object} SearchOptions
 * @property {number} limit
 * @property {Record<string, any>} [filter]
 */

/**
 * Typed error for vector DB failures. The `code` matches the error taxonomy
 * (ERR-VDB-001 unreachable, ERR-VDB-002 corrupt, ERR-VDB-003 write failed).
 */
export class VdbError extends Error {
  /**
   * @param {string} code  Error taxonomy code (e.g. 'ERR-VDB-002').
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'VdbError';
    this.code = code;
  }
}

/**
 * Abstract base class for vector DB adapters. Subclasses must override
 * every method below; calling them on the base class throws
 * "Not implemented".
 */
export class VectorDBAdapter {
  constructor() {
    if (new.target === VectorDBAdapter) {
      throw new Error('VectorDBAdapter is abstract — subclass it');
    }
  }

  /**
   * Bulk insert or upsert vectors.
   * @param {VectorRecord[]} _vectors
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async store(_vectors) {
    throw new Error('Not implemented');
  }

  /**
   * Nearest-neighbour search by vector.
   * @param {number[]} _query
   * @param {SearchOptions} _options
   * @returns {Promise<VectorResult[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async search(_query, _options) {
    throw new Error('Not implemented');
  }

  /**
   * Bulk delete by id.
   * @param {string[]} _ids
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async delete(_ids) {
    throw new Error('Not implemented');
  }

  /**
   * Clear the entire index.
   * @returns {Promise<void>}
   */
  async deleteAll() {
    throw new Error('Not implemented');
  }

  /**
   * Index statistics: count, dimensions, on-disk size.
   * @returns {Promise<IndexStats>}
   */
  async stats() {
    throw new Error('Not implemented');
  }
}
