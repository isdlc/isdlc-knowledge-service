// T013: SVN Source Connector — checkout, update, revision diff.
// Traces: FR-003 (AC-003-02, AC-003-07), ERR-CONN-001, ERR-CONN-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - Uses a thin wrapper around the `svn` CLI (per the inference noted in
//   tasks.md: "SVN connector uses CLI wrapper (svn command) — Medium
//   confidence"). The actual spawn function is injected via the `_spawn`
//   constructor seam so unit tests can substitute canned stdout/exit codes
//   without touching the network or requiring `svn` to be installed.
// - On `crawl`: runs `svn checkout` if `localPath` is empty, otherwise
//   `svn update`. Walks the resulting working copy on disk and yields one
//   NormalisedChunk per text file. Repo metadata (URL, last-changed
//   revision/date) is read from `svn info --xml`.
// - On `diff`: runs `svn diff --summarize -r {since}:HEAD --xml` against
//   the upstream URL and parses the resulting `<paths><path …>` entries
//   into add/modify/delete actions.
// - Binary detection: streaming heuristic — the first 8KB of the file is
//   scanned for null bytes; any null → file is treated as binary and
//   skipped.
// - Error mapping: a missing `svn` binary (ENOENT) or a network/repo
//   failure becomes ERR-CONN-001; auth failures (E170001 and friends)
//   become ERR-CONN-002.
import { spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SourceConnector, ConnectorError } from './connector.js';

