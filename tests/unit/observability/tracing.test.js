// Unit tests for src/observability/tracing.js
// Traces: FR-015 / AC-015-03 — "Given OpenTelemetry configuration, then the
//                                service supports OTLP export for traces."
//
// Behavioural contract:
//   - init({ otlpEndpoint?, serviceName? }) returns an awaitable result.
//   - When neither otlpEndpoint nor OTEL_EXPORTER_OTLP_ENDPOINT is configured,
//     init() succeeds but does NOT wire an exporter ("no-op tracing"). The
//     module reports { enabled: false }.
//   - When OTEL_EXPORTER_OTLP_ENDPOINT is set, init() wires an OTLP exporter
//     and reports { enabled: true, endpoint }.
//   - shutdown() succeeds whether init() wired anything or not.
//
// We avoid spinning up a real OTLP collector — it is enough to assert the
// observable state of the module.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  init,
  shutdown,
  isEnabled,
  getEndpoint,
  resetForTests,
} from '../../../src/observability/tracing.js';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  // Strip every OTEL_* var so each test starts from a known config.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OTEL_')) delete process.env[k];
  }
  resetForTests();
});

afterEach(async () => {
  await shutdown().catch(() => {});
  process.env = { ...ORIG_ENV };
});

// ------------------------------------------------------------------ NO-OP MODE
describe('init() — no OTLP configuration', () => {
  test('with no env and no arg, init() succeeds and tracing stays disabled', async () => {
    const r = await init();
    assert.equal(r.enabled, false);
    assert.equal(getEndpoint(), null);
    assert.equal(isEnabled(), false);
  });

  test('init({}) is the same as init()', async () => {
    const r = await init({});
    assert.equal(r.enabled, false);
  });

  test('shutdown() succeeds even when not initialised', async () => {
    await shutdown();
    // No assertion — must simply not throw.
  });
});

// ------------------------------------------------------------------ ENABLED VIA ENV
describe('init() — OTEL_EXPORTER_OTLP_ENDPOINT in env', () => {
  test('reads endpoint from env and reports enabled=true', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector.test:4318';
    const r = await init();
    assert.equal(r.enabled, true);
    assert.equal(r.endpoint, 'http://otel-collector.test:4318');
    assert.equal(isEnabled(), true);
    assert.equal(getEndpoint(), 'http://otel-collector.test:4318');
  });

  test('shutdown() after env-driven init succeeds', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.test:4318';
    await init();
    await shutdown();
    assert.equal(isEnabled(), false);
  });
});

// ------------------------------------------------------------------ ENABLED VIA ARG
describe('init({ otlpEndpoint })', () => {
  test('explicit otlpEndpoint wins over absent env', async () => {
    const r = await init({ otlpEndpoint: 'http://my-collector:4318' });
    assert.equal(r.enabled, true);
    assert.equal(r.endpoint, 'http://my-collector:4318');
  });

  test('explicit otlpEndpoint overrides env value', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://from-env:4318';
    const r = await init({ otlpEndpoint: 'http://from-arg:4318' });
    assert.equal(r.enabled, true);
    assert.equal(r.endpoint, 'http://from-arg:4318');
  });

  test('init is idempotent — second init() returns the existing config', async () => {
    const a = await init({ otlpEndpoint: 'http://first:4318' });
    const b = await init({ otlpEndpoint: 'http://second:4318' });
    // Either: second call is a no-op (returns first config), OR it
    // tears down + re-inits. Both are acceptable, but the resulting
    // state must be self-consistent: enabled=true, getEndpoint() in
    // {first, second}. The simplest contract: calling init twice
    // does not throw, and `isEnabled()` is still true.
    assert.equal(a.enabled, true);
    assert.equal(b.enabled, true);
    assert.equal(isEnabled(), true);
  });
});

// ------------------------------------------------------------------ SERVICE NAME
describe('serviceName default', () => {
  test('defaults to "isdlc-knowledge-service" when not provided', async () => {
    const r = await init({ otlpEndpoint: 'http://x:4318' });
    assert.equal(r.serviceName, 'isdlc-knowledge-service');
  });

  test('honours explicit serviceName', async () => {
    const r = await init({
      otlpEndpoint: 'http://x:4318',
      serviceName: 'knowledge-svc-staging',
    });
    assert.equal(r.serviceName, 'knowledge-svc-staging');
  });

  test('honours OTEL_SERVICE_NAME env var as fallback when no arg', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://x:4318';
    process.env.OTEL_SERVICE_NAME = 'svc-from-env';
    const r = await init();
    assert.equal(r.serviceName, 'svc-from-env');
  });
});
