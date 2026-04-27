// T029 — CLI start: spawn API + Worker, write pidfile, health-check.
// Traces: FR-010 (AC-010-05, AC-010-06, AC-010-07)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 12
//
// Cross-platform notes:
//   * Uses child_process.fork for both processes — no shells, no .sh/.cmd.
//   * pidfile location: {dataDir}/run/server.pid
//   * Health check: poll {host}:{api_port}/api/system/health up to 30s.
//   * On Windows, SIGTERM is approximated by process termination — that's
//     fine for our use because the worker is idempotent (Constitution VI.2).
//
// Test seams:
//   runStart({ configPath, dataDir, _spawn, _fetch, _writePid, _readConfig, stdout, _waitMs })
//
//   - _spawn(modulePath, args, opts) → { pid, on, kill }   — fork() seam.
//   - _fetch                                                — health probe seam.
//   - _writePid(pid)                                        — pidfile seam.
//   - _readConfig()                                         — config loader seam.
//   - _waitMs(ms)                                           — sleep seam.
//
// On success returns { pids: {api, worker}, healthy: boolean }.

import { fork as nodeFork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDeploymentVocabulary } from '../pipeline/metadata-vocabulary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 500;

/**
 * @param {object} [opts]
 */
export async function runStart(opts = {}) {
  const stdout = opts.stdout || process.stdout;
  const write = (l) => stdout.write(`${l}\n`);

  const dataDir = opts.dataDir || path.resolve(process.cwd(), 'data');
  const configPath = opts.configPath || path.join(dataDir, 'config.json');

  const readConfig = opts._readConfig || (async () => JSON.parse(await fs.readFile(configPath, 'utf8')));
  const config = await readConfig().catch((err) => {
    throw new Error(`Could not read config at ${configPath} — run \`isdlc-knowledge setup\` first. (${err.message})`);
  });

  // REQ-GH-7 FR-002: validate deployment-wide metadata vocabulary BEFORE
  // forking children. An invalid block fails fast — no half-spawned state.
  const vocabErrors = validateDeploymentVocabulary(config);
  if (vocabErrors.length > 0) {
    write(`Invalid metadata_vocabulary in ${configPath}:`);
    for (const e of vocabErrors) write(`  - ${e}`);
    throw new Error(
      `Deployment metadata_vocabulary in ${configPath} is invalid. Fix the errors above and re-run.`,
    );
  }

  const spawn = opts._spawn || ((mod, args, o) => nodeFork(mod, args, o));
  const fetchFn = opts._fetch;
  const waitMs = opts._waitMs || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const apiEntry = path.resolve(__dirname, '../api/index.js');
  const workerEntry = path.resolve(__dirname, '../worker/index.js');

  write(`Starting API server on ${config.server.host}:${config.server.api_port} ...`);
  const apiChild = spawn(apiEntry, [], {
    env: { ...process.env, KNOWLEDGE_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  write('Starting Worker process ...');
  const workerChild = spawn(workerEntry, [], {
    env: { ...process.env, KNOWLEDGE_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  const writePid = opts._writePid || (async (record) => {
    const runDir = path.join(dataDir, 'run');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'server.pid'), JSON.stringify(record, null, 2), 'utf8');
  });
  await writePid({ api_pid: apiChild.pid, worker_pid: workerChild.pid, started_at: new Date().toISOString() });

  // ---- Health check polling --------------------------------------------
  const healthUrl = `http://${config.server.host}:${config.server.api_port}/api/system/health`;
  const healthy = await pollHealth(healthUrl, fetchFn, waitMs, HEALTH_TIMEOUT_MS, HEALTH_INTERVAL_MS);
  if (healthy) {
    write(`Service is healthy: ${healthUrl}`);
  } else {
    write(`WARN: health endpoint did not respond OK within ${HEALTH_TIMEOUT_MS / 1000}s.`);
  }

  return { pids: { api: apiChild.pid, worker: workerChild.pid }, healthy };
}

async function pollHealth(url, fetchFn, waitMs, timeoutMs, intervalMs) {
  const f = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await f(url);
      if (res && res.ok) return true;
    } catch {
      /* keep polling */
    }
    await waitMs(intervalMs);
  }
  return false;
}