const FIRST_BYTES = 8 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1MB
const DEFAULT_IGNORED_DIRS = new Set([
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

/**
 * Patterns in svn stderr / error messages that indicate authentication
 * trouble. Subversion uses stable error codes (E170001 etc.) plus english
 * phrases, so we match both to be robust across locales/versions.
 */
const AUTH_PATTERNS = [
  /E170001/,                      // Authentication required / failed
  /E215004/,                      // No more credentials / aborting auth
  /authorization failed/i,
  /authentication failed/i,
  /authentication realm/i,
  /could not authenticate/i,
  /unable to connect.*authentication/i,
];

function isAuthError(message) {
  if (!message) return false;
  return AUTH_PATTERNS.some((re) => re.test(message));
}

function looksBinary(buf) {
  const len = Math.min(buf.length, FIRST_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * @typedef {object} SvnConnectorConfig
 * @property {string}  url            SVN repository URL (or local file:// path).
 * @property {string}  [localPath]    Where to check out. Default: a fresh temp dir.
 * @property {{username: string, password: string}} [auth]
 * @property {number}  [maxFileBytes] Skip files larger than this (default 1MB).
 * @property {string[]} [ignoredDirs] Path segments to skip when walking.
 * @property {(cmd: string, args: string[], opts?: object) => import('node:child_process').ChildProcess} [_spawn]
 *           Test seam — defaults to node:child_process.spawn.
 */

export class SvnConnector extends SourceConnector {
  /** @param {SvnConnectorConfig} config */
  constructor(config = {}) {
    super();
    if (!config.url) {
      throw new Error('SvnConnector: `url` is required');
    }
    this.url = config.url;
    this.localPath =
      config.localPath ??
      mkdtempSync(join(tmpdir(), 'isdlc-svn-conn-checkout-'));
    this.auth = config.auth ?? null;
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.ignoredDirs = new Set(config.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
    this._spawn = config._spawn ?? nodeSpawn;
  }

  /**
   * Run `svn` with the given arguments and collect stdout/stderr/exit code.
   * Auth flags are appended automatically when this.auth is set.
   * Translates spawn / non-zero exits into ConnectorError with the right code.
   *
   * @param {string[]} args   Arguments after the `svn` binary.
   * @param {{ allowNonZero?: boolean }} [opts]
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
   */
  async _runSvn(args, opts = {}) {
    const fullArgs = [...args, '--non-interactive'];
    if (this.auth && this.auth.username) {
      fullArgs.push('--username', this.auth.username);
      if (this.auth.password) {
        fullArgs.push('--password', this.auth.password);
      }
    }

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn('svn', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(
          new ConnectorError(
            'ERR-CONN-001',
            `Failed to spawn svn: ${err.message || err}`,
            { cause: err },
          ),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      if (child.stdout) {
        child.stdout.on('data', (d) => {
          stdout += d.toString('utf8');
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (d) => {
          stderr += d.toString('utf8');
        });
      }

      child.on('error', (err) => {
        // ENOENT = `svn` not on PATH. Always ERR-CONN-001.
        reject(
          new ConnectorError(
            'ERR-CONN-001',
            `svn ${args[0] || ''} failed: ${err.message || err}`,
            { cause: err },
          ),
        );
      });

      child.on('close', (code) => {
        if (code === 0 || opts.allowNonZero) {
          resolve({ stdout, stderr, code: code ?? 0 });
          return;
        }
        const errMsg = stderr || stdout || `svn exited with code ${code}`;
        if (isAuthError(errMsg)) {
          reject(
            new ConnectorError(
              'ERR-CONN-002',
              `SVN auth failed for ${this.url}: ${errMsg.trim()}`,
            ),
          );
          return;
        }
        reject(
          new ConnectorError(
            'ERR-CONN-001',
            `svn ${args[0] || ''} failed for ${this.url}: ${errMsg.trim()}`,
          ),
        );
      });
    });
  }

  /**
   * Ensure a working copy exists at `localPath`. Runs `svn checkout` on
   * first call, `svn update` on subsequent calls.
   */
  async _ensureCheckout() {
    const dotSvn = join(this.localPath, '.svn');
    if (existsSync(dotSvn)) {
      await this._runSvn(['update', this.localPath]);
      return;
    }
    mkdirSync(this.localPath, { recursive: true });
    await this._runSvn(['checkout', this.url, this.localPath]);
  }

  /**
   * Returns the last-changed revision and ISO-8601 commit date for a path
   * by parsing `svn info --xml`. If parsing fails, falls back to mtime
   * with revision = "unknown".
   */
  async _info(path) {
    try {
      const { stdout } = await this._runSvn(['info', '--xml', path]);
      const rev = (stdout.match(/<commit\s+revision="(\d+)"/) || [])[1];
      const date = (stdout.match(/<date>([^<]+)<\/date>/) || [])[1];
      return { revision: rev || 'unknown', date: date || null };
    } catch {
      return { revision: 'unknown', date: null };
    }
  }

  /**
   * Path-segment ignore filter, mirrored from GitConnector.
   * @param {string} path  Relative path inside the working copy.
   */
  _isIgnored(path) {
    const parts = path.split('/');
    for (const seg of parts) {
      if (this.ignoredDirs.has(seg)) return true;
    }
    return false;
  }

  /**
   * Recursively yield every regular file path under `dir`, relative to
   * `this.localPath`, in deterministic (sorted) order. Pure filesystem
   * walk — no svn calls.
   */
  *_walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = abs.slice(this.localPath.length + 1);
      if (this._isIgnored(rel)) continue;
      if (entry.isDirectory()) {
        yield* this._walk(abs);
      } else if (entry.isFile()) {
        yield rel;
      }
    }
  }

  /**
   * Read a file from the working copy and synthesise a NormalisedChunk.
   * Returns null if the file should be skipped (binary or oversized).
   */
  async _readChunk(relPath) {
    const abs = join(this.localPath, relPath);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > this.maxFileBytes) return null;

    const buf = readFileSync(abs);
    if (looksBinary(buf)) return null;

    const info = await this._info(abs);
    const lastModified = info.date || st.mtime.toISOString();

    return {
      content: buf.toString('utf8'),
      path: relPath,
      source_type: 'svn',
      source_url: `${this.url.replace(/\/+$/, '')}/${relPath}`,
      last_modified: lastModified,
      metadata: { size: st.size, revision: info.revision },
    };
  }

  /**
   * Full crawl — checkout/update, walk every text file, yield chunks.
   * @param {object} _config
   */
  async *crawl(_config) {
    await this._ensureCheckout();

    for (const relPath of this._walk(this.localPath)) {
      const chunk = await this._readChunk(relPath);
      if (chunk) yield chunk;
    }
  }

  /**
   * Parse the XML output of `svn diff --summarize -r N:HEAD --xml`.
   * Returns an array of { path, action } where action ∈
   * { "add", "modify", "delete" }.
   *
   * Sample XML:
   *   <?xml version="1.0"?>
   *   <diff>
   *     <paths>
   *       <path props="none" kind="file" item="modified">repo/src/app.js</path>
   *       <path props="none" kind="file" item="added">repo/docs.md</path>
   *       <path props="none" kind="file" item="deleted">repo/README.md</path>
   *     </paths>
   *   </diff>
   *
   * @param {string} xml
   */
  _parseDiffSummary(xml) {
    const out = [];
    const pathRe = /<path\b([^>]*)>([^<]*)<\/path>/g;
    let m;
    while ((m = pathRe.exec(xml)) !== null) {
      const attrs = m[1];
      const inner = m[2].trim();
      const itemMatch = attrs.match(/\bitem="([^"]+)"/);
      if (!itemMatch) continue;
      const item = itemMatch[1];
      let action;
      if (item === 'added') action = 'add';
      else if (item === 'modified') action = 'modify';
      else if (item === 'deleted') action = 'delete';
      else continue;

      // Strip the repo URL prefix if svn echoed it back (it does for
      // remote-target diffs). Path stored is relative to this.url.
      let path = inner;
      const urlNoSlash = this.url.replace(/\/+$/, '');
      if (path.startsWith(urlNoSlash + '/')) {
        path = path.slice(urlNoSlash.length + 1);
      } else if (path.startsWith(urlNoSlash)) {
        path = path.slice(urlNoSlash.length).replace(/^\/+/, '');
      }
      out.push({ path, action });
    }
    return out;
  }

  /**
   * Incremental diff between revision `since` and HEAD.
   * @param {object} _config
   * @param {string} since   Revision marker, e.g. "42".
   */
  async *diff(_config, since) {
    if (!since) {
      throw new Error('SvnConnector.diff(): `since` revision is required');
    }
    await this._ensureCheckout();

    const { stdout } = await this._runSvn([
      'diff',
      '--summarize',
      '--xml',
      '-r',
      `${since}:HEAD`,
      this.url,
    ]);

    const entries = this._parseDiffSummary(stdout);
    for (const { path, action } of entries) {
      if (this._isIgnored(path)) continue;

      if (action === 'delete') {
        yield {
          chunk: {
            content: '',
            path,
            source_type: 'svn',
            source_url: `${this.url.replace(/\/+$/, '')}/${path}`,
            last_modified: new Date().toISOString(),
            metadata: {},
          },
          action,
        };
        continue;
      }

      // add / modify: read the current working-copy file if present.
      const chunk = await this._readChunk(path);
      if (chunk) {
        yield { chunk, action };
      } else {
        // Working copy missing the file (e.g. server-only add not yet
        // updated locally) — still yield a minimal stub so callers know
        // it changed.
        yield {
          chunk: {
            content: '',
            path,
            source_type: 'svn',
            source_url: `${this.url.replace(/\/+$/, '')}/${path}`,
            last_modified: new Date().toISOString(),
            metadata: {},
          },
          action,
        };
      }
    }
  }
}
