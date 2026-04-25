// Module 9: SQLite-vec adapter — local on-disk vector store.
// Traces: FR-006, FR-008, FR-009
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 9
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-002, ERR-VDB-003
//
// Uses better-sqlite3 + sqlite-vec extension. Two tables:
//   - vectors_meta(id PK, content, source_type, source_url, project, metadata JSON)
//   - vec_index VIRTUAL TABLE USING vec0(embedding float[N])
// search() uses sqlite-vec MATCH + k-NN, joining vectors_meta for content.
import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { VectorDBAdapter, VdbError } from './adapter.js';

export class SqliteVecAdapter extends VectorDBAdapter {
  /**
   * @param {{ path: string, dimensions: number }} options
   */
  constructor(options = {}) {
    super();
    const { path, dimensions } = options;
    if (!path || typeof path !== 'string') {
      throw new Error('SqliteVecAdapter: "path" is required');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('SqliteVecAdapter: "dimensions" must be a positive integer');
    }
    this._path = path;
    this._dimensions = dimensions;
    this._db = null; // opened lazily so corruption surfaces from operations
    this._opened = false;
  }

  // --- internals --------------------------------------------------------

  _open() {
    if (this._opened) return;
    try {
      const db = new Database(this._path);
      // sqlite-vec's vec0 only accepts plain JS Number rowids — disable BigInt.
      db.defaultSafeIntegers(false);
      db.pragma('journal_mode = WAL');
      sqliteVec.load(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS vectors_meta (
          id           TEXT PRIMARY KEY,
          content      TEXT NOT NULL,
          source_type  TEXT NOT NULL,
          source_url   TEXT NOT NULL,
          project      TEXT NOT NULL,
          metadata     TEXT NOT NULL
        );
      `);
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_index ` +
          `USING vec0(embedding float[${this._dimensions}]);`,
      );
      this._db = db;
      this._opened = true;
    } catch (err) {
      // SQLITE_NOTADB / SQLITE_CORRUPT both indicate corrupt index file.
      const code = err && (err.code || '');
      if (
        code === 'SQLITE_CORRUPT' ||
        code === 'SQLITE_NOTADB' ||
        /not a database|file is not a database|malformed/i.test(err?.message || '')
      ) {
        throw new VdbError('ERR-VDB-002', `Vector index corrupt at ${this._path}: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Test-only accessor. Returns the underlying Database handle.
   * @returns {import('better-sqlite3').Database}
   */
  _dbForTest() {
    this._open();
    return this._db;
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch { /* ignore */ }
    }
    this._db = null;
    this._opened = false;
  }

  _toFloat32Buffer(vec) {
    const f = new Float32Array(vec);
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
  }

  _wrapWriteError(err) {
    const code = err && (err.code || '');
    // Already wrapped — pass through unchanged.
    if (err instanceof VdbError) return err;
    // Corrupt index gets its own taxonomy code.
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || /malformed/i.test(err?.message || '')) {
      return new VdbError('ERR-VDB-002', `Vector index corrupt: ${err.message}`, { cause: err });
    }
    // All other write/IO failures map to ERR-VDB-003.
    return new VdbError('ERR-VDB-003', `Vector DB write failed: ${err.message}`, { cause: err });
  }

  // --- public API -------------------------------------------------------

  async store(vectors) {
    this._open();
    if (!Array.isArray(vectors) || vectors.length === 0) return;

    for (const v of vectors) {
      if (!v || !Array.isArray(v.vector) || v.vector.length !== this._dimensions) {
        throw new VdbError(
          'ERR-VDB-003',
          `Vector dimension mismatch for id=${v?.id}: expected ${this._dimensions}, got ${v?.vector?.length}`,
        );
      }
    }

    let findRowid, insertMeta, updateMeta, deleteVec, insertVec;
    try {
      findRowid = this._db.prepare(`SELECT rowid FROM vectors_meta WHERE id = ?`);
      insertMeta = this._db.prepare(
        `INSERT INTO vectors_meta (id, content, source_type, source_url, project, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      updateMeta = this._db.prepare(
        `UPDATE vectors_meta SET content = ?, source_type = ?, source_url = ?, project = ?, metadata = ?
         WHERE id = ?`,
      );
      deleteVec = this._db.prepare(`DELETE FROM vec_index WHERE rowid = ?`);
      insertVec = this._db.prepare(
        `INSERT INTO vec_index (rowid, embedding) VALUES (?, ?)`,
      );
    } catch (err) {
      throw this._wrapWriteError(err);
    }

    const txn = this._db.transaction((records) => {
      for (const rec of records) {
        const md = rec.metadata || {};
        const existing = findRowid.get(rec.id);
        // sqlite-vec's vec0 requires BigInt rowid bindings (Number is rejected
        // with "Only integers are allows for primary key values on vec_index").
        let rowid;
        if (existing) {
          rowid = BigInt(existing.rowid);
          updateMeta.run(
            md.content ?? '',
            md.source_type ?? '',
            md.source_url ?? '',
            md.project ?? '',
            JSON.stringify(md),
            rec.id,
          );
          deleteVec.run(rowid);
        } else {
          const info = insertMeta.run(
            rec.id,
            md.content ?? '',
            md.source_type ?? '',
            md.source_url ?? '',
            md.project ?? '',
            JSON.stringify(md),
          );
          rowid = BigInt(info.lastInsertRowid);
        }
        insertVec.run(rowid, this._toFloat32Buffer(rec.vector));
      }
    });

    try {
      txn(vectors);
    } catch (err) {
      throw this._wrapWriteError(err);
    }
  }

  async search(queryVector, options = {}) {
    this._open();
    if (!Array.isArray(queryVector) || queryVector.length !== this._dimensions) {
      throw new VdbError(
        'ERR-VDB-003',
        `Query vector dimension mismatch: expected ${this._dimensions}, got ${queryVector?.length}`,
      );
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
    const filter = options.filter || null;

    // First fetch k-NN rowids + distances from vec_index.
    let rows;
    try {
      rows = this._db
        .prepare(
          `SELECT rowid, distance FROM vec_index
           WHERE embedding MATCH ? AND k = ?
           ORDER BY distance`,
        )
        .all(this._toFloat32Buffer(queryVector), limit * (filter ? 8 : 1));
    } catch (err) {
      const code = err && (err.code || '');
      if (code === 'SQLITE_CORRUPT' || /malformed/i.test(err?.message || '')) {
        throw new VdbError('ERR-VDB-002', `Vector index corrupt: ${err.message}`, { cause: err });
      }
      throw err;
    }

    if (rows.length === 0) return [];

    // Join with vectors_meta and apply optional metadata filter in JS.
    const placeholders = rows.map(() => '?').join(',');
    const metaRows = this._db
      .prepare(
        `SELECT rowid, id, content, source_type, source_url, project, metadata
         FROM vectors_meta WHERE rowid IN (${placeholders})`,
      )
      .all(...rows.map((r) => r.rowid));
    const byRowid = new Map(metaRows.map((m) => [m.rowid, m]));

    const out = [];
    for (const r of rows) {
      const m = byRowid.get(r.rowid);
      if (!m) continue;
      const metadata = JSON.parse(m.metadata);
      if (filter && !matchesFilter(metadata, filter)) continue;
      out.push({
        id: m.id,
        score: r.distance,
        content: m.content,
        metadata,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async delete(ids) {
    this._open();
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
      const findRow = this._db.prepare(`SELECT rowid FROM vectors_meta WHERE id = ?`);
      const delMeta = this._db.prepare(`DELETE FROM vectors_meta WHERE id = ?`);
      const delVec = this._db.prepare(`DELETE FROM vec_index WHERE rowid = ?`);
      const txn = this._db.transaction((deleteIds) => {
        for (const id of deleteIds) {
          const row = findRow.get(id);
          if (row) {
            // vec0 expects BigInt for rowid (see store()).
            delVec.run(BigInt(row.rowid));
            delMeta.run(id);
          }
        }
      });
      txn(ids);
    } catch (err) {
      throw this._wrapWriteError(err);
    }
  }

  async deleteAll() {
    this._open();
    try {
      const txn = this._db.transaction(() => {
        this._db.exec(`DELETE FROM vec_index`);
        this._db.exec(`DELETE FROM vectors_meta`);
      });
      txn();
    } catch (err) {
      throw this._wrapWriteError(err);
    }
  }

  async stats() {
    this._open();
    const row = this._db.prepare(`SELECT COUNT(*) AS n FROM vectors_meta`).get();
    let sizeBytes = 0;
    try { sizeBytes = statSync(this._path).size; } catch { sizeBytes = 0; }
    return {
      count: row?.n ?? 0,
      dimensions: this._dimensions,
      size_bytes: sizeBytes,
    };
  }
}

function matchesFilter(metadata, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (metadata?.[k] !== v) return false;
  }
  return true;
}
