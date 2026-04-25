// Module 9: Vector DB Adapters
// Responsibility: Unified vector storage interface — local or remote.
// Implementations: SqliteVecAdapter, QdrantAdapter, ChromaDbAdapter, MilvusAdapter,
//                  WeaviateAdapter, FaissAdapter, OpenSearchAdapter, PineconeAdapter,
//                  QdrantCloudAdapter, WeaviateCloudAdapter, MilvusCloudAdapter
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9

/**
 * @typedef {object} VectorResult
 * @property {string} id
 * @property {number} score
 * @property {string} content
 * @property {object} metadata
 */

/**
 * @typedef {object} IndexStats
 * @property {number} document_count
 * @property {number} dimensions
 * @property {string} backend
 */

/**
 * @typedef {object} VectorDbAdapter
 * @property {(vectors: import('../pipeline/index.js').EmbeddedChunk[]) => Promise<void>} store
 * @property {(query: number[], options?: object) => Promise<VectorResult[]>} search
 * @property {(ids: string[]) => Promise<void>} delete
 * @property {() => Promise<void>} deleteAll
 * @property {() => Promise<IndexStats>} stats
 */

/**
 * Resolve a Vector DB adapter from project vectordb_config.
 * @param {object} vectordbConfig
 * @returns {VectorDbAdapter}
 */
export function getAdapter(vectordbConfig) {
  throw new Error('Not implemented — see T009-T011');
}
