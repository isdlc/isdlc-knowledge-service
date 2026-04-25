// T016: Google Docs Source Connector — unit tests.
// Traces: FR-003 (AC-003-05), ERR-CONN-001, ERR-CONN-002
//
// Strategy:
//   The GDocs connector accepts a `_driveFactory` test seam — when supplied,
//   it skips the real `googleapis` Drive client and uses the factory's
//   return value instead. We hand-build a fake Drive client whose
//   `files.list` and `files.export` methods return scripted responses.
//   That gives us full control over folder hierarchies, MIME types, paging,
//   auth errors, and network errors with zero network access.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GDocsConnector } from '../../../src/connectors/gdocs.js';
import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const PNG_MIME = 'image/png';

/**
 * Build a fake googleapis Drive client. `tree` is a map keyed by folder id,
 * whose values are arrays of file/folder records as Drive would return
 * them. `exports` is a map keyed by file id whose values are the plaintext
 * the export endpoint should serve.
 */
function makeFakeDrive(tree, exports = {}, opts = {}) {
  const calls = { list: [], export: [] };
  const drive = {
    files: {
      async list(args) {
        calls.list.push(args);
        if (opts.listError) throw opts.listError;
        // Parse the parents folderId out of the q expression.
        const parentsMatch = /'([^']+)' in parents/.exec(args.q || '');
        const folderId = parentsMatch ? parentsMatch[1] : null;
        const modifiedMatch = /modifiedTime > '([^']+)'/.exec(args.q || '');
        const modifiedSince = modifiedMatch ? modifiedMatch[1] : null;
        let files = (tree[folderId] || []).slice();
        if (modifiedSince) {
          files = files.filter(
            (f) => f.modifiedTime && f.modifiedTime > modifiedSince,
          );
        }
        return { data: { files, nextPageToken: undefined } };
      },
      async export(args) {
        calls.export.push(args);
        if (opts.exportError) throw opts.exportError;
        const text = exports[args.fileId];
        if (text == null) {
          const err = new Error('not found');
          err.code = 404;
          throw err;
        }
        return { data: text };
      },
    },
  };
  return { drive, calls };
}

test('GDocsConnector extends SourceConnector', () => {
  const { drive } = makeFakeDrive({});
  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });
  assert.ok(c instanceof SourceConnector);
  assert.equal(typeof c.crawl, 'function');
  assert.equal(typeof c.diff, 'function');
});

test('constructor requires rootFolderId and auth', () => {
  assert.throws(() => new GDocsConnector({ auth: {} }), /rootFolderId/);
  assert.throws(
    () => new GDocsConnector({ rootFolderId: 'root' }),
    /auth/,
  );
});

test('crawl yields normalised chunks for Google Docs (AC-003-05)', async () => {
  const tree = {
    root: [
      {
        id: 'doc1',
        name: 'Spec.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
        webViewLink: 'https://docs.google.com/document/d/doc1/edit',
        owners: [{ emailAddress: 'a@example.com' }],
      },
    ],
  };
  const exports = { doc1: 'Hello from doc1' };
  const { drive, calls } = makeFakeDrive(tree, exports);

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  const ch = chunks[0];
  assert.equal(ch.path, 'Spec.gdoc');
  assert.equal(ch.content, 'Hello from doc1');
  assert.equal(ch.source_type, 'gdocs');
  assert.equal(ch.source_url, 'https://docs.google.com/document/d/doc1/edit');
  assert.equal(ch.last_modified, '2026-04-01T10:00:00Z');
  assert.equal(ch.metadata.mimeType, DOC_MIME);
  assert.deepEqual(ch.metadata.owners, [{ emailAddress: 'a@example.com' }]);

  // Sanity: list was called once with the right q, export was called for doc1.
  assert.equal(calls.list.length, 1);
  assert.match(calls.list[0].q, /'root' in parents/);
  assert.equal(calls.export.length, 1);
  assert.equal(calls.export[0].fileId, 'doc1');
  assert.equal(calls.export[0].mimeType, 'text/plain');
});

test('crawl recurses into sub-folders depth-first', async () => {
  const tree = {
    root: [
      {
        id: 'sub',
        name: 'Sub',
        mimeType: FOLDER_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
      },
      {
        id: 'doc1',
        name: 'Top.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
        webViewLink: 'https://docs.google.com/document/d/doc1/edit',
      },
    ],
    sub: [
      {
        id: 'doc2',
        name: 'Nested.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-04-02T10:00:00Z',
        webViewLink: 'https://docs.google.com/document/d/doc2/edit',
      },
    ],
  };
  const exports = { doc1: 'top', doc2: 'nested' };
  const { drive } = makeFakeDrive(tree, exports);

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  const byPath = Object.fromEntries(chunks.map((ch) => [ch.path, ch.content]));
  assert.equal(byPath['Top.gdoc'], 'top');
  assert.equal(byPath['Sub/Nested.gdoc'], 'nested');
});

