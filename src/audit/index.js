// Module 13: Audit Logger
// Responsibility: Append-only admin action log.
// Storage: JSONL at data/audit.jsonl, rotated by size.
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 13
// Shape: docs/architecture/data-model.md §2.2

/**
 * @typedef {object} AuditEntry
 * @property {string} timestamp
 * @property {string} action
 * @property {string} [project_id]
 * @property {object} details
 * @property {string} [ip_address]
 */

/**
 * Append an admin action to the audit log.
 * @param {string} action     e.g. "project.created"
 * @param {object} details
 * @returns {Promise<void>}
 */
export async function log(action, details) {
  throw new Error('Not implemented — see T005');
}

/**
 * Query the audit log with filters.
 * @param {object} filters    { project_id?, action?, from?, to?, limit?, offset? }
 * @returns {Promise<AuditEntry[]>}
 */
export async function query(filters) {
  throw new Error('Not implemented — see T005');
}
