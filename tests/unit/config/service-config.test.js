// REQ-GH-3 — service config loader tests.
//
// Trace: FR-002 / AC-002-01..04, FR-010 / AC-010-01..02 (skip behavior),
//        ERR-CONFIG-001, ERR-DB-001.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultServiceConfig,
  loadServiceConfig,
  resolveDatabaseUrl,
  serviceConfigPath,
  ServiceConfigError,
  validateServiceConfig,
  writeServiceConfig,
} from '../../../src/config/service-config.js';

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'kn-svc-cfg-'));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe('defaultServiceConfig', () => {
  test('returns the canonical shape', () => {
    const cfg = defaultServiceConfig();
    assert.equal(cfg.version, 1);
    assert.equal(cfg.database.urlEnv, 'KNOWLEDGE_DATABASE_URL');
    assert.equal(cfg.database.schema, 'ks');
    assert.equal(cfg.database.ssl, false);
    assert.equal(cfg.queue.provider, 'pg-boss');
    assert.equal(cfg.queue.schema, 'pgboss');
    assert.equal(cfg.state.provider, 'postgres');
    assert.equal(cfg.tests.skipDbE2EWhenUnconfigured, true);
  });

  test('honors overrides', () => {
    const cfg = defaultServiceConfig({ urlEnv: 'KS_URL', schema: 'app', ssl: true });
    assert.equal(cfg.database.urlEnv, 'KS_URL');
    assert.equal(cfg.database.schema, 'app');
    assert.equal(cfg.database.ssl, true);
  });
});

describe('validateServiceConfig', () => {
  test('accepts the default config', () => {
    assert.deepEqual(validateServiceConfig(defaultServiceConfig()), []);
  });

  test('rejects null/non-object', () => {
    assert.deepEqual(validateServiceConfig(null), ['service config must be a JSON object']);
    assert.deepEqual(validateServiceConfig([]), ['service config must be a JSON object']);
    assert.deepEqual(validateServiceConfig('hello'), ['service config must be a JSON object']);
  });

  test('rejects missing or wrong-version', () => {
    const cfg = defaultServiceConfig();
    delete cfg.version;
    assert.match(validateServiceConfig(cfg)[0], /version must be 1/);

    cfg.version = 99;
    assert.match(validateServiceConfig(cfg)[0], /version must be 1/);
  });

  test('rejects missing database.urlEnv', () => {
    const cfg = defaultServiceConfig();
    cfg.database.urlEnv = '';
    const errors = validateServiceConfig(cfg);
    assert.ok(errors.some((e) => /urlEnv must be a non-empty string/.test(e)));
  });

  test('REQ-GH-3 NFR-003 — rejects inline database.url (env reference required)', () => {
    const cfg = defaultServiceConfig();
    cfg.database.url = 'postgres://user:secret@host/db';
    const errors = validateServiceConfig(cfg);
    assert.ok(errors.some((e) => /database\.url is not allowed/.test(e)));
  });

  test('rejects unsupported queue/state providers', () => {
    const cfg1 = defaultServiceConfig();
    cfg1.queue.provider = 'graphile';
    assert.ok(validateServiceConfig(cfg1).some((e) => /queue\.provider must be "pg-boss"/.test(e)));

    const cfg2 = defaultServiceConfig();
    cfg2.state.provider = 'sqlite';
    assert.ok(validateServiceConfig(cfg2).some((e) => /state\.provider must be "postgres"/.test(e)));
  });
});

describe('writeServiceConfig + loadServiceConfig round trip', () => {
  test('AC-002-01 — writeServiceConfig writes .ks/config.json with the default shape', async () => {
    const filePath = await writeServiceConfig({ cwd });
    assert.equal(filePath, serviceConfigPath(cwd));

    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(onDisk, defaultServiceConfig());
  });

  test('writeServiceConfig refuses to write an invalid config', async () => {
    await assert.rejects(
      () => writeServiceConfig({ cwd, config: { version: 99, database: { urlEnv: 'X' } } }),
      (err) => err instanceof ServiceConfigError && err.code === 'ERR-CONFIG-001',
    );
  });

  test('AC-002-02 — loadServiceConfig returns the parsed object', async () => {
    await writeServiceConfig({ cwd });
    const cfg = await loadServiceConfig({ cwd });
    assert.equal(cfg.database.urlEnv, 'KNOWLEDGE_DATABASE_URL');
  });

  test('AC-002-03 — loadServiceConfig surfaces a clear ERR-CONFIG-001 when the file is missing', async () => {
    await assert.rejects(
      () => loadServiceConfig({ cwd }),
      (err) =>
        err instanceof ServiceConfigError &&
        err.code === 'ERR-CONFIG-001' &&
        /not found/.test(err.message) &&
        /isdlc-knowledge setup/.test(err.message),
    );
  });

  test('loadServiceConfig surfaces ERR-CONFIG-001 on invalid JSON', async () => {
    await mkdir(join(cwd, '.ks'), { recursive: true });
    await writeFile(join(cwd, '.ks', 'config.json'), '{ not json');
    await assert.rejects(
      () => loadServiceConfig({ cwd }),
      (err) => err.code === 'ERR-CONFIG-001' && /not valid JSON/.test(err.message),
    );
  });

  test('loadServiceConfig surfaces ERR-CONFIG-001 with each validation error listed', async () => {
    await mkdir(join(cwd, '.ks'), { recursive: true });
    await writeFile(
      join(cwd, '.ks', 'config.json'),
      JSON.stringify({
        version: 99,
        database: { urlEnv: '', url: 'postgres://leak' },
      }),
    );
    await assert.rejects(
      () => loadServiceConfig({ cwd }),
      (err) => {
        assert.equal(err.code, 'ERR-CONFIG-001');
        assert.match(err.message, /version must be 1/);
        assert.match(err.message, /urlEnv must be a non-empty string/);
        assert.match(err.message, /database\.url is not allowed/);
        return true;
      },
    );
  });
});

describe('resolveDatabaseUrl', () => {
  test('returns env-resolved URL when configured', () => {
    const cfg = defaultServiceConfig();
    const url = resolveDatabaseUrl(cfg, { KNOWLEDGE_DATABASE_URL: 'postgres://u:p@h/d' });
    assert.equal(url, 'postgres://u:p@h/d');
  });

  test('AC-010-02 — surfaces ERR-DB-001 when env var is unset', () => {
    const cfg = defaultServiceConfig();
    assert.throws(
      () => resolveDatabaseUrl(cfg, {}),
      (err) =>
        err instanceof ServiceConfigError &&
        err.code === 'ERR-DB-001' &&
        /\$KNOWLEDGE_DATABASE_URL is not set/.test(err.message),
    );
  });

  test('surfaces ERR-DB-001 when database.urlEnv is itself missing', () => {
    assert.throws(
      () => resolveDatabaseUrl({ database: {} }, { ANY: 'x' }),
      (err) => err.code === 'ERR-DB-001' && /urlEnv is missing/.test(err.message),
    );
  });
});
