// Module 13: Audit Logger — public entry point.
// Traces: FR-014 (AC-014-01..05)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 13
//      docs/requirements/REQ-GH-263-.../interface-spec.md §AuditEntry
//
// CONSTITUTIONAL CONSTRAINT: this module exposes ONLY append + read.
// There is no `delete`, `update`, `truncate`, `clear`, or any other mutation
// API — the audit log is append-only by design (AC-014-04). Tests verify
// this by allowlist over the module's exports.

import path from 'node:path';
import { createAuditLogger } from './logger.js';

/**
 * @typedef {object} AuditEntry
 * @property {string} timestamp
 * @property {string} action
 * @property {string} [project_id]
 * @property {object} details
 * @property {string} [ip_address]
 */

const DEFAULT_PATH = path.resolve('./data/audit.jsonl');

// Lazily-instantiated default logger so the file is not created until the
// first call. Useful for tests and tools that import the module without
// intending to write.
let _default = null;
function defaultLogger() {
  if (_default === null) {
    _default = createAuditLogger({ path: DEFAULT_PATH });
  }
  return _default;
}

/**
 * Append an admin action to the default audit log.
 *
 * @param {string} action     e.g. "project.created"
 * @param {object} [details]
 * @returns {Promise<void>}
 */
export function log(action, details) {
  return defaultLogger().log(action, details);
}

/**
 * Query the default audit log with filters.
 *
 * @param {object} [filters]    { project?, action?, from?, to?, limit?, offset? }
 * @returns {Promise<AuditEntry[]>}
 */
export function query(filters) {
  return defaultLogger().query(filters);
}

// Re-export the factory for tests and callers that need a custom path
// (e.g., per-project audit shards or alternate storage roots).
export { createAuditLogger };
