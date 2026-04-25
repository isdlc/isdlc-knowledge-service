// T014: Confluence Source Connector — REST API, sub-page crawl.
// Traces: FR-003 (AC-003-03), ERR-CONN-001, ERR-CONN-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - Targets Confluence Cloud REST API v1 endpoints
//   (`/wiki/rest/api/content/{id}` and `/wiki/rest/api/content/{id}/child/page`)
//   because they are universally supported across Cloud and Data Center, and
//   v2 has not stabilised cleanly across all flavours yet.
// - Uses Node's built-in WHATWG `fetch` (Node 18+) but accepts a `_fetch` seam
//   for dependency injection in tests — no real network access in unit tests.
// - On `crawl`: starting from `rootPageId` (or a page id parsed out of
//   `rootPageUrl`), GETs each page's body and child listing recursively.
//   Children listings are paginated; we follow `_links.next` until the cursor
//   is empty.
// - On `diff(since)`: walks the tree the same way and yields a "modify" entry
//   for every page whose `version.when` is strictly newer than `sinceISO`.
//   We deliberately scan client-side rather than using `?lastmodified-gt=` —
//   that query string isn't supported on the v1 content endpoint and CQL
//   responses don't include the body content we need anyway.
// - Error mapping:
//     HTTP 5xx + network errors -> ConnectorError("ERR-CONN-001")
//     HTTP 401 / 403            -> ConnectorError("ERR-CONN-002")
import { SourceConnector, ConnectorError } from './connector.js';

/**
 * Strip HTML tags and decode the small set of entities Confluence's storage
 * format actually emits (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`).
 * This is intentionally lo-fi: a downstream cleanup pass can do better, but
 * the embedding pipeline must not see raw `<p>` tags.
 */
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Best-effort extraction of the numeric page id from a Confluence page URL.
 * Supports the modern `/spaces/<KEY>/pages/<id>/<slug>` and legacy
 * `/pages/viewpage.action?pageId=<id>` shapes.
 */
function parsePageIdFromUrl(url) {
  if (!url) return null;
  const m1 = String(url).match(/\/pages\/(\d+)(?:\b|\/)/);
  if (m1) return m1[1];
  const m2 = String(url).match(/[?&]pageId=(\d+)/);
  if (m2) return m2[1];
  return null;
}

/**
 * @typedef {object} ConfluenceAuth
 * @property {string} [username]    Atlassian account email.
 * @property {string} [apiToken]    API token paired with `username`.
 * @property {string} [bearerToken] OAuth bearer token (used in lieu of basic).
 */

/**
 * @typedef {object} ConfluenceConnectorConfig
 * @property {string} baseUrl              e.g. https://acme.atlassian.net/wiki
 * @property {ConfluenceAuth} auth         Basic (username+apiToken) OR bearer.
 * @property {string} [rootPageId]         Numeric page id to crawl from.
 * @property {string} [rootPageUrl]        Alternative to rootPageId — parsed.
 * @property {number} [pageLimit]          Page size for child listings (default 25).
 * @property {Function} [_fetch]           Fetch seam for tests.
 */

