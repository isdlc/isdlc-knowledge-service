// Module 13: Audit Logger — append-only JSONL with size-based rotation.
// Traces: FR-014 (AC-014-01..05)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 13
//      docs/requirements/REQ-GH-263-.../interface-spec.md §AuditEntry
//
// CONSTITUTIONAL CONSTRAINT: append-only.
// This module MUST NOT expose any API path that mutates or removes entries.
// Rotated files are renamed and preserved; the logger never deletes them.
// All write operations use fs.appendFile; the file is never opened for read+write.

import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * @typedef {object} AuditEntry
 * @property {string} timestamp     ISO-8601 UTC timestamp
 * @property {string} action        e.g. "project.created"
 * @property {string} [project_id]
 * @property {object} details
 * @property {string} [ip_address]
 */

/**
 * Create an audit logger bound to a specific JSONL file path.
 *
 * The returned object exposes only `log` and `query`. There is intentionally
 * no `delete`, `update`, `truncate`, `clear`, or any other mutation method —
 * the audit log is append-only by contract (AC-014-04).
 *
 * @param {object} [opts]
 * @param {string} [opts.path]    Absolute path to the audit JSONL file
 * @param {number} [opts.maxSize] Rotate when file exceeds this size (bytes)
 * @returns {{ log: (action: string, details?: object) => Promise<void>,
 *            query: (filters?: object) => Promise<AuditEntry[]> }}
 */
export function createAuditLogger(opts = {}) {
  const filePath = opts.path ?? path.resolve('./data/audit.jsonl');
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;

  // Serialize all log() calls so rotation-check + rename + append form an
  // atomic critical section relative to other log() calls. Without this,
  // parallel appends could race the rotation rename and corrupt the file
  // sequence.
  let chain = Promise.resolve();

  async function ensureDir() {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
  }

  async function maybeRotate() {
    let size;
    try {
      const s = await stat(filePath);
      size = s.size;
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // nothing to rotate
      throw err;
    }
    if (size < maxSize) return;

    // Rename to audit.{ISO}.jsonl. Replace ':' with '-' for cross-platform
    // filesystem compatibility (Windows disallows ':' in filenames).
    const stamp = new Date().toISOString().replace(/:/g, '-');
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.jsonl');
    let rotatedName = `${base}.${stamp}.jsonl`;
    let rotatedPath = path.join(dir, rotatedName);

    // Disambiguate if a previous rotation produced the same stamp
    // (sub-millisecond rotations during tests).
    let suffix = 0;
    // eslint-disable-next-line no-await-in-loop
    while (await fileExists(rotatedPath)) {
      suffix += 1;
      rotatedName = `${base}.${stamp}-${suffix}.jsonl`;
      rotatedPath = path.join(dir, rotatedName);
    }

    await rename(filePath, rotatedPath);
    // Rotated files are NEVER deleted by the logger. They are the historical
    // audit trail and may be archived externally.
  }

  /**
   * Append a new audit entry. Generates an ISO-8601 timestamp.
   *
   * @param {string} action   e.g. "project.created"
   * @param {object} [details]
   * @returns {Promise<void>}
   */
  function log(action, details = {}) {
    if (typeof action !== 'string' || action.length === 0) {
      return Promise.reject(new TypeError('audit.log: action must be a non-empty string'));
    }

    // Pull recognised top-level fields out of details so they appear at the
    // entry root per the AuditEntry shape in interface-spec.md.
    const { project_id, ip_address, ...rest } = details ?? {};

    const entry = {
      timestamp: new Date().toISOString(),
      action,
      ...(project_id !== undefined ? { project_id } : {}),
      details: rest,
      ...(ip_address !== undefined ? { ip_address } : {}),
    };

    const next = chain.then(async () => {
      await ensureDir();
      await maybeRotate();
      await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
    });

    // Keep the chain alive even if a single append rejects; otherwise one
    // failure would poison every subsequent log().
    chain = next.catch(() => {});
    return next;
  }

  /**
   * Read the live log file and apply filters in memory.
   *
   * @param {object} [filters]
   * @param {string} [filters.project]   Match entry.project_id
   * @param {string} [filters.action]    Match entry.action exactly
   * @param {string} [filters.from]      ISO-8601, inclusive lower bound
   * @param {string} [filters.to]        ISO-8601, inclusive upper bound
   * @param {number} [filters.limit]
   * @param {number} [filters.offset]
   * @returns {Promise<AuditEntry[]>}
   */
  async function query(filters = {}) {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }

    const entries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip corrupted lines rather than throwing — operators investigate
        // via observability tooling, not by crashing the audit reader.
        continue;
      }
    }

    const { project, action, from, to, limit, offset = 0 } = filters;

    let filtered = entries.filter((e) => {
      if (project !== undefined && e.project_id !== project) return false;
      if (action !== undefined && e.action !== action) return false;
      // ISO-8601 with 'Z' suffix sorts lexicographically, so string compare
      // is correct for from/to.
      if (from !== undefined && e.timestamp < from) return false;
      if (to !== undefined && e.timestamp > to) return false;
      return true;
    });

    if (offset > 0) filtered = filtered.slice(offset);
    if (typeof limit === 'number') filtered = filtered.slice(0, limit);
    return filtered;
  }

  // Frozen surface — append-only contract enforced architecturally.
  return Object.freeze({ log, query });
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}
