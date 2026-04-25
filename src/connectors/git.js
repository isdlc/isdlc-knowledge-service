// T012: Git Source Connector — clone, pull, diff.
// Traces: FR-003 (AC-003-01, AC-003-07), ERR-CONN-001, ERR-CONN-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - Uses `simple-git` (already a dependency).
// - On `crawl`: clones the repo to `localPath` if it does not exist yet,
//   otherwise runs `git pull` to update. Then walks every tracked file via
//   `git ls-tree -r HEAD --name-only` (so .gitignored content stays ignored
//   without us reimplementing gitignore).
// - On `diff`: uses `git diff --name-status {since}..HEAD` to determine which
//   files were added, modified, or deleted between revisions.
// - Binary detection: a streaming heuristic — read up to FIRST_BYTES bytes;
//   if any null byte is present, treat the file as binary and skip.
// - Error mapping: clone/pull failures become ERR-CONN-001 (unreachable);
//   credential / 401 / 403 patterns become ERR-CONN-002 (auth failed).
import { simpleGit } from 'simple-git';
import { mkdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SourceConnector, ConnectorError } from './connector.js';

const FIRST_BYTES = 8 * 1024;             // 8KB sample for binary heuristic.
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1MB
const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

/**
 * Patterns in error messages that indicate authentication trouble. simple-git
 * surfaces git's stderr verbatim, so we sniff the strings git itself uses.
 */
const AUTH_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /permission denied \(publickey\)/i,
  /403/,
  /401/,
  /invalid credentials/i,
];

function isAuthError(message) {
  if (!message) return false;
  return AUTH_PATTERNS.some((re) => re.test(message));
}

/**
 * Quick null-byte check on a buffer slice.
 */
