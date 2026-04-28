// REQ-GH-3 / FR-007 — config-as-code import/export CLI helpers.
//
// Three export scopes (AC-007-01):
//   * project    — single project's config + refresh history (+ scoped audit)
//   * all        — every project; deployment-wide audit/IE-runs excluded
//   * deployment — projects + audit_entries + import_export_runs +
//                   queue/job history when pg-boss exposes it
//
// Import (AC-007-02 / AC-007-04):
//   * Validates payload version BEFORE any DB mutation.
//   * Wraps the apply phase in a transaction; on partial failure raises
//     the underlying error and rolls back, recording the run as 'failure'.

import { readFile, writeFile } from 'node:fs/promises';

import { DatabaseError } from '../db/pool.js';

export const PAYLOAD_VERSION = 1;
const EXPORT_SCOPES = new Set(['project', 'all', 'deployment']);

export class ConfigImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigImportError';
    this.code = code;
  }
}

/**
 * @typedef {object} ExportPayload
 * @property {number} version
 * @property {string} exported_at
 * @property {"project"|"all"|"deployment"} scope
 * @property {string} [target_id]            — project id when scope='project'
 * @property {object} [service_config]       — sanitised .ks/config.json copy
 * @property {object[]} projects
 * @property {object[]} refresh_history
 * @property {object[]} [audit_entries]      — only when scope='deployment'
 * @property {object[]} [import_export_runs] — only when scope='deployment'
 * @property {object[]} [jobs]               — only when scope='deployment' AND queue.listJobs available
 */

/**
 * Build an export payload from the live state store.
 *
 * @param {{
 *   stateStore: ReturnType<typeof import('../state/postgres-state-store.js').createPostgresStateStore>,
 *   queue?: { listJobs?: Function },
 *   serviceConfig?: object,
 *   scope: "project"|"all"|"deployment",
 *   target_id?: string,
 *   limits?: { auditMax?: number, refreshMax?: number, runsMax?: number, jobsMax?: number },
 * }} options
 * @returns {Promise<ExportPayload>}
 */
export async function exportConfig(options = {}) {
  const { stateStore, scope, target_id, queue, serviceConfig, limits = {} } = options;
  if (!stateStore) {
    throw new ConfigImportError('ERR-EXPORT-001', 'exportConfig requires a stateStore');
  }
  if (!EXPORT_SCOPES.has(scope)) {
    throw new ConfigImportError(
      'ERR-EXPORT-001',
      `Unknown scope "${scope}". Use one of: ${[...EXPORT_SCOPES].join(', ')}`,
    );
  }

  const auditMax = limits.auditMax ?? 10_000;
  const refreshMax = limits.refreshMax ?? 1_000;
  const runsMax = limits.runsMax ?? 1_000;
  const jobsMax = limits.jobsMax ?? 1_000;

  const out = /** @type {ExportPayload} */ ({
    version: PAYLOAD_VERSION,
    exported_at: new Date().toISOString(),
    scope,
    projects: [],
    refresh_history: [],
  });
  if (serviceConfig) out.service_config = serviceConfig;

  if (scope === 'project') {
    if (typeof target_id !== 'string' || target_id.length === 0) {
      throw new ConfigImportError(
        'ERR-EXPORT-001',
        'scope=project requires target_id (project id to export)',
      );
    }
    out.target_id = target_id;
    const project = await stateStore.projects.get(target_id);
    if (!project) {
      throw new ConfigImportError('ERR-EXPORT-001', `Project not found: ${target_id}`);
    }
    out.projects.push(project);
    out.refresh_history = await stateStore.refreshHistory.list(target_id, { limit: refreshMax });
  } else {
    // all and deployment both export every project + their refresh history.
    const projects = await stateStore.projects.list();
    out.projects = projects;
    for (const p of projects) {
      const history = await stateStore.refreshHistory.list(p.id, { limit: refreshMax });
      out.refresh_history.push(...history);
    }
  }

  if (scope === 'deployment') {
    out.audit_entries = await stateStore.audit.query({ limit: auditMax });
    out.import_export_runs = await stateStore.importExport.listRuns({ limit: runsMax });
    if (queue && typeof queue.listJobs === 'function') {
      try {
        out.jobs = await queue.listJobs({ limit: jobsMax });
      } catch (err) {
        // Queue history is best-effort per AC-007-03 — don't fail the export.
        out.jobs = [];
        out.jobs_export_warning = err && err.message ? err.message : 'queue.listJobs failed';
      }
    } else {
      out.jobs = [];
    }
  }

  return out;
}

/**
 * Validate an import payload's shape and version.
 *
 * @param {object | undefined | null} payload
 * @returns {string[]}
 */
