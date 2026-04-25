// Unit tests for project store (T003 / FR-001)
// Trace IDs: UT-001 (AC-001-01), UT-002 (AC-001-02), UT-003 (AC-001-05), UT-030 (AC-009-01)
// See: docs/requirements/REQ-GH-263-.../test-strategy.md §1 FR-001
// Specs:
//   - module-design.md §Module 11: Config Store
//   - interface-spec.md ProjectConfig shape
//   - error-taxonomy.md ERR-API-001 INVALID_PROJECT
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProjectStore,
  slugifyProjectId,
} from '../../../src/config/project-store.js';

let dataDir;
let store;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kn-config-'));
  store = createProjectStore({ dataDir });
});

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('slugifyProjectId (UT-003 / AC-001-05)', () => {
  test('derives kebab-case ID from "Payments" + "2.7"', () => {
    assert.equal(slugifyProjectId('Payments', '2.7'), 'payments-2.7');
  });

  test('lowercases name with internal whitespace', () => {
    assert.equal(slugifyProjectId('Order Management', '3.0'), 'order-management-3.0');
  });

  test('preserves dots within version', () => {
    assert.equal(slugifyProjectId('Inventory', '1.2.3'), 'inventory-1.2.3');
  });

  test('strips non-alphanumeric chars from name', () => {
    assert.equal(slugifyProjectId('Foo/Bar!', '0.1'), 'foo-bar-0.1');
  });

  test('throws on empty name', () => {
    assert.throws(() => slugifyProjectId('', '1.0'), /name/i);
  });

  test('throws on empty version', () => {
    assert.throws(() => slugifyProjectId('Foo', ''), /version/i);
  });
});

describe('createProject (UT-001 / AC-001-01)', () => {
  test('persists JSON to data/projects/{id}/config.json', async () => {
    const project = await store.createProject({
      name: 'Payments',
      version: '2.7',
      description: 'Payment processing module',
      sources: [],
      model_config: { source: 'local', model_name: 'jina-v2-base-code', precision: 'fp16' },
      vectordb_config: { backend: 'sqlite-vec', path: 'data/projects/payments-2.7/index.db' },
    });

    assert.equal(project.id, 'payments-2.7');
    assert.equal(project.name, 'Payments');
    assert.equal(project.version, '2.7');
    assert.ok(project.created_at, 'created_at should be set');
    assert.ok(project.updated_at, 'updated_at should be set');

    // Verify it's actually persisted to disk at the documented path.
    const onDisk = JSON.parse(
      await readFile(join(dataDir, 'projects', 'payments-2.7', 'config.json'), 'utf8'),
    );
    assert.equal(onDisk.id, 'payments-2.7');
    assert.equal(onDisk.name, 'Payments');
    assert.equal(onDisk.description, 'Payment processing module');
  });

  test('listProjects returns the created project (UT-001)', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: { source: 'local' },
      vectordb_config: { backend: 'sqlite-vec' },
    });

    const projects = await store.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, 'payments-2.7');
  });

  test('rejects duplicate id (NT — INVALID_PROJECT)', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });

    await assert.rejects(
      () => store.createProject({
        name: 'Payments',
        version: '2.7',
        sources: [],
        model_config: {},
        vectordb_config: {},
      }),
      (err) => {
        assert.equal(err.code, 'INVALID_PROJECT');
        assert.match(err.message, /already exists|duplicate/i);
        return true;
      },
    );
  });

  test('rejects creation when name is missing', async () => {
    await assert.rejects(
      () => store.createProject({ version: '2.7', sources: [], model_config: {}, vectordb_config: {} }),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });

  test('rejects creation when version is missing', async () => {
    await assert.rejects(
      () => store.createProject({ name: 'Payments', sources: [], model_config: {}, vectordb_config: {} }),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });

  test('persists model_config with source field (UT-030 / AC-009-01)', async () => {
    const project = await store.createProject({
      name: 'Cloud Project',
      version: '1.0',
      sources: [],
      model_config: { source: 'cloud', provider: 'openai', api_key_env: 'OPENAI_API_KEY' },
      vectordb_config: { backend: 'pinecone' },
    });
    assert.equal(project.model_config.source, 'cloud');
    assert.equal(project.model_config.provider, 'openai');
  });
});

describe('getProject', () => {
  test('returns the project by id', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });
    const got = await store.getProject('payments-2.7');
    assert.equal(got.id, 'payments-2.7');
  });

  test('throws INVALID_PROJECT for unknown id', async () => {
    await assert.rejects(
      () => store.getProject('does-not-exist'),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });
});

describe('updateProject (UT-002 / AC-001-02)', () => {
  test('adds and removes sources', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [{ type: 'git', url: 'git.example.com/payments', branch: 'main' }],
      model_config: {},
      vectordb_config: {},
    });

    // Add a source
    let updated = await store.updateProject('payments-2.7', {
      sources: [
        { type: 'git', url: 'git.example.com/payments', branch: 'main' },
        { type: 'confluence', url: 'confluence.example.com/PAY' },
      ],
    });
    assert.equal(updated.sources.length, 2);
    assert.equal(updated.sources[1].type, 'confluence');

    // Remove a source
    updated = await store.updateProject('payments-2.7', {
      sources: [{ type: 'confluence', url: 'confluence.example.com/PAY' }],
    });
    assert.equal(updated.sources.length, 1);
    assert.equal(updated.sources[0].type, 'confluence');
  });

  test('preserves id and created_at; bumps updated_at', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });
    const before = await store.getProject('payments-2.7');
    // Sleep 5ms so timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.updateProject('payments-2.7', { description: 'Updated' });
    assert.equal(updated.id, before.id);
    assert.equal(updated.created_at, before.created_at);
    assert.notEqual(updated.updated_at, before.updated_at);
    assert.equal(updated.description, 'Updated');
  });

  test('throws INVALID_PROJECT for unknown id', async () => {
    await assert.rejects(
      () => store.updateProject('does-not-exist', { description: 'x' }),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });

  test('rejects update when id is missing/falsy', async () => {
    await assert.rejects(
      () => store.updateProject(undefined, { description: 'x' }),
      (err) => err.code === 'INVALID_PROJECT',
    );
    await assert.rejects(
      () => store.updateProject('', { description: 'x' }),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });

  test('does not allow id mutation', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });
    const updated = await store.updateProject('payments-2.7', {
      id: 'malicious-id',
      description: 'changed',
    });
    assert.equal(updated.id, 'payments-2.7');
  });
});

