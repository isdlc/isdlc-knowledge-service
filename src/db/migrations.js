// REQ-GH-3 / FR-003 / AC-003-03 — migration runner.
//
// Reads `*.sql` files from `src/db/migrations/`, applies them in lexical
// order, records each in `ks.schema_migrations`. Idempotent: re-running a
// migration that's already recorded is a no-op (the SQL files themselves
// use IF NOT EXISTS / ON CONFLICT patterns).

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseError } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * @param {{ migrationsDir?: string }} [options]
 * @returns {Promise<Array<{ id: string, file: string, sql: string, checksum: string }>>}
 */
export async function listMigrations(options = {}) {
  const dir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new DatabaseError('ERR-DB-003', `Cannot read migrations dir ${dir}: ${err.message}`, {
      cause: err,
    });
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
  /** @type {Array<{ id: string, file: string, sql: string, checksum: string }>} */
  const out = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    out.push({ id, file, sql, checksum });
  }
  return out;
}

/**
 * Apply every migration that hasn't been recorded yet. Returns the list of
 * migrations applied during this call (empty when up-to-date). Each
 * application runs inside a transaction so a failure rolls back partial
 * schema changes.
 *
 * @param {import('pg').Pool} pool
 * @param {{ migrationsDir?: string }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function runMigrations(pool, options = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new DatabaseError('ERR-DB-003', 'runMigrations requires a Postgres pool');
  }

  const migrations = await listMigrations(options);
  if (migrations.length === 0) return { applied: [], skipped: [] };

  // Ensure the bookkeeping table exists before we query it. The first
  // migration creates it, but we need to know whether to apply that very
  // migration — so check via an outer "table exists?" probe.
  const client = await pool.connect();
  try {
    const applied = [];
    const skipped = [];

    const exists = await client.query(
      `SELECT to_regclass('ks.schema_migrations') AS reg`,
    );
    const tableExists = exists.rows[0]?.reg !== null;

    /** @type {Set<string>} */
    let alreadyApplied = new Set();
    if (tableExists) {
      const rows = await client.query('SELECT id FROM ks.schema_migrations');
      alreadyApplied = new Set(rows.rows.map((r) => r.id));
    }

    for (const m of migrations) {
      if (alreadyApplied.has(m.id)) {
        skipped.push(m.id);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        // After the first migration runs, the table now exists — record it.
        await client.query(
          'INSERT INTO ks.schema_migrations (id, checksum, notes) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [m.id, m.checksum, `Applied via runMigrations from ${m.file}`],
        );
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw new DatabaseError(
          'ERR-DB-003',
          `Migration ${m.id} (${m.file}) failed: ${err.message}`,
          { cause: err },
        );
      }
    }

    return { applied, skipped };
  } finally {
    client.release();
  }
}

/**
 * Read-only diagnostic: list migrations recorded in the DB.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{ id: string, applied_at: string, checksum: string | null }>>}
 */
export async function listAppliedMigrations(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new DatabaseError('ERR-DB-003', 'listAppliedMigrations requires a Postgres pool');
  }
  const client = await pool.connect();
  try {
    const exists = await client.query(`SELECT to_regclass('ks.schema_migrations') AS reg`);
    if (!exists.rows[0]?.reg) return [];
    const rows = await client.query(
      'SELECT id, applied_at, checksum FROM ks.schema_migrations ORDER BY applied_at',
    );
    return rows.rows;
  } finally {
    client.release();
  }
}
