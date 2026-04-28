// Module 3: Worker — job loop.
// T019: dequeue → dispatch → complete/fail. Handles full_rebuild,
//       incremental_refresh, add_content.
// Traces: FR-004, FR-005
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 3
//
// Design notes:
//   - The loop is async and yields between iterations via setTimeout (or the
//     injected `wait` test seam) so a slow job never starves event-loop tasks.
//   - `stop()` returns a Promise that resolves AFTER the in-flight job (if any)
//     completes. We never abort a running handler — interrupting an embedding
//     mid-flight would leave the index in a half-written state. The stable-ID
//     idempotency keystone (Constitution Article VI.2) means a graceful retry
//     is always safer than an abort.
//   - Errors from handlers are converted to queue.fail(id, err). The queue
//     itself decides whether to retry or send to the dead-letter (ERR-QUEUE-001).
//   - Unknown job types fail with a stable code so the dead-letter explains
//     the operator action ("update worker" vs "investigate handler").

import { runFullRebuild } from './rebuild.js';
import { runIncrementalRefresh } from './refresh.js';
import { mergeVocabularies } from '../pipeline/metadata-vocabulary.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * @typedef {object} WorkerOptions
 * @property {number} [pollIntervalMs]   Default 1000.
 * @property {number} [batchSize]        Forwarded to rebuild/refresh handlers.
 * @property {(ms: number) => Promise<void>} [wait]   Test seam for delays.
 */

/**
 * @typedef {object} WorkerDeps
 * @property {object} queue              { dequeue, complete, fail }
 * @property {object} configStore        See rebuild.js RebuildDeps.
 * @property {object|Function} connectorFactory
 * @property {object} correlationEngine
 * @property {object} pipeline
 * @property {Function} vectorDbFactory
 * @property {object} modelManager
 * @property {object} [auditLogger]
 * @property {import('../pipeline/metadata-vocabulary.js').MetadataVocabularyConfig | null} [deploymentVocabulary]
 *   REQ-GH-7 deployment-wide custom_link_fields. Threaded into pipeline.embed
 *   by each handler so chunks pick up deployment-level vocabulary in addition
 *   to per-project vocabulary. The eventual worker entry-point bootstrap
 *   reads this from `KNOWLEDGE_CONFIG.metadata_vocabulary` (set by start.js)
 *   and passes it here.
 * @property {WorkerOptions} [options]
 * @property {object} [handlers]         Internal seam for tests — override
 *                                       full_rebuild / incremental_refresh /
 *                                       add_content handlers.
 */

/**
 * Start the Worker process (job loop). Returns a handle with a `stop()` method.
 *
 * @param {WorkerDeps} deps
 * @returns {{ stop: () => Promise<void>, running: () => boolean }}
 */
export function startWorker(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('startWorker: deps is required');
  }
  if (!deps.queue || typeof deps.queue.dequeue !== 'function') {
    throw new TypeError('startWorker: queue.dequeue is required');
  }
  if (typeof deps.queue.complete !== 'function' || typeof deps.queue.fail !== 'function') {
    throw new TypeError('startWorker: queue.complete and queue.fail are required');
  }

  const options = deps.options || {};
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs >= 0
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const wait = typeof options.wait === 'function' ? options.wait : defaultWait;

  // Per-handler dependency bundle (shared shape).
  const handlerDeps = {
    configStore: deps.configStore,
    connectorFactory: deps.connectorFactory,
    correlationEngine: deps.correlationEngine,
    pipeline: deps.pipeline,
    vectorDbFactory: deps.vectorDbFactory,
    modelManager: deps.modelManager,
    auditLogger: deps.auditLogger,
    // REQ-GH-7 deployment-wide vocabulary baseline. Threaded into the
    // pipeline.embed call by each handler so chunks pick up deployment-level
    // custom_link_fields in addition to the project's own.
    deploymentVocabulary: deps.deploymentVocabulary || null,
    options: { batchSize: options.batchSize },
  };

  // Allow tests to inject custom handlers; default to the production trio.
  const handlers = {
    full_rebuild: (payload) => runFullRebuild(payload, handlerDeps),
    incremental_refresh: (payload) => runIncrementalRefresh(payload, handlerDeps),
    add_content: (payload) => runAddContent(payload, handlerDeps),
    ...(deps.handlers || {}),
  };

  let stopping = false;
  let running = true;
  let inFlight = null;
  let stopResolve = null;

  const stoppedPromise = new Promise((resolve) => {
    stopResolve = resolve;
  });

  // Kick off the loop on the next microtask so callers can attach listeners
  // before the first dequeue() runs.
  Promise.resolve().then(loop).catch((err) => {
    // If the loop crashes (which it shouldn't — every iteration is wrapped),
    // surface the error rather than silently exiting.
    // eslint-disable-next-line no-console
    console.error('[worker] loop crashed:', err);
    finalizeStop();
  });

  async function loop() {
    while (!stopping) {
      let job = null;
      try {
        job = await Promise.resolve(deps.queue.dequeue());
      } catch (err) {
        // dequeue itself failed (DB error, etc). Back off and retry.
        // eslint-disable-next-line no-console
        console.error('[worker] dequeue failed:', err?.message ?? err);
        await wait(pollIntervalMs);
        continue;
      }

      if (!job) {
        await wait(pollIntervalMs);
        continue;
      }

      inFlight = handleJob(job).finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
    finalizeStop();
  }

  async function handleJob(job) {
    const handler = handlers[job.type];
    if (typeof handler !== 'function') {
      const err = new Error(`Unknown job type: ${job.type}`);
      err.code = 'ERR-WORKER-001';
      try {
        await Promise.resolve(deps.queue.fail(job.id, err));
      } catch {
        // ignore — queue persistence error already logged elsewhere
      }
      return;
    }
    try {
      const result = await handler(job.payload || {});
      await Promise.resolve(deps.queue.complete(job.id, result ?? {}));
    } catch (err) {
      try {
        await Promise.resolve(deps.queue.fail(job.id, err));
      } catch {
        // ignore
      }
    }
  }

  function finalizeStop() {
    if (!running) return;
    running = false;
    if (stopResolve) {
      const r = stopResolve;
      stopResolve = null;
      r();
    }
  }

  async function stop() {
    stopping = true;
    // Wait for the current job (if any) to finish.
    if (inFlight) {
      try { await inFlight; } catch { /* errors already routed to queue.fail */ }
    }
    // The loop checks `stopping` AFTER each await wait()/dequeue() — wait for
    // it to acknowledge the stop signal.
    await stoppedPromise;
    // REQ-GH-3 / FR-006 / AC-006-03 — release pg-boss + DB resources
    // gracefully. The legacy SQLite queue's close() is also covered.
    if (deps.queue && typeof deps.queue.close === 'function') {
      try {
        await Promise.resolve(deps.queue.close());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[worker] queue.close() failed during shutdown:', err?.message ?? err);
      }
    }
  }

  return {
    stop,
    running: () => running,
  };
}

