// T015: Website Source Connector — unit tests.
// Traces: FR-003 (AC-003-01, AC-003-07), ERR-CONN-001
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Mocking strategy:
//   The WebConnector accepts an injectable `_fetch` function (constructor seam).
//   Tests build canned page maps and a `makeFetch(map)` helper which returns a
//   fetch-like function that resolves a Response-shaped object. This avoids
//   real network calls while exercising BFS, depth limits, same-origin
//   filtering, and per-page failure tolerance.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebConnector } from '../../../src/connectors/web.js';
import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

/**
 * Build a fetch double from a `{ [url]: { status, html, lastModified? } }`
 * map. Unmapped URLs reject with a network-style error so the connector's
 * per-page error path is exercised when desired.
 */
function makeFetch(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const entry = map[url];
    if (!entry) {
      const err = new Error(`ENOTFOUND ${url}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    if (entry.throw) {
      throw entry.throw;
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: {
        get(name) {
          if (name.toLowerCase() === 'last-modified') {
            return entry.lastModified || null;
          }
          if (name.toLowerCase() === 'content-type') {
            return entry.contentType || 'text/html';
          }
          return null;
        },
      },
      async text() {
        return entry.html || '';
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test('WebConnector extends SourceConnector', () => {
  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    _fetch: makeFetch({}),
  });
  assert.ok(c instanceof SourceConnector);
  assert.equal(typeof c.crawl, 'function');
  assert.equal(typeof c.diff, 'function');
});

test('crawl yields BFS pages with normalised chunk fields (AC-003-07)', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': {
      status: 200,
      lastModified: 'Wed, 01 Jan 2025 12:00:00 GMT',
      html: `
        <html><head><title>Root</title></head>
        <body>
          <main>
            <p>Root page content.</p>
            <a href="/a">A</a>
            <a href="/b">B</a>
          </main>
        </body></html>`,
    },
    'https://example.com/a': {
      status: 200,
      html: '<html><head><title>A</title></head><body><article>Page A body.</article></body></html>',
    },
    'https://example.com/b': {
      status: 200,
      html: '<html><head><title>B</title></head><body><article>Page B body.</article></body></html>',
    },
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    depthLimit: 3,
    _fetch: fetchFn,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  // BFS root + 2 children = 3 chunks.
  assert.equal(chunks.length, 3);
  const urls = chunks.map((c) => c.source_url).sort();
  assert.deepEqual(urls, [
    'https://example.com/',
    'https://example.com/a',
    'https://example.com/b',
  ]);

  // Validate normalised chunk shape on every yield.
  for (const chunk of chunks) {
    assert.equal(chunk.source_type, 'website');
    assert.equal(typeof chunk.path, 'string');
    assert.ok(chunk.content.length > 0);
    assert.equal(typeof chunk.metadata, 'object');
    assert.equal(typeof chunk.metadata.title, 'string');
    assert.equal(typeof chunk.metadata.depth, 'number');
    assert.equal(typeof chunk.metadata.links_outbound_count, 'number');
  }

  // Root specifically: title "Root", depth 0, 2 outbound links, parsed
  // last-modified from response header.
  const root = chunks.find((c) => c.source_url === 'https://example.com/');
  assert.equal(root.metadata.title, 'Root');
  assert.equal(root.metadata.depth, 0);
  assert.equal(root.metadata.links_outbound_count, 2);
  assert.ok(!Number.isNaN(Date.parse(root.last_modified)));
});

test('crawl honours depthLimit (depth 1 does not follow children)', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': {
      status: 200,
      html: `<html><body><a href="/a">A</a></body></html>`,
    },
    'https://example.com/a': {
      status: 200,
      html: `<html><body><a href="/b">B</a></body></html>`,
    },
    // /b is reachable in the map but should NOT be fetched at depth 1.
    'https://example.com/b': {
      status: 200,
      html: '<html><body>B</body></html>',
    },
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    depthLimit: 1,
    _fetch: fetchFn,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  // depth 0 (root) + depth 1 (a) only.
  const urls = chunks.map((c) => c.source_url).sort();
  assert.deepEqual(urls, ['https://example.com/', 'https://example.com/a']);
  assert.ok(
    !fetchFn.calls.includes('https://example.com/b'),
    '/b must not be fetched when depthLimit=1',
  );
});

test('crawl filters external links when sameOriginOnly=true', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': {
      status: 200,
      html: `
        <html><body>
          <a href="https://other.com/x">external</a>
          <a href="/internal">internal</a>
        </body></html>`,
    },
    'https://example.com/internal': {
      status: 200,
      html: '<html><body>internal page</body></html>',
    },
    'https://other.com/x': {
      status: 200,
      html: '<html><body>should not be fetched</body></html>',
    },
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    sameOriginOnly: true,
    _fetch: fetchFn,
  });

  for await (const _ of c.crawl({})) void _;

  assert.ok(
    !fetchFn.calls.includes('https://other.com/x'),
    'external origin must be skipped',
  );
  assert.ok(fetchFn.calls.includes('https://example.com/internal'));
});

test('crawl tolerates an unreachable child page (logged, not thrown)', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': {
      status: 200,
      html: `
        <html><body>
          <a href="/good">good</a>
          <a href="/dead">dead</a>
        </body></html>`,
    },
    'https://example.com/good': {
      status: 200,
      html: '<html><body>Good content</body></html>',
    },
    // /dead intentionally absent — fetch will throw.
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    _fetch: fetchFn,
  });

  // Capture warnings to assert the dead URL was logged rather than thrown.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  let chunks;
  try {
    chunks = [];
    for await (const chunk of c.crawl({})) chunks.push(chunk);
  } finally {
    console.warn = origWarn;
  }

  // Root + good only — dead page silently dropped from the stream.
  const urls = chunks.map((c) => c.source_url).sort();
  assert.deepEqual(urls, [
    'https://example.com/',
    'https://example.com/good',
  ]);
  assert.ok(
    warnings.some((w) => w.includes('https://example.com/dead')),
    'dead child page must produce a warn-level log entry',
  );
});

test('crawl visits each URL at most once (cycle protection)', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': {
      status: 200,
      html: `<html><body>
        <a href="/a">A</a>
        <a href="/a">A again</a>
        <a href="/">self</a>
      </body></html>`,
    },
    'https://example.com/a': {
      status: 200,
      html: `<html><body>
        <a href="/">back to root</a>
      </body></html>`,
    },
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    _fetch: fetchFn,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  // Each URL appears exactly once despite duplicate / cyclic links.
  assert.equal(chunks.length, 2);
  const rootCalls = fetchFn.calls.filter((u) => u === 'https://example.com/').length;
  const aCalls = fetchFn.calls.filter((u) => u === 'https://example.com/a').length;
  assert.equal(rootCalls, 1);
  assert.equal(aCalls, 1);
});

test('crawl on an unreachable root throws ConnectorError ERR-CONN-001', async () => {
  const fetchFn = makeFetch({}); // empty map -> root rejects.

  const c = new WebConnector({
    rootUrl: 'https://nope.invalid/',
    _fetch: fetchFn,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError, 'expected ConnectorError');
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('crawl on a non-2xx root throws ConnectorError ERR-CONN-001', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': { status: 500, html: '' },
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    _fetch: fetchFn,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('diff re-crawls and yields all pages as "modify" actions (v1 behaviour)', async () => {
  const fetchFn = makeFetch({
    'https://example.com/': {
      status: 200,
      html: '<html><body><a href="/a">A</a></body></html>',
    },
    'https://example.com/a': {
      status: 200,
      html: '<html><body>A content</body></html>',
    },
  });

  const c = new WebConnector({
    rootUrl: 'https://example.com/',
    _fetch: fetchFn,
  });

  const entries = [];
  for await (const entry of c.diff({}, '2025-01-01T00:00:00Z')) entries.push(entry);

  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.equal(e.action, 'modify');
    assert.equal(e.chunk.source_type, 'website');
  }
});

test('constructor rejects missing rootUrl', () => {
  assert.throws(() => new WebConnector({ _fetch: makeFetch({}) }), /rootUrl/);
});
