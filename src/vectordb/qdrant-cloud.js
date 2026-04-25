// Module 9: Qdrant Cloud adapter — hosted Qdrant via REST API + API key.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Header note: Qdrant Cloud uses the SAME @qdrant/js-client-rest SDK as a
// self-hosted Qdrant; the only differences are (a) a cloud URL and (b) an
// API key. T010 ships a local QdrantAdapter and this cloud variant SHOULD
// reduce to a thin wrapper once T010 lands. Today T010 is not yet
// implemented, so QdrantCloudAdapter implements the same surface directly
// and forces the cloud-required `apiKey` constructor argument. When T010
// arrives, refactor this class to compose the local adapter and pass
// { url, apiKey } through to it.
import { VectorDBAdapter, VdbError } from './adapter.js';
import { retry, isTransient } from './retry.js';

export class QdrantCloudAdapter extends VectorDBAdapter {
  /**
   * @param {{
   *   url: string,           // https://xyz.cloud.qdrant.io
   *   apiKey: string,
   *   collection: string,
   *   dimensions: number,
   *   _clientFactory?: (opts: object) => any,
   * }} options
   */
  constructor(options = {}) {
    super();
    const { url, apiKey, collection, dimensions, _clientFactory } = options;
    if (!url || typeof url !== 'string') {
      throw new Error('QdrantCloudAdapter: "url" is required');
    }
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('QdrantCloudAdapter: "apiKey" is required');
    }
    if (!collection || typeof collection !== 'string') {
      throw new Error('QdrantCloudAdapter: "collection" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('QdrantCloudAdapter: "dimensions" must be a positive integer');
    }
    this._url = url;
    this._apiKey = apiKey;
    this._collection = collection;
    this._dimensions = dimensions;
    this._clientFactory = _clientFactory;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    if (this._clientFactory) {
      this._client = this._clientFactory({ url: this._url, apiKey: this._apiKey });
      return this._client;
    }
    const mod = await import('@qdrant/js-client-rest');
    const Ctor = mod.QdrantClient || mod.default;
    this._client = new Ctor({ url: this._url, apiKey: this._apiKey });
    return this._client;
  }

  _wrap(err) {
    if (err instanceof VdbError) return err;
    const status = err?.status || err?.statusCode || err?.response?.status;
    if (status === 401 || status === 403) {
      return new VdbError('ERR-VDB-001', `Qdrant Cloud auth failed: ${err.message}`, { cause: err });
    }
    if (isTransient(err)) {
      return new VdbError('ERR-VDB-001', `Qdrant Cloud unreachable: ${err.message}`, { cause: err });
    }
    return new VdbError('ERR-VDB-003', `Qdrant Cloud write failed: ${err.message}`, { cause: err });
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
    const points = vectors.map((v) => ({ id: v.id, vector: v.vector, payload: v.metadata || {} }));
    try {
      await retry(() => client.upsert(this._collection, { wait: true, points }));
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
    const filter = options.filter
      ? { must: Object.entries(options.filter).map(([key, value]) => ({ key, match: { value } })) }
      : undefined;
    const client = await this._getClient();
    let res;
    try {
      res = await retry(() =>
        client.search(this._collection, { vector: queryVector, limit, with_payload: true, filter }),
      );
    } catch (err) {
      throw this._wrap(err);
    }
    const points = Array.isArray(res) ? res : res?.points || [];
    return points.map((p) => ({
      id: String(p.id),
      score: typeof p.score === 'number' ? p.score : 0,
      content: p.payload?.content ?? '',
      metadata: p.payload || {},
    }));
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const client = await this._getClient();
    try {
      await retry(() => client.delete(this._collection, { wait: true, points: ids }));
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async deleteAll() {
    const client = await this._getClient();
    try {
      await retry(() => client.delete(this._collection, { wait: true, filter: {} }));
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async stats() {
    const client = await this._getClient();
    try {
      const info = await retry(() => client.getCollection(this._collection));
      const count = info?.points_count ?? info?.vectors_count ?? 0;
      return { count, dimensions: this._dimensions, size_bytes: 0 };
    } catch (err) {
      throw this._wrap(err);
    }
  }
}
