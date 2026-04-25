// Unit tests for src/observability/metrics.js
// Traces: FR-015 / AC-015-01 (Prometheus /metrics endpoint with job queue depth,
//         success/failure counts, document counts, staleness age, model memory,
//         throughput, and API latency).
//
// These tests exercise the public surface of the metrics module:
//   - getMetricsText() returns Prometheus exposition format
//   - typed metric instances exposed for recording
//   - init({ defaultLabels }) registers default labels (e.g., service name)
//   - label cardinality is correct for each metric

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMetricsText,
  init,
  resetForTests,
  metrics,
} from '../../../src/observability/metrics.js';

beforeEach(() => {
  // Each test starts from a clean registry so default labels and recorded
  // values don't leak across cases.
  resetForTests();
});

// ------------------------------------------------------------------ EXPOSITION
describe('getMetricsText() — Prometheus exposition', () => {
  test('returns text/plain Prometheus format with all expected metric names', async () => {
    const text = await getMetricsText();
    // All metrics required by AC-015-01 must be present in the registry, even
    // when no values have been recorded — Prometheus requires definitions
    // to be stable across scrapes.
    assert.match(text, /job_queue_depth/);
    assert.match(text, /job_success_total/);
    assert.match(text, /job_failure_total/);
    assert.match(text, /project_document_count/);
    assert.match(text, /project_staleness_seconds/);
    assert.match(text, /model_memory_bytes/);
    assert.match(text, /embedding_throughput_chunks_per_second/);
    assert.match(text, /api_request_duration_seconds/);
  });

  test('emits TYPE comments matching the metric kind', async () => {
    const text = await getMetricsText();
    assert.match(text, /# TYPE job_queue_depth gauge/);
    assert.match(text, /# TYPE job_success_total counter/);
    assert.match(text, /# TYPE job_failure_total counter/);
    assert.match(text, /# TYPE project_document_count gauge/);
    assert.match(text, /# TYPE project_staleness_seconds gauge/);
    assert.match(text, /# TYPE model_memory_bytes gauge/);
    assert.match(text, /# TYPE embedding_throughput_chunks_per_second gauge/);
    assert.match(text, /# TYPE api_request_duration_seconds histogram/);
  });
});

// ------------------------------------------------------------------ COUNTERS
describe('job success / failure counters', () => {
  test('recordJobSuccess increments job_success_total with type label', async () => {
    metrics.recordJobSuccess('full_rebuild');
    metrics.recordJobSuccess('full_rebuild');
    metrics.recordJobSuccess('incremental_refresh');
    const text = await getMetricsText();
    assert.match(text, /job_success_total\{[^}]*type="full_rebuild"[^}]*\} 2/);
    assert.match(text, /job_success_total\{[^}]*type="incremental_refresh"[^}]*\} 1/);
  });

  test('recordJobFailure increments job_failure_total with type label', async () => {
    metrics.recordJobFailure('full_rebuild');
    metrics.recordJobFailure('incremental_refresh');
    metrics.recordJobFailure('incremental_refresh');
    const text = await getMetricsText();
    assert.match(text, /job_failure_total\{[^}]*type="full_rebuild"[^}]*\} 1/);
    assert.match(text, /job_failure_total\{[^}]*type="incremental_refresh"[^}]*\} 2/);
  });
});

// ------------------------------------------------------------------ GAUGES
describe('queue depth / project / model gauges', () => {
  test('setQueueDepth records job_queue_depth with status label', async () => {
    metrics.setQueueDepth('queued', 5);
    metrics.setQueueDepth('running', 1);
    metrics.setQueueDepth('failed', 0);
    const text = await getMetricsText();
    assert.match(text, /job_queue_depth\{[^}]*status="queued"[^}]*\} 5/);
    assert.match(text, /job_queue_depth\{[^}]*status="running"[^}]*\} 1/);
    assert.match(text, /job_queue_depth\{[^}]*status="failed"[^}]*\} 0/);
  });

  test('setProjectDocumentCount records project_document_count by project', async () => {
    metrics.setProjectDocumentCount('payments-2.7', 250);
    metrics.setProjectDocumentCount('checkout-1.0', 100);
    const text = await getMetricsText();
    assert.match(text, /project_document_count\{[^}]*project="payments-2\.7"[^}]*\} 250/);
    assert.match(text, /project_document_count\{[^}]*project="checkout-1\.0"[^}]*\} 100/);
  });

  test('setProjectStalenessSeconds records staleness by project', async () => {
    metrics.setProjectStalenessSeconds('payments-2.7', 300);
    metrics.setProjectStalenessSeconds('checkout-1.0', 7200);
    const text = await getMetricsText();
    assert.match(text, /project_staleness_seconds\{[^}]*project="payments-2\.7"[^}]*\} 300/);
    assert.match(text, /project_staleness_seconds\{[^}]*project="checkout-1\.0"[^}]*\} 7200/);
  });

  test('setModelMemoryBytes records model footprint with name + type labels', async () => {
    metrics.setModelMemoryBytes('jina-v2-base-code', 'fp16', 280 * 1024 * 1024);
    metrics.setModelMemoryBytes('all-MiniLM-L6-v2', 'fp32', 90 * 1024 * 1024);
    const text = await getMetricsText();
    assert.match(text, /model_memory_bytes\{[^}]*name="jina-v2-base-code"[^}]*type="fp16"[^}]*\}/);
    assert.match(text, /model_memory_bytes\{[^}]*name="all-MiniLM-L6-v2"[^}]*type="fp32"[^}]*\}/);
  });
});