export class ConfluenceConnector extends SourceConnector {
  /** @param {ConfluenceConnectorConfig} config */
  constructor(config = {}) {
    super();
    if (!config.baseUrl) {
      throw new Error('ConfluenceConnector: `baseUrl` is required');
    }
    if (!config.auth || (!config.auth.bearerToken && !(config.auth.username && config.auth.apiToken))) {
      throw new Error(
        'ConfluenceConnector: `auth` must be { username, apiToken } or { bearerToken }',
      );
    }
    const rootId = config.rootPageId || parsePageIdFromUrl(config.rootPageUrl);
    if (!rootId) {
      throw new Error(
        'ConfluenceConnector: `rootPageId` or a parseable `rootPageUrl` is required',
      );
    }

    // Trim trailing slash from baseUrl for predictable URL composition.
    this.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    this.auth = config.auth;
    this.rootPageId = String(rootId);
    this.pageLimit = config.pageLimit ?? 25;
    this._fetch = config._fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new Error(
        'ConfluenceConnector: no fetch implementation available (Node >=18 or pass _fetch)',
      );
    }
  }

  /**
   * Build the Authorization header for the configured auth mode.
   */
  _authHeader() {
    if (this.auth.bearerToken) {
      return `Bearer ${this.auth.bearerToken}`;
    }
    const raw = `${this.auth.username}:${this.auth.apiToken}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  /**
   * Issue a GET against the Confluence REST API and return parsed JSON.
   * Maps HTTP and network failures onto ConnectorError per the taxonomy.
   * @param {string} url Either an absolute URL or a path beginning with `/`.
   */
  async _get(url) {
    const absolute = url.startsWith('http')
      ? url
      : `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;

    let res;
    try {
      res = await this._fetch(absolute, {
        method: 'GET',
        headers: {
          Authorization: this._authHeader(),
          Accept: 'application/json',
        },
      });
    } catch (err) {
      // Network-level failure (DNS, ECONNREFUSED, TLS, abort, …).
      throw new ConnectorError(
        'ERR-CONN-001',
        `Confluence request failed for ${absolute}: ${err && err.message ? err.message : err}`,
        { cause: err },
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError(
        'ERR-CONN-002',
        `Confluence auth failed (${res.status}) for ${absolute}`,
      );
    }
    if (!res.ok || res.status >= 500) {
      throw new ConnectorError(
        'ERR-CONN-001',
        `Confluence request failed (${res.status}) for ${absolute}`,
      );
    }

    try {
      return await res.json();
    } catch (err) {
      throw new ConnectorError(
        'ERR-CONN-001',
        `Confluence returned non-JSON for ${absolute}: ${err && err.message ? err.message : err}`,
        { cause: err },
      );
    }
  }

  /**
   * GET a single page including its body in storage format and version info.
   */
  async _getPage(id) {
    const path = `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space,ancestors`;
    return this._get(path);
  }

  /**
   * List immediate child pages, transparently following `_links.next`.
   * Yields `{ id, title }` stubs — full bodies are fetched lazily via _getPage.
   */
  async *_iterChildren(parentId) {
    let url = `/rest/api/content/${encodeURIComponent(parentId)}/child/page?limit=${this.pageLimit}`;
    while (url) {
      const body = await this._get(url);
      const results = Array.isArray(body && body.results) ? body.results : [];
      for (const r of results) {
        if (r && r.id) yield { id: String(r.id), title: r.title || r.id };
      }
      const next = body && body._links && body._links.next;
      if (!next) {
        url = null;
      } else if (next.startsWith('http')) {
        url = next;
      } else {
        // Confluence returns `next` like "/wiki/rest/api/...". The leading
        // /wiki overlaps with our baseUrl (which already ends in /wiki), so
        // fall back to the host root for these hops.
        const base = this.baseUrl.replace(/\/wiki$/, '');
        url = `${base}${next}`;
      }
    }
  }

  /**
   * Convert a fetched page payload into a NormalisedChunk.
   * `pathPrefix` carries the ancestor titles so children are addressable as
   * "Root/Section/Page".
   */
  _toChunk(page, pathPrefix) {
    const title = page.title || String(page.id);
    const path = pathPrefix ? `${pathPrefix}/${title}` : title;
    const html =
      (page.body && page.body.storage && page.body.storage.value) || '';
    const lastModified =
      (page.version && page.version.when) || new Date().toISOString();
    const space = (page.space && page.space.key) || null;
    const ancestors = Array.isArray(page.ancestors)
      ? page.ancestors.map((a) => ({ id: String(a.id), title: a.title }))
      : [];

    // Compose a stable, human-shareable URL when the API supplies _links.webui.
    // Confluence Cloud's webui paths sometimes start with `/wiki/...` (in which
    // case we anchor at the host root) and sometimes start with `/spaces/...`
    // (in which case we anchor at baseUrl which already ends in /wiki).
    let sourceUrl;
    if (page._links && page._links.webui) {
      const webui = page._links.webui;
      if (webui.startsWith('/wiki/')) {
        const base = this.baseUrl.replace(/\/wiki$/, '');
        sourceUrl = `${base}${webui}`;
      } else {
        sourceUrl = `${this.baseUrl}${webui.startsWith('/') ? '' : '/'}${webui}`;
      }
    } else {
      sourceUrl = `${this.baseUrl}/pages/${page.id}`;
    }

    return {
      content: htmlToText(html),
      path,
      source_type: 'confluence',
      source_url: sourceUrl,
      last_modified: lastModified,
      metadata: { id: String(page.id), space, ancestors },
    };
  }

  /**
   * Recursive walk: yield (page, chunk) for the subtree rooted at `id`.
   * Children inherit the parent's title path.
   * @param {string} id          Confluence page id to start from.
   * @param {string} pathPrefix  Title path of the parent (empty for root).
   */
  async *_walk(id, pathPrefix) {
    const page = await this._getPage(id);
    const chunk = this._toChunk(page, pathPrefix);
    yield { page, chunk };

    const childPrefix = chunk.path;
    for await (const child of this._iterChildren(id)) {
      yield* this._walk(child.id, childPrefix);
    }
  }

  /**
   * Full crawl from `rootPageId` (AC-003-03).
   * @param {object} _config
   */
  async *crawl(_config) {
    for await (const { chunk } of this._walk(this.rootPageId, '')) {
      yield chunk;
    }
  }

  /**
   * Incremental diff — yield modify entries for pages whose version is newer
   * than `sinceISO`. We always rewalk the tree because Confluence's REST API
   * doesn't support a free-form "give me bodies modified after X" query that
   * also returns `body.storage`.
   * @param {object} _config
   * @param {string} sinceISO   ISO-8601 timestamp; only newer pages emit.
   */
  async *diff(_config, sinceISO) {
    if (!sinceISO) {
      throw new Error('ConfluenceConnector.diff(): `sinceISO` is required');
    }
    const cutoff = Date.parse(sinceISO);
    if (Number.isNaN(cutoff)) {
      throw new Error(`ConfluenceConnector.diff(): invalid sinceISO "${sinceISO}"`);
    }

    for await (const { chunk } of this._walk(this.rootPageId, '')) {
      const ts = Date.parse(chunk.last_modified);
      if (!Number.isNaN(ts) && ts > cutoff) {
        yield { chunk, action: 'modify' };
      }
    }
  }
}
