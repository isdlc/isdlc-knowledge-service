// T016: Filesystem Source Connector — unit tests.
// Traces: FR-003 (AC-003-06), ERR-CONN-001
//
// Strategy:
//   We use real on-disk fixtures under os.tmpdir() so we exercise the
//   genuine fs/promises code path rather than mocking it. Each test creates
//   a clean directory tree, runs the connector, and asserts on the yielded
//   NormalisedChunks. The tmp dir is cleaned up in afterEach.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FilesystemConnector } from '../../../src/connectors/filesystem.js';
import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'isdlc-fs-conn-'));
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test('FilesystemConnector extends SourceConnector', () => {
  const c = new FilesystemConnector({ path: workspace });
  assert.ok(c instanceof SourceConnector);
  assert.equal(typeof c.crawl, 'function');
  assert.equal(typeof c.diff, 'function');
});

test('constructor requires `path`', () => {
  assert.throws(() => new FilesystemConnector({}), /path/);
});

test('crawl yields normalised chunks for every text file (AC-003-06)', async () => {
  writeFileSync(join(workspace, 'README.md'), '# Project\nHello.\n');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'app.js'), 'export const x = 1;\n');

  const c = new FilesystemConnector({ path: workspace });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  const byPath = Object.fromEntries(chunks.map((ch) => [ch.path, ch]));
  assert.deepEqual(Object.keys(byPath).sort(), ['README.md', 'src/app.js']);

  const readme = byPath['README.md'];
  assert.equal(readme.source_type, 'filesystem');
  assert.equal(
    readme.source_url,
    pathToFileURL(join(workspace, 'README.md')).href,
  );
  assert.match(readme.content, /Project/);
  assert.ok(readme.metadata.size > 0);
  assert.ok(!Number.isNaN(Date.parse(readme.last_modified)));

  // Cross-platform path: forward slashes only.
  assert.equal(byPath['src/app.js'].path, 'src/app.js');
});

test('crawl skips binary files via the null-byte heuristic', async () => {
  writeFileSync(join(workspace, 'text.txt'), 'plain text\n');
  // Binary fixture: PNG header + null bytes -> caught by null-byte heuristic.
  const bin = Buffer.alloc(64, 0);
  bin[0] = 0x89;
  bin[1] = 0x50;
  bin[2] = 0x4e;
  bin[3] = 0x47;
  writeFileSync(join(workspace, 'logo.png'), bin);

  const c = new FilesystemConnector({ path: workspace });
  const chunks = [];
  for await (const ch of c.crawl({})) chunks.push(ch);

  const paths = chunks.map((c) => c.path);
  assert.ok(paths.includes('text.txt'));
  assert.ok(!paths.includes('logo.png'), 'binary file must be skipped');
});

test('crawl skips files larger than maxFileBytes', async () => {
  writeFileSync(join(workspace, 'small.txt'), 'small');
  writeFileSync(join(workspace, 'big.txt'), 'A'.repeat(2 * 1024 * 1024));

  const c = new FilesystemConnector({ path: workspace });
  const chunks = [];
  for await (const ch of c.crawl({})) chunks.push(ch);

  const paths = chunks.map((c) => c.path);
  assert.ok(paths.includes('small.txt'));
  assert.ok(!paths.includes('big.txt'), '2MB file must be skipped (>1MB cap)');
});

test('crawl honours default ignorePatterns (.git, node_modules, .DS_Store)', async () => {
  writeFileSync(join(workspace, 'visible.md'), 'visible');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(workspace, 'node_modules', 'foo'), { recursive: true });
  writeFileSync(join(workspace, 'node_modules', 'foo', 'index.js'), 'x');
  writeFileSync(join(workspace, '.DS_Store'), 'finder junk');

  const c = new FilesystemConnector({ path: workspace });
  const chunks = [];
  for await (const ch of c.crawl({})) chunks.push(ch);

  const paths = chunks.map((c) => c.path);
  assert.ok(paths.includes('visible.md'));
  assert.ok(!paths.some((p) => p.startsWith('.git/')));
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
  assert.ok(!paths.includes('.DS_Store'));
});

test('crawl honours custom ignorePatterns', async () => {
  writeFileSync(join(workspace, 'keep.md'), 'keep');
  mkdirSync(join(workspace, 'tmp'), { recursive: true });
  writeFileSync(join(workspace, 'tmp', 'junk.txt'), 'junk');

  const c = new FilesystemConnector({
    path: workspace,
    ignorePatterns: ['tmp'],
  });
  const chunks = [];
  for await (const ch of c.crawl({})) chunks.push(ch);

  const paths = chunks.map((c) => c.path);
  assert.deepEqual(paths.sort(), ['keep.md']);
});

test('crawl on a non-existent path throws ERR-CONN-001', async () => {
  const c = new FilesystemConnector({
    path: join(workspace, 'does-not-exist'),
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

test('crawl when path is a file (not a directory) throws ERR-CONN-001', async () => {
  const filePath = join(workspace, 'file.txt');
  writeFileSync(filePath, 'hi');
  const c = new FilesystemConnector({ path: filePath });

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

test('diff filters files by mtime > sinceISO and yields modify actions', async () => {
  // Old file: backdated mtime. New file: current mtime.
  writeFileSync(join(workspace, 'old.txt'), 'old');
  writeFileSync(join(workspace, 'new.txt'), 'new');

  const oldTime = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(workspace, 'old.txt'), oldTime, oldTime);

  const c = new FilesystemConnector({ path: workspace });

  const entries = [];
  for await (const e of c.diff({}, '2026-02-01T00:00:00Z')) entries.push(e);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'modify');
  assert.equal(entries[0].chunk.path, 'new.txt');
  assert.equal(entries[0].chunk.source_type, 'filesystem');
});

test('diff requires a valid ISO timestamp', async () => {
  const c = new FilesystemConnector({ path: workspace });

  await assert.rejects(async () => {
    for await (const _ of c.diff({}, '')) void _;
  }, /since/);

  await assert.rejects(async () => {
    for await (const _ of c.diff({}, 'not-a-date')) void _;
  }, /invalid/i);
});

test('diff returns nothing when no files have changed since `since`', async () => {
  writeFileSync(join(workspace, 'a.txt'), 'a');
  const oldTime = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(workspace, 'a.txt'), oldTime, oldTime);

  const c = new FilesystemConnector({ path: workspace });
  const entries = [];
  for await (const e of c.diff({}, '2026-04-01T00:00:00Z')) entries.push(e);

  assert.equal(entries.length, 0);
});

test('crawl recurses into nested directories', async () => {
  mkdirSync(join(workspace, 'a', 'b', 'c'), { recursive: true });
  writeFileSync(join(workspace, 'a', 'b', 'c', 'deep.txt'), 'deep');
  writeFileSync(join(workspace, 'top.txt'), 'top');

  const c = new FilesystemConnector({ path: workspace });
  const chunks = [];
  for await (const ch of c.crawl({})) chunks.push(ch);

  const paths = chunks.map((c) => c.path).sort();
  assert.deepEqual(paths, ['a/b/c/deep.txt', 'top.txt']);
});