describe('deleteProject', () => {
  test('removes the project from listProjects', async () => {
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });
    await store.createProject({
      name: 'Inventory',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });

    await store.deleteProject('payments-2.7');
    const remaining = await store.listProjects();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'inventory-2.7');
  });

  test('throws INVALID_PROJECT for unknown id', async () => {
    await assert.rejects(
      () => store.deleteProject('does-not-exist'),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });
});

describe('listProjects', () => {
  test('returns empty array when dataDir is fresh', async () => {
    const projects = await store.listProjects();
    assert.deepEqual(projects, []);
  });

  test('returns empty array when projects dir is missing', async () => {
    // Use a fresh sub-path that does not exist yet.
    const fresh = createProjectStore({ dataDir: join(dataDir, 'nonexistent') });
    const projects = await fresh.listProjects();
    assert.deepEqual(projects, []);
  });

  test('skips non-directory entries and dirs without config.json', async () => {
    // Create a stray file and a malformed project dir.
    const projectsRoot = join(dataDir, 'projects');
    await mkdir(projectsRoot, { recursive: true });
    await writeFile(join(projectsRoot, 'stray.txt'), 'not a project');
    await mkdir(join(projectsRoot, 'orphan-dir'));

    // Add one valid project alongside.
    await store.createProject({
      name: 'Payments',
      version: '2.7',
      sources: [],
      model_config: {},
      vectordb_config: {},
    });

    const projects = await store.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, 'payments-2.7');
  });
});

describe('credential validator (BLOCKING-1 remediation, Articles V.5/VII.5/VII.6)', () => {
  test('rejects bare api_key in model_config with ERR-API-004', async () => {
    await assert.rejects(
      () =>
        store.createProject({
          name: 'A',
          version: '1',
          sources: [],
          model_config: { source: 'cloud', backend: 'openai', api_key: 'sk-bare' },
          vectordb_config: {},
        }),
      (err) => err.code === 'ERR-API-004' && /model_config\.api_key/.test(err.message),
    );
  });

  test('rejects bare api_key in vectordb_config with ERR-API-004', async () => {
    await assert.rejects(
      () =>
        store.createProject({
          name: 'B',
          version: '1',
          sources: [],
          model_config: {},
          vectordb_config: { backend: 'pinecone', api_key: 'pk-bare' },
        }),
      (err) => err.code === 'ERR-API-004' && /vectordb_config\.api_key/.test(err.message),
    );
  });

  test('rejects bare auth.password in sources[] with ERR-API-004', async () => {
    await assert.rejects(
      () =>
        store.createProject({
          name: 'C',
          version: '1',
          sources: [
            { type: 'svn', url: 'https://svn.example/', auth: { username: 'u', password: 'p' } },
          ],
          model_config: {},
          vectordb_config: {},
        }),
      (err) => err.code === 'ERR-API-004' && /sources\[0\]\.auth\.password/.test(err.message),
    );
  });

  test('rejects bare auth.apiToken in sources[] with ERR-API-004', async () => {
    await assert.rejects(
      () =>
        store.createProject({
          name: 'D',
          version: '1',
          sources: [
            { type: 'confluence', url: 'https://x.atlassian.net/wiki/', auth: { username: 'u', apiToken: 'token' } },
          ],
          model_config: {},
          vectordb_config: {},
        }),
      (err) => err.code === 'ERR-API-004' && /sources\[0\]\.auth\.apiToken/.test(err.message),
    );
  });

  test('accepts { env: "VAR" } reference in model_config', async () => {
    const project = await store.createProject({
      name: 'E',
      version: '1',
      sources: [],
      model_config: { source: 'cloud', backend: 'openai', api_key: { env: 'OPENAI_API_KEY' } },
      vectordb_config: {},
    });
    assert.deepEqual(project.model_config.api_key, { env: 'OPENAI_API_KEY' });
  });

  test('accepts { secret_ref: "..." } reference in vectordb_config', async () => {
    const project = await store.createProject({
      name: 'F',
      version: '1',
      sources: [],
      model_config: {},
      vectordb_config: { backend: 'pinecone', api_key: { secret_ref: 'vault://prod/pk' } },
    });
    assert.deepEqual(project.vectordb_config.api_key, { secret_ref: 'vault://prod/pk' });
  });

  test('updateProject also rejects bare credentials', async () => {
    await store.createProject({
      name: 'G',
      version: '1',
      sources: [],
      model_config: { source: 'cloud', backend: 'openai', api_key: { env: 'OPENAI_API_KEY' } },
      vectordb_config: {},
    });
    await assert.rejects(
      () =>
        store.updateProject('g-1', {
          model_config: { source: 'cloud', backend: 'openai', api_key: 'sk-leak' },
        }),
      (err) => err.code === 'ERR-API-004',
    );
  });
});
