// T014: Confluence Source Connector — unit tests.
// Traces: FR-003 (AC-003-03), ERR-CONN-001, ERR-CONN-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Fixture strategy:
//   The connector accepts a `_fetch` seam that mirrors WHATWG fetch. Each test
//   wires a stub that pattern-matches on URL + query and returns a Response-shaped
//   object with status/json(). This exercises the full pagination + sub-page
//   crawl logic without any network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfluenceConnector } from '../../../src/connectors/confluence.js';
import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

const SITE = 'https://acme.atlassian.net/wiki';

/**
 * Build a minimal fake Response. The connector only ever calls .json() and
 * inspects .status / .ok, so we don't need the full WHATWG surface.
 */
function jsonResponse(body, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

/**
 * Build a stub fetch that dispatches by URL.
 * Each entry in `routes` is { match: (url) => boolean, response: <Response> }.
 * Entries are tried in order; first match wins. Throws if no route matches —
 * that surfaces as an unexpected request in the test.
 */
function stubFetch(routes) {
  const calls = [];
  async function fakeFetch(url, init) {
    calls.push({ url: String(url), init });
    for (const route of routes) {
      if (route.match(String(url))) {
        if (typeof route.response === 'function') {
          return route.response(String(url), init);
        }
        return route.response;
      }
    }
    throw new Error(`stubFetch: no route for ${url}`);
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

test('ConfluenceConnector extends SourceConnector', () => {
  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { username: 'u', apiToken: 't' },
    rootPageId: '100',
  });
  assert.ok(c instanceof SourceConnector);
  assert.equal(typeof c.crawl, 'function');
  assert.equal(typeof c.diff, 'function');
});

test('crawl walks root + sub-pages and yields normalised chunks (AC-003-03)', async () => {
  // 3-page tree: root (100) -> [child A (200), child B (201)]
  const fetchStub = stubFetch([
    {
      match: (u) => u.includes('/content/100') && !u.includes('/child/'),
      response: jsonResponse({
        id: '100',
        title: 'Root Page',
        space: { key: 'ENG' },
        version: { when: '2026-04-20T10:00:00.000Z' },
        body: { storage: { value: '<p>Root <b>page</b> content.</p>' } },
        ancestors: [],
        _links: { webui: '/spaces/ENG/pages/100' },
      }),
    },
    {
      match: (u) => u.includes('/content/100/child/page'),
      response: jsonResponse({
        results: [
          { id: '200', title: 'Child A' },
          { id: '201', title: 'Child B' },
        ],
        _links: {},
      }),
    },
    {
      match: (u) => u.includes('/content/200') && !u.includes('/child/'),
      response: jsonResponse({
        id: '200',
        title: 'Child A',
        space: { key: 'ENG' },
        version: { when: '2026-04-21T10:00:00.000Z' },
        body: { storage: { value: '<h1>A</h1><p>Alpha</p>' } },
        ancestors: [{ id: '100', title: 'Root Page' }],
        _links: { webui: '/spaces/ENG/pages/200' },
      }),
    },
    {
      match: (u) => u.includes('/content/200/child/page'),
      response: jsonResponse({ results: [], _links: {} }),
    },
    {
      match: (u) => u.includes('/content/201') && !u.includes('/child/'),
      response: jsonResponse({
        id: '201',
        title: 'Child B',
        space: { key: 'ENG' },
        version: { when: '2026-04-22T10:00:00.000Z' },
        body: { storage: { value: '<p>Bravo</p>' } },
        ancestors: [{ id: '100', title: 'Root Page' }],
        _links: { webui: '/spaces/ENG/pages/201' },
      }),
    },
    {
      match: (u) => u.includes('/content/201/child/page'),
      response: jsonResponse({ results: [], _links: {} }),
    },
  ]);

  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { username: 'u', apiToken: 't' },
    rootPageId: '100',
    _fetch: fetchStub,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.equal(chunks.length, 3, 'all 3 pages yielded');

  const byTitle = Object.fromEntries(chunks.map((c) => [c.path.split('/').pop(), c]));
  assert.ok(byTitle['Root Page'], 'root yielded');
  assert.ok(byTitle['Child A'], 'child A yielded');
  assert.ok(byTitle['Child B'], 'child B yielded');

  for (const chunk of chunks) {
    assert.equal(chunk.source_type, 'confluence');
    assert.ok(chunk.source_url.startsWith(SITE), 'URL anchored at site');
    assert.ok(!Number.isNaN(Date.parse(chunk.last_modified)), 'ISO timestamp');
    assert.equal(typeof chunk.metadata, 'object');
    assert.equal(chunk.metadata.space, 'ENG');
    // HTML must have been stripped to plain text — no tags should remain.
    assert.ok(!/<[a-z]/i.test(chunk.content), 'HTML tags stripped');
  }

  // Children carry the root in their path.
  assert.equal(byTitle['Child A'].path, 'Root Page/Child A');
  assert.equal(byTitle['Child B'].path, 'Root Page/Child B');

  // Auth header should be Basic for username+apiToken.
  const firstCall = fetchStub.calls[0];
  const authHeader = firstCall.init.headers.Authorization || firstCall.init.headers.authorization;
  assert.ok(authHeader.startsWith('Basic '), 'Basic auth header present');
});

test('crawl follows pagination on _links.next when listing children', async () => {
  // root has 3 children, returned in two pages.
  const fetchStub = stubFetch([
    {
      match: (u) => u.includes('/content/300') && !u.includes('/child/'),
      response: jsonResponse({
        id: '300',
        title: 'Root',
        space: { key: 'ENG' },
        version: { when: '2026-04-20T10:00:00.000Z' },
        body: { storage: { value: '<p>r</p>' } },
        ancestors: [],
        _links: { webui: '/spaces/ENG/pages/300' },
      }),
    },
    {
      match: (u) =>
        u.includes('/content/300/child/page') && !u.includes('start=2'),
      response: jsonResponse({
        results: [
          { id: '301', title: 'C1' },
          { id: '302', title: 'C2' },
        ],
        _links: { next: '/wiki/rest/api/content/300/child/page?start=2&limit=2' },
      }),
    },
    {
      match: (u) =>
        u.includes('/content/300/child/page') && u.includes('start=2'),
      response: jsonResponse({
        results: [{ id: '303', title: 'C3' }],
        _links: {},
      }),
    },
    // Three child page bodies + their (empty) child queries.
    ...['301', '302', '303'].flatMap((id) => [
      {
        match: (u) => u.includes(`/content/${id}`) && !u.includes('/child/'),
        response: jsonResponse({
          id,
          title: `C${id}`,
          space: { key: 'ENG' },
          version: { when: '2026-04-21T10:00:00.000Z' },
          body: { storage: { value: `<p>body ${id}</p>` } },
          ancestors: [{ id: '300', title: 'Root' }],
          _links: { webui: `/spaces/ENG/pages/${id}` },
        }),
      },
      {
        match: (u) => u.includes(`/content/${id}/child/page`),
        response: jsonResponse({ results: [], _links: {} }),
      },
    ]),
  ]);

  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { username: 'u', apiToken: 't' },
    rootPageId: '300',
    _fetch: fetchStub,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  // 1 root + 3 children = 4
  assert.equal(chunks.length, 4, 'paginated children all collected');
  // Both pagination URLs were hit.
  const childListCalls = fetchStub.calls.filter((c) =>
    /\/content\/300\/child\/page/.test(c.url),
  );
  assert.ok(childListCalls.length >= 2, 'at least two pagination requests');
  assert.ok(
    childListCalls.some((c) => c.url.includes('start=2')),
    'next-page URL was followed',
  );
});

test('crawl maps HTTP 5xx onto ConnectorError ERR-CONN-001', async () => {
  const fetchStub = stubFetch([
    {
      match: () => true,
      response: jsonResponse({ error: 'boom' }, { status: 500 }),
    },
  ]);
  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { username: 'u', apiToken: 't' },
    rootPageId: '999',
    _fetch: fetchStub,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError, 'ConnectorError thrown');
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('crawl maps HTTP 401 onto ConnectorError ERR-CONN-002', async () => {
  const fetchStub = stubFetch([
    {
      match: () => true,
      response: jsonResponse({ message: 'Unauthorized' }, { status: 401 }),
    },
  ]);
  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { username: 'u', apiToken: 't' },
    rootPageId: '999',
    _fetch: fetchStub,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError, 'ConnectorError thrown');
      assert.equal(err.code, 'ERR-CONN-002');
      return true;
    },
  );
});

