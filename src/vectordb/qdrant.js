// Module 9: Qdrant Vector DB Adapter (T010)
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Wraps `@qdrant/js-client-rest`. Maps:
//   store()     → client.upsert(collection, { points: [{ id, vector, payload }] })
//   search()    → client.search(collection, { vector, limit, filter? })
//   delete()    → client.delete(collection, { points: ids })
//   deleteAll() → client.delete(collection, { filter: { must: [] } })
//   stats()     → client.getCollection(collection) — count from points_count
//
// Mocking seam: `_clientFactory({ url })` returns a client whose method shape
// matches QdrantClient (upsert/search/delete/getCollection). The default factory
// constructs `new QdrantClient({ url })` from `@qdrant/js-client-rest`.
//
// NOTE: Qdrant point IDs must be unsigned ints or UUIDs. We pass strings through
// because tests bind to mocks; real deployments should ensure UUID-shaped ids.
//
// Error mapping:
//   network / auth (ECONNREFUSED, ENOTFOUND, status 401/403) → ERR-VDB-001
//   other write failures                                     → ERR-VDB-003

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
    return new VdbError('ERR-VDB-001', `Qdrant unreachable or auth failed: ${err.message}`, { cause: err });
  }
  return new VdbError('ERR-VDB-003', `Qdrant write failed: ${err.message}`, { cause: err });
}

export class QdrantAdapter extends VectorDBAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {number} opts.dimensions
   * @param {string} [opts.collection]
   * @param {(args: { url: string }) => any} [opts._clientFactory]
   */
  constructor(opts = {}) {
    super();
    const { url, dimensions, collection, _clientFactory } = opts;
    if (!url || typeof url !== 'string') {
      throw new Error('QdrantAdapter: "url" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('QdrantAdapter: "dimensions" must be a positive integer');
    }
    this._url = url;
    this._dimensions = dimensions;
    this._collection = collection || 'default';

    if (typeof _clientFactory === 'function') {
      try {
        this._client = _clientFactory({ url });
      } catch (err) {
        throw new VdbError('ERR-VDB-001', `Qdrant client init failed: ${err.message}`, { cause: err });
      }
    } else {
      // Real client constructed lazily on first use via dynamic import (ESM).
      this._client = null;
    }
  }

  async _getClient() {
    if (this._client) return this._client;
    try {
      const mod = await import('@qdrant/js-client-rest');
      const QdrantClient = mod.QdrantClient || mod.default?.QdrantClient;
      this._client = new QdrantClient({ url: this._url });
      return this._client;
    } catch (err) {
      throw new VdbError('ERR-VDB-001', `Qdrant client init failed: ${err.message}`, { cause: err });
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
    const points = vectors.map((v) => ({
      id: v.id,
      vector: v.vector,
      payload: { ...(v.metadata || {}) },
    }));
    try {
      const client = await this._getClient();
      await client.upsert(this._collection, { points });
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
    const params = { vector: queryVector, limit, with_payload: true };
    if (options.filter) {
      params.filter = {
        must: Object.entries(options.filter).map(([key, value]) => ({
          key,
          match: { value },
        })),
      };
    }
    let hits;
    try {
      const client = await this._getClient();
      hits = await client.search(this._collection, params);
    } catch (err) {
      throw wrapError(err);
    }
    const results = Array.isArray(hits) ? hits : hits?.result || [];
    return results.map((hit) => {
      const payload = hit.payload || {};
      return {
        id: String(hit.id),
        score: hit.score ?? 0,
        content: payload.content ?? '',
        metadata: payload,
      };
    });
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
      const client = await this._getClient();
      await client.delete(this._collection, { points: ids });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async deleteAll() {
    try {
      const client = await this._getClient();
      await client.delete(this._collection, { filter: { must: [] } });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async stats() {
    try {
      const client = await this._getClient();
      const info = await client.getCollection(this._collection);
      const count = info?.points_count ?? info?.vectors_count ?? 0;
      return {
        count,
        dimensions: this._dimensions,
        size_bytes: 0, // Qdrant REST API does not expose on-disk size cheaply.
      };
    } catch (err) {
      throw wrapError(err);
    }
  }
}
