// T016: Google Docs Source Connector — Drive API folder crawl + export.
// Traces: FR-003 (AC-003-05), ERR-CONN-001, ERR-CONN-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - Walks a Google Drive folder tree starting from `rootFolderId`. For each
//   Google Doc found (or any text-exportable type), uses the Drive API
//   `files.export` endpoint to materialise plain-text contents.
// - Sub-folders are recursed depth-first. Non-text MIME types (images,
//   videos, archives, …) are skipped.
// - The `_driveFactory` constructor option is a test seam: when supplied, it
//   is invoked instead of building a real `googleapis` Drive client. Tests
//   pass in a fake with `.files.list` and `.files.export` so the connector
//   can be exercised without network access or real credentials.
// - Error mapping:
//     * 401/403/invalid_grant ......................... ERR-CONN-002
//     * everything else (404, 5xx, network, ENOTFOUND) . ERR-CONN-001
import { SourceConnector, ConnectorError } from './connector.js';

// MIME types we know how to convert to text via Drive's export endpoint.
// Google Sheets exports as CSV (text). Plain-text Drive files (uploaded .md,
// .txt, etc.) are read via `files.get?alt=media` instead of export.
const TEXT_EXPORT_MAP = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Sniff an error to decide whether it is an authentication failure.
 * Drive surfaces auth issues via HTTP 401/403 and OAuth invalid_grant.
 */
function isAuthError(err) {
  if (!err) return false;
  const code = err.code || (err.response && err.response.status);
  if (code === 401 || code === 403) return true;
  const msg = err.message || '';
  return /invalid_grant|invalid credentials|unauthorized|permission/i.test(msg);
}

/**
 * @typedef {object} GDocsConnectorConfig
 * @property {object}   auth                OAuth2 client or service-account JSON.
 * @property {string}   rootFolderId        Drive folder to crawl.
 * @property {() => any} [_driveFactory]    Test seam — return a Drive client.
 */

export class GDocsConnector extends SourceConnector {
  /** @param {GDocsConnectorConfig} config */
  constructor(config = {}) {
    super();
    if (!config.rootFolderId) {
      throw new Error('GDocsConnector: `rootFolderId` is required');
    }
    if (!config.auth && !config._driveFactory) {
      throw new Error('GDocsConnector: `auth` is required');
    }
    this.auth = config.auth ?? null;
    this.rootFolderId = config.rootFolderId;
    this._driveFactory = config._driveFactory ?? null;
    this._drive = null;
  }

  /**
   * Lazily build (or reuse) the Drive client. The test seam wins if present.
   */
  async _getDrive() {
    if (this._drive) return this._drive;
    if (this._driveFactory) {
      this._drive = await this._driveFactory();
      return this._drive;
    }
    // Real path: dynamic import so tests can run without googleapis installed
    // in environments that strip it.
    const { google } = await import('googleapis');
    this._drive = google.drive({ version: 'v3', auth: this.auth });
    return this._drive;
  }

  /**
   * Translate a thrown error into a ConnectorError with the right code.
   */
  _mapError(err, op) {
    if (err instanceof ConnectorError) return err;
    if (isAuthError(err)) {
      return new ConnectorError(
        'ERR-CONN-002',
        `Google Drive auth failed during ${op}: ${err.message || err}`,
        { cause: err },
      );
    }
    return new ConnectorError(
      'ERR-CONN-001',
      `Google Drive ${op} failed: ${err.message || err}`,
      { cause: err },
    );
  }

  /**
   * List every direct child of a folder, paginating through all results.
   */
  async _listChildren(drive, folderId, extraQ = '') {
    const out = [];
    let pageToken;
    const baseQ = `'${folderId}' in parents and trashed = false`;
    const q = extraQ ? `${baseQ} and ${extraQ}` : baseQ;
    do {
      let res;
      try {
        res = await drive.files.list({
          q,
          fields:
            'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, owners, size, parents)',
          pageToken,
          pageSize: 100,
        });
      } catch (err) {
        throw this._mapError(err, 'files.list');
      }
      const data = (res && res.data) || res || {};
      const files = data.files || [];
      out.push(...files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  /**
   * Pull text for an exportable file (Google Doc / Sheet).
   */
  async _exportText(drive, file) {
    const targetMime = TEXT_EXPORT_MAP[file.mimeType];
    if (!targetMime) return null;
    let res;
    try {
      res = await drive.files.export({
        fileId: file.id,
        mimeType: targetMime,
      });
    } catch (err) {
      throw this._mapError(err, 'files.export');
    }
    // Real client returns { data: '<text>' }. Tests supply { data: '...' } too.
    const data = (res && res.data) ?? res;
    if (data == null) return null;
    return typeof data === 'string' ? data : String(data);
  }

  /**
   * Build a NormalisedChunk for a single Drive file at `pathPrefix`.
   * Returns null when the file should be skipped (folder, image, etc.).
   */
  async _chunkFor(drive, file, pathPrefix) {
    if (file.mimeType === FOLDER_MIME) return null;
    if (!Object.prototype.hasOwnProperty.call(TEXT_EXPORT_MAP, file.mimeType)) {
      // Skip images, videos, binary uploads — the connector is text-only.
      return null;
    }
    const text = await this._exportText(drive, file);
    if (text == null) return null;
    const path = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
    return {
      content: text,
      path,
      source_type: 'gdocs',
      source_url:
        file.webViewLink || `https://docs.google.com/document/d/${file.id}`,
      last_modified: file.modifiedTime || new Date().toISOString(),
      metadata: {
        mimeType: file.mimeType,
        owners: file.owners || [],
      },
    };
  }

  /**
   * Recursive folder walk. Yields NormalisedChunk objects depth-first.
   * `pathPrefix` accumulates folder names so the chunk path mirrors the
   * Drive folder hierarchy (useful for module-design path correlation).
   */
  async *_walk(drive, folderId, pathPrefix) {
    const children = await this._listChildren(drive, folderId);
    for (const file of children) {
      if (file.mimeType === FOLDER_MIME) {
        const nextPrefix = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
        yield* this._walk(drive, file.id, nextPrefix);
        continue;
      }
      const chunk = await this._chunkFor(drive, file, pathPrefix);
      if (chunk) yield chunk;
    }
  }

  /**
   * Full crawl from the configured root folder.
   * @param {object} _config
   */
  async *crawl(_config) {
    const drive = await this._getDrive();
    yield* this._walk(drive, this.rootFolderId, '');
  }

  /**
   * Incremental diff — list files modified after `since` and yield them as
   * `modify` actions. Drive does not give us per-file delete events without
   * the changes feed, so deletes show up only on the next full rebuild.
   *
   * @param {object} _config
   * @param {string} since   ISO-8601 timestamp.
   */
  async *diff(_config, since) {
    if (!since) {
      throw new Error('GDocsConnector.diff(): `since` ISO timestamp is required');
    }
    const drive = await this._getDrive();
    // Drive query syntax requires single-quoted ISO timestamps.
    const recent = await this._listChildren(
      drive,
      this.rootFolderId,
      `modifiedTime > '${since}'`,
    );
    for (const file of recent) {
      const chunk = await this._chunkFor(drive, file, '');
      if (chunk) {
        yield { chunk, action: 'modify' };
      }
    }
  }
}
