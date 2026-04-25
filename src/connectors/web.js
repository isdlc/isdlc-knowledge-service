// T015: Website Source Connector — fetch + parse + BFS link following.
// Traces: FR-003 (AC-003-01, AC-003-07), ERR-CONN-001
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Implementation notes:
// - HTTP via Node's global `fetch` (Node 18+). The constructor accepts an
//   `_fetch` seam so tests can inject a deterministic double without the
//   network or extra deps like nock.
// - HTML parsing via `cheerio` (already a project dependency). We extract
//   the page title and the textual content of <main>/<article>/<body> in
//   that priority order — the first non-empty match wins. This biases the
//   chunk content toward main-content selectors and away from chrome.
// - BFS traversal with a visited-URL set to avoid cycles. Each enqueued
//   target carries its parent depth so we can enforce `depthLimit`.
// - `sameOriginOnly` (default true) drops any link whose URL.origin differs
//   from the root URL's origin. This keeps a crawl bounded to one site by
//   default — operators can flip it off explicitly when federating.
// - Per-page failures (4xx/5xx, network errors, parse errors) are logged at
//   warn-level and skipped; they MUST NOT abort the crawl. Only a failure
//   on the root URL itself escalates to ERR-CONN-001 — without the root
//   page there is nothing to crawl.
// - `diff` v1 simply re-crawls and emits every page as "modify". A future
//   iteration can compare ETags / Last-Modified against a cache; the
//   v1 contract is that callers re-embed everything we yield.
import { load as cheerioLoad } from 'cheerio';

import { SourceConnector, ConnectorError } from './connector.js';

const DEFAULT_DEPTH_LIMIT = 3;
const DEFAULT_USER_AGENT = 'isdlc-knowledge-service/0.1 (+website-connector)';

/**
 * Extract the textual content of the first non-empty matching selector,
 * preferring main-content elements over the full <body>.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractMainText($) {
  const selectors = ['main', 'article', 'body'];
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el && el.length) {
      const text = el.text().replace(/\s+/g, ' ').trim();
      if (text.length > 0) return text;
    }
  }
  return '';
}

/**
 * @typedef {object} WebConnectorConfig
 * @property {string}  rootUrl          Where the crawl starts.
 * @property {number}  [depthLimit]     Max BFS depth from root (default 3).
 * @property {boolean} [sameOriginOnly] Drop cross-origin links (default true).
 * @property {string}  [userAgent]      User-Agent header to send.
 * @property {(url: string, init?: object) => Promise<Response>} [_fetch]
 *           Test seam — defaults to global `fetch`.
 */

export class WebConnector extends SourceConnector {
  /** @param {WebConnectorConfig} config */
  constructor(config = {}) {
    super();
    if (!config.rootUrl) {
      throw new Error('WebConnector: `rootUrl` is required');
    }
    this.rootUrl = config.rootUrl;
    this.depthLimit = config.depthLimit ?? DEFAULT_DEPTH_LIMIT;
    this.sameOriginOnly = config.sameOriginOnly ?? true;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    // Bind in case the caller passes a method off an object.
    this._fetch = config._fetch ?? ((url, init) => fetch(url, init));

    // Pre-parse the root URL once — used for same-origin checks.
    try {
      this._rootParsed = new URL(this.rootUrl);
    } catch (err) {
      throw new Error(`WebConnector: invalid rootUrl "${this.rootUrl}": ${err.message}`);
    }
  }