function looksBinary(buf) {
  const len = Math.min(buf.length, FIRST_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * @typedef {object} GitConnectorConfig
 * @property {string}  url              Git remote URL (or local path for tests).
 * @property {string}  [branch]         Branch to track (default: repo default).
 * @property {string}  [localPath]      Where to clone. Default: a fresh temp dir.
 * @property {object}  [auth]           { username, password|token } — set via env.
 * @property {number}  [maxFileBytes]   Skip files larger than this (default 1MB).
 * @property {string[]} [ignoredDirs]   Path prefixes to skip.
 */

export class GitConnector extends SourceConnector {
  /** @param {GitConnectorConfig} config */
  constructor(config = {}) {
    super();
    if (!config.url) {
      throw new Error('GitConnector: `url` is required');
    }
    this.url = config.url;
    this.branch = config.branch ?? null;
    this.localPath =
      config.localPath ??
      mkdtempSync(join(tmpdir(), 'isdlc-git-conn-checkout-'));
    this.auth = config.auth ?? null;
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.ignoredDirs = new Set(config.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  }

  /**
   * Ensure a working clone exists at `localPath`. Returns a simple-git instance
   * bound to that working directory. Maps clone/pull failures onto ConnectorError.
   */
  async _ensureClone() {
    // Already cloned? Pull to refresh.
    const dotGit = join(this.localPath, '.git');
    if (existsSync(dotGit)) {
      const git = simpleGit(this.localPath);
      try {
        await git.pull();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (isAuthError(msg)) {
          throw new ConnectorError(
            'ERR-CONN-002',
            `Git auth failed for ${this.url}: ${msg}`,
            { cause: err },
          );
        }
        throw new ConnectorError(
          'ERR-CONN-001',
          `Git pull failed for ${this.url}: ${msg}`,
          { cause: err },
        );
      }
      return git;
    }

    // Fresh clone.
    mkdirSync(dirname(this.localPath), { recursive: true });
    mkdirSync(this.localPath, { recursive: true });
    const git = simpleGit();
    try {
      const args = [];
      if (this.branch) args.push('--branch', this.branch);
      await git.clone(this.url, this.localPath, args);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new ConnectorError(
          'ERR-CONN-002',
          `Git auth failed for ${this.url}: ${msg}`,
          { cause: err },
        );
      }
      throw new ConnectorError(
        'ERR-CONN-001',
        `Git clone failed for ${this.url}: ${msg}`,
        { cause: err },
      );
    }
    return simpleGit(this.localPath);
  }

  /**
   * True if any segment of `path` is in the ignored-dirs set.
   */
  _isIgnored(path) {
    const parts = path.split('/');
    for (const seg of parts) {
      if (this.ignoredDirs.has(seg)) return true;
    }
    return false;
  }

  /**
   * Read a tracked file and synthesise a NormalisedChunk. Returns null if the
   * file should be skipped (binary or oversized).
   */
  async _readChunk(git, path) {
    const abs = join(this.localPath, path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      // File listed by git but missing on disk — skip rather than crash.
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > this.maxFileBytes) return null;

    // Binary heuristic on the first 8KB.
    const buf = readFileSync(abs);
    if (looksBinary(buf)) return null;

    let lastModified;
    try {
      const log = await git.log({ file: path, maxCount: 1, format: { iso: '%cI' } });
      lastModified = (log.latest && log.latest.iso) || st.mtime.toISOString();
    } catch {
      lastModified = st.mtime.toISOString();
    }

    return {
      content: buf.toString('utf8'),
      path,
      source_type: 'git',
      source_url: `${this.url}/${path}`,
      last_modified: lastModified,
      metadata: { size: st.size },
    };
  }

  /**
   * Full crawl — clone/pull, walk every tracked file, yield text chunks.
   * @param {object} _config
   */
  async *crawl(_config) {
    const git = await this._ensureClone();

    // List tracked files at HEAD. raw() gives us a single newline-delimited blob.
    let listing;
    try {
      listing = await git.raw(['ls-tree', '-r', 'HEAD', '--name-only']);
    } catch (err) {
      throw new ConnectorError(
        'ERR-CONN-001',
        `Git ls-tree failed for ${this.url}: ${err.message || err}`,
        { cause: err },
      );
    }

    const files = listing.split('\n').filter(Boolean);
    for (const path of files) {
      if (this._isIgnored(path)) continue;
      const chunk = await this._readChunk(git, path);
      if (chunk) yield chunk;
    }
  }

  /**
   * Incremental diff between `since` and HEAD.
   * @param {object} _config
   * @param {string} since
   */
  async *diff(_config, since) {
    if (!since) {
      throw new Error('GitConnector.diff(): `since` revision is required');
    }
    const git = await this._ensureClone();

    let raw;
    try {
      raw = await git.raw(['diff', '--name-status', `${since}..HEAD`]);
    } catch (err) {
      throw new ConnectorError(
        'ERR-CONN-001',
        `Git diff failed for ${this.url}: ${err.message || err}`,
        { cause: err },
      );
    }

    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      // name-status format: "A\tpath", "M\tpath", "D\tpath",
      // "R100\told\tnew" (rename), "C100\told\tnew" (copy).
      const parts = line.split('\t');
      const status = parts[0];
      const code = status[0];

      // Map rename/copy onto add of the new path; original is reported as delete.
      let action;
      let path;
      if (code === 'A') {
        action = 'add';
        path = parts[1];
      } else if (code === 'M') {
        action = 'modify';
        path = parts[1];
      } else if (code === 'D') {
        action = 'delete';
        path = parts[1];
      } else if (code === 'R' || code === 'C') {
        // Yield the new file as added; treat the original as deleted.
        const oldPath = parts[1];
        const newPath = parts[2];
        if (!this._isIgnored(oldPath)) {
          yield {
            chunk: {
              content: '',
              path: oldPath,
              source_type: 'git',
              source_url: `${this.url}/${oldPath}`,
              last_modified: new Date().toISOString(),
              metadata: { renamed_to: newPath },
            },
            action: 'delete',
          };
        }
        action = 'add';
        path = newPath;
      } else {
        // Unknown / type-change — skip rather than guess.
        continue;
      }

      if (this._isIgnored(path)) continue;

      if (action === 'delete') {
        yield {
          chunk: {
            content: '',
            path,
            source_type: 'git',
            source_url: `${this.url}/${path}`,
            last_modified: new Date().toISOString(),
            metadata: {},
          },
          action,
        };
        continue;
      }

      const chunk = await this._readChunk(git, path);
      if (chunk) yield { chunk, action };
    }
  }
}
