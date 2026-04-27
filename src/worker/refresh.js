// T019: Worker — incremental refresh handler.
// Traces: FR-004 (AC-004-01..04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 3
//      docs/requirements/REQ-GH-263-.../architecture-overview.md
//
// Responsibility: handle an `incremental_refresh` job by re-embedding only the
// files that changed (per the payload) and removing vectors for deleted paths.
//
// Sequence:
//   1. Read project config.
//   2. Locate the source matching `repo_id` (or `source_type`).
//   3. Partition payload.changes into:
//        - upserts: action ∈ { 'add', 'modify' }
//        - deletes: action === 'delete'
//   4. For upserts: ask the connector to crawl just those paths
//      (connector.crawl(source, { paths }) when supported, otherwise full
//      crawl filtered to the changed set — connectors are async iterables).
//   5. correlationEngine.correlate(upsertChunks, projectConfig)
//      NOTE: v1 limitation — re-correlation is scoped to the changed set.
//      Cross-source links to *unchanged* files will not refresh until the
//      next full rebuild. This trade-off is intentional: a true full
//      re-correlation would require re-crawling every source on every
//      incremental refresh. Documented in module-design.md §Worker.
//   6. pipeline.embed → vdb.store (upsert via stable IDs).
//   7. For deletes: synthesize candidate IDs (sha256(project:path:i) for
//      i in [0, MAX_CHUNKS_PER_PATH)) and call vdb.delete(ids). The vector
//      DB is expected to silently ignore unknown IDs — this is part of the
//      adapter contract. (See AC-004-04: "re-embeds only changed files
//      plus their correlated sources.")
//   8. configStore.addRefreshRecord({ type: 'incremental', … })
//
// Error handling: errors propagate to the worker loop for queue retry.

import { stableChunkId } from '../pipeline/index.js';
import { mergeVocabularies } from '../pipeline/metadata-vocabulary.js';

// A single source file should never produce more than this many sub-chunks
// at the embedding pipeline's smallest reasonable max_input_tokens.
// 64 sub-chunks * 4096 tokens ~= 256k tokens of source text per file —
// effectively unbounded for code/doc files.
const MAX_CHUNKS_PER_PATH = 64;
const DEFAULT_BATCH_SIZE = 50;

/**
 * @typedef {object} ChangeEntry
 * @property {string} path
 * @property {"add"|"modify"|"delete"} action
 */

/**
 * @typedef {object} RefreshPayload
 * @property {string} project_id
 * @property {string} [source_type]   "git" | "svn" | …
 * @property {string} [repo_id]       opaque connector-specific identifier
 * @property {ChangeEntry[]} changes
 */

/**
 * Run an incremental refresh.
 *
 * @param {RefreshPayload} payload
 * @param {import('./rebuild.js').RebuildDeps} deps
 * @returns {Promise<{ documents_processed: number, deleted: number, duration_seconds: number }>}
 */
