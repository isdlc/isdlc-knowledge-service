// T029 — CLI command registry. Wires commander → src/cli/{setup,start,...}.
// Traces: FR-010, FR-012
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 12
//
// Cross-platform: pure Node.js APIs (child_process, fs, http). No shells.
//
// Public surface:
//   registerCommands(program, deps?)  — attach all subcommands to a commander
//                                        Command instance. `deps` is the test
//                                        seam used by commands.test.js to
//                                        substitute spawn / fetch / fs without
//                                        actually starting servers.

import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { runSetup } from './setup.js';
import { runStart } from './start.js';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');

/**
 * @typedef {object} CommandDeps
 * @property {string} [dataDir]
 * @property {NodeJS.WritableStream} [stdout]
 * @property {NodeJS.ReadableStream} [stdin]
 * @property {(opts: any) => Promise<any>} [_runSetup]
 * @property {(opts: any) => Promise<any>} [_runStart]
 * @property {typeof fetch} [_fetch]
 * @property {(pid: number, sig?: string|number) => boolean} [_kill]
 * @property {(msg: string) => Promise<boolean>} [_confirmFn]
 * @property {(ms: number) => Promise<void>} [_waitMs]
 */

/**
 * @param {import('commander').Command} program
 * @param {CommandDeps} [deps]
 */
