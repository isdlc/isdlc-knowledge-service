// T016: Filesystem Source Connector — local directory tree crawl.
// Traces: FR-003 (AC-003-06), ERR-CONN-001
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - Walks the configured `path` recursively using `fs/promises`. Each file
//   becomes a NormalisedChunk with its repo-relative path; the `source_url`
//   is a `file://` URL pointing at the absolute on-disk location so the
//   web UI can deep-link.
// - Skips:
//     * directories whose name matches `ignorePatterns` (default: .git,
//       node_modules, .DS_Store)
//     * files larger than 1 MB (avoid pulling huge binaries through the
//       embedding pipeline by accident)
//     * files whose first 8 KB contain a null byte (binary heuristic)
// - The `_fs` constructor option exists for tests that wish to stub fs;
//   default behaviour goes through `fs/promises`.
// - Error mapping: ENOENT / EACCES on the root path become ERR-CONN-001
//   (unreachable). Per-file read errors are logged-and-skipped so a single
//   broken symlink does not abort the whole crawl.
import * as fsPromises from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SourceConnector, ConnectorError } from './connector.js';

const FIRST_BYTES = 8 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_IGNORE = ['.git', 'node_modules', '.DS_Store'];

function looksBinary(buf) {
  const len = Math.min(buf.length, FIRST_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * @typedef {object} FilesystemConnectorConfig
 * @property {string}   path                Absolute root directory to crawl.
 * @property {string[]} [ignorePatterns]    Directory / file name segments to skip.
 * @property {number}   [maxFileBytes]      Per-file size cap (default 1 MB).
 * @property {object}   [_fs]               Test seam — alternative fs/promises module.
 */

export class FilesystemConnector extends SourceConnector {
  /** @param {FilesystemConnectorConfig} config */
  constructor(config = {}) {
    super();
    if (!config.path) {
      throw new Error('FilesystemConnector: `path` is required');
    }
    this.path = resolve(config.path);
    this.ignorePatterns = new Set(config.ignorePatterns ?? DEFAULT_IGNORE);
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this._fs = config._fs ?? fsPromises;
  }

  /**
   * True if any segment of `relPath` matches an ignore pattern.
   */
  _isIgnored(relPath) {
    if (!relPath) return false;
    const parts = relPath.split(sep).filter(Boolean);
    for (const seg of parts) {
      if (this.ignorePatterns.has(seg)) return true;
    }
    return false;
  }

  /**
   * Read a single file into a NormalisedChunk. Returns null when the file
   * should be skipped (binary, oversized, or unreadable).
   *
   * @param {string} abs        Absolute path on disk.
   * @param {string} relPath    Path relative to `this.path` (may use OS sep).
   * @param {object} [statCache] Pre-fetched fs.Stats — saves an extra syscall.
   */
  async _readChunk(abs, relPath, statCache) {
    let st;
    try {
      st = statCache ?? (await this._fs.stat(abs));
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > this.maxFileBytes) return null;

    let buf;
    try {
      buf = await this._fs.readFile(abs);
    } catch {
      return null;
    }
    if (looksBinary(buf)) return null;

    // Always present chunk paths with forward slashes so downstream consumers
    // (correlation, query merging) see a stable representation across OSes.
    const path = relPath.split(sep).join('/');

    return {
      content: buf.toString('utf8'),
      path,
      source_type: 'filesystem',
      source_url: pathToFileURL(abs).href,
      last_modified: st.mtime ? st.mtime.toISOString() : new Date().toISOString(),
      metadata: { size: st.size },
    };
  }

  /**
   * Depth-first directory walk. Yields { abs, relPath, stat } tuples for
   * every regular file encountered (modulo ignore patterns).
   */
  async *_walk(dir, relDir) {
    let entries;
    try {
      entries = await this._fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Mid-walk read errors: skip this subtree but keep crawling.
      if (relDir === '') {
        // Root unreadable -> caller maps to ERR-CONN-001.
        throw err;
      }
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (this.ignorePatterns.has(name)) continue;
      const abs = join(dir, name);
      const relPath = relDir ? join(relDir, name) : name;

      if (entry.isDirectory()) {
        yield* this._walk(abs, relPath);
        continue;
      }

      if (!entry.isFile()) continue;

      let st;
      try {
        st = await this._fs.stat(abs);
      } catch {
        continue;
      }
      yield { abs, relPath, stat: st };
    }
  }

  /**
   * Validate that the configured root exists and is a directory.
   * Throws ERR-CONN-001 otherwise.
   */
  async _checkRoot() {
    try {
      const st = await this._fs.stat(this.path);
      if (!st.isDirectory()) {
        throw new ConnectorError(
          'ERR-CONN-001',
          `Filesystem path is not a directory: ${this.path}`,
        );
      }
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      throw new ConnectorError(
        'ERR-CONN-001',
        `Filesystem path unreachable: ${this.path}: ${err.message || err}`,
        { cause: err },
      );
    }
  }

  /**
   * Full crawl. Yields one NormalisedChunk per text file under `path`.
   * @param {object} _config
   */
  async *crawl(_config) {
    await this._checkRoot();
    try {
      for await (const { abs, relPath, stat } of this._walk(this.path, '')) {
        const chunk = await this._readChunk(abs, relPath, stat);
        if (chunk) yield chunk;
      }
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      throw new ConnectorError(
        'ERR-CONN-001',
        `Filesystem walk failed: ${err.message || err}`,
        { cause: err },
      );
    }
  }

  /**
   * Incremental diff — yield `modify` actions for every file whose mtime is
   * strictly greater than `since`. Deletes are not detected here; the
   * worker reconciles deletions during a periodic full rebuild.
   *
   * @param {object} _config
   * @param {string} since  ISO-8601 timestamp.
   */
  async *diff(_config, since) {
    if (!since) {
      throw new Error('FilesystemConnector.diff(): `since` ISO timestamp is required');
    }
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) {
      throw new Error(`FilesystemConnector.diff(): invalid ISO timestamp ${since}`);
    }

    await this._checkRoot();
    for await (const { abs, relPath, stat } of this._walk(this.path, '')) {
      if (!stat.mtime || stat.mtime.getTime() <= sinceMs) continue;
      const chunk = await this._readChunk(abs, relPath, stat);
      if (chunk) yield { chunk, action: 'modify' };
    }
  }
}

// Convenience re-export for index.js wiring later (T016).
export const _DEFAULT_IGNORE = DEFAULT_IGNORE;
