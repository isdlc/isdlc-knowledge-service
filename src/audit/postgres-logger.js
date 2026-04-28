// REQ-GH-3 / FR-005 — Postgres-backed audit logger.
//
// Same `{ log, query }` surface as the existing JSONL logger so callers
// (REST, MCP, worker, CLI) don't change. The append-only invariant is
// enforced at the database role layer (ks_app cannot UPDATE/DELETE
// audit_entries; see migrations/001_state_substrate.sql).
//
// Constitutional constraint preserved: this module exposes ONLY `log`
// and `query`. No update/delete/truncate path.

import { DatabaseError } from '../db/pool.js';

/**
 * @typedef {object} AuditEntry
 * @property {string} timestamp     ISO-8601 UTC timestamp
 * @property {string} action        e.g. "project.created"
 * @property {string} [project_id]
 * @property {object} details
 * @property {string} [ip_address]
 */

/**
 * Build a Postgres audit logger that delegates to the shared state store.
 *
 * @param {{
 *   stateStore?: ReturnType<typeof import('../state/postgres-state-store.js').createPostgresStateStore>,
 *   pool?: import('pg').Pool,
 * }} options
 *   Either `stateStore` or `pool` must be provided. Production wiring
 *   passes the shared state store so transactions flow through one
 *   boundary; tests can pass a fake pool to isolate audit behavior.
 */
export function createPostgresAuditLogger(options = {}) {
  const audit = resolveAuditPort(options);

  /**
   * @param {string} action
   * @param {object} [details]
   * @param {{ project_id?: string | null, ip_address?: string | null, actor?: string | null }} [meta]
   * @returns {Promise<void>}
   */
  async function log(action, details, meta) {
    await audit.log(action, details ?? {}, meta ?? {});
  }

  /**
   * @param {{ action?: string, project_id?: string, since?: string, until?: string,
   *           limit?: number, offset?: number }} [filters]
   * @returns {Promise<AuditEntry[]>}
   */
  async function query(filters = {}) {
    return audit.query(filters);
  }

  return { log, query };
}

function resolveAuditPort({ stateStore, pool }) {
  if (stateStore && stateStore.audit) return stateStore.audit;
  if (pool && typeof pool.query === 'function') {
    // Lazy import to avoid a cycle when the audit module loads alongside
    // the state module.
    // eslint-disable-next-line global-require
    return import('../state/postgres-state-store.js').then((m) =>
      m.createPostgresStateStore({ pool }).audit,
    );
  }
  throw new DatabaseError(
    'ERR-DB-002',
    'createPostgresAuditLogger requires a stateStore or a pg pool.',
  );
}
