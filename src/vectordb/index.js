// Module 9: Vector DB Adapters — default factory.
// Responsibility: Unified vector storage interface — local or remote.
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//
// Credential resolution (Constitution V.5, VII.5): cloud adapters receive
// resolved strings; api_key reference shapes are resolved here.

import { resolveCredential } from '../credentials/resolver.js';

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
 * @property {(vectors: object[]) => Promise<void>} store
 * @property {(query: number[], options?: object) => Promise<VectorResult[]>} search
 * @property {(ids: string[]) => Promise<void>} delete
 * @property {() => Promise<void>} deleteAll
 * @property {() => Promise<IndexStats>} stats
 */

const ADAPTER_MAP = {
  'sqlite-vec': './sqlite-vec.js',
  qdrant: './qdrant.js',
  chromadb: './chromadb.js',
  milvus: './milvus.js',
  weaviate: './weaviate.js',
  faiss: './faiss.js',
  opensearch: './opensearch.js',
  pinecone: './pinecone.js',
  'qdrant-cloud': './qdrant-cloud.js',
  'weaviate-cloud': './weaviate-cloud.js',
  'milvus-cloud': './milvus-cloud.js',
};

const ADAPTER_CLASS_NAME = {
  'sqlite-vec': 'SqliteVecAdapter',
  qdrant: 'QdrantAdapter',
  chromadb: 'ChromaDbAdapter',
  milvus: 'MilvusAdapter',
  weaviate: 'WeaviateAdapter',
  faiss: 'FaissAdapter',
  opensearch: 'OpenSearchAdapter',
  pinecone: 'PineconeAdapter',
  'qdrant-cloud': 'QdrantCloudAdapter',
  'weaviate-cloud': 'WeaviateCloudAdapter',
  'milvus-cloud': 'MilvusCloudAdapter',
};

/**
 * Default factory: resolve a Vector DB adapter from project vectordb_config.
 * Cloud adapters' api_key references are resolved at this boundary.
 *
 * @param {object} vectordbConfig
 * @returns {Promise<VectorDbAdapter>}
 */
export async function getAdapter(vectordbConfig) {
  if (!vectordbConfig || typeof vectordbConfig !== 'object') {
    throw new TypeError('getAdapter: vectordbConfig is required');
  }
  const backend = vectordbConfig.backend;
  const modulePath = ADAPTER_MAP[backend];
  if (!modulePath) {
    throw new Error(`Unknown vector DB backend: ${backend}`);
  }

  const mod = await import(modulePath);
  const className = ADAPTER_CLASS_NAME[backend];
  const AdapterClass = mod[className];
  if (!AdapterClass) {
    throw new Error(`${className} not found in ${modulePath}`);
  }

  // Resolve api_key reference for cloud adapters; pass undefined for local.
  const apiKey = resolveCredential(vectordbConfig.api_key);

  return new AdapterClass({
    ...vectordbConfig,
    api_key: apiKey,
  });
}