export async function runIncrementalRefresh(payload, deps) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('runIncrementalRefresh: payload is required');
  }
  if (typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    throw new TypeError('runIncrementalRefresh: payload.project_id is required');
  }

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
  const triggerSource = options.triggerSource || 'github-actions';

  const startedAt = Date.now();
  const projectId = payload.project_id;
  const changes = Array.isArray(payload.changes) ? payload.changes : [];

  let documentsProcessed = 0;
  let deletedCount = 0;

  try {
    const project = await configStore.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const source = pickSource(project.sources || [], payload);
    if (!source && changes.length > 0) {
      throw new Error(
        `No matching source for project=${projectId} source_type=${payload.source_type ?? '?'} repo_id=${payload.repo_id ?? '?'}`,
      );
    }

    // Partition changes.
    const upsertPaths = new Set();
    const deletePaths = [];
    for (const c of changes) {
      if (!c || typeof c.path !== 'string') continue;
      if (c.action === 'delete') deletePaths.push(c.path);
      else upsertPaths.add(c.path);
    }

    // Process upserts first, deletes second (so a path that flips delete→add
    // in the same payload — unusual but possible — still ends up indexed).
    if (upsertPaths.size > 0 && source) {
      const modelAdapter = modelManager.getAdapter(project.model_config || {});
      const vdb = vectorDbFactory(project.vectordb_config || {});

      const connector = resolveConnector(connectorFactory, source.type, source);
      const chunks = [];
      for await (const chunk of crawlPaths(connector, source, upsertPaths)) {
        if (chunk) chunks.push(chunk);
      }

      // Correlate within the changed set only (v1 limitation; see header).
      const correlated = await correlationEngine.correlate(chunks, project);

      // REQ-GH-7 FR-004: merge deployment + project vocabularies before embed.
      const effectiveVocab = mergeVocabularies(deps.deploymentVocabulary, project.metadata_vocabulary);
      let batch = [];
      for await (const embedded of pipeline.embed(correlated, modelAdapter, {
        project: projectId,
        metadata_vocabulary: effectiveVocab,
      })) {
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
      }
    }

    // Deletes: synthesize candidate IDs and ask the adapter to remove them.
    if (deletePaths.length > 0) {
      const vdb = vectorDbFactory(project.vectordb_config || {});
      const ids = [];
      for (const path of deletePaths) {
        for (let i = 0; i < MAX_CHUNKS_PER_PATH; i++) {
          ids.push(stableChunkId(projectId, path, i));
        }
      }
      await vdb.delete(ids);
      deletedCount = deletePaths.length;
    }
  } catch (err) {
    await safeRecord(configStore, projectId, {
      timestamp: new Date().toISOString(),
      type: 'incremental',
      trigger_source: triggerSource,
      duration_seconds: secondsSince(startedAt),
      documents_processed: documentsProcessed,
      status: 'failed',
      error: errorMessage(err),
    });
    if (auditLogger && typeof auditLogger.log === 'function') {
      try {
        await auditLogger.log('refresh.failed', {
          project_id: projectId,
          documents_processed: documentsProcessed,
          error: errorMessage(err),
        });
      } catch {
        // ignore
      }
    }
    throw err;
  }

  const duration = secondsSince(startedAt);
  await safeRecord(configStore, projectId, {
    timestamp: new Date().toISOString(),
    type: 'incremental',
    trigger_source: triggerSource,
    duration_seconds: duration,
    documents_processed: documentsProcessed,
    status: 'success',
    error: null,
  });
  if (auditLogger && typeof auditLogger.log === 'function') {
    try {
      await auditLogger.log('refresh.completed', {
        project_id: projectId,
        documents_processed: documentsProcessed,
        deleted: deletedCount,
        duration_seconds: duration,
      });
    } catch {
      // ignore
    }
  }

  return {
    documents_processed: documentsProcessed,
    deleted: deletedCount,
    duration_seconds: duration,
  };
}

/**
 * Pick the project source that matches the refresh payload. Matching rules:
 *   1. If payload.repo_id is set: prefer source whose `id` or `repo_id`
 *      equals payload.repo_id.
 *   2. Otherwise (or as fallback) match by source.type === payload.source_type.
 *   3. If only one source on the project: use it.
 */
function pickSource(sources, payload) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (payload.repo_id) {
    const byId = sources.find(
      (s) => s && (s.id === payload.repo_id || s.repo_id === payload.repo_id),
    );
    if (byId) return byId;
  }
  if (payload.source_type) {
    const byType = sources.find((s) => s && s.type === payload.source_type);
    if (byType) return byType;
  }
  if (sources.length === 1) return sources[0];
  return null;
}

/**
 * Crawl only the paths in `pathSet`. If the connector exposes a path-aware
 * crawl signature (crawl(config, { paths })), prefer that. Otherwise we run
 * a normal crawl and filter — connectors yield NormalisedChunks and the
 * crawl is async-iterable, so filtering is streaming.
 */
async function* crawlPaths(connector, source, pathSet) {
  // Connectors MAY accept an options arg with a paths filter. We attempt this
  // first and fall back to filtering on the consumer side. The two-arg call
  // is a no-op for connectors that ignore the second argument.
  let usedFilteredCrawl = false;
  try {
    const it = connector.crawl(source, { paths: [...pathSet] });
    if (it && typeof it[Symbol.asyncIterator] === 'function') {
      usedFilteredCrawl = true;
      for await (const chunk of it) {
        if (chunk && (pathSet.has(chunk.path) || pathSet.size === 0)) {
          yield chunk;
        }
      }
    }
  } catch {
    // fall through to plain crawl
  }
  if (usedFilteredCrawl) return;

  for await (const chunk of connector.crawl(source)) {
    if (chunk && pathSet.has(chunk.path)) yield chunk;
  }
}

function resolveConnector(factory, type, config) {
  if (factory && typeof factory.get === 'function') return factory.get(type, config);
  if (typeof factory === 'function') return factory(type, config);
  throw new TypeError('runIncrementalRefresh: connectorFactory must be a function or have a .get() method');
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
    // ignore
  }
}