export function validateImportPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Import payload must be a JSON object'];
  }
  if (payload.version !== PAYLOAD_VERSION) {
    errors.push(`Unsupported payload version ${JSON.stringify(payload.version)}; expected ${PAYLOAD_VERSION}`);
  }
  if (!EXPORT_SCOPES.has(payload.scope)) {
    errors.push(`Unknown scope ${JSON.stringify(payload.scope)}`);
  }
  if (!Array.isArray(payload.projects)) {
    errors.push('projects must be an array');
  }
  if (!Array.isArray(payload.refresh_history)) {
    errors.push('refresh_history must be an array');
  }
  if (payload.scope === 'project' && typeof payload.target_id !== 'string') {
    errors.push('scope=project requires target_id');
  }
  return errors;
}

/**
 * Apply an import payload to the live state store. Wraps every mutation in
 * a single transaction (AC-007-04). On error, rolls back and records the
 * import_export run with status='failure'.
 *
 * @param {{
 *   stateStore: ReturnType<typeof import('../state/postgres-state-store.js').createPostgresStateStore>,
 *   payload: object,
 *   strategy?: 'replace'|'merge',
 * }} options
 * @returns {Promise<{ projects_imported: number, refresh_records_imported: number,
 *                     audit_entries_imported: number, runs_imported: number }>}
 */
export async function importConfig(options = {}) {
  const { stateStore, payload, strategy = 'merge' } = options;
  if (!stateStore) {
    throw new ConfigImportError('ERR-IMPORT-001', 'importConfig requires a stateStore');
  }

  const errors = validateImportPayload(payload);
  if (errors.length > 0) {
    throw new ConfigImportError(
      'ERR-IMPORT-001',
      `Import payload is invalid:\n  - ${errors.join('\n  - ')}`,
    );
  }

  const stats = {
    projects_imported: 0,
    refresh_records_imported: 0,
    audit_entries_imported: 0,
    runs_imported: 0,
  };

  let runErr = null;
  try {
    await stateStore.transaction(async (tx) => {
      for (const project of payload.projects) {
        if (!project || typeof project.id !== 'string') {
          throw new ConfigImportError(
            'ERR-IMPORT-001',
            'Invalid project entry (missing id) in import payload',
          );
        }
        if (strategy === 'replace') {
          await tx.projects.delete(project.id).catch(() => {});
        }
        const existing = await tx.projects.get(project.id);
        if (existing) {
          // Patch — preserves created_at and lets updated_at advance via tx.now().
          await tx.projects.update(project.id, project);
        } else {
          await tx.projects.create(project);
        }
        stats.projects_imported += 1;
      }

      for (const record of payload.refresh_history) {
        if (!record || typeof record.project_id !== 'string') continue;
        await tx.refreshHistory.add(record.project_id, record);
        stats.refresh_records_imported += 1;
      }

      if (Array.isArray(payload.audit_entries)) {
        for (const entry of payload.audit_entries) {
          if (!entry || typeof entry.action !== 'string') continue;
          await tx.audit.log(entry.action, entry.details ?? {}, {
            project_id: entry.project_id ?? null,
            ip_address: entry.ip_address ?? null,
            actor: entry.actor ?? null,
          });
          stats.audit_entries_imported += 1;
        }
      }

      if (Array.isArray(payload.import_export_runs)) {
        for (const run of payload.import_export_runs) {
          if (!run || typeof run.direction !== 'string') continue;
          await tx.importExport.recordRun(run);
          stats.runs_imported += 1;
        }
      }
    });
  } catch (err) {
    runErr = err;
  }

  // Record the import run regardless of outcome so the operator has a
  // permanent record of what was attempted.
  try {
    await stateStore.importExport.recordRun({
      direction: 'import',
      scope: payload.scope,
      target_id: payload.target_id ?? null,
      status: runErr ? 'failure' : 'success',
      payload_size: estimatePayloadSize(payload),
      manifest: { strategy, ...stats },
      error: runErr ? String(runErr.message ?? runErr) : null,
    });
  } catch {
    // Best-effort run recording — never mask the original error.
  }

  if (runErr) throw runErr;
  return stats;
}

/**
 * Read a JSON payload from disk and import it.
 *
 * @param {{ stateStore: object, file: string, strategy?: 'replace'|'merge' }} options
 */
export async function importConfigFromFile(options) {
  const raw = await readFile(options.file, 'utf8').catch((err) => {
    throw new ConfigImportError('ERR-IMPORT-001', `Cannot read import file ${options.file}: ${err.message}`);
  });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new ConfigImportError('ERR-IMPORT-001', `Import file ${options.file} is not valid JSON: ${err.message}`);
  }
  return importConfig({ stateStore: options.stateStore, payload, strategy: options.strategy });
}

/**
 * Serialise an export payload to disk.
 * @param {{ payload: object, file: string }} options
 */
export async function writeExportToFile(options) {
  const json = JSON.stringify(options.payload, null, 2);
  await writeFile(options.file, json + '\n', 'utf8');
  return { bytes: Buffer.byteLength(json, 'utf8') };
}

function estimatePayloadSize(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return null;
  }
}

/**
 * @returns {string[]}  list of supported export scopes
 */
export function listScopes() {
  return [...EXPORT_SCOPES];
}

/**
 * @returns {DatabaseError}  surfaced when wiring is incomplete (not used today)
 */
export function _internalDatabaseErrorRef() {
  return DatabaseError;
}