test('crawl skips images / unsupported MIME types', async () => {
  const tree = {
    root: [
      {
        id: 'doc1',
        name: 'Doc.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
        webViewLink: 'x',
      },
      {
        id: 'png1',
        name: 'logo.png',
        mimeType: PNG_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
        webViewLink: 'y',
      },
    ],
  };
  const { drive, calls } = makeFakeDrive(tree, { doc1: 'hi' });

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].path, 'Doc.gdoc');
  // Export must only be called for the Doc, not the PNG.
  assert.equal(calls.export.length, 1);
  assert.equal(calls.export[0].fileId, 'doc1');
});

test('crawl exports Google Sheets as CSV text', async () => {
  const tree = {
    root: [
      {
        id: 'sh1',
        name: 'Budget',
        mimeType: SHEET_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
        webViewLink: 'https://docs.google.com/spreadsheets/d/sh1/edit',
      },
    ],
  };
  const exports = { sh1: 'a,b\n1,2\n' };
  const { drive, calls } = makeFakeDrive(tree, exports);

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, 'a,b\n1,2\n');
  assert.equal(calls.export[0].mimeType, 'text/csv');
});

test('diff filters by modifiedTime and yields modify actions', async () => {
  const tree = {
    root: [
      {
        id: 'old',
        name: 'Old.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-03-01T00:00:00Z',
        webViewLink: 'a',
      },
      {
        id: 'new',
        name: 'New.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-04-15T00:00:00Z',
        webViewLink: 'b',
      },
    ],
  };
  const exports = { old: 'old', new: 'new' };
  const { drive, calls } = makeFakeDrive(tree, exports);

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  const entries = [];
  for await (const e of c.diff({}, '2026-04-01T00:00:00Z')) entries.push(e);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'modify');
  assert.equal(entries[0].chunk.path, 'New.gdoc');
  // The list query must include the modifiedTime predicate.
  assert.match(calls.list[0].q, /modifiedTime > '2026-04-01T00:00:00Z'/);
});

test('diff requires `since` ISO timestamp', async () => {
  const { drive } = makeFakeDrive({});
  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });
  await assert.rejects(async () => {
    for await (const _ of c.diff({}, '')) void _;
  }, /since/);
});

test('crawl maps 401 from list to ERR-CONN-002 (auth failed)', async () => {
  const authErr = Object.assign(new Error('Unauthorized'), { code: 401 });
  const { drive } = makeFakeDrive({}, {}, { listError: authErr });

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'ERR-CONN-002');
      return true;
    },
  );
});

test('crawl maps invalid_grant from export to ERR-CONN-002 (auth failed)', async () => {
  const tree = {
    root: [
      {
        id: 'doc1',
        name: 'Doc.gdoc',
        mimeType: DOC_MIME,
        modifiedTime: '2026-04-01T10:00:00Z',
        webViewLink: 'x',
      },
    ],
  };
  const authErr = new Error('invalid_grant');
  const { drive } = makeFakeDrive(tree, {}, { exportError: authErr });

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'ERR-CONN-002');
      return true;
    },
  );
});

test('crawl maps generic network failure to ERR-CONN-001 (unreachable)', async () => {
  const netErr = Object.assign(new Error('getaddrinfo ENOTFOUND drive.googleapis.com'), {
    code: 'ENOTFOUND',
  });
  const { drive } = makeFakeDrive({}, {}, { listError: netErr });

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
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

test('crawl handles paginated list responses', async () => {
  // Custom drive that returns two pages for the root folder.
  const calls = { list: 0, export: 0 };
  const drive = {
    files: {
      async list(args) {
        calls.list++;
        if (!args.pageToken) {
          return {
            data: {
              files: [
                {
                  id: 'd1',
                  name: 'A.gdoc',
                  mimeType: DOC_MIME,
                  modifiedTime: '2026-04-01T00:00:00Z',
                  webViewLink: 'a',
                },
              ],
              nextPageToken: 'p2',
            },
          };
        }
        return {
          data: {
            files: [
              {
                id: 'd2',
                name: 'B.gdoc',
                mimeType: DOC_MIME,
                modifiedTime: '2026-04-02T00:00:00Z',
                webViewLink: 'b',
              },
            ],
          },
        };
      },
      async export(args) {
        calls.export++;
        return { data: `body-${args.fileId}` };
      },
    },
  };

  const c = new GDocsConnector({
    auth: {},
    rootFolderId: 'root',
    _driveFactory: () => drive,
  });

  const chunks = [];
  for await (const ch of c.crawl({})) chunks.push(ch);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.path).sort(), ['A.gdoc', 'B.gdoc']);
  assert.equal(calls.list, 2);
});
