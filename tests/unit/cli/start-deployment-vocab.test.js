// REQ-GH-7 FR-002 — startup validation of deployment metadata vocabulary.
//
// Verifies that runStart fails fast when data/config.json declares an invalid
// metadata_vocabulary block, BEFORE either child process is spawned.
//
// Trace: AC-002-01..03

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { runStart } from '../../../src/cli/start.js';
import { defaultServiceConfig } from '../../../src/config/service-config.js';

// REQ-GH-3 added two new gates (service config + DB URL resolution) to
// runStart. Provide a default service-config seam and ensure the env var
// resolved by start.js is set, so tests that focus on REQ-GH-7 vocabulary
// validation can still reach (or short-circuit before) that gate cleanly.
const stubServiceConfig = async () => defaultServiceConfig();
const ORIGINAL_DB_URL = process.env.KNOWLEDGE_DATABASE_URL;
process.env.KNOWLEDGE_DATABASE_URL =
  process.env.KNOWLEDGE_DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.on('exit', () => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.KNOWLEDGE_DATABASE_URL;
  else process.env.KNOWLEDGE_DATABASE_URL = ORIGINAL_DB_URL;
});

/** Build a fake fork() that records calls and returns a noop child handle. */
function makeSpawnSpy() {
  const calls = [];
  const fn = (mod, args, opts) => {
    calls.push({ mod, args, opts });
    return {
      pid: 99000 + calls.length,
      on: () => {},
      kill: () => {},
    };
  };
  return { fn, calls };
}

function makeStdout() {
  const s = new PassThrough();
  s.captured = '';
  s.on('data', (c) => {
    s.captured += c.toString('utf8');
  });
  return s;
}

const okHealthFetch = async () => ({ ok: true });

test('runStart rejects invalid deployment metadata_vocabulary BEFORE spawning children (AC-002-01)', async () => {
  const spawn = makeSpawnSpy();
  const stdout = makeStdout();

  const config = {
    server: { host: '127.0.0.1', api_port: 3000, mcp_port: 0 },
    metadata_vocabulary: {
      // 'linked_FR' fails the lowercase rule; 'compliance_check' is missing
      // the linked_ prefix; 'linked_fr' redeclares a built-in.
      custom_link_fields: ['linked_FR', 'compliance_check', 'linked_fr'],
    },
  };

  await assert.rejects(
    () =>
      runStart({
        dataDir: '/tmp/kn-test-bad',
        configPath: '/tmp/kn-test-bad/config.json',
        stdout,
        _readConfig: async () => config,
        _spawn: spawn.fn,
        _fetch: okHealthFetch,
        _writePid: async () => {},
        _waitMs: async () => {},
        _loadServiceConfig: stubServiceConfig,
      }),
    (err) => /metadata_vocabulary.*invalid/i.test(err.message),
  );

  assert.equal(spawn.calls.length, 0, 'no child process should have been spawned');
});

test('runStart error output lists every validation error and references config path (AC-002-02)', async () => {
  const spawn = makeSpawnSpy();
  const stdout = makeStdout();

  const config = {
    server: { host: '127.0.0.1', api_port: 3000, mcp_port: 0 },
    metadata_vocabulary: {
      custom_link_fields: ['linked_FR', 'linked_test_case'],
    },
  };

  await assert.rejects(() =>
    runStart({
      dataDir: '/tmp/kn-test-bad',
      configPath: '/tmp/kn-test-bad/config.json',
      stdout,
      _readConfig: async () => config,
      _spawn: spawn.fn,
      _fetch: okHealthFetch,
      _writePid: async () => {},
      _waitMs: async () => {},
    }),
  );

  // Each individual error must be printed before the throw.
  assert.match(stdout.captured, /lowercase snake_case/);
  assert.match(stdout.captured, /built-in field linked_test_case/);
  // The config path is referenced.
  assert.match(stdout.captured, /\/tmp\/kn-test-bad\/config\.json/);
});

test('runStart proceeds normally when metadata_vocabulary block is absent (AC-002-03)', async () => {
  const spawn = makeSpawnSpy();
  const stdout = makeStdout();

  const config = {
    server: { host: '127.0.0.1', api_port: 3000, mcp_port: 0 },
    // No metadata_vocabulary at all.
  };

  const result = await runStart({
    dataDir: '/tmp/kn-test-ok',
    configPath: '/tmp/kn-test-ok/config.json',
    stdout,
    _readConfig: async () => config,
    _spawn: spawn.fn,
    _fetch: okHealthFetch,
    _writePid: async () => {},
    _waitMs: async () => {},
    _loadServiceConfig: stubServiceConfig,
    serviceConfigCwd: '/tmp/kn-test-ok',
  });

  assert.equal(spawn.calls.length, 2, 'API + Worker children spawned');
  assert.equal(result.healthy, true);
});

test('runStart proceeds normally when metadata_vocabulary is valid', async () => {
  const spawn = makeSpawnSpy();
  const stdout = makeStdout();

  const config = {
    server: { host: '127.0.0.1', api_port: 3000, mcp_port: 0 },
    metadata_vocabulary: {
      custom_link_fields: ['linked_jira_epic', 'linked_compliance_check'],
    },
  };

  const result = await runStart({
    dataDir: '/tmp/kn-test-valid',
    configPath: '/tmp/kn-test-valid/config.json',
    stdout,
    _readConfig: async () => config,
    _spawn: spawn.fn,
    _fetch: okHealthFetch,
    _writePid: async () => {},
    _waitMs: async () => {},
    _loadServiceConfig: stubServiceConfig,
    serviceConfigCwd: '/tmp/kn-test-valid',
  });

  assert.equal(spawn.calls.length, 2);
  assert.equal(result.healthy, true);
});