export function registerCommands(program, deps = {}) {
  const dataDir = deps.dataDir || DEFAULT_DATA_DIR;
  const stdout = deps.stdout || process.stdout;
  const write = (l) => stdout.write(`${l}\n`);

  // ---- setup -----------------------------------------------------------
  program
    .command('setup')
    .description('Interactive first-time setup (model, Vector DB, ports)')
    .action(async () => {
      const fn = deps._runSetup || runSetup;
      await fn({ stdin: deps.stdin, stdout, dataDir, _fetch: deps._fetch, _confirmFn: deps._confirmFn });
    });

  // ---- start -----------------------------------------------------------
  program
    .command('start')
    .description('Start API + Worker processes')
    .action(async () => {
      const fn = deps._runStart || runStart;
      await fn({ dataDir, stdout, _spawn: deps._spawn, _fetch: deps._fetch, _waitMs: deps._waitMs });
    });

  // ---- stop ------------------------------------------------------------
  program
    .command('stop')
    .description('Graceful shutdown (SIGTERM to API + Worker)')
    .action(async () => {
      const kill = deps._kill || ((pid, sig) => process.kill(pid, sig));
      const wait = deps._waitMs || ((ms) => new Promise((r) => setTimeout(r, ms)));
      await stopCommand({ dataDir, write, kill, wait });
    });

  // ---- status ----------------------------------------------------------
  program
    .command('status')
    .description('Report process state and health')
    .action(async () => {
      const kill = deps._kill || ((pid, sig) => process.kill(pid, sig));
      await statusCommand({ dataDir, write, kill, fetchFn: deps._fetch });
    });

  // ---- logs ------------------------------------------------------------
  program
    .command('logs')
    .description('Stream contents of data/logs/*.log')
    .action(async () => {
      await logsCommand({ dataDir, stdout, write });
    });

  // ---- reset <project-id> ----------------------------------------------
  program
    .command('reset')
    .argument('<project-id>', 'Project identifier to clear')
    .description("Clear a project's index and data directory")
    .action(async (projectId) => {
      const confirmFn = deps._confirmFn || (async () => {
        // Default confirm: refuse unless explicit --force flag in argv.
        // We keep it conservative — tests inject _confirmFn directly.
        return process.argv.includes('--force');
      });
      const ok = await confirmFn(`Permanently delete project "${projectId}"?`);
      if (!ok) {
        write('Aborted.');
        return;
      }
      await resetCommand({
        dataDir,
        projectId,
        write,
        fetchFn: deps._fetch,
        kill: deps._kill || ((pid, sig) => process.kill(pid, sig)),
      });
    });

  return program;
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export async function readPidfile(dataDir) {
  const pidPath = path.join(dataDir, 'run', 'server.pid');
  try {
    return JSON.parse(await fs.readFile(pidPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function removePidfile(dataDir) {
  const pidPath = path.join(dataDir, 'run', 'server.pid');
  await fs.rm(pidPath, { force: true });
}

export function isAlive(kill, pid) {
  if (!pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(dataDir) {
  const configPath = path.join(dataDir, 'config.json');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

export async function stopCommand({ dataDir, write, kill, wait }) {
  const record = await readPidfile(dataDir);
  if (!record) {
    write('No pidfile — service not running.');
    return { stopped: false, reason: 'no_pidfile' };
  }

  for (const [name, pid] of [['api', record.api_pid], ['worker', record.worker_pid]]) {
    if (!pid) continue;
    if (!isAlive(kill, pid)) {
      write(`${name} (pid ${pid}) already gone.`);
      continue;
    }
    try {
      kill(pid, 'SIGTERM');
      write(`Sent SIGTERM to ${name} (pid ${pid}).`);
    } catch (err) {
      write(`Failed to signal ${name} (pid ${pid}): ${err.message}`);
    }
  }

  // Best-effort: poll for exit up to ~5s.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(kill, record.api_pid) && !isAlive(kill, record.worker_pid)) break;
    await wait(200);
  }

  await removePidfile(dataDir);
  return { stopped: true };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function statusCommand({ dataDir, write, kill, fetchFn }) {
  const record = await readPidfile(dataDir);
  const config = await readConfig(dataDir);

  if (!record) {
    write('Status: not running (no pidfile).');
    return { running: false };
  }

  const apiAlive = isAlive(kill, record.api_pid);
  const workerAlive = isAlive(kill, record.worker_pid);
  write(`API:    pid ${record.api_pid} ${apiAlive ? 'ALIVE' : 'DEAD'}`);
  write(`Worker: pid ${record.worker_pid} ${workerAlive ? 'ALIVE' : 'DEAD'}`);

  let health = null;
  if (config && apiAlive) {
    const f = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (f) {
      const url = `http://${config.server.host}:${config.server.api_port}/api/system/health`;
      try {
        const res = await f(url);
        health = res && res.ok ? 'ok' : `unhealthy (${res ? res.status : 'no response'})`;
      } catch (err) {
        health = `unreachable (${err.message})`;
      }
      write(`Health: ${health}`);
    }
  }

  return { running: apiAlive || workerAlive, api_alive: apiAlive, worker_alive: workerAlive, health };
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export async function logsCommand({ dataDir, stdout, write }) {
  const logsDir = path.join(dataDir, 'logs');
  let entries;
  try {
    entries = await fs.readdir(logsDir);
  } catch {
    write('No log directory yet (data/logs/). Start the service to begin logging.');
    return { files: 0 };
  }
  const logs = entries.filter((f) => f.endsWith('.log')).sort();
  if (logs.length === 0) {
    write('No log files yet.');
    return { files: 0 };
  }
  for (const f of logs) {
    write(`--- ${f} ---`);
    await new Promise((resolve, reject) => {
      const stream = createReadStream(path.join(logsDir, f), { encoding: 'utf8' });
      stream.on('data', (chunk) => stdout.write(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }
  return { files: logs.length };
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

export async function resetCommand({ dataDir, projectId, write, fetchFn, kill }) {
  // Path 1: server is running → call DELETE /api/projects/:id so it can
  // tear down adapters cleanly. Path 2: server down → just rm -rf.
  const record = await readPidfile(dataDir);
  const config = await readConfig(dataDir);
  const serverUp = record && config && isAlive(kill, record.api_pid);

  if (serverUp && (fetchFn || typeof fetch !== 'undefined')) {
    const f = fetchFn || fetch;
    const url = `http://${config.server.host}:${config.server.api_port}/api/projects/${encodeURIComponent(projectId)}`;
    try {
      const res = await f(url, { method: 'DELETE' });
      if (res && res.ok) {
        write(`Deleted project "${projectId}" via API.`);
        return { mode: 'api', ok: true };
      }
      write(`API DELETE returned ${res ? res.status : 'no response'} — falling back to filesystem cleanup.`);
    } catch (err) {
      write(`API DELETE failed (${err.message}) — falling back to filesystem cleanup.`);
    }
  }

  // Filesystem fallback.
  const projectDir = path.join(dataDir, 'projects', projectId);
  try {
    await fs.rm(projectDir, { recursive: true, force: true });
    write(`Removed ${projectDir}.`);
    return { mode: 'fs', ok: true };
  } catch (err) {
    write(`Failed to remove ${projectDir}: ${err.message}`);
    return { mode: 'fs', ok: false, error: err.message };
  }
}
