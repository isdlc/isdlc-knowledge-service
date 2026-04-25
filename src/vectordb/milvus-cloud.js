// Module 9: Milvus Cloud (Zilliz) adapter — hosted Milvus over gRPC w/ token.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Header note: Zilliz Cloud uses the SAME @zilliz/milvus2-sdk-node SDK as a
// self-hosted Milvus. The only difference is the cloud endpoint and a token
// (instead of username/password). When T010 ships a local MilvusAdapter,
// this cloud variant should refactor into a thin wrapper that injects
// { address, token, ssl: true } defaults. Today T010 is pending so the
// surface is implemented directly here.
//
// Client shape:
//   const c = new MilvusClient({ address, token, ssl: true });
//   c.insert({ collection_name, fields_data: [{ id, vector, content, ... }] })
//   c.search({ collection_name, vectors: [v], limit, output_fields: [...] })
//   c.delete_entities({ collection_name, expr: 'id in ["a","b"]' })
import { VectorDBAdapter, VdbError } from './adapter.js';
import { retry, isTransient } from './retry.js';

export class MilvusCloudAdapter extends VectorDBAdapter {
  /**
   * @param {{
   *   endpoint: string,        // https://in03-...zillizcloud.com
   *   token: string,
   *   collection: string,
   *   dimensions: number,
   *   _clientFactory?: (opts: object) => any,
   * }} options
   */
  constructor(options = {}) {
    super();
    const { endpoint, token, collection, dimensions, _clientFactory } = options;
    if (!endpoint || typeof endpoint !== 'string') {
      throw new Error('MilvusCloudAdapter: "endpoint" is required');
    }
    if (!token || typeof token !== 'string') {
      throw new Error('MilvusCloudAdapter: "token" is required');
    }
    if (!collection || typeof collection !== 'string') {
      throw new Error('MilvusCloudAdapter: "collection" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('MilvusCloudAdapter: "dimensions" must be a positive integer');
    }
    this._endpoint = endpoint;
    this._token = token;
    this._collection = collection;
    this._dimensions = dimensions;
    this._clientFactory = _clientFactory;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    if (this._clientFactory) {
      this._client = this._clientFactory({ address: this._endpoint, token: this._token });
      return this._client;
    }
    const mod = await import('@zilliz/milvus2-sdk-node');
    const Ctor = mod.MilvusClient || mod.default;
    this._client = new Ctor({ address: this._endpoint, token: this._token, ssl: true });
    return this._client;
  }

  _isStatusOk(res) {
    if (!res) return false;
    if (res.status && typeof res.status.error_code === 'string') {
      return res.status.error_code === 'Success';
    }
    return true;
  }

  _wrap(err) {
    if (err instanceof VdbError) return err;
    const status = err?.statusCode || err?.status || err?.response?.status;
    const msg = (err?.message || '').toLowerCase();
    if (status === 401 || status === 403 || /unauth|forbidden|invalid token|permission/.test(msg)) {
      return new VdbError('ERR-VDB-001', `Milvus Cloud auth failed: ${err.message}`, { cause: err });
    }
    if (isTransient(err)) {
      return new VdbError('ERR-VDB-001', `Milvus Cloud unreachable: ${err.message}`, { cause: err });
    }
    return new VdbError('ERR-VDB-003', `Milvus Cloud write failed: ${err.message}`, { cause: err });
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
    const fields_data = vectors.map((v) => ({
      id: v.id,
      vector: v.vector,
      content: v.metadata?.content ?? '',
      source_type: v.metadata?.source_type ?? '',
      source_url: v.metadata?.source_url ?? '',
      project: v.metadata?.project ?? '',
      metadata: JSON.stringify(v.metadata || {}),
    }));
    try {
      const res = await retry(() => client.insert({ collection_name: this._collection, fields_data }));
      if (!this._isStatusOk(res)) {
        throw new Error(res?.status?.reason || 'Milvus insert failed');
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
    const client = await this._getClient();
    let res;
    try {
      res = await retry(() =>
        client.search({
          collection_name: this._collection,
          vectors: [queryVector],
          limit,
          output_fields: ['id', 'content', 'source_type', 'source_url', 'project', 'metadata'],
        }),
      );
    } catch (err) {
      throw this._wrap(err);
    }
    if (!this._isStatusOk(res)) {
      throw this._wrap(new Error(res?.status?.reason || 'Milvus search failed'));
    }
    const results = res?.results || [];
    return results.map((r) => {
      let metadata = {};
      try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
      return {
        id: String(r.id),
        score: typeof r.score === 'number' ? r.score : 0,
        content: r.content ?? metadata.content ?? '',
        metadata: { content: r.content, source_type: r.source_type, source_url: r.source_url, project: r.project, ...metadata },
      };
    });
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const client = await this._getClient();
    const escaped = ids.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',');
    const expr = `id in [${escaped}]`;
    try {
      const res = await retry(() => client.delete_entities({ collection_name: this._collection, expr }));
      if (!this._isStatusOk(res)) {
        throw new Error(res?.status?.reason || 'Milvus delete failed');
      }
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async deleteAll() {
    const client = await this._getClient();
    try {
      const res = await retry(() =>
        client.delete_entities({ collection_name: this._collection, expr: 'id != ""' }),
      );
      if (!this._isStatusOk(res)) {
        throw new Error(res?.status?.reason || 'Milvus deleteAll failed');
      }
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async stats() {
    const client = await this._getClient();
    try {
      const res = await retry(() =>
        client.getCollectionStatistics({ collection_name: this._collection }),
      );
      let count = 0;
      const stats = res?.stats || res?.data || [];
      for (const kv of stats) {
        if (kv?.key === 'row_count') count = Number(kv.value) || 0;
      }
      return { count, dimensions: this._dimensions, size_bytes: 0 };
    } catch (err) {
      throw this._wrap(err);
    }
  }
}