/**
 * Default delay implementation. Tests inject a deterministic `wait` to avoid
 * real timers.
 */
function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `add_content` handler — accepts a single chunk-shaped payload, threads it
 * through correlate → embed → store. This bypasses connectors entirely; the
 * caller (typically iSDLC's finalize step or a direct API user) supplies the
 * content.
 *
 * Payload shape:
 *   { project_id: string, content: NormalisedChunk | { content: string, ... } }
 *
 * Missing fields are filled with safe defaults (source_type='direct',
 * source_url='', last_modified=now).
 */
async function runAddContent(payload, deps) {
  if (!payload || typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    throw new TypeError('add_content: payload.project_id is required');
  }
  const raw = payload.content;
  if (!raw || (typeof raw !== 'object' && typeof raw !== 'string')) {
    throw new TypeError('add_content: payload.content is required');
  }
  const projectId = payload.project_id;

  const project = await deps.configStore.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const chunk = normaliseAddContent(raw, projectId);

  const modelAdapter = deps.modelManager.getAdapter(project.model_config || {});
  const vdb = deps.vectorDbFactory(project.vectordb_config || {});

  const correlated = await deps.correlationEngine.correlate([chunk], project);

  let documentsProcessed = 0;
  const batch = [];
  for await (const embedded of deps.pipeline.embed(correlated, modelAdapter, {
    project: projectId,
    metadata_vocabulary: mergeVocabularies(deps.deploymentVocabulary, project.metadata_vocabulary),
  })) {
    batch.push(embedded);
  }
  if (batch.length > 0) {
    await vdb.store(batch);
    documentsProcessed = batch.length;
  }

  if (deps.auditLogger && typeof deps.auditLogger.log === 'function') {
    try {
      await deps.auditLogger.log('content.added', {
        project_id: projectId,
        path: chunk.path,
        documents_processed: documentsProcessed,
      });
    } catch {
      // ignore
    }
  }

  return { documents_processed: documentsProcessed };
}

function normaliseAddContent(raw, projectId) {
  if (typeof raw === 'string') {
    return {
      content: raw,
      path: `direct/${projectId}/${shortHash(raw)}`,
      source_type: 'direct',
      source_url: '',
      last_modified: new Date().toISOString(),
      metadata: { project: projectId },
    };
  }
  return {
    content: typeof raw.content === 'string' ? raw.content : '',
    path: typeof raw.path === 'string' && raw.path.length > 0
      ? raw.path
      : `direct/${projectId}/${shortHash(raw.content || '')}`,
    source_type: typeof raw.source_type === 'string' ? raw.source_type : 'direct',
    source_url: typeof raw.source_url === 'string' ? raw.source_url : '',
    last_modified: typeof raw.last_modified === 'string'
      ? raw.last_modified
      : new Date().toISOString(),
    metadata: {
      project: projectId,
      ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
    },
  };
}

function shortHash(s) {
  // Tiny, dependency-free hash to give direct-add chunks a stable-ish path.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
