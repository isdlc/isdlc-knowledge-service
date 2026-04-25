// T028: OpenTelemetry OTLP exporter wiring.
// Traces: FR-015 / AC-015-03 — "Given OpenTelemetry configuration, then the
//                                service supports OTLP export for traces."
// See:    docs/requirements/REQ-GH-263-.../module-design.md §Module 14
//
// Tracing is opt-in:
//   - If neither `otlpEndpoint` (arg) nor `OTEL_EXPORTER_OTLP_ENDPOINT` (env)
//     is configured, init() succeeds but does NOT wire an exporter. The SDK
//     remains uninitialised. This keeps tracing free in default deployments.
//   - If an endpoint is configured (env or arg), init() lazily imports the
//     SDK + exporter and starts it. We import lazily so that the no-op path
//     never pulls the heavy SDK into the loader graph.
//
// Public surface:
//   init({ otlpEndpoint?, serviceName? }) → Promise<{ enabled, endpoint?, serviceName }>
//   shutdown()                            → Promise<void>
//   isEnabled()                           → boolean
//   getEndpoint()                         → string|null
//   resetForTests()                       → reset module state

const DEFAULT_SERVICE_NAME = 'isdlc-knowledge-service';

/** Module-level state. */
let sdkInstance = null;
let activeEndpoint = null;
let activeServiceName = null;

/**
 * Resolve the effective OTLP endpoint from arg + env. Argument wins.
 *
 * @param {{ otlpEndpoint?: string }} [opts]
 * @returns {string|null}
 */
function resolveEndpoint(opts) {
  if (opts && typeof opts.otlpEndpoint === 'string' && opts.otlpEndpoint.length > 0) {
    return opts.otlpEndpoint;
  }
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (typeof envEndpoint === 'string' && envEndpoint.length > 0) {
    return envEndpoint;
  }
  return null;
}

/**
 * Resolve the effective service name from arg + env, defaulting to
 * "isdlc-knowledge-service".
 *
 * @param {{ serviceName?: string }} [opts]
 * @returns {string}
 */
function resolveServiceName(opts) {
  if (opts && typeof opts.serviceName === 'string' && opts.serviceName.length > 0) {
    return opts.serviceName;
  }
  const envName = process.env.OTEL_SERVICE_NAME;
  if (typeof envName === 'string' && envName.length > 0) {
    return envName;
  }
  return DEFAULT_SERVICE_NAME;
}

/**
 * Initialise OpenTelemetry tracing with an OTLP/HTTP exporter when configured.
 * No-op (returns enabled=false) when no endpoint is configured.
 *
 * @param {{ otlpEndpoint?: string, serviceName?: string }} [opts]
 * @returns {Promise<{ enabled: boolean, endpoint?: string, serviceName: string }>}
 */
export async function init(opts = {}) {
  const endpoint = resolveEndpoint(opts);
  const serviceName = resolveServiceName(opts);

  if (!endpoint) {
    // No exporter wired — tracing stays disabled.
    activeEndpoint = null;
    activeServiceName = serviceName;
    return { enabled: false, serviceName };
  }

  // If already initialised, treat the call as idempotent. We do not tear
  // down + rebuild — the cost is non-trivial and the contract only requires
  // that re-init does not throw. The earlier endpoint/serviceName remain
  // active.
  if (sdkInstance) {
    return {
      enabled: true,
      endpoint: activeEndpoint,
      serviceName: activeServiceName,
    };
  }

  // Lazy-import the SDK + OTLP exporter so the no-op path never pulls them
  // into the loader graph.
  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);

  const traceExporter = new OTLPTraceExporter({ url: endpoint });
  sdkInstance = new NodeSDK({
    serviceName,
    traceExporter,
  });
  // start() is synchronous in current SDK versions but we wrap defensively.
  await Promise.resolve(sdkInstance.start());

  activeEndpoint = endpoint;
  activeServiceName = serviceName;
  return { enabled: true, endpoint, serviceName };
}

/**
 * Gracefully shut down the OpenTelemetry SDK if it was initialised.
 * Always succeeds — never throws.
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (!sdkInstance) {
    activeEndpoint = null;
    return;
  }
  try {
    await sdkInstance.shutdown();
  } catch {
    // Swallow — shutdown errors should not block service teardown.
  } finally {
    sdkInstance = null;
    activeEndpoint = null;
  }
}

/**
 * Whether tracing is currently exporting to an OTLP endpoint.
 * @returns {boolean}
 */
export function isEnabled() {
  return sdkInstance !== null && activeEndpoint !== null;
}

/**
 * The active OTLP endpoint, or null when tracing is in no-op mode.
 * @returns {string|null}
 */
export function getEndpoint() {
  return activeEndpoint;
}

/**
 * Test helper: clear module state without invoking SDK shutdown.
 * Production code never calls this.
 */
export function resetForTests() {
  sdkInstance = null;
  activeEndpoint = null;
  activeServiceName = null;
}

export default { init, shutdown, isEnabled, getEndpoint };
