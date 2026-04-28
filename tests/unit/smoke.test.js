// Smoke test — confirms node --test runner is wired correctly.
// See: docs/architecture/test-strategy-outline.md §1
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node --test runner is wired', () => {
  assert.equal(1 + 1, 2);
});

test('package.json declares ESM', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.name, 'isdlc-knowledge-service');
});

test('REQ-GH-3 AC-001-01 — package.json declares Node >=22.12.0 engine', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  assert.equal(pkg.engines.node, '>=22.12.0');
});

test('REQ-GH-3 AC-001-02 — package.json declares pg and pg-boss dependencies', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  assert.ok(pkg.dependencies.pg, 'pg dependency is missing');
  assert.ok(pkg.dependencies['pg-boss'], 'pg-boss dependency is missing');
});
