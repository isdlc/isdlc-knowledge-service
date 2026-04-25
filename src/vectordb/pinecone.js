// Module 9: Pinecone adapter — managed cloud vector DB.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Uses @pinecone-database/pinecone. Pinecone client shape:
//   const pc = new Pinecone({ apiKey });
//   const index = pc.index(indexName);
//   await index.upsert([{ id, values, metadata }]);
//   const r = await index.query({ vector, topK, filter, includeMetadata: true });
//   await index.deleteMany([ids]);
//
// `_clientFactory` is the test seam — production omits it and we lazy-load
// the real Pinecone SDK. Auth (401/403) and 5xx/network errors map to
// ERR-VDB-001; other write failures map to ERR-VDB-003. Retries apply 3x
// with exponential backoff via shared retry helper.
import { VectorDBAdapter, VdbError } from './adapter.js';
import { retry, isTransient } from './retry.js';

export class PineconeAdapter extends VectorDBAdapter {
  /**
   * @param {{
   *   apiKey: string,
   *   indexName: string,
   *   dimensions: number,
   *   namespace?: string,
   *   _clientFactory?: (opts: object) => any,
   * }} options
   */
  constructor(options = {}) {
    super();
    const { apiKey, indexName, dimensions, namespace, _clientFactory } = options;
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('PineconeAdapter: "apiKey" is required');
    }
    if (!indexName || typeof indexName !== 'string') {
      throw new Error('PineconeAdapter: "indexName" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('PineconeAdapter: "dimensions" must be a positive integer');
    }
    this._apiKey = apiKey;
    this._indexName = indexName;
    this._dimensions = dimensions;
    this._namespace = namespace;
    this._clientFactory = _clientFactory;
    this._index = null;
  }

  async _getIndex() {
    if (this._index) return this._index;
    let client;
    if (this._clientFactory) {
      client = this._clientFactory({ apiKey: this._apiKey });
    } else {
      const mod = await import('@pinecone-database/pinecone');
      const Ctor = mod.Pinecone || mod.default;
      client = new Ctor({ apiKey: this._apiKey });
    }
    let idx = client.index(this._indexName);
    if (this._namespace) idx = idx.namespace(this._namespace);
    this._index = idx;
    return idx;
  }

  _wrap(err) {
    if (err instanceof VdbError) return err;
    const status = err?.statusCode || err?.status || err?.response?.status;
    if (status === 401 || status === 403) {
      return new VdbError('ERR-VDB-001', `Pinecone auth failed: ${err.message}`, { cause: err });
    }
    if (isTransient(err)) {
      return new VdbError('ERR-VDB-001', `Pinecone unreachable: ${err.message}`, { cause: err });
    }
    return new VdbError('ERR-VDB-003', `Pinecone write failed: ${err.message}`, { cause: err });
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
    const idx = await this._getIndex();
    const records = vectors.map((v) => ({ id: v.id, values: v.vector, metadata: v.metadata || {} }));
    try {
      await retry(() => idx.upsert(records));
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
    const filter = options.filter || undefined;
    const idx = await this._getIndex();
    let res;
    try {
      res = await retry(() =>
        idx.query({ vector: queryVector, topK: limit, includeMetadata: true, filter }),
      );
    } catch (err) {
      throw this._wrap(err);
    }
    const matches = res?.matches || [];
    return matches.map((m) => ({
      id: m.id,
      score: typeof m.score === 'number' ? m.score : 0,
      content: m.metadata?.content ?? '',
      metadata: m.metadata || {},
    }));
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const idx = await this._getIndex();
    try {
      await retry(() => idx.deleteMany(ids));
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async deleteAll() {
    const idx = await this._getIndex();
    try {
      await retry(() => idx.deleteAll());
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async stats() {
    const idx = await this._getIndex();
    try {
      const res = await retry(() => idx.describeIndexStats());
      const count = res?.totalRecordCount ?? res?.totalVectorCount ?? 0;
      return { count, dimensions: this._dimensions, size_bytes: 0 };
    } catch (err) {
      throw this._wrap(err);
    }
  }
}
