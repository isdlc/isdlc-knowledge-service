// Unit tests for src/cli/commands.js (T029).
// Traces: FR-010 (AC-010-05, AC-010-06, AC-010-07), FR-012
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 12
//
// All tests use injected seams (_runSetup, _runStart, _spawn, _fetch, _kill,
// _confirmFn) so we never start a real server, fork a process, or touch the
// network.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { PassThrough } from 'node:stream';

import {
  registerCommands,
  stopCommand,
  statusCommand,
  logsCommand,
  resetCommand,
  readPidfile,
  isAlive,
} from '../../../src/cli/commands.js';

let dataDir;
let stdout;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kn-cli-cmd-'));
  stdout = new PassThrough();
  stdout.captured = '';
  stdout.on('data', (c) => { stdout.captured += c.toString('utf8'); });
});

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function writePid(record) {
  await mkdir(join(dataDir, 'run'), { recursive: true });
  await writeFile(join(dataDir, 'run', 'server.pid'), JSON.stringify(record));
}

async function writeConfig(cfg) {
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(cfg));
}

function neverAlive() { throw new Error('ESRCH'); }
function alwaysAlive() { /* signal 0 succeeds */ }

describe('registerCommands routing (UT-CLI-010)', () => {
  test('setup invokes _runSetup with shared dataDir', async () => {
    let called = null;
    const program = new Command();
    registerCommands(program, {
      dataDir, stdout,
      _runSetup: async (opts) => { called = opts; return { ok: true }; },
    });
    await program.parseAsync(['node', 'cli', 'setup']);
    assert.ok(called);
    assert.equal(called.dataDir, dataDir);
  });

  test('start invokes _runStart with shared dataDir', async () => {
    let called = null;
    const program = new Command();
    registerCommands(program, {
      dataDir, stdout,
      _runStart: async (opts) => { called = opts; return { pids: { api: 1, worker: 2 }, healthy: true }; },
    });
    await program.parseAsync(['node', 'cli', 'start']);
    assert.equal(called.dataDir, dataDir);
  });

  test('reset requires confirmation', async () => {
    let confirmedWith = null;
    const program = new Command();
    registerCommands(program, {
      dataDir, stdout,
      _confirmFn: async (msg) => { confirmedWith = msg; return false; },
    });
    await program.parseAsync(['node', 'cli', 'reset', 'payments-2.7']);
    assert.match(confirmedWith, /payments-2\.7/);
    assert.match(stdout.captured, /Aborted/);
  });

  test('AC-010-07: registered commands cover all six required verbs', () => {
    const program = new Command();
    registerCommands(program, { dataDir });
    const names = program.commands.map((c) => c.name()).sort();
    assert.deepEqual(names, ['logs', 'reset', 'setup', 'start', 'status', 'stop']);
  });
});

describe('stopCommand (UT-CLI-011)', () => {
  test('returns gracefully when no pidfile', async () => {
    const result = await stopCommand({
      dataDir, write: (l) => stdout.write(l + '\n'),
      kill: alwaysAlive, wait: async () => {},
    });
    assert.equal(result.stopped, false);
    assert.equal(result.reason, 'no_pidfile');
  });

  test('sends SIGTERM to api + worker pids and removes pidfile', async () => {
    await writePid({ api_pid: 111, worker_pid: 222, started_at: 't' });
    const calls = [];
    // Both pids alive on initial check; after both SIGTERMs delivered, the
    // post-loop liveness check returns dead (ESRCH) so the wait loop exits.
    let sigtermsSent = 0;
    const kill = (pid, sig) => {
      calls.push([pid, sig]);
      if (sig === 'SIGTERM') { sigtermsSent++; return; }
      // signal 0 (liveness): treat as alive until both SIGTERMs delivered.
      if (sigtermsSent < 2) return;
      throw new Error('ESRCH');
    };

    const result = await stopCommand({
      dataDir, write: (l) => stdout.write(l + '\n'),
      kill, wait: async () => {},
    });
    assert.equal(result.stopped, true);
    const sigterms = calls.filter((c) => c[1] === 'SIGTERM').map((c) => c[0]).sort();
    assert.deepEqual(sigterms, [111, 222]);
    assert.equal(await readPidfile(dataDir), null);
  });
});

