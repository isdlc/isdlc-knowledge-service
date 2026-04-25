// T004: Job Queue — SQLite-backed durable async job queue.
// Traces: FR-004, FR-005, ERR-QUEUE-001, ERR-QUEUE-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 10
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - better-sqlite3 (synchronous) — matches its programming model directly.
// - WAL journal mode for safe concurrent reads.
// - dequeue uses a single atomic UPDATE...WHERE rowid=(SELECT...) LIMIT 1
//   wrapped in a transaction so two callers cannot hand out the same job.
// - SQLITE_BUSY is retried 5x with 100ms backoff (ERR-QUEUE-002).
// - On reaching max_retries, status flips to 'dead' (ERR-QUEUE-001).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_DB_PATH = './data/queue.db';
const MAX_RETRIES = 3;
const BUSY_MAX_ATTEMPTS = 5;
const BUSY_BACKOFF_MS = 100;

const VALID_TYPES = new Set(['full_rebuild', 'incremental_refresh', 'add_content']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL,
    payload       TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'queued',
    retries       INTEGER NOT NULL DEFAULT 0,
    max_retries   INTEGER NOT NULL DEFAULT 3,
    created_at    TEXT    NOT NULL,
    started_at    TEXT,
    completed_at  TEXT,
    result        TEXT,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_type   ON jobs(type);
`;

/**
 * Sleep (synchronous-style busy wait via Atomics) for short retry backoff.
 * better-sqlite3 is sync; we want a sync sleep so the retry loop is sync too.
 */
function sleepSync(ms) {
  // node:atomics-based sleep; safe and accurate for short waits.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Run a synchronous SQLite operation, retrying on SQLITE_BUSY (ERR-QUEUE-002).
 */
function withBusyRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < BUSY_MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = err && err.code;
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
        lastErr = err;
        sleepSync(BUSY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    type: row.type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    status: row.status,
    retries: row.retries,
    max_retries: row.max_retries,
    created_at: row.created_at,
    started_at: row.started_at || undefined,
    completed_at: row.completed_at || undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ? JSON.parse(row.error) : undefined,
  };
}

/**
 * Create a job-queue handle bound to a SQLite database.
 *
 * @param {{ dbPath?: string, maxRetries?: number }} [opts]
 * @returns {{
 *   enqueue: (type: string, payload: object) => string,
 *   dequeue: () => object | null,
 *   complete: (id: string, result: object) => void,
 *   fail: (id: string, error: { code?: string, message: string }) => void,
 *   getStatus: (id: string) => object | null,
 *   listJobs: (filters?: { status?: string, type?: string }) => object[],
 *   close: () => void,
 * }}
 */
export function createQueue(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : MAX_RETRIES;

  // Ensure parent directory exists for default/relative paths.
  if (dbPath !== ':memory:') {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (_) {
      // ignore — Database() will surface a clearer error if path is bad.
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  // Pre-compiled statements.
  const stInsert = db.prepare(
    `INSERT INTO jobs (type, payload, status, retries, max_retries, created_at)
     VALUES (?, ?, 'queued', 0, ?, ?)`,
  );
  const stPickNext = db.prepare(
    `SELECT id FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1`,
  );
  const stMarkRunning = db.prepare(
    `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
  );
  const stSelectById = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
  const stComplete = db.prepare(
    `UPDATE jobs SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`,
  );
  const stFailRequeue = db.prepare(
    `UPDATE jobs SET status = 'queued', retries = retries + 1, error = ?, started_at = NULL WHERE id = ?`,
  );
  const stFailDead = db.prepare(
    `UPDATE jobs SET status = 'dead', retries = retries + 1, error = ?, completed_at = ? WHERE id = ?`,
  );

  // Atomic dequeue: pick + mark running in a single transaction.
  const dequeueTxn = db.transaction(() => {
    const pick = stPickNext.get();
    if (!pick) return null;
    const now = new Date().toISOString();
    const info = stMarkRunning.run(now, pick.id);
    if (info.changes === 0) {
      // Lost the race — caller will retry by calling dequeue() again.
      return null;
    }
    return stSelectById.get(pick.id);
  });

  function enqueue(type, payload) {
    if (!VALID_TYPES.has(type)) {
      throw new Error(`Invalid job type: ${type}`);
    }
    const json = JSON.stringify(payload ?? {});
    const now = new Date().toISOString();
    return withBusyRetry(() => {
      const info = stInsert.run(type, json, maxRetries, now);
      return String(info.lastInsertRowid);
    });
  }

  function dequeue() {
    return withBusyRetry(() => {
      const row = dequeueTxn();
      return rowToJob(row);
    });
  }

  function complete(id, result) {
    const json = JSON.stringify(result ?? {});
    const now = new Date().toISOString();
    withBusyRetry(() => stComplete.run(json, now, Number(id)));
  }

  function fail(id, error) {
    const errJson = JSON.stringify({
      code: error?.code,
      message: error?.message ?? String(error),
    });
    withBusyRetry(() => {
      const row = stSelectById.get(Number(id));
      if (!row) return;
      const nextRetries = row.retries + 1;
      if (nextRetries >= row.max_retries) {
        const now = new Date().toISOString();
        stFailDead.run(errJson, now, Number(id));
      } else {
        stFailRequeue.run(errJson, Number(id));
      }
    });
  }

  function getStatus(id) {
    const row = stSelectById.get(Number(id));
    return rowToJob(row);
  }

  function listJobs(filters = {}) {
    const where = [];
    const params = [];
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.type) {
      where.push('type = ?');
      params.push(filters.type);
    }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
    const rows = db.prepare(sql).all(...params);
    return rows.map(rowToJob);
  }

  function close() {
    if (db.open) db.close();
  }

  return { enqueue, dequeue, complete, fail, getStatus, listJobs, close };
}