// ------------------------------------------------------------------ THROUGHPUT
describe('embedding throughput', () => {
  test('recordEmbedding sets the chunks/sec gauge', async () => {
    metrics.recordEmbedding(42.5);
    const text = await getMetricsText();
    assert.match(text, /embedding_throughput_chunks_per_second(\{[^}]*\})? 42\.5/);
  });

  test('recordEmbedding overwrites the previous value (gauge semantics)', async () => {
    metrics.recordEmbedding(10);
    metrics.recordEmbedding(20);
    const text = await getMetricsText();
    // 20 must appear; 10 must not be the current value.
    assert.match(text, /embedding_throughput_chunks_per_second(\{[^}]*\})? 20/);
  });
});

// ------------------------------------------------------------------ HISTOGRAM
describe('api_request_duration_seconds histogram', () => {
  test('recordRequest observes duration with method/route/status labels', async () => {
    metrics.recordRequest('GET', '/api/system/health', 200, 0.012);
    metrics.recordRequest('POST', '/api/refresh', 202, 0.150);
    metrics.recordRequest('GET', '/api/system/health', 200, 0.008);
    const text = await getMetricsText();
    // Histograms emit *_count, *_sum and *_bucket lines.
    assert.match(
      text,
      /api_request_duration_seconds_count\{[^}]*method="GET"[^}]*route="\/api\/system\/health"[^}]*status="200"[^}]*\} 2/,
    );
    assert.match(
      text,
      /api_request_duration_seconds_count\{[^}]*method="POST"[^}]*route="\/api\/refresh"[^}]*status="202"[^}]*\} 1/,
    );
    assert.match(text, /api_request_duration_seconds_bucket\{[^}]*le="[^"]+"[^}]*\}/);
  });
});

// ------------------------------------------------------------------ INIT / DEFAULTS
describe('init({ defaultLabels })', () => {
  test('default service label appears on every emitted sample', async () => {
    init({ defaultLabels: { service: 'isdlc-knowledge-service' } });
    metrics.recordJobSuccess('full_rebuild');
    metrics.setQueueDepth('queued', 3);
    const text = await getMetricsText();
    // Every sample line must carry service="isdlc-knowledge-service".
    const sampleLines = text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    assert.ok(sampleLines.length > 0, 'expected at least one sample line');
    for (const line of sampleLines) {
      assert.ok(
        /service="isdlc-knowledge-service"/.test(line),
        `sample line missing default label: ${line}`,
      );
    }
  });

  test('init() may be called multiple times without throwing', () => {
    init({ defaultLabels: { service: 'a' } });
    init({ defaultLabels: { service: 'b' } });
    // No assertion beyond not throwing — re-init must be idempotent.
  });
});

// ------------------------------------------------------------------ LABEL CARDINALITY
describe('label cardinality contract', () => {
  test('each metric exposes exactly the documented labels', async () => {
    metrics.setQueueDepth('queued', 1);
    metrics.recordJobSuccess('full_rebuild');
    metrics.recordJobFailure('full_rebuild');
    metrics.setProjectDocumentCount('p', 1);
    metrics.setProjectStalenessSeconds('p', 1);
    metrics.setModelMemoryBytes('m', 'fp16', 1);
    metrics.recordRequest('GET', '/x', 200, 0.001);

    const text = await getMetricsText();
    // job_queue_depth has exactly { status }
    assert.match(text, /job_queue_depth\{status="queued"\}/);
    // job_success_total / job_failure_total have exactly { type }
    assert.match(text, /job_success_total\{type="full_rebuild"\}/);
    assert.match(text, /job_failure_total\{type="full_rebuild"\}/);
    // project_document_count / project_staleness_seconds have exactly { project }
    assert.match(text, /project_document_count\{project="p"\}/);
    assert.match(text, /project_staleness_seconds\{project="p"\}/);
    // model_memory_bytes has { name, type } (order not guaranteed)
    assert.match(text, /model_memory_bytes\{(name="m",type="fp16"|type="fp16",name="m")\}/);
    // api_request_duration_seconds has { method, route, status } + le for buckets
    assert.match(text, /api_request_duration_seconds_count\{method="GET",route="\/x",status="200"\}/);
  });
});