  /**
   * GET a URL and return { html, lastModified } or throw on non-2xx /
   * network failure. This is the single I/O choke-point; callers decide
   * whether the failure is fatal (root) or skippable (child).
   * @param {string} url
   */
  async _fetchPage(url) {
    const res = await this._fetch(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'text/html,*/*;q=0.5' },
      redirect: 'follow',
    });
    if (!res || !res.ok) {
      const status = res ? res.status : 'no-response';
      throw new Error(`HTTP ${status} for ${url}`);
    }
    const html = await res.text();
    const lastModified = res.headers && res.headers.get
      ? res.headers.get('last-modified')
      : null;
    return { html, lastModified };
  }

  /**
   * Resolve `href` against `base` and decide whether it should be enqueued.
   * Returns the canonical absolute URL string, or null to skip.
   */
  _normaliseLink(href, base) {
    if (!href) return null;
    // Skip in-page anchors, mailto:, javascript:, tel:, etc.
    if (/^(mailto:|javascript:|tel:|#)/i.test(href)) return null;

    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      return null;
    }
    // Only HTTP(S) scheme is meaningful for a website crawler.
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    if (this.sameOriginOnly && abs.origin !== this._rootParsed.origin) return null;
    // Strip fragment so /a and /a#section dedupe in the visited set.
    abs.hash = '';
    return abs.toString();
  }

  /**
   * Parse `html` and produce both a NormalisedChunk and the outbound link list
   * (already filtered + deduped, but not yet checked against the visited set).
   */
  _parsePage(url, html, lastModified, depth) {
    const $ = cheerioLoad(html);
    const title = ($('title').first().text() || '').trim();
    const content = extractMainText($);

    const seenLocal = new Set();
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const norm = this._normaliseLink(href, url);
      if (!norm) return;
      if (seenLocal.has(norm)) return;
      seenLocal.add(norm);
      links.push(norm);
    });

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname + (parsedUrl.search || '');

    /** @type {import('./connector.js').NormalisedChunk} */
    const chunk = {
      content,
      path,
      source_type: 'website',
      source_url: url,
      last_modified: lastModified
        ? new Date(lastModified).toISOString()
        : null,
      metadata: {
        title,
        depth,
        links_outbound_count: links.length,
      },
    };

    // Guard against an invalid Last-Modified header — fall back to null.
    if (chunk.last_modified === 'Invalid Date' ||
        (chunk.last_modified && Number.isNaN(Date.parse(chunk.last_modified)))) {
      chunk.last_modified = null;
    }

    return { chunk, links };
  }

  /**
   * Full BFS crawl from `rootUrl`. Yields one NormalisedChunk per reachable
   * page, in BFS visitation order. Per-page failures are warn-logged and
   * skipped; only a root-fetch failure escalates to ERR-CONN-001.
   * @param {object} _config
   */
  async *crawl(_config) {
    const visited = new Set();
    const queue = [{ url: this.rootUrl, depth: 0 }];

    // Fetch + parse the root explicitly so we can map its failure to
    // ERR-CONN-001. After this, child failures are tolerated.
    let rootPage;
    try {
      rootPage = await this._fetchPage(this.rootUrl);
    } catch (err) {
      throw new ConnectorError(
        'ERR-CONN-001',
        `Website root unreachable (${this.rootUrl}): ${err.message || err}`,
        { cause: err },
      );
    }
    visited.add(this.rootUrl);
    queue.shift(); // we just consumed root manually
    {
      const { chunk, links } = this._parsePage(
        this.rootUrl,
        rootPage.html,
        rootPage.lastModified,
        0,
      );
      yield chunk;
      if (0 < this.depthLimit) {
        for (const link of links) {
          if (!visited.has(link)) queue.push({ url: link, depth: 1 });
        }
      }
    }

    while (queue.length > 0) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      let page;
      try {
        page = await this._fetchPage(url);
      } catch (err) {
        // Per-page failure — log and continue. FR-003 risk: best-effort.
        console.warn(
          `[WebConnector] failed to fetch ${url} (depth ${depth}): ${err.message || err}`,
        );
        continue;
      }

      let parsed;
      try {
        parsed = this._parsePage(url, page.html, page.lastModified, depth);
      } catch (err) {
        console.warn(
          `[WebConnector] failed to parse ${url} (depth ${depth}): ${err.message || err}`,
        );
        continue;
      }

      yield parsed.chunk;

      if (depth < this.depthLimit) {
        for (const link of parsed.links) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    }
  }

  /**
   * Incremental diff. v1: re-crawl and emit every reachable page as
   * "modify". A future revision can use a persisted ETag/Last-Modified
   * cache to emit fine-grained add/modify/delete actions.
   * @param {object} config
   * @param {string} _sinceISO   Reserved for future cache-keyed diffs.
   */
  async *diff(config, _sinceISO) {
    for await (const chunk of this.crawl(config)) {
      yield { chunk, action: 'modify' };
    }
  }
}
