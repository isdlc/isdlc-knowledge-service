// Module 9: Weaviate Cloud adapter — hosted Weaviate (WCD) over HTTPS.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Header note: Weaviate Cloud uses the SAME weaviate-ts-client SDK as a
// self-hosted Weaviate. The only difference is API-key authn and the
// scheme/host. When T010 lands a local WeaviateAdapter, this cloud variant
// should refactor to a thin wrapper that supplies cloud defaults
// (scheme: 'https', apiKey-based auth). For now it implements the surface
// directly so the carve-out is unblocked.
//
// Client shape (weaviate-ts-client v2):
//   const c = weaviate.client({ scheme, host, apiKey: new ApiKey(token) });
//   c.batch.objectsBatcher().withObject({ class, id, vector, properties }).do()
//   c.graphql.get().withClassName(...).withNearVector(...).withLimit(...).do()
//   c.data.deleter().withClassName(...).withId(...).do()
import { VectorDBAdapter, VdbError } from './adapter.js';
import { retry, isTransient } from './retry.js';

export class WeaviateCloudAdapter extends VectorDBAdapter {
  /**
   * @param {{
   *   host: string,            // e.g. my-cluster.weaviate.network
   *   apiKey: string,
   *   className: string,       // collection / class name
   *   dimensions: number,
   *   _clientFactory?: (opts: object) => any,
   * }} options
   */
  constructor(options = {}) {
    super();
    const { host, apiKey, className, dimensions, _clientFactory } = options;
    if (!host || typeof host !== 'string') {
      throw new Error('WeaviateCloudAdapter: "host" is required');
    }
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('WeaviateCloudAdapter: "apiKey" is required');
    }
    if (!className || typeof className !== 'string') {
      throw new Error('WeaviateCloudAdapter: "className" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('WeaviateCloudAdapter: "dimensions" must be a positive integer');
    }
    this._host = host;
    this._apiKey = apiKey;
    this._className = className;
    this._dimensions = dimensions;
    this._clientFactory = _clientFactory;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    if (this._clientFactory) {
      this._client = this._clientFactory({ host: this._host, apiKey: this._apiKey });
      return this._client;
    }
    const mod = await import('weaviate-ts-client');
    const weaviate = mod.default || mod;
    this._client = weaviate.client({
      scheme: 'https',
      host: this._host,
      apiKey: new weaviate.ApiKey(this._apiKey),
    });
    return this._client;
  }

  _wrap(err) {
    if (err instanceof VdbError) return err;
    const status = err?.statusCode || err?.status || err?.response?.status;
    if (status === 401 || status === 403) {
      return new VdbError('ERR-VDB-001', `Weaviate Cloud auth failed: ${err.message}`, { cause: err });
    }
    if (isTransient(err)) {
      return new VdbError('ERR-VDB-001', `Weaviate Cloud unreachable: ${err.message}`, { cause: err });
    }
    return new VdbError('ERR-VDB-003', `Weaviate Cloud write failed: ${err.message}`, { cause: err });
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
    try {
      await retry(async () => {
        let batcher = client.batch.objectsBatcher();
        for (const v of vectors) {
          batcher = batcher.withObject({
            class: this._className,
            id: v.id,
            vector: v.vector,
            properties: v.metadata || {},
          });
        }
        return batcher.do();
      });
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
        client.graphql
          .get()
          .withClassName(this._className)
          .withNearVector({ vector: queryVector })
          .withLimit(limit)
          .withFields('content source_type source_url project _additional { id distance }')
          .do(),
      );
    } catch (err) {
      throw this._wrap(err);
    }
    const items = res?.data?.Get?.[this._className] || [];
    return items.map((it) => {
      const { _additional, ...meta } = it;
      return {
        id: _additional?.id || '',
        score: typeof _additional?.distance === 'number' ? _additional.distance : 0,
        content: meta.content ?? '',
        metadata: meta,
      };
    });
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const client = await this._getClient();
    try {
      await retry(async () => {
        for (const id of ids) {
          await client.data.deleter().withClassName(this._className).withId(id).do();
        }
      });
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async deleteAll() {
    const client = await this._getClient();
    try {
      await retry(() => client.schema.classDeleter().withClassName(this._className).do());
    } catch (err) {
      throw this._wrap(err);
    }
  }

  async stats() {
    const client = await this._getClient();
    try {
      const res = await retry(() =>
        client.graphql
          .aggregate()
          .withClassName(this._className)
          .withFields('meta { count }')
          .do(),
      );
      const count = res?.data?.Aggregate?.[this._className]?.[0]?.meta?.count ?? 0;
      return { count, dimensions: this._dimensions, size_bytes: 0 };
    } catch (err) {
      throw this._wrap(err);
    }
  }
}
