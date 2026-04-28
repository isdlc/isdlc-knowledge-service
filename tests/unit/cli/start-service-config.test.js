// REQ-GH-3 — startup gates for the service config + DB URL resolution.
//
// Trace:
//   FR-002 / AC-002-02..03 — start reads .ks/config.json; missing file
//                             produces a clear setup instruction.
//   FR-010 / AC-010-02     — start fails clearly when DB is unreachable
//                             (today: when the configured env var is unset).
//   ERR-CONFIG-001, ERR-DB-001.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { runStart } from '../../../src/cli/start.js';
import {
  defaultServiceConfig,
  ServiceConfigError,
} from '../../../src/config/service-config.js';

function makeSpawnSpy() {
  const calls = [];
  const fn = (mod, args, opts) => {
    calls.push({ mod, args, opts });
    return { pid: 99000 + calls.length, on: () => {}, kill: () => {} };
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

const validLegacyConfig = {
  server: { host: '127.0.0.1', api_port: 3000, mcp_port: 0 },
};

// Manage the env var across tests — never accidentally leak into other suites.
const ORIGINAL_DB_URL = process.env.KNOWLEDGE_DATABASE_URL;
process.on('exit', () => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.KNOWLEDGE_DATABASE_URL;
  else process.env.KNOWLEDGE_DATABASE_URL = ORIGINAL_DB_URL;
});

function withDbUrl(url, fn) {
  return async () => {
    const prior = process.env.KNOWLEDGE_DATABASE_URL;
    if (url === null) delete process.env.KNOWLEDGE_DATABASE_URL;
    else process.env.KNOWLEDGE_DATABASE_URL = url;
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env.KNOWLEDGE_DATABASE_URL;
      else process.env.KNOWLEDGE_DATABASE_URL = prior;
    }
  };
}

test(
  'AC-002-03 — runStart aborts with ERR-CONFIG-001 instructions when .ks/config.json is missing',
  withDbUrl('postgres://x', async () => {
    const spawn = makeSpawnSpy();
    const stdout = makeStdout();

    const failingLoader = async () => {
      throw new ServiceConfigError(
        'ERR-CONFIG-001',
        'Service config not found at /tmp/no-such-place/.ks/config.json. Run `isdlc-knowledge setup` to create it.',
      );
    };

    await assert.rejects(
      () =>
        runStart({
          dataDir: '/tmp/kn-test',
          configPath: '/tmp/kn-test/config.json',
          stdout,
          _readConfig: async () => validLegacyConfig,
          _loadServiceConfig: failingLoader,
          serviceConfigCwd: '/tmp/no-such-place',
          _spawn: spawn.fn,
          _fetch: okHealthFetch,
          _writePid: async () => {},
          _waitMs: async () => {},
        }),
      (err) =>
        /service config at .* is missing or invalid/.test(err.message) &&
        /isdlc-knowledge setup/.test(err.message),
    );

    assert.equal(spawn.calls.length, 0, 'no child process should have spawned');
    assert.match(stdout.captured, /ERR-CONFIG-001/);
    assert.match(stdout.captured, /Service config not found/);
  }),
);

test(
  'AC-010-02 — runStart aborts with ERR-DB-001 when KNOWLEDGE_DATABASE_URL is unset',
  withDbUrl(null, async () => {
    const spawn = makeSpawnSpy();
    const stdout = makeStdout();

    const validLoader = async () => defaultServiceConfig();

    await assert.rejects(
      () =>
        runStart({
          dataDir: '/tmp/kn-test',
          configPath: '/tmp/kn-test/config.json',
          stdout,
          _readConfig: async () => validLegacyConfig,
          _loadServiceConfig: validLoader,
          serviceConfigCwd: '/tmp/kn-test',
          _spawn: spawn.fn,
          _fetch: okHealthFetch,
          _writePid: async () => {},
          _waitMs: async () => {},
        }),
      (err) =>
        /\$KNOWLEDGE_DATABASE_URL is not set/.test(err.message) &&
        /Postgres setup/.test(err.message),
    );

    assert.equal(spawn.calls.length, 0, 'no spawn before DB URL gate passes');
    assert.match(stdout.captured, /ERR-DB-001/);
  }),
);

test(
  'runStart proceeds normally when service config + DB env are both valid',
  withDbUrl('postgres://test@host/db', async () => {
    const spawn = makeSpawnSpy();
    const stdout = makeStdout();

    const validLoader = async () => defaultServiceConfig();

    const result = await runStart({
      dataDir: '/tmp/kn-test',
      configPath: '/tmp/kn-test/config.json',
      stdout,
      _readConfig: async () => validLegacyConfig,
      _loadServiceConfig: validLoader,
      serviceConfigCwd: '/tmp/kn-test',
      _spawn: spawn.fn,
      _fetch: okHealthFetch,
      _writePid: async () => {},
      _waitMs: async () => {},
    });

    assert.equal(spawn.calls.length, 2, 'API + Worker children spawned');
    assert.equal(result.healthy, true);
  }),
);
