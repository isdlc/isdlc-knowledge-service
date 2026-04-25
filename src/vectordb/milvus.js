// Module 9: Milvus Vector DB Adapter (T010)
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Wraps `@zilliz/milvus2-sdk-node` (`MilvusClient`).
//   store()     → client.insert({ collection_name, fields_data: [...] })
//   search()    → client.search({ collection_name, vectors: [v], topk, filter? })
//   delete()    → client.deleteEntities({ collection_name, expr: 'id in [...]' })
//   deleteAll() → client.deleteEntities({ collection_name, expr: 'id != ""' })
//   stats()     → client.getCollectionStatistics({ collection_name })
//
// Mocking seam: `_clientFactory({ address })` returns a client whose method
// shape matches MilvusClient. Tests stub this; real factory does
// `new MilvusClient({ address })` from the npm package.
//
// Error mapping:
//   network / auth (ECONNREFUSED, status 401/403, gRPC UNAVAILABLE) → ERR-VDB-001
//   other write or query failures                                   → ERR-VDB-003

import { VectorDBAdapter, VdbError } from './adapter.js';

function isNetworkOrAuthError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
  // gRPC status codes: UNAVAILABLE = 14, UNAUTHENTICATED = 16, PERMISSION_DENIED = 7
  if (code === 14 || code === 16 || code === 7) return true;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (status === 401 || status === 403 || status === 0) return true;
  if (/unreachable|unauthor|forbidden|connection refused|getaddrinfo|UNAVAILABLE|UNAUTHENTICATED/i.test(err.message || '')) return true;
  return false;
}

function wrapError(err) {
  if (err instanceof VdbError) return err;
  if (isNetworkOrAuthError(err)) {
    return new VdbError('ERR-VDB-001', `Milvus unreachable or auth failed: ${err.message}`, { cause: err });
  }
  return new VdbError('ERR-VDB-003', `Milvus write failed: ${err.message}`, { cause: err });
}

export class MilvusAdapter extends VectorDBAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.address      host:port form, e.g. localhost:19530
   * @param {number} opts.dimensions
   * @param {string} opts.collection
   * @param {(args: { address: string }) => any} [opts._clientFactory]
   */
  constructor(opts = {}) {
    super();
    const { address, dimensions, collection, _clientFactory } = opts;
    if (!address || typeof address !== 'string') {
      throw new Error('MilvusAdapter: "address" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('MilvusAdapter: "dimensions" must be a positive integer');
    }
    if (!collection || typeof collection !== 'string') {
      throw new Error('MilvusAdapter: "collection" is required');
    }
    this._address = address;
    this._dimensions = dimensions;
    this._collection = collection;

    if (typeof _clientFactory === 'function') {
      try {
        this._client = _clientFactory({ address });
      } catch (err) {
        throw new VdbError('ERR-VDB-001', `Milvus client init failed: ${err.message}`, { cause: err });
      }
    } else {
      this._client = null;
    }
  }

  async _getClient() {
    if (this._client) return this._client;
    try {
      const mod = await import('@zilliz/milvus2-sdk-node');
      const MilvusClient = mod.MilvusClient || mod.default?.MilvusClient;
      this._client = new MilvusClient({ address: this._address });
      return this._client;
    } catch (err) {
      throw new VdbError('ERR-VDB-001', `Milvus client init failed: ${err.message}`, { cause: err });
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
    const fields_data = vectors.map((v) => ({
      id: v.id,
      vector: v.vector,
      metadata: JSON.stringify(v.metadata || {}),
    }));
    try {
      const client = await this._getClient();
      await client.insert({ collection_name: this._collection, fields_data });
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
    const params = {
      collection_name: this._collection,
      vectors: [queryVector],
      topk: limit,
      output_fields: ['id', 'metadata'],
    };
    if (options.filter) {
      // Milvus filter expression: metadata stored as JSON string; in real deployments
      // schema would expose individual fields. For mock-bound tests, we forward an
      // expression built from key=value pairs.
      const expr = Object.entries(options.filter)
        .map(([k, v]) => `${k} == ${typeof v === 'string' ? `"${v}"` : v}`)
        .join(' && ');
      params.filter = expr;
    }
    let res;
    try {
      const client = await this._getClient();
      res = await client.search(params);
    } catch (err) {
      throw wrapError(err);
    }
    // Milvus returns { results: [{ id, score, metadata }, ...] }
    const results = res?.results || [];
    return results.map((r) => {
      let metadata = {};
      if (typeof r.metadata === 'string') {
        try { metadata = JSON.parse(r.metadata); } catch { /* leave empty */ }
      } else if (r.metadata && typeof r.metadata === 'object') {
        metadata = r.metadata;
      }
      return {
        id: String(r.id),
        score: r.score ?? 0,
        content: metadata.content ?? '',
        metadata,
      };
    });
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const expr = `id in [${ids.map((id) => `"${id}"`).join(',')}]`;
    try {
      const client = await this._getClient();
      await client.deleteEntities({ collection_name: this._collection, expr });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async deleteAll() {
    try {
      const client = await this._getClient();
      await client.deleteEntities({ collection_name: this._collection, expr: 'id != ""' });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async stats() {
    try {
      const client = await this._getClient();
      const info = await client.getCollectionStatistics({ collection_name: this._collection });
      const row = info?.stats?.find?.((s) => s.key === 'row_count');
      const count = row ? Number(row.value) : Number(info?.row_count ?? 0);
      return {
        count: Number.isFinite(count) ? count : 0,
        dimensions: this._dimensions,
        size_bytes: 0,
      };
    } catch (err) {
      throw wrapError(err);
    }
  }
}