describe('statusCommand (UT-CLI-012 / AC-010-06)', () => {
  test('reports not running when pidfile missing', async () => {
    const result = await statusCommand({
      dataDir, write: (l) => stdout.write(l + '\n'),
      kill: alwaysAlive, fetchFn: async () => ({ ok: true }),
    });
    assert.equal(result.running, false);
  });

  test('reports alive + healthy when api responds 200', async () => {
    await writePid({ api_pid: 10, worker_pid: 20, started_at: 't' });
    await writeConfig({ server: { host: '127.0.0.1', api_port: 3000 } });

    let healthUrl = null;
    const result = await statusCommand({
      dataDir, write: (l) => stdout.write(l + '\n'),
      kill: alwaysAlive,
      fetchFn: async (url) => { healthUrl = url; return { ok: true, status: 200 }; },
    });
    assert.equal(result.api_alive, true);
    assert.equal(result.worker_alive, true);
    assert.equal(result.health, 'ok');
    assert.equal(healthUrl, 'http://127.0.0.1:3000/api/system/health');
  });

  test('reports DEAD when process is gone (ESRCH)', async () => {
    await writePid({ api_pid: 999999, worker_pid: 999998, started_at: 't' });
    const result = await statusCommand({
      dataDir, write: (l) => stdout.write(l + '\n'),
      kill: neverAlive, fetchFn: async () => ({ ok: true }),
    });
    assert.equal(result.api_alive, false);
    assert.equal(result.worker_alive, false);
    assert.match(stdout.captured, /DEAD/);
  });
});

describe('logsCommand (UT-CLI-013)', () => {
  test('handles missing logs/ gracefully', async () => {
    const result = await logsCommand({
      dataDir, stdout, write: (l) => stdout.write(l + '\n'),
    });
    assert.equal(result.files, 0);
    assert.match(stdout.captured, /No log directory/);
  });

  test('streams contents of every .log file', async () => {
    await mkdir(join(dataDir, 'logs'), { recursive: true });
    await writeFile(join(dataDir, 'logs', 'api.log'), 'API_LINE\n');
    await writeFile(join(dataDir, 'logs', 'worker.log'), 'WORKER_LINE\n');
    await writeFile(join(dataDir, 'logs', 'ignore.txt'), 'NOPE\n');

    const result = await logsCommand({
      dataDir, stdout, write: (l) => stdout.write(l + '\n'),
    });
    assert.equal(result.files, 2);
    assert.match(stdout.captured, /API_LINE/);
    assert.match(stdout.captured, /WORKER_LINE/);
    assert.doesNotMatch(stdout.captured, /NOPE/);
  });
});

describe('resetCommand (UT-CLI-014)', () => {
  test('uses DELETE /api/projects/:id when server is up', async () => {
    await writePid({ api_pid: 333, worker_pid: 444, started_at: 't' });
    await writeConfig({ server: { host: '127.0.0.1', api_port: 3000 } });

    let calledUrl = null;
    let calledMethod = null;
    const result = await resetCommand({
      dataDir, projectId: 'payments-2.7',
      write: (l) => stdout.write(l + '\n'),
      kill: alwaysAlive,
      fetchFn: async (url, opts) => { calledUrl = url; calledMethod = opts.method; return { ok: true, status: 200 }; },
    });
    assert.equal(result.mode, 'api');
    assert.equal(result.ok, true);
    assert.equal(calledMethod, 'DELETE');
    assert.match(calledUrl, /\/api\/projects\/payments-2\.7$/);
  });

  test('falls back to filesystem rm when server is down', async () => {
    await mkdir(join(dataDir, 'projects', 'orders-3.0'), { recursive: true });
    await writeFile(join(dataDir, 'projects', 'orders-3.0', 'config.json'), '{}');

    const result = await resetCommand({
      dataDir, projectId: 'orders-3.0',
      write: (l) => stdout.write(l + '\n'),
      kill: neverAlive,
      fetchFn: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.mode, 'fs');
    assert.equal(result.ok, true);
  });
});

describe('isAlive helper', () => {
  test('returns false on ESRCH', () => {
    assert.equal(isAlive(() => { throw new Error('ESRCH'); }, 12345), false);
  });
  test('returns true on signal 0 success', () => {
    assert.equal(isAlive(() => {}, 1), true);
  });
  test('returns false for falsy pid', () => {
    assert.equal(isAlive(() => {}, 0), false);
  });
});
