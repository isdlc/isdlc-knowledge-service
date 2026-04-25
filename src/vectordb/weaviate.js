// Module 9: Weaviate Vector DB Adapter (T010)
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001, ERR-VDB-003
//
// Wraps `weaviate-ts-client`. Weaviate uses a chained-builder API which is
// awkward to mock per-call, so each public method on this adapter calls a
// small private helper (`_storeBatch`, `_runSearch`, `_runDelete`,
// `_runStats`). Tests stub only those helpers via the `_clientFactory`
// returning a thin object with these named methods, OR the underlying
// chained-builder client is mocked end-to-end (we accept either shape via the
// thin wrapper below).
//
// Default factory (production): wraps `weaviate.client({ scheme, host })` and
// exposes the four helpers used by the adapter, hiding the chain-builder.
//
// Error mapping:
//   network / auth (ECONNREFUSED, status 401/403) → ERR-VDB-001
//   other write or query failures                 → ERR-VDB-003

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
    return new VdbError('ERR-VDB-001', `Weaviate unreachable or auth failed: ${err.message}`, { cause: err });
  }
  return new VdbError('ERR-VDB-003', `Weaviate write failed: ${err.message}`, { cause: err });
}

/**
 * Wrap the chained-builder weaviate-ts-client into the four-method shape the
 * adapter uses. Kept private; tests should stub the client directly.
 */
function defaultProductionClient({ scheme, host, className }) {
  // Lazy: only built when no _clientFactory is supplied.
  let chained;
  return {
    async storeBatch(objects) {
      if (!chained) chained = await loadChainedClient({ scheme, host });
      let batcher = chained.batch.objectsBatcher();
      for (const obj of objects) batcher = batcher.withObject(obj);
      return batcher.do();
    },
    async runSearch({ vector, limit, filter }) {
      if (!chained) chained = await loadChainedClient({ scheme, host });
      let q = chained.graphql
        .get()
        .withClassName(className)
        .withFields('_additional { id distance } content metadata')
        .withNearVector({ vector })
        .withLimit(limit);
      if (filter) q = q.withWhere(filter);
      return q.do();
    },
    async runDelete({ ids }) {
      if (!chained) chained = await loadChainedClient({ scheme, host });
      const out = [];
      for (const id of ids) {
        out.push(await chained.data.deleter().withClassName(className).withId(id).do());
      }
      return out;
    },
    async runDeleteAll() {
      if (!chained) chained = await loadChainedClient({ scheme, host });
      return chained.batch
        .objectsBatchDeleter()
        .withClassName(className)
        .withWhere({ path: ['id'], operator: 'NotEqual', valueText: '' })
        .do();
    },
    async runStats() {
      if (!chained) chained = await loadChainedClient({ scheme, host });
      const res = await chained.graphql
        .aggregate()
        .withClassName(className)
        .withFields('meta { count }')
        .do();
      const count = res?.data?.Aggregate?.[className]?.[0]?.meta?.count ?? 0;
      return { count };
    },
  };
}

async function loadChainedClient({ scheme, host }) {
  const mod = await import('weaviate-ts-client');
  const weaviate = mod.default || mod;
  return weaviate.client({ scheme, host });
}

export class WeaviateAdapter extends VectorDBAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.scheme       'http' | 'https'
   * @param {string} opts.host         e.g. 'localhost:8080'
   * @param {number} opts.dimensions
   * @param {string} opts.className    Weaviate class (collection) name
   * @param {(args: { scheme: string, host: string, className: string }) => any} [opts._clientFactory]
   */
  constructor(opts = {}) {
    super();
    const { scheme, host, dimensions, className, _clientFactory } = opts;
    if (!scheme || !host) {
      throw new Error('WeaviateAdapter: "scheme" and "host" are required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('WeaviateAdapter: "dimensions" must be a positive integer');
    }
    if (!className || typeof className !== 'string') {
      throw new Error('WeaviateAdapter: "className" is required');
    }
    this._scheme = scheme;
    this._host = host;
    this._dimensions = dimensions;
    this._className = className;

    if (typeof _clientFactory === 'function') {
      try {
        this._client = _clientFactory({ scheme, host, className });
      } catch (err) {
        throw new VdbError('ERR-VDB-001', `Weaviate client init failed: ${err.message}`, { cause: err });
      }
    } else {
      this._client = defaultProductionClient({ scheme, host, className });
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
    const objects = vectors.map((v) => ({
      class: this._className,
      id: v.id,
      vector: v.vector,
      properties: { ...(v.metadata || {}) },
    }));
    try {
      await this._client.storeBatch(objects);
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
    let filter;
    if (options.filter) {
      const entries = Object.entries(options.filter);
      const ops = entries.map(([k, v]) => ({
        path: [k],
        operator: 'Equal',
        valueText: typeof v === 'string' ? v : String(v),
      }));
      filter = ops.length === 1 ? ops[0] : { operator: 'And', operands: ops };
    }
    let res;
    try {
      res = await this._client.runSearch({ vector: queryVector, limit, filter });
    } catch (err) {
      throw wrapError(err);
    }
    // Adapter accepts either { data: { Get: { [className]: [...] } } } (raw GraphQL)
    // or a pre-flattened { results: [...] } shape (mock-friendly).
    let raw = res?.results;
    if (!raw) raw = res?.data?.Get?.[this._className] || [];
    return raw.map((r) => {
      const metadata = (r.metadata && typeof r.metadata === 'object') ? r.metadata : (r.properties || {});
      return {
        id: String(r._additional?.id ?? r.id ?? ''),
        score: r._additional?.distance ?? r.distance ?? r.score ?? 0,
        content: r.content ?? metadata.content ?? '',
        metadata,
      };
    });
  }

  async delete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
      await this._client.runDelete({ ids });
    } catch (err) {
      throw wrapError(err);
    }
  }

  async deleteAll() {
    try {
      await this._client.runDeleteAll();
    } catch (err) {
      throw wrapError(err);
    }
  }

  async stats() {
    try {
      const out = await this._client.runStats();
      return {
        count: out?.count ?? 0,
        dimensions: this._dimensions,
        size_bytes: 0,
      };
    } catch (err) {
      throw wrapError(err);
    }
  }
}
