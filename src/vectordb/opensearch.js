// Module 9: OpenSearch adapter — remote/cloud kNN vector index.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Uses @opensearch-project/opensearch. kNN search via the `knn` query;
// bulk indexing via _bulk for store(); _delete_by_query for deleteAll.
// Constructor accepts a `_clientFactory` test seam; production callers omit
// it and the real OpenSearch client is constructed from { node, auth }.
//
// Retry: transient network/5xx errors retried 3 attempts with exponential
// backoff (100/300/900 ms). Auth failures (401/403) and 4xx are not retried.
import { VectorDBAdapter, VdbError } from './adapter.js';
import { retry, isTransient } from './retry.js';

export class OpenSearchAdapter extends VectorDBAdapter {
  /**
   * @param {{
   *   node: string,
   *   auth?: { username: string, password: string } | { aws: object },
   *   dimensions: number,
   *   index: string,
   *   _clientFactory?: (opts: object) => any,
   * }} options
   */
  constructor(options = {}) {
    super();
    const { node, auth, dimensions, index, _clientFactory } = options;
    if (!node || typeof node !== 'string') {
      throw new Error('OpenSearchAdapter: "node" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('OpenSearchAdapter: "dimensions" must be a positive integer');
    }
    if (!index || typeof index !== 'string') {
      throw new Error('OpenSearchAdapter: "index" is required');
    }
    this._node = node;
    this._auth = auth;
    this._dimensions = dimensions;
    this._index = index;
    this._clientFactory = _clientFactory;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    if (this._clientFactory) {
      this._client = this._clientFactory({ node: this._node, auth: this._auth });
      return this._client;
    }
    // Lazy-load the real ESM client only when no factory is provided.
    const mod = await import('@opensearch-project/opensearch');
    this._client = new mod.Client({ node: this._node, auth: this._auth });
    return this._client;
  }

  _wrap(err) {
    if (err instanceof VdbError) return err;
    const status = err?.statusCode || err?.meta?.statusCode;
    if (status === 401 || status === 403) {
      return new VdbError('ERR-VDB-001', `OpenSearch auth failed: ${err.message}`, { cause: err });
    }
    if (isTransient(err)) {
      return new VdbError('ERR-VDB-001', `OpenSearch unreachable: ${err.message}`, { cause: err });
    }
    return new VdbError('ERR-VDB-003', `OpenSearch write failed: ${err.message}`, { cause: err });
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
    const client = await this._getClient();
    const body = [];
    for (const v of vectors) {
      body.push({ index: { _index: this._index, _id: v.id } });
      body.push({ embedding: v.vector, ...v.metadata });
    }
    try {
      const res = await retry(() => client.bulk({ refresh: true, body }));
      if (res?.body?.errors) {
        throw new Error('OpenSearch bulk reported item-level errors');
      }
    } catch (err) {
      throw this._wrap(err);
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
    const filter = options.filter || null;

    const knn = { embedding: { vector: queryVector, k: limit } };
    /** @type {any} */
    const query = { knn };
    if (filter) {
      const must = Object.entries(filter).map(([k, v]) => ({ term: { [k]: v } }));
      query.bool = { must: [{ knn }, ...must] };
      delete query.knn;
    }
    const client = await this._getClient();
    let res;
    try {
      res = await retry(() => client.search({ index: this._index, body: { size: limit, query } }));
    } catch (err) {
      throw this._wrap(err);
    }
    const hits = res?.body?.hits?.hits || [];
    return hits.map((h) => {
      const src = h._source || {};
      const { embedding: _e, content = '', ...meta } = src;
      return {
        id: h._id,
        score: typeof h._score === 'number' ? h._score : 0,
        content,
        metadata: { content, ...meta },
      };
    });
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const client = await this._getClient();
    const body = ids.flatMap((id) => [{ delete: { _index: this._index, _id: id } }]);
    try {
      await retry(() => client.bulk({ refresh: true, body }));
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async deleteAll() {
    const client = await this._getClient();
    try {
      await retry(() =>
        client.deleteByQuery({ index: this._index, body: { query: { match_all: {} } }, refresh: true }),
      );
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async stats() {
    const client = await this._getClient();
    try {
      const res = await retry(() => client.count({ index: this._index }));
      return {
        count: res?.body?.count ?? 0,
        dimensions: this._dimensions,
        size_bytes: 0,
      };
    } catch (err) {
      throw this._wrap(err);
    }
  }
}
