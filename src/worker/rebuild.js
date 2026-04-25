// T019: Worker — full rebuild handler.
// Traces: FR-005 (AC-005-01, AC-005-02), FR-004 ancillary (AC-004-04 idempotency)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 3
//      docs/requirements/REQ-GH-263-.../architecture-overview.md (data flow)
//
// Responsibility: handle a `full_rebuild` job by re-crawling every source of a
// project, correlating chunks, embedding them, and replacing the project's
// vector index in place.
//
// Sequence (canonical):
//   1. Read project config (sources, model_config, vectordb_config)
//   2. Resolve modelAdapter (modelManager.getAdapter)
//   3. Resolve vdb (vectorDbFactory)
//   4. For each source: connectorFactory.get(source.type).crawl(source) →
//      collect NormalisedChunks
//   5. correlationEngine.correlate(chunks, projectConfig)
//   6. vdb.deleteAll() — wipe the index BEFORE writing new vectors so a partial
//      crash leaves an empty (rebuildable) state rather than mixed old+new.
//   7. pipeline.embed(correlated, modelAdapter, { project }) → batched
//      vdb.store(batch). Stable IDs (sha256(project:path:chunkIndex)) keep
//      this idempotent across retries (Constitution Article VI.2).
//   8. configStore.addRefreshRecord({ type: 'full', status: 'success', … })
//   9. auditLogger.log('rebuild.completed', { project_id, stats })
//
// Errors propagate to the worker loop, which calls queue.fail(id, err). The
// queue handles retry / dead-letter — this module does NOT swallow errors.

const DEFAULT_BATCH_SIZE = 50;

/**
 * @typedef {object} RebuildDeps
 * @property {{ getProject: (id: string) => Promise<object|null>,
 *             addRefreshRecord: (id: string, r: object) => Promise<void> }} configStore
 * @property {{ get: (type: string, config?: object) => object } |
 *           ((type: string, config?: object) => object)} connectorFactory
 * @property {{ correlate: (chunks: object[], projectConfig: object) => Promise<object[]> }} correlationEngine
 * @property {{ embed: (chunks: object[], adapter: object, opts?: object) => AsyncIterable<object> }} pipeline
 * @property {(vectordbConfig: object) => object} vectorDbFactory
 * @property {{ getAdapter: (model_config: object) => object }} modelManager
 * @property {{ log: (action: string, details: object) => Promise<void> }} [auditLogger]
 * @property {{ batchSize?: number, triggerSource?: string }} [options]
 */

/**
 * Run a full rebuild for a project.
 *
 * @param {{ project_id: string }} payload
 * @param {RebuildDeps} deps
 * @returns {Promise<{ documents_processed: number, sources: number, duration_seconds: number }>}
 */
export async function runFullRebuild(payload, deps) {
  if (!payload || typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    throw new TypeError('runFullRebuild: payload.project_id is required');
  }
  const projectId = payload.project_id;

  const {
    configStore,
    connectorFactory,
    correlationEngine,
    pipeline,
    vectorDbFactory,
    modelManager,
    auditLogger,
    options = {},
  } = deps;

  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
    ? options.batchSize
    : DEFAULT_BATCH_SIZE;
  const triggerSource = options.triggerSource || 'web-ui';

  const startedAt = Date.now();
  let documentsProcessed = 0;
  let recordError = null;

  try {
    const project = await configStore.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const sources = Array.isArray(project.sources) ? project.sources : [];
    const modelAdapter = modelManager.getAdapter(project.model_config || {});
    const vdb = vectorDbFactory(project.vectordb_config || {});

    // 1. Crawl all sources.
    const chunks = [];
    for (const source of sources) {
      const connector = resolveConnector(connectorFactory, source.type, source);
      for await (const chunk of connector.crawl(source)) {
        if (chunk) chunks.push(chunk);
      }
    }

    // 2. Correlate within the project.
    const correlated = await correlationEngine.correlate(chunks, project);

    // 3. Wipe old index BEFORE writing new vectors.
    await vdb.deleteAll();

    // 4. Embed and store in batches.
    let batch = [];
    for await (const embedded of pipeline.embed(correlated, modelAdapter, { project: projectId })) {
      batch.push(embedded);
      if (batch.length >= batchSize) {
        await vdb.store(batch);
        documentsProcessed += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await vdb.store(batch);
      documentsProcessed += batch.length;
      batch = [];
    }
  } catch (err) {
    recordError = err;
    // Best-effort failure record before re-raising — never let recording
    // failures mask the original error.
    await safeRecord(configStore, projectId, {
      timestamp: new Date().toISOString(),
      type: 'full',
      trigger_source: triggerSource,
      duration_seconds: secondsSince(startedAt),
      documents_processed: documentsProcessed,
      status: 'failed',
      error: errorMessage(err),
    });
    if (auditLogger && typeof auditLogger.log === 'function') {
      try {
        await auditLogger.log('rebuild.failed', {
          project_id: projectId,
          documents_processed: documentsProcessed,
          error: errorMessage(err),
        });
      } catch {
        // ignore audit failures
      }
    }
    throw err;
  }

  const duration = secondsSince(startedAt);
  await safeRecord(configStore, projectId, {
    timestamp: new Date().toISOString(),
    type: 'full',
    trigger_source: triggerSource,
    duration_seconds: duration,
    documents_processed: documentsProcessed,
    status: 'success',
    error: null,
  });
  if (auditLogger && typeof auditLogger.log === 'function') {
    try {
      await auditLogger.log('rebuild.completed', {
        project_id: projectId,
        documents_processed: documentsProcessed,
        duration_seconds: duration,
      });
    } catch {
      // ignore
    }
  }

  return {
    documents_processed: documentsProcessed,
    sources: Array.isArray((await configStore.getProject(projectId))?.sources)
      ? (await configStore.getProject(projectId)).sources.length
      : 0,
    duration_seconds: duration,
  };
}

/**
 * Connector factory may be exposed as either { get(type, config) } (object) or
 * a bare function (type, config) → connector. Accept both.
 */
function resolveConnector(factory, type, config) {
  if (factory && typeof factory.get === 'function') return factory.get(type, config);
  if (typeof factory === 'function') return factory(type, config);
  throw new TypeError('runFullRebuild: connectorFactory must be a function or have a .get() method');
}

function secondsSince(startMs) {
  return Math.round((Date.now() - startMs) / 1000);
}

function errorMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err.message === 'string') return err.message;
  return String(err);
}

async function safeRecord(configStore, projectId, record) {
  try {
    await configStore.addRefreshRecord(projectId, record);
  } catch {
    // do not let bookkeeping failures mask the real error
  }
}
