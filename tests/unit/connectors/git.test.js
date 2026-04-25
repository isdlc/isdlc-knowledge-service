// T012: Git Source Connector — unit tests.
// Traces: FR-003 (AC-003-01, AC-003-07), ERR-CONN-001
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// Fixture strategy:
//   We build a self-contained on-disk fixture per test using simple-git:
//     1. Create a "remote" directory and `git init --bare` it.
//     2. Create a "seed" working copy, populate it with files, commit, push
//        to the bare remote.
//     3. Point the GitConnector at the bare remote URL (a local file path).
//   This exercises real clone/pull/diff behaviour without any network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

import { GitConnector } from '../../../src/connectors/git.js';
import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

let workspace;
let remoteUrl;
let seedDir;
let firstSha;
let secondSha;

async function commitFile(git, path, content, message) {
  writeFileSync(join(seedDir, path), content);
  await git.add(path);
  await git.commit(message);
  const log = await git.log({ maxCount: 1 });
  return log.latest.hash;
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'isdlc-git-conn-'));

  // 1. Bare "remote" repo (acts as the upstream URL).
  const bare = join(workspace, 'remote.git');
  mkdirSync(bare, { recursive: true });
  await simpleGit(bare).init(true, ['--initial-branch=main']);
  remoteUrl = bare;

  // 2. Seed working copy.
  seedDir = join(workspace, 'seed');
  mkdirSync(seedDir, { recursive: true });
  const seedGit = simpleGit(seedDir);
  await seedGit.init(['--initial-branch=main']);
  await seedGit.addConfig('user.email', 'test@example.com');
  await seedGit.addConfig('user.name', 'Test User');

  // First commit: text + nested file + a binary file (null bytes -> must be skipped).
  writeFileSync(join(seedDir, 'README.md'), '# Project\n\nHello world.\n');
  mkdirSync(join(seedDir, 'src'), { recursive: true });
  writeFileSync(join(seedDir, 'src', 'app.js'), 'export const x = 1;\n');
  // Binary fixture — first 8KB contains null bytes.
  const bin = Buffer.alloc(16, 0);
  bin[0] = 0x89;
  bin[1] = 0x50;
  bin[2] = 0x4e;
  bin[3] = 0x47;
  // bytes [4..] are zero -> contains nulls -> binary heuristic must skip.
  writeFileSync(join(seedDir, 'logo.png'), bin);

  await seedGit.add('.');
  await seedGit.commit('initial commit');
  firstSha = (await seedGit.log({ maxCount: 1 })).latest.hash;

  // Second commit: modify one file, add another, delete one.
  secondSha = await commitFile(
    seedGit,
    'src/app.js',
    'export const x = 2;\n',
    'bump x',
  );
  secondSha = await commitFile(
    seedGit,
    'docs.md',
    '# Docs\n',
    'add docs',
  );
  await seedGit.rm(['README.md']);
  await seedGit.commit('drop readme');
  secondSha = (await seedGit.log({ maxCount: 1 })).latest.hash;

  await seedGit.addRemote('origin', remoteUrl);
  await seedGit.push(['-u', 'origin', 'main']);
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test('GitConnector extends SourceConnector', () => {
  const c = new GitConnector({ url: remoteUrl });
  assert.ok(c instanceof SourceConnector);
  assert.equal(typeof c.crawl, 'function');
  assert.equal(typeof c.diff, 'function');
});

test('crawl yields all tracked text files with normalised chunk fields (AC-003-07)', async () => {
  const localPath = join(workspace, 'clone-crawl');
  const c = new GitConnector({ url: remoteUrl, localPath });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  // After 3 commits the tracked text files are: src/app.js, docs.md.
  // README.md was deleted; logo.png is binary and must be skipped.
  const paths = chunks.map((c) => c.path).sort();
  assert.deepEqual(paths, ['docs.md', 'src/app.js']);

  for (const chunk of chunks) {
    assert.equal(chunk.source_type, 'git');
    assert.ok(chunk.source_url.startsWith(remoteUrl));
    assert.ok(chunk.source_url.endsWith(chunk.path));
    assert.ok(chunk.content.length > 0);
    // last_modified must be a parseable ISO-8601 timestamp.
    assert.ok(!Number.isNaN(Date.parse(chunk.last_modified)));
    assert.equal(typeof chunk.metadata, 'object');
  }
});

test('crawl skips binary files (null-byte heuristic)', async () => {
  const localPath = join(workspace, 'clone-binary');
  const c = new GitConnector({ url: remoteUrl, localPath });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.ok(
    !chunks.some((c) => c.path === 'logo.png'),
    'binary file logo.png must be skipped',
  );
});

test('crawl skips files larger than maxFileBytes', async () => {
  // Add a >1MB file in a fresh commit.
  const seedGit = simpleGit(seedDir);
  const big = 'A'.repeat(2 * 1024 * 1024); // 2 MB
  writeFileSync(join(seedDir, 'big.txt'), big);
  await seedGit.add('big.txt');
  await seedGit.commit('add big');
  await seedGit.push();

  const localPath = join(workspace, 'clone-big');
  const c = new GitConnector({ url: remoteUrl, localPath });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.ok(
    !chunks.some((c) => c.path === 'big.txt'),
    'file larger than maxFileBytes must be skipped',
  );
});

test('diff between two commits yields add/modify/delete actions (AC-003-01)', async () => {
  const localPath = join(workspace, 'clone-diff');
  const c = new GitConnector({ url: remoteUrl, localPath });

  // Prime the local clone (crawl pulls on first run).
  for await (const _ of c.crawl({})) void _;

  const entries = [];
  for await (const entry of c.diff({}, firstSha)) entries.push(entry);

  const byPath = Object.fromEntries(entries.map((e) => [e.chunk.path, e.action]));

  assert.equal(byPath['src/app.js'], 'modify', 'app.js was modified');
  assert.equal(byPath['docs.md'], 'add', 'docs.md was added');
  assert.equal(byPath['README.md'], 'delete', 'README.md was deleted');

  // Modify/add chunks must include real content; delete chunks may be empty.
  for (const e of entries) {
    assert.equal(e.chunk.source_type, 'git');
    assert.ok(['add', 'modify', 'delete'].includes(e.action));
    if (e.action !== 'delete') {
      assert.ok(e.chunk.content.length > 0);
    }
  }
});

test('crawl on an unreachable URL throws ConnectorError ERR-CONN-001', async () => {
  const localPath = join(workspace, 'clone-bad');
  const bogus = join(workspace, 'does-not-exist.git');
  const c = new GitConnector({ url: bogus, localPath });

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

test('crawl skips default-ignored directories (.git, node_modules)', async () => {
  // Add tracked content under node_modules to prove ignore is by walk-time
  // path filter, not gitignore.
  const seedGit = simpleGit(seedDir);
  mkdirSync(join(seedDir, 'node_modules', 'foo'), { recursive: true });
  writeFileSync(join(seedDir, 'node_modules', 'foo', 'index.js'), 'module.exports={};\n');
  await seedGit.add(['-f', 'node_modules/foo/index.js']);
  await seedGit.commit('add nm');
  await seedGit.push();

  const localPath = join(workspace, 'clone-ignore');
  const c = new GitConnector({ url: remoteUrl, localPath });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.ok(
    !chunks.some((c) => c.path.startsWith('node_modules/')),
    'node_modules must be skipped by default',
  );
  assert.ok(
    !chunks.some((c) => c.path.startsWith('.git/')),
    '.git must be skipped',
  );
});
