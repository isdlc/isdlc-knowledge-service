// REQ-GH-3 / FR-006 — pg-boss queue adapter.
//
// Replaces the custom SQLite-backed queue (`src/queue/queue.js`) with the
// maintained pg-boss library. Public surface preserves the existing
// contract: enqueue / dequeue / complete / fail / getStatus / listJobs /
// close. Job types and status semantics are unchanged.
//
// pg-boss model mapping:
//   - enqueue(type, payload)    → boss.send(type, payload)         → returns job.id (uuid)
//   - dequeue()                 → boss.fetch(type) for each known type, return first match
//   - complete(id, result)      → boss.complete(id, result)
//   - fail(id, error)           → boss.fail(id, error)
//   - getStatus(id)             → boss.getJobById(id)
//   - listJobs(filters)         → manual SELECT against boss.queue tables
//                                  (pg-boss exposes tables but not a list API
//                                   for arbitrary filters)
//
// Dead-letter behavior (ERR-QUEUE-001) is preserved: pg-boss retries up to
// `retryLimit` (default 3 below) and routes exhausted jobs to a DLQ.

import { DatabaseError } from '../db/pool.js';

const VALID_TYPES = new Set(['full_rebuild', 'incremental_refresh', 'add_content']);
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_FETCH_INTERVAL_MS = 1_000;

/**
 * @typedef {object} PgBossQueueOptions
 * @property {object} boss                — initialized pg-boss instance (started)
 * @property {number} [retryLimit]        — default 3 (matches existing dead-letter threshold)
 * @property {number} [fetchIntervalMs]   — polling cadence for dequeue() default 1000
 */

/**
 * Build the pg-boss queue adapter. The caller owns the pg-boss lifecycle
 * (start before this is constructed; close via `queue.close()`).
 *
 * @param {PgBossQueueOptions} options
 */
export function createPgBossQueue(options) {
  if (!options || !options.boss || typeof options.boss.send !== 'function') {
    throw new DatabaseError(
      'ERR-QUEUE-001',
      'createPgBossQueue requires a started pg-boss instance.',
    );
  }
  const boss = options.boss;
  const retryLimit = Number.isInteger(options.retryLimit) ? options.retryLimit : DEFAULT_RETRY_LIMIT;
  const fetchIntervalMs = Number.isInteger(options.fetchIntervalMs)
    ? options.fetchIntervalMs
    : DEFAULT_FETCH_INTERVAL_MS;

  /**
   * Enqueue a new job.
   * @param {"full_rebuild"|"incremental_refresh"|"add_content"} type
   * @param {object} payload
   * @returns {Promise<string>}  job id (uuid)
   */
  async function enqueue(type, payload) {
    assertType(type);
    const id = await boss.send(type, payload ?? {}, {
      retryLimit,
      retryDelay: 30,
    });
    return String(id);
  }

  /**
   * Dequeue the next job across all known types. Returns null when nothing
   * is available — callers (the worker loop) poll on a short interval.
   *
   * Equivalent to the SQLite queue's atomic UPDATE…WHERE pattern: pg-boss's
   * `fetch()` reserves the job for this consumer until it's completed or
   * failed.
   *
   * @returns {Promise<{ id: string, type: string, payload: object } | null>}
   */
  async function dequeue() {
    for (const type of VALID_TYPES) {
      const job = await boss.fetch(type);
      if (job) {
        return { id: String(job.id), type, payload: job.data ?? {} };
      }
    }
    return null;
  }

  /**
   * Mark a job complete with a result.
   * @param {string} id
   * @param {object} [result]
   */
  async function complete(id, result) {
    assertId(id);
    await boss.complete(id, result ?? {});
  }

  /**
   * Mark a job failed. pg-boss handles retry/dead-letter automatically per
   * the configured retryLimit on enqueue. Returns the resulting job state
   * (or null if pg-boss can no longer find the job).
   *
   * @param {string} id
   * @param {Error | string | object} error
   */
  async function fail(id, error) {
    assertId(id);
    const payload =
      error instanceof Error
        ? { message: error.message, code: error.code, stack: error.stack }
        : error;
    await boss.fail(id, payload);
  }

  /**
   * @param {string} id
   * @returns {Promise<object | null>}
   */
  async function getStatus(id) {
    assertId(id);
    if (typeof boss.getJobById === 'function') {
      const job = await boss.getJobById(id);
      return jobRowToPublic(job);
    }
    return null;
  }

  /**
   * Optional listing — pg-boss does not expose a generic list API across
   * queues, but exposes per-state queries on the `boss.job` table. The
   * implementation is best-effort and intended for diagnostics, not for
   * production hot paths.
   *
   * @param {{ type?: string, state?: string, limit?: number }} [filters]
   * @returns {Promise<object[]>}
   */
  async function listJobs(filters = {}) {
    if (typeof boss.executeSql === 'function') {
      const where = [];
      const values = [];
      if (filters.type) {
        values.push(filters.type);
        where.push(`name = $${values.length}`);
      }
      if (filters.state) {
        values.push(filters.state);
        where.push(`state = $${values.length}`);
      }
      const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : 100;
      values.push(limit);
      const sql = `SELECT id, name, data, state, retrycount, retrylimit,
                          createdon, startedon, completedon
                     FROM pgboss.job
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                    ORDER BY createdon DESC
                    LIMIT $${values.length}`;
      const res = await boss.executeSql(sql, values);
      return (res.rows || []).map(jobRowToPublic);
    }
    return [];
  }

  /**
   * Stop the pg-boss instance. Idempotent.
   */
  async function close() {
    if (typeof boss.stop === 'function') {
      await boss.stop({ graceful: true });
    }
  }

  return {
    enqueue,
    dequeue,
    complete,
    fail,
    getStatus,
    listJobs,
    close,
    fetchIntervalMs,
  };
}

function assertType(type) {
  if (!VALID_TYPES.has(type)) {
    throw new TypeError(
      `pgboss-queue.enqueue: unknown job type "${type}". ` +
        `Expected one of: ${[...VALID_TYPES].join(', ')}`,
    );
  }
}

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('pgboss-queue: id must be a non-empty string');
  }
}

function jobRowToPublic(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    type: row.name ?? row.type,
    payload: row.data ?? {},
    status: row.state ?? row.status,
    retries: row.retrycount ?? row.retries ?? 0,
    max_retries: row.retrylimit ?? row.max_retries ?? null,
    created_at: row.createdon ?? row.created_at ?? null,
    started_at: row.startedon ?? row.started_at ?? null,
    completed_at: row.completedon ?? row.completed_at ?? null,
  };
}
