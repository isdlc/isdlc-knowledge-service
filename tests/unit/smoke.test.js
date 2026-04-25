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