test('crawl maps HTTP 403 onto ConnectorError ERR-CONN-002', async () => {
  const fetchStub = stubFetch([
    {
      match: () => true,
      response: jsonResponse({ message: 'Forbidden' }, { status: 403 }),
    },
  ]);
  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { bearerToken: 'tok' },
    rootPageId: '999',
    _fetch: fetchStub,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.equal(err.code, 'ERR-CONN-002');
      return true;
    },
  );
});

test('crawl maps network error onto ConnectorError ERR-CONN-001', async () => {
  async function failingFetch() {
    throw new Error('ECONNREFUSED');
  }
  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { bearerToken: 'tok' },
    rootPageId: '999',
    _fetch: failingFetch,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('diff yields modify entries for pages newer than sinceISO', async () => {
  // root + 2 children. only Child B is newer than `since`.
  const since = '2026-04-21T12:00:00.000Z';

  const fetchStub = stubFetch([
    {
      match: (u) => u.includes('/content/400') && !u.includes('/child/'),
      response: jsonResponse({
        id: '400',
        title: 'Root',
        space: { key: 'ENG' },
        version: { when: '2026-04-20T10:00:00.000Z' }, // older
        body: { storage: { value: '<p>r</p>' } },
        ancestors: [],
        _links: { webui: '/spaces/ENG/pages/400' },
      }),
    },
    {
      match: (u) => u.includes('/content/400/child/page'),
      response: jsonResponse({
        results: [
          { id: '401', title: 'A' },
          { id: '402', title: 'B' },
        ],
        _links: {},
      }),
    },
    {
      match: (u) => u.includes('/content/401') && !u.includes('/child/'),
      response: jsonResponse({
        id: '401',
        title: 'A',
        space: { key: 'ENG' },
        version: { when: '2026-04-21T09:00:00.000Z' }, // older
        body: { storage: { value: '<p>a</p>' } },
        ancestors: [{ id: '400', title: 'Root' }],
        _links: { webui: '/spaces/ENG/pages/401' },
      }),
    },
    {
      match: (u) => u.includes('/content/401/child/page'),
      response: jsonResponse({ results: [], _links: {} }),
    },
    {
      match: (u) => u.includes('/content/402') && !u.includes('/child/'),
      response: jsonResponse({
        id: '402',
        title: 'B',
        space: { key: 'ENG' },
        version: { when: '2026-04-22T10:00:00.000Z' }, // NEWER than since
        body: { storage: { value: '<p>b</p>' } },
        ancestors: [{ id: '400', title: 'Root' }],
        _links: { webui: '/spaces/ENG/pages/402' },
      }),
    },
    {
      match: (u) => u.includes('/content/402/child/page'),
      response: jsonResponse({ results: [], _links: {} }),
    },
  ]);

  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { username: 'u', apiToken: 't' },
    rootPageId: '400',
    _fetch: fetchStub,
  });

  const entries = [];
  for await (const entry of c.diff({}, since)) entries.push(entry);

  assert.equal(entries.length, 1, 'only the newer page surfaces');
  assert.equal(entries[0].action, 'modify');
  assert.equal(entries[0].chunk.path, 'Root/B');
  assert.equal(entries[0].chunk.source_type, 'confluence');
});

test('rootPageUrl is parsed into a page id when rootPageId is omitted', async () => {
  const fetchStub = stubFetch([
    {
      match: (u) => u.includes('/content/12345') && !u.includes('/child/'),
      response: jsonResponse({
        id: '12345',
        title: 'Imported',
        space: { key: 'DOCS' },
        version: { when: '2026-04-22T10:00:00.000Z' },
        body: { storage: { value: '<p>x</p>' } },
        ancestors: [],
        _links: { webui: '/spaces/DOCS/pages/12345' },
      }),
    },
    {
      match: (u) => u.includes('/content/12345/child/page'),
      response: jsonResponse({ results: [], _links: {} }),
    },
  ]);

  const c = new ConfluenceConnector({
    baseUrl: SITE,
    auth: { bearerToken: 'tok' },
    rootPageUrl: `${SITE}/spaces/DOCS/pages/12345/Imported`,
    _fetch: fetchStub,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].path, 'Imported');
});
