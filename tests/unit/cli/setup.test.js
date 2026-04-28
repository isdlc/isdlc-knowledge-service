// Unit tests for src/cli/setup.js (T029).
// Traces: FR-010 (AC-010-02, AC-010-03, AC-010-04, AC-010-07), FR-012 (AC-012-02)
// See: docs/requirements/REQ-GH-263-.../requirements-spec.md FR-010, FR-012
//      docs/requirements/REQ-GH-263-.../module-design.md §Module 12

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { runSetup } from '../../../src/cli/setup.js';

let dataDir;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kn-cli-setup-'));
});

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/**
 * Drive readline-backed prompts by writing CRLF-terminated answers ahead of time.
 * Note: readline expects '\n' delimited lines on a non-terminal stream.
 */
function makeStdio(answers) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // Collect output so we can assert on it.
  let captured = '';
  stdout.on('data', (chunk) => { captured += chunk.toString('utf8'); });

  // Write answers. End the stream so readline drains and resolves.
  for (const a of answers) stdin.write(`${a}\n`);
  stdin.end();

  return { stdin, stdout, getOutput: () => captured };
}

describe('runSetup wizard (UT-CLI-001 / AC-010-02)', () => {
  test('writes config.json with local model + sqlite-vec defaults', async () => {
    const { stdin, stdout } = makeStdio([
      '1',           // model source: local
      '',            // model name: default
      '',            // model URL: default
      'n',           // pre-download: no
      '1',           // vectordb: sqlite-vec
      '3000',        // api port
      '0',           // mcp port
      '127.0.0.1',   // host
    ]);

    const config = await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });

    assert.equal(config.model.source, 'local');
    assert.equal(config.model.backend, 'onnx');
    assert.equal(config.vectordb.backend, 'sqlite-vec');
    assert.equal(config.server.api_port, 3000);
    assert.equal(config.server.host, '127.0.0.1');

    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.model, config.model);
  });

  test('cloud branch records provider + api_key as env reference (AC-010-04, V.5)', async () => {
    const { stdin, stdout, getOutput } = makeStdio([
      '2',           // model source: cloud
      '1',           // provider: OpenAI
      '',            // accept default env name (OPENAI_API_KEY)
      '1',           // vectordb: sqlite-vec
      '',            // api port default
      '',            // mcp port default
      '',            // host default
    ]);

    const config = await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });
    assert.equal(config.model.source, 'cloud');
    assert.equal(config.model.backend, 'openai');
    // Constitution V.5 / VII.5: api_key MUST be a {env} reference, not a bare string.
    assert.deepEqual(config.model.api_key, { env: 'OPENAI_API_KEY' });
    assert.match(getOutput(), /Will read API key from \$OPENAI_API_KEY/);
  });

  test('REQ-GH-3 AC-002-01 — setup writes .ks/config.json with default Postgres/queue/state shape', async () => {
    const { stdin, stdout, getOutput } = makeStdio([
      '1', '', '', 'n', // local model + defaults + no download
      '1',              // sqlite-vec
      '', '', '',       // ports + host defaults
      '',               // env var name default → KNOWLEDGE_DATABASE_URL
    ]);

    await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });

    const ksOnDisk = JSON.parse(
      await readFile(join(dataDir, '.ks', 'config.json'), 'utf8'),
    );
    assert.equal(ksOnDisk.version, 1);
    assert.equal(ksOnDisk.database.urlEnv, 'KNOWLEDGE_DATABASE_URL');
    assert.equal(ksOnDisk.database.schema, 'ks');
    assert.equal(ksOnDisk.database.ssl, false);
    assert.equal(ksOnDisk.queue.provider, 'pg-boss');
    assert.equal(ksOnDisk.queue.schema, 'pgboss');
    assert.equal(ksOnDisk.state.provider, 'postgres');
    assert.equal(ksOnDisk.tests.skipDbE2EWhenUnconfigured, true);

    // AC-010-01 — Postgres setup guidance is printed.
    const out = getOutput();
    assert.match(out, /Postgres setup/);
    assert.match(out, /KNOWLEDGE_DATABASE_URL/);
    assert.match(out, /service does NOT auto-launch Docker/);
  });

  test('REQ-GH-3 AC-002-01 — setup honors a custom DB env var name', async () => {
    const { stdin, stdout } = makeStdio([
      '1', '', '', 'n',
      '1',
      '', '', '',
      'KS_PG_URL', // custom env var name
    ]);

    await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });

    const ksOnDisk = JSON.parse(
      await readFile(join(dataDir, '.ks', 'config.json'), 'utf8'),
    );
    assert.equal(ksOnDisk.database.urlEnv, 'KS_PG_URL');
  });

  test('FR-012: setup completion prints refresh integration guidance (AC-012-02)', async () => {
    const { stdin, stdout, getOutput } = makeStdio([
      '1', '', '', 'n',     // local model, defaults, no download
      '1',                  // sqlite-vec
      '4242', '0', '0.0.0.0',
    ]);

    await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });
    const out = getOutput();
    assert.match(out, /POST to/);
    assert.match(out, /\/api\/refresh/);
    assert.match(out, /source_type/);
    assert.match(out, /http:\/\/0\.0\.0\.0:4242/);
  });

  test('AC-010-03: model download attempted when user opts in', async () => {
    let fetchedUrl = null;
    const _fetch = async (url) => { fetchedUrl = url; return { ok: true, status: 200 }; };
    const { stdin, stdout } = makeStdio([
      '1', 'my-model', 'https://example.com/m.onnx', 'y',  // pre-download yes
      '1',
      '', '', '',
    ]);

    const config = await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir, _fetch });
    assert.equal(fetchedUrl, 'https://example.com/m.onnx');
    assert.equal(config.model.downloaded, true);
  });

  test('ERR-SETUP-002: download failure offers cloud fallback', async () => {
    const _fetch = async () => { throw new Error('ENETUNREACH'); };
    const { stdin, stdout, getOutput } = makeStdio([
      '1', '', '', 'y',     // local, defaults, pre-download yes
      'y',                  // fallback to cloud: yes
      '1',                  // provider: openai
      '',                   // accept default env name (OPENAI_API_KEY)
      '1',                  // vectordb sqlite-vec
      '', '', '',
    ]);

    const config = await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir, _fetch });
    assert.equal(config.model.source, 'cloud');
    assert.deepEqual(config.model.api_key, { env: 'OPENAI_API_KEY' });
    assert.match(getOutput(), /ERR-SETUP-002/);
  });

  test('remote vector DB collects URL + api_key as env reference (AC-010-04, V.5)', async () => {
    const { stdin, stdout, getOutput } = makeStdio([
      '1', '', '', 'n',                  // local model, no download
      '8',                                // pinecone (remote)
      'https://example-pinecone.io',     // url
      '',                                 // accept default env name (PINECONE_API_KEY)
      '', '', '',
    ]);

    const config = await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });
    assert.equal(config.vectordb.backend, 'pinecone');
    assert.equal(config.vectordb.url, 'https://example-pinecone.io');
    // Constitution V.5 / VII.5: api_key MUST be a {env} reference, not a bare string.
    assert.deepEqual(config.vectordb.api_key, { env: 'PINECONE_API_KEY' });
    assert.match(getOutput(), /Will read API key from \$PINECONE_API_KEY/);
  });

  test('invalid port falls back to default', async () => {
    const { stdin, stdout } = makeStdio([
      '1', '', '', 'n',
      '1',
      'bogus',         // api port → default 3000
      '99999',         // mcp port out of range → default 0
      '',
    ]);
    const config = await runSetup({ stdin, stdout, dataDir, serviceConfigCwd: dataDir });
    assert.equal(config.server.api_port, 3000);
    assert.equal(config.server.mcp_port, 0);
  });

  test('AC-010-07: pure Node — no shell side-effects (no spawn used)', async () => {
    // Sanity: setup never imports child_process. Asserts the wizard relies
    // only on Node core APIs and works on any platform.
    const src = await readFile(new URL('../../../src/cli/setup.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /child_process/);
    assert.doesNotMatch(src, /\.cmd|\.sh\b/);
  });
});
