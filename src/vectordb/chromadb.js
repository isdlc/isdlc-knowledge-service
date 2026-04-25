// Module 9: ChromaDB Vector DB Adapter (T010)
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Wraps `chromadb` (`ChromaClient`). Uses one collection per adapter instance.
//   store()     → collection.add({ ids, embeddings, metadatas, documents })
//   search()    → collection.query({ queryEmbeddings, nResults, where? })
//   delete()    → collection.delete({ ids })
//   deleteAll() → collection.delete({}) (deletes all items)
//   stats()     → collection.count()
//
// Mocking seam: `_clientFactory({ url, path })` returns a client whose
// `getOrCreateCollection({ name }) → collection` matches the chromadb npm package.
// The returned collection must expose add/query/delete/count.
//
// Error mapping:
//   network / auth (ECONNREFUSED, status 401/403)             → ERR-VDB-001
//   other write or query failures                             → ERR-VDB-003

import { VectorDBAdapter, VdbError } from './adapter.js';

function isNetworkOrAuthError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (status === 401 || status === 403 || status === 0) return true;
  if (/unreachable|unauthor|forbidden|connection refused|getaddrinfo/i.test(err.message || '')) return true;
  return false;
}

function wrapError(err) {
  if (err instanceof VdbError) return err;
  if (isNetworkOrAuthError(err)) {
    return new VdbError('ERR-VDB-001', `ChromaDB unreachable or auth failed: ${err.message}`, { cause: err });
  }
  return new VdbError('ERR-VDB-003', `ChromaDB write failed: ${err.message}`, { cause: err });
}

export class ChromaDbAdapter extends VectorDBAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.url]            HTTP endpoint of Chroma server (e.g. http://localhost:8000)
   * @param {string} [opts.path]           Local path (alternative to url for embedded mode)
   * @param {number} opts.dimensions
   * @param {string} opts.collection
   * @param {(args: { url?: string, path?: string }) => any} [opts._clientFactory]
   */
  constructor(opts = {}) {
    super();
    const { url, path, dimensions, collection, _clientFactory } = opts;
    if (!url && !path) {
      throw new Error('ChromaDbAdapter: "url" or "path" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('ChromaDbAdapter: "dimensions" must be a positive integer');
    }
    if (!collection || typeof collection !== 'string') {
      throw new Error('ChromaDbAdapter: "collection" is required');
    }
    this._url = url;
    this._path = path;
    this._dimensions = dimensions;
    this._collectionName = collection;

    if (typeof _clientFactory === 'function') {
      try {
        this._client = _clientFactory({ url, path });
      } catch (err) {
        throw new VdbError('ERR-VDB-001', `ChromaDB client init failed: ${err.message}`, { cause: err });
      }
    } else {
      this._client = null;
    }
    this._collection = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    try {
      const mod = await import('chromadb');
      const ChromaClient = mod.ChromaClient || mod.default?.ChromaClient;
      this._client = new ChromaClient(this._url ? { path: this._url } : { path: this._path });
      return this._client;
    } catch (err) {
      throw new VdbError('ERR-VDB-001', `ChromaDB client init failed: ${err.message}`, { cause: err });
    }
  }

  async _getCollection() {
    if (this._collection) return this._collection;
    try {
      const client = await this._getClient();
      this._collection = await client.getOrCreateCollection({ name: this._collectionName });
      return this._collection;
    } catch (err) {
      throw wrapError(err);
    }
  }

  async store(vectors) {
    if (!Array.isArray(vectors) || vectors.length === 0) return;
    for (const v of vectors) {
      if (!v || !Array.isArray(v.vector) || v.vector.length !== this._dimensions) {
        throw new VdbError(
          'ERR-VDB-003',
          `Vector dimension mismatch for id=${v?.id}: expected ${this._dimensions}, got ${v?.vector?.length}`,
        );
      }
    }
    const ids = vectors.map((v) => v.id);
    const embeddings = vectors.map((v) => v.vector);
    const metadatas = vectors.map((v) => ({ ...(v.metadata || {}) }));
    const documents = vectors.map((v) => v.metadata?.content ?? '');
    try {
      const col = await this._getCollection();
      await col.add({ ids, embeddings, metadatas, documents });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async search(queryVector, options = {}) {
    if (!Array.isArray(queryVector) || queryVector.length !== this._dimensions) {
      throw new VdbError(
        'ERR-VDB-003',
        `Query vector dimension mismatch: expected ${this._dimensions}, got ${queryVector?.length}`,
      );
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
    const params = { queryEmbeddings: [queryVector], nResults: limit };
    if (options.filter) {
      // Chroma uses `where` for metadata filtering. Single-key filters pass through;
      // multi-key filters get wrapped in $and.
      const entries = Object.entries(options.filter);
      params.where =
        entries.length === 1
          ? { [entries[0][0]]: entries[0][1] }
          : { $and: entries.map(([k, v]) => ({ [k]: v })) };
    }
    let res;
    try {
      const col = await this._getCollection();
      res = await col.query(params);
    } catch (err) {
      throw wrapError(err);
    }
    // Chroma returns { ids: [[..]], distances: [[..]], metadatas: [[..]], documents: [[..]] }
    const ids = res?.ids?.[0] || [];
    const distances = res?.distances?.[0] || [];
    const metas = res?.metadatas?.[0] || [];
    const docs = res?.documents?.[0] || [];
    return ids.map((id, i) => ({
      id: String(id),
      score: distances[i] ?? 0,
      content: docs[i] ?? metas[i]?.content ?? '',
      metadata: metas[i] || {},
    }));
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
      const col = await this._getCollection();
      await col.delete({ ids });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async deleteAll() {
    try {
      const col = await this._getCollection();
      await col.delete({});
    } catch (err) {
      throw wrapError(err);
    }
  }

  async stats() {
    try {
      const col = await this._getCollection();
      const count = await col.count();
      return {
        count: typeof count === 'number' ? count : 0,
        dimensions: this._dimensions,
        size_bytes: 0,
      };
    } catch (err) {
      throw wrapError(err);
    }
  }
}
