// Module 14: Observability
// Responsibility: Prometheus metrics, OpenTelemetry traces, staleness detection.
// Submodules: metrics.js, tracing.js, staleness.js
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 14

export { default as metrics } from './metrics.js';
export { default as tracing } from './tracing.js';
export { default as staleness } from './staleness.js';
