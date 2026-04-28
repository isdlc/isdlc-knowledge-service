// REQ-GH-3 / FR-003 — Postgres connection pool factory.
//
// Owns lifecycle: createPool / closePool / healthCheck. Production wiring
// (T011) constructs one pool per process and forwards it to the state
// layer, queue adapter, and audit logger. Tests can swap to a fake pool
// or use `tests/helpers/postgres.js` to skip when no DB is configured.

import pg from 'pg';

const { Pool } = pg;

export class DatabaseError extends Error {
  /**
   * @param {string} code  ERR-DB-002 (unreachable) | ERR-DB-003 (migration) | ERR-DB-004 (permission).
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts);
    this.name = 'DatabaseError';
    this.code = code;
    if (opts.cause !== undefined && this.cause === undefined) this.cause = opts.cause;
  }
}

/**
 * Create a Postgres connection pool.
 *
 * @param {{
 *   connectionString: string,
 *   ssl?: boolean | object,
 *   max?: number,
 *   idleTimeoutMillis?: number,
 *   _PoolImpl?: typeof Pool,
 * }} options
 * @returns {pg.Pool}
 */
export function createPool(options = {}) {
  if (typeof options.connectionString !== 'string' || options.connectionString.length === 0) {
    throw new DatabaseError(
      'ERR-DB-001',
      'createPool requires a connectionString. See `isdlc-knowledge setup` for guidance.',
    );
  }
  const PoolImpl = options._PoolImpl || Pool;
  return new PoolImpl({
    connectionString: options.connectionString,
    ssl: options.ssl ?? false,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  });
}

/**
 * Run `SELECT 1` against the pool to verify connectivity. Surfaces
 * ERR-DB-002 with a clear message when the round trip fails.
 *
 * @param {pg.Pool} pool
 * @returns {Promise<{ ok: true, latency_ms: number, server_version: string }>}
 */
export async function healthCheck(pool) {
  const startedAt = process.hrtime.bigint();
  let client;
  try {
    client = await pool.connect();
    const ping = await client.query('SELECT 1 AS ping');
    if (!ping.rows[0] || ping.rows[0].ping !== 1) {
      throw new DatabaseError('ERR-DB-002', 'Postgres responded to SELECT 1 with unexpected payload');
    }
    const versionRow = await client.query('SHOW server_version');
    const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    return {
      ok: true,
      latency_ms: elapsedMs,
      server_version: versionRow.rows[0]?.server_version || 'unknown',
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      'ERR-DB-002',
      `Postgres health check failed: ${err.message}. Verify the database is reachable and the configured user can connect.`,
      { cause: err },
    );
  } finally {
    if (client) client.release();
  }
}

/**
 * Close the pool, draining in-flight clients first. Idempotent.
 * @param {pg.Pool} pool
 */
export async function closePool(pool) {
  if (!pool || typeof pool.end !== 'function') return;
  try {
    await pool.end();
  } catch {
    // Pool already ended or in an unrecoverable state — nothing to do.
  }
}
