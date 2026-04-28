// REQ-GH-3 / FR-004 — Postgres-backed state store.
//
// One DB-backed access boundary for project config, refresh history, audit
// entries, and import/export run records. Callers (config store, audit
// logger, queue, import/export CLI) consume this surface so SQL stays out
// of higher-level modules.
//
// Identity / shape contract: every method returns plain JSON-shaped values
// equivalent to what the legacy JSON store produced. Existing FR-014 audit
// query semantics (action filter, project filter, time range) are preserved.

import { DatabaseError } from '../db/pool.js';

/**
 * @typedef {object} PostgresStateStoreOptions
 * @property {import('pg').Pool} pool
 * @property {string} [schema]   default "ks"
 * @property {() => string} [now]  test seam — defaults to () => new Date().toISOString()
 */

/**
 * Build the state store. The pool is shared with the queue adapter and
 * audit logger so they participate in the same connection pool / pgBouncer.
 *
 * @param {PostgresStateStoreOptions} options
 */
export function createPostgresStateStore(options) {
  if (!options || !options.pool || typeof options.pool.connect !== 'function') {
    throw new DatabaseError(
      'ERR-DB-002',
      'createPostgresStateStore requires a pg Pool. Construct one via src/db/pool.js#createPool.',
    );
  }
  const pool = options.pool;
  const schema = options.schema || 'ks';
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  // Schema is a static identifier from service config — interpolate
  // directly. Untrusted input never reaches this string.
  const t = (table) => `${schema}.${table}`;

  // --------------------------------------------------------------------
  // projects
  // --------------------------------------------------------------------
  const projects = {
    /** @returns {Promise<Array<object>>} */
    async list() {
      const res = await pool.query(
        `SELECT id, name, version, description, sources, model_config, vectordb_config,
                metadata_vocabulary, created_at, updated_at
           FROM ${t('projects')}
          ORDER BY id ASC`,
      );
      return res.rows.map(rowToProject);
    },

    /**
     * @param {string} id
     * @returns {Promise<object | null>}
     */
    async get(id) {
      assertId(id);
      const res = await pool.query(
        `SELECT id, name, version, description, sources, model_config, vectordb_config,
                metadata_vocabulary, created_at, updated_at
           FROM ${t('projects')}
          WHERE id = $1`,
        [id],
      );
      if (res.rowCount === 0) return null;
      return rowToProject(res.rows[0]);
    },

    /**
     * @param {object} project — must already include `id`. The config-store
     * layer slugifies + validates before calling this.
     */
    async create(project) {
      assertProjectShape(project);
      const ts = now();
      try {
        const res = await pool.query(
          `INSERT INTO ${t('projects')}
             (id, name, version, description, sources, model_config, vectordb_config,
              metadata_vocabulary, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
           RETURNING id, name, version, description, sources, model_config, vectordb_config,
                     metadata_vocabulary, created_at, updated_at`,
          [
            project.id,
            project.name,
            project.version,
            project.description ?? null,
            JSON.stringify(project.sources ?? []),
            JSON.stringify(project.model_config ?? {}),
            JSON.stringify(project.vectordb_config ?? {}),
            project.metadata_vocabulary === undefined
              ? null
              : JSON.stringify(project.metadata_vocabulary),
            ts,
            ts,
          ],
        );
        return rowToProject(res.rows[0]);
      } catch (err) {
        if (err && err.code === '23505') {
          // Duplicate primary key — surface as a typed conflict the caller
          // can translate to ERR-API-001 INVALID_PROJECT.
          throw new StateConflictError(`Project already exists: ${project.id}`);
        }
        throw err;
      }
    },

    /**
     * @param {string} id
     * @param {Partial<object>} patch
     */
    async update(id, patch) {
      assertId(id);
      if (!patch || typeof patch !== 'object') {
        throw new TypeError('postgres-state-store.projects.update: patch is required');
      }

      const fields = [];
      const values = [];
      const set = (col, raw, asJson = false) => {
        values.push(asJson ? JSON.stringify(raw) : raw);
        fields.push(`${col} = $${values.length}${asJson ? '::jsonb' : ''}`);
      };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.version !== undefined) set('version', patch.version);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.sources !== undefined) set('sources', patch.sources, true);
      if (patch.model_config !== undefined) set('model_config', patch.model_config, true);
      if (patch.vectordb_config !== undefined) set('vectordb_config', patch.vectordb_config, true);
      if (patch.metadata_vocabulary !== undefined) {
        set('metadata_vocabulary', patch.metadata_vocabulary, true);
      }
      values.push(now());
      fields.push(`updated_at = $${values.length}`);
      values.push(id);

      const res = await pool.query(
        `UPDATE ${t('projects')}
            SET ${fields.join(', ')}
          WHERE id = $${values.length}
          RETURNING id, name, version, description, sources, model_config, vectordb_config,
                    metadata_vocabulary, created_at, updated_at`,
        values,
      );
      if (res.rowCount === 0) return null;
      return rowToProject(res.rows[0]);
    },

    /** @param {string} id */
    async delete(id) {
      assertId(id);
      const res = await pool.query(`DELETE FROM ${t('projects')} WHERE id = $1`, [id]);
      return res.rowCount > 0;
    },
  };

  // --------------------------------------------------------------------
  // refreshHistory
  // --------------------------------------------------------------------
  const refreshHistory = {
    /**
     * @param {string} projectId
     * @param {object} record
     */
    async add(projectId, record) {
      assertId(projectId);
      if (!record || typeof record !== 'object') {
        throw new TypeError('refreshHistory.add: record is required');
      }
      const res = await pool.query(
        `INSERT INTO ${t('refresh_history')}
           (project_id, ts, type, trigger_source, duration_seconds,
            documents_processed, status, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, project_id, ts, type, trigger_source, duration_seconds,
                   documents_processed, status, error`,
        [
          projectId,
          record.timestamp || now(),
          record.type,
          record.trigger_source ?? null,
          record.duration_seconds ?? null,
          record.documents_processed ?? null,
          record.status,
          record.error ?? null,
        ],
      );
      return rowToRefreshRecord(res.rows[0]);
    },

    /**
     * @param {string} projectId
     * @param {{ limit?: number }} [filters]
     */
    async list(projectId, filters = {}) {
      assertId(projectId);
      const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : 100;
      const res = await pool.query(
        `SELECT id, project_id, ts, type, trigger_source, duration_seconds,
                documents_processed, status, error
           FROM ${t('refresh_history')}
          WHERE project_id = $1
          ORDER BY ts DESC
          LIMIT $2`,
        [projectId, limit],
      );
      return res.rows.map(rowToRefreshRecord);
    },
  };

  // --------------------------------------------------------------------
  // audit (FR-005 / AC-005-01..04 — semantics preserved; grants enforced
  // at the role layer in 001_state_substrate.sql).
  // --------------------------------------------------------------------
  const audit = {
    /**
     * @param {string} action
     * @param {object} [details]
     * @param {{ project_id?: string | null, ip_address?: string | null, actor?: string | null }} [meta]
     */
    async log(action, details = {}, meta = {}) {
      if (typeof action !== 'string' || action.length === 0) {
        throw new TypeError('audit.log: action must be a non-empty string');
      }
      const res = await pool.query(
        `INSERT INTO ${t('audit_entries')}
           (ts, action, project_id, details, ip_address, actor)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id, ts, action, project_id, details, ip_address, actor`,
        [
          now(),
          action,
          meta.project_id ?? null,
          JSON.stringify(details ?? {}),
          meta.ip_address ?? null,
          meta.actor ?? null,
        ],
      );
      return rowToAudit(res.rows[0]);
    },

    /**
     * @param {{ action?: string, project_id?: string, since?: string, until?: string,
     *           limit?: number, offset?: number }} [filters]
     */
    async query(filters = {}) {
      const where = [];
      const values = [];
      if (filters.action) {
        values.push(filters.action);
        where.push(`action = $${values.length}`);
      }
      if (filters.project_id) {
        values.push(filters.project_id);
        where.push(`project_id = $${values.length}`);
      }
      if (filters.since) {
        values.push(filters.since);
        where.push(`ts >= $${values.length}`);
      }
      if (filters.until) {
        values.push(filters.until);
        where.push(`ts <= $${values.length}`);
      }
      const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : 200;
      const offset = Number.isInteger(filters.offset) && filters.offset >= 0 ? filters.offset : 0;
      values.push(limit);
      const limitIdx = values.length;
      values.push(offset);
      const offsetIdx = values.length;

      const sql = `SELECT id, ts, action, project_id, details, ip_address, actor
                     FROM ${t('audit_entries')}
                     ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
                    ORDER BY ts DESC
                    LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
      const res = await pool.query(sql, values);
      return res.rows.map(rowToAudit);
    },
  };

  // --------------------------------------------------------------------
  // importExport — operational history of config-as-code runs (FR-007).
  // --------------------------------------------------------------------
  const importExport = {
    async recordRun(run) {
      if (!run || typeof run !== 'object') {
        throw new TypeError('importExport.recordRun: run is required');
      }
      const res = await pool.query(
        `INSERT INTO ${t('import_export_runs')}
           (ts, direction, scope, target_id, status, payload_size, manifest, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id, ts, direction, scope, target_id, status, payload_size, manifest, error`,
        [
          run.timestamp || now(),
          run.direction,
          run.scope,
          run.target_id ?? null,
          run.status,
          run.payload_size ?? null,
          JSON.stringify(run.manifest ?? {}),
          run.error ?? null,
        ],
      );
      return rowToImportExport(res.rows[0]);
    },

    async listRuns(filters = {}) {
      const where = [];
      const values = [];
      if (filters.direction) {
        values.push(filters.direction);
        where.push(`direction = $${values.length}`);
      }
      if (filters.scope) {
        values.push(filters.scope);
        where.push(`scope = $${values.length}`);
      }
      const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : 100;
      values.push(limit);

      const res = await pool.query(
        `SELECT id, ts, direction, scope, target_id, status, payload_size, manifest, error
           FROM ${t('import_export_runs')}
           ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY ts DESC
          LIMIT $${values.length}`,
        values,
      );
      return res.rows.map(rowToImportExport);
    },
  };

  /**
   * Run a function inside a Postgres transaction. The callback receives a
   * scoped store that uses the transaction's connection — every method on
   * that scoped store operates in the same TX.
   *
   * @template T
   * @param {(tx: ReturnType<typeof createPostgresStateStore>) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = createPostgresStateStore({
        pool: clientAsPool(client),
        schema,
        now,
      });
      let result;
      try {
        result = await fn(txStore);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    } finally {
      client.release();
    }
  }

  return { projects, refreshHistory, audit, importExport, transaction };
}

/**
 * Wrap a checked-out client so it satisfies the Pool interface used by the
 * inner store inside a transaction. Only `query` and `connect` are needed.
 * @param {import('pg').PoolClient} client
 */
function clientAsPool(client) {
  return {
    async connect() {
      return {
        query: client.query.bind(client),
        release: () => {},
      };
    },
    async query(...args) {
      return client.query(...args);
    },
    async end() {
      /* tx pool is not endable — ownership stays with the parent pool */
    },
  };
}

export class StateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateConflictError';
    this.code = 'STATE_CONFLICT';
  }
}

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('postgres-state-store: id must be a non-empty string');
  }
}

function assertProjectShape(p) {
  if (!p || typeof p !== 'object') {
    throw new TypeError('postgres-state-store: project must be an object');
  }
  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new TypeError('postgres-state-store: project.id is required');
  }
  if (typeof p.name !== 'string' || typeof p.version !== 'string') {
    throw new TypeError('postgres-state-store: project.name and project.version are required');
  }
}

// ----------------------------------------------------------------------
// Row → public-shape adapters. Postgres returns Date objects for TIMESTAMPTZ
// and parses JSONB to native objects; we normalise to ISO strings so the
// public surface looks identical to the legacy JSON store.
// ----------------------------------------------------------------------
function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowToProject(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description ?? undefined,
    sources: row.sources ?? [],
    model_config: row.model_config ?? {},
    vectordb_config: row.vectordb_config ?? {},
    ...(row.metadata_vocabulary != null
      ? { metadata_vocabulary: row.metadata_vocabulary }
      : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function rowToRefreshRecord(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    timestamp: toIso(row.ts),
    type: row.type,
    trigger_source: row.trigger_source,
    duration_seconds: row.duration_seconds,
    documents_processed: row.documents_processed,
    status: row.status,
    error: row.error,
  };
}

function rowToAudit(row) {
  return {
    id: row.id,
    timestamp: toIso(row.ts),
    action: row.action,
    project_id: row.project_id,
    details: row.details ?? {},
    ip_address: row.ip_address,
    actor: row.actor,
  };
}

function rowToImportExport(row) {
  return {
    id: row.id,
    timestamp: toIso(row.ts),
    direction: row.direction,
    scope: row.scope,
    target_id: row.target_id,
    status: row.status,
    payload_size: row.payload_size,
    manifest: row.manifest ?? {},
    error: row.error,
  };
}
