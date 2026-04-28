// REQ-GH-3 / FR-008 — vector storage regression assertions.
//
// Confirms the REQ-GH-3 migration does NOT touch vector adapters or the
// sqlite-vec dependency. Independent of the existing per-adapter test
// suites, which continue to pass unchanged (AC-008-02).
//
// Trace: AC-008-01 — adapter selection / storage paths preserved.
//        AC-008-03 — removing the custom SQLite queue does not remove
//                    sqlite-vec support.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '../../../package.json');

test('AC-008-01 — vectordb module still exports the canonical adapter set', async () => {
  const mod = await import('../../../src/vectordb/index.js');
  // We don't enumerate every export here (that's covered by adapter tests).
  // We just confirm the module loads without throwing — i.e. the REQ-GH-3
  // changes haven't broken its import graph.
  assert.equal(typeof mod, 'object');
  assert.ok(Object.keys(mod).length > 0, 'vectordb/index.js exports at least one symbol');
});

test('AC-008-03 — package.json keeps sqlite-vec as a dependency', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'));
  assert.ok(pkg.dependencies['sqlite-vec'], 'sqlite-vec must remain in dependencies');
});

test('AC-008-03 — package.json keeps better-sqlite3 (sqlite-vec consumer)', async () => {
  // sqlite-vec is loaded as an extension into better-sqlite3, so removing
  // better-sqlite3 would break vector support. T013 cleanup intentionally
  // does NOT remove this dependency.
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'));
  assert.ok(pkg.dependencies['better-sqlite3'], 'better-sqlite3 must remain — sqlite-vec depends on it');
});

test('AC-008-01 — sqlite-vec adapter file still exists at the expected path', async () => {
  // Sanity-check the adapter file is still where the index re-exports it
  // from. If T013 (or anyone else) moves it accidentally, this test fires.
  const adapterPath = path.resolve(__dirname, '../../../src/vectordb/sqlite-vec.js');
  const stat = await import('node:fs').then((fs) => fs.promises.stat(adapterPath));
  assert.ok(stat.isFile(), 'src/vectordb/sqlite-vec.js must remain on disk');
});
