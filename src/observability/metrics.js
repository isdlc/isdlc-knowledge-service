// T028: Prometheus /metrics endpoint backed by prom-client.
// Traces: FR-015 / AC-015-01 (job queue depth, success/failure counts, document
//         counts, staleness age, model memory, throughput, API latency).
// See:    docs/requirements/REQ-GH-263-.../module-design.md §Module 14
//
// Public surface:
//   getMetricsText()                      → Promise<string> Prometheus text format
//   init({ defaultLabels })               → register default labels (e.g., service)
//   resetForTests()                       → clear registry + recreate metric instances
//   metrics.recordJobSuccess(type)
//   metrics.recordJobFailure(type)
//   metrics.setQueueDepth(status, n)
//   metrics.setProjectDocumentCount(project, n)
//   metrics.setProjectStalenessSeconds(project, secs)
//   metrics.setModelMemoryBytes(name, type, bytes)
//   metrics.recordEmbedding(chunksPerSec)
//   metrics.recordRequest(method, route, status, durationSeconds)
//
// The handler at GET /metrics in src/api/routes/system.js is wired to
// getMetricsText() with content-type "text/plain; version=0.0.4".

import { Registry, Counter, Gauge, Histogram } from 'prom-client';

/** Lazily-built singleton registry. */
let registry = null;

/** Typed metric instances — recreated by resetForTests(). */
let jobQueueDepth = null;
let jobSuccessTotal = null;
let jobFailureTotal = null;
let projectDocumentCount = null;
let projectStalenessSeconds = null;
let modelMemoryBytes = null;
let embeddingThroughput = null;
let apiRequestDurationSeconds = null;

/**
 * Build the registry + register every typed metric. Idempotent: calling twice
 * returns the same registry — to start fresh use resetForTests().
 */
function ensureRegistry() {
  if (registry) return registry;
  registry = new Registry();

  jobQueueDepth = new Gauge({
    name: 'job_queue_depth',
    help: 'Number of jobs in the queue, partitioned by status.',
    labelNames: ['status'],
    registers: [registry],
  });

  jobSuccessTotal = new Counter({
    name: 'job_success_total',
    help: 'Total number of jobs that completed successfully, partitioned by type.',
    labelNames: ['type'],
    registers: [registry],
  });

  jobFailureTotal = new Counter({
    name: 'job_failure_total',
    help: 'Total number of jobs that failed, partitioned by type.',
    labelNames: ['type'],
    registers: [registry],
  });

  projectDocumentCount = new Gauge({
    name: 'project_document_count',
    help: 'Document count per project.',
    labelNames: ['project'],
    registers: [registry],
  });

  projectStalenessSeconds = new Gauge({
    name: 'project_staleness_seconds',
    help: 'Staleness age in seconds per project (drift since last indexed).',
    labelNames: ['project'],
    registers: [registry],
  });

  modelMemoryBytes = new Gauge({
    name: 'model_memory_bytes',
    help: 'Model memory footprint in bytes, partitioned by model name and quantisation type.',
    labelNames: ['name', 'type'],
    registers: [registry],
  });

  embeddingThroughput = new Gauge({
    name: 'embedding_throughput_chunks_per_second',
    help: 'Most recent embedding throughput measured in chunks per second.',
    registers: [registry],
  });

  apiRequestDurationSeconds = new Histogram({
    name: 'api_request_duration_seconds',
    help: 'API request latency in seconds, partitioned by method, route, and status.',
    labelNames: ['method', 'route', 'status'],
    // Buckets tuned for sub-millisecond local handlers up to ~5s remote calls.
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  return registry;
}

/**
 * Initialise the metrics registry. Currently the only configurable knob is
 * defaultLabels (e.g., { service: "isdlc-knowledge-service" }), which prom-client
 * applies to every emitted sample.
 *
 * @param {{ defaultLabels?: Record<string, string> }} [opts]
 */
export function init(opts = {}) {
  ensureRegistry();
  if (opts && opts.defaultLabels) {
    registry.setDefaultLabels(opts.defaultLabels);
  }
}

/**
 * Return the Prometheus text-format exposition for all registered metrics.
 * The content-type for the response is `text/plain; version=0.0.4`.
 *
 * @returns {Promise<string>}
 */
export async function getMetricsText() {
  ensureRegistry();
  return registry.metrics();
}

/**
 * Test helper: clear the registry and recreate every metric instance.
 * Calling code in production never needs this — only the unit tests do.
 */
export function resetForTests() {
  if (registry) registry.clear();
  registry = null;
  jobQueueDepth = null;
  jobSuccessTotal = null;
  jobFailureTotal = null;
  projectDocumentCount = null;
  projectStalenessSeconds = null;
  modelMemoryBytes = null;
  embeddingThroughput = null;
  apiRequestDurationSeconds = null;
  ensureRegistry();
}

/**
 * Recorder API surface — modules call these helpers rather than poking the
 * metric instances directly. Keeps the registry an internal detail.
 */
export const metrics = {
  recordJobSuccess(type) {
    ensureRegistry();
    jobSuccessTotal.inc({ type });
  },
  recordJobFailure(type) {
    ensureRegistry();
    jobFailureTotal.inc({ type });
  },
  setQueueDepth(status, n) {
    ensureRegistry();
    jobQueueDepth.set({ status }, n);
  },
  setProjectDocumentCount(project, n) {
    ensureRegistry();
    projectDocumentCount.set({ project }, n);
  },
  setProjectStalenessSeconds(project, secs) {
    ensureRegistry();
    projectStalenessSeconds.set({ project }, secs);
  },
  setModelMemoryBytes(name, type, bytes) {
    ensureRegistry();
    modelMemoryBytes.set({ name, type }, bytes);
  },
  recordEmbedding(chunksPerSecond) {
    ensureRegistry();
    embeddingThroughput.set(chunksPerSecond);
  },
  recordRequest(method, route, status, durationSeconds) {
    ensureRegistry();
    apiRequestDurationSeconds.observe(
      { method, route, status: String(status) },
      durationSeconds,
    );
  },
};

export default metrics;
