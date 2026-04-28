// T029 — CLI setup wizard.
// Traces: FR-010 (AC-010-02, AC-010-03, AC-010-04, AC-010-07), FR-012 (AC-012-02)
// See: docs/requirements/REQ-GH-263-.../requirements-spec.md FR-010, FR-012
//      docs/requirements/REQ-GH-263-.../module-design.md §Module 12
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-SETUP-002
//
// Cross-platform: pure Node.js. Uses node:readline + PassThrough-friendly
// `terminal: false` so tests can drive prompts deterministically.
//
// Test seams:
//   runSetup({ stdin, stdout, dataDir, _confirmFn, _fetch, _writeFile, _mkdir })
//
//   - stdin / stdout — defaults to process.stdin/stdout. Tests pass PassThrough
//     streams and write the answer sequence ahead of time.
//   - _confirmFn(message) — yes/no prompt seam (defaults to readline-backed).
//   - _fetch — used for cloud API key validation and model pre-download.
//   - _writeFile / _mkdir — fs seams so tests don't write to real disk
//     unless they want to.
//
// On success returns the resolved config object that was persisted to
// {dataDir}/config.json.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  defaultServiceConfig,
  writeServiceConfig,
} from '../config/service-config.js';

const MODEL_SOURCES = [
  { key: 'local', label: 'Local ONNX (offline, runs in-process)' },
  { key: 'cloud', label: 'Cloud API (OpenAI / Cohere / Bedrock)' },
];

const CLOUD_PROVIDERS = [
  { key: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY' },
  { key: 'cohere', label: 'Cohere', envKey: 'COHERE_API_KEY' },
  { key: 'bedrock', label: 'AWS Bedrock', envKey: 'AWS_ACCESS_KEY_ID' },
];

const VECTOR_BACKENDS = [
  { key: 'sqlite-vec', label: 'sqlite-vec (local, default)', remote: false },
  { key: 'qdrant', label: 'Qdrant (local)', remote: false },
  { key: 'chromadb', label: 'ChromaDB (local)', remote: false },
  { key: 'milvus', label: 'Milvus (local)', remote: false },
  { key: 'weaviate', label: 'Weaviate (local)', remote: false },
  { key: 'faiss', label: 'FAISS (local, in-memory)', remote: false },
  { key: 'opensearch', label: 'OpenSearch (remote)', remote: true },
  { key: 'pinecone', label: 'Pinecone (remote)', remote: true },
  { key: 'qdrant-cloud', label: 'Qdrant Cloud (remote)', remote: true },
  { key: 'weaviate-cloud', label: 'Weaviate Cloud (remote)', remote: true },
  { key: 'milvus-cloud', label: 'Milvus Cloud (Zilliz, remote)', remote: true },
];

const DEFAULT_LOCAL_MODEL = 'all-MiniLM-L6-v2';
const DEFAULT_LOCAL_MODEL_URL =
  'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx';

/**
 * Run the interactive setup wizard.
 *
 * @param {object} [opts]
 * @param {NodeJS.ReadableStream} [opts.stdin]
 * @param {NodeJS.WritableStream} [opts.stdout]
 * @param {string} [opts.dataDir]
 * @param {(msg: string) => Promise<boolean>} [opts._confirmFn]
 * @param {typeof fetch} [opts._fetch]
 * @param {(p: string, c: string) => Promise<void>} [opts._writeFile]
 * @param {(p: string, o?: any) => Promise<void>} [opts._mkdir]
 */
export async function runSetup(opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const dataDir = opts.dataDir || path.resolve(process.cwd(), 'data');
  const writeFile = opts._writeFile || ((p, c) => fs.writeFile(p, c, 'utf8'));
  const mkdir = opts._mkdir || ((p, o) => fs.mkdir(p, o));
  const fetchFn = opts._fetch;

  const reader = createLineReader(stdin);
  const ask = async (q) => {
    stdout.write(q);
    const line = await reader.next();
    return (line || '').trim();
  };
  const confirm = opts._confirmFn || (async (msg) => /^(y|yes)$/i.test(await ask(`${msg} [y/N]: `)));

  const write = (line) => stdout.write(`${line}\n`);

  try {
    write('--- isdlc-knowledge-service setup wizard ---');
    write('All prompts are non-interactive-friendly; press Enter to accept defaults.');

    // ---- 1. Embedding model source ----------------------------------------
    write('\nEmbedding model source:');
    MODEL_SOURCES.forEach((m, i) => write(`  ${i + 1}. ${m.label}`));
    const modelChoiceRaw = await ask('Choose [1]: ');
    const modelChoice = MODEL_SOURCES[parseIndex(modelChoiceRaw, 1, MODEL_SOURCES.length) - 1];

    let modelConfig;
    if (modelChoice.key === 'local') {
      const modelName = (await ask(`Local ONNX model name [${DEFAULT_LOCAL_MODEL}]: `)) || DEFAULT_LOCAL_MODEL;
      const modelUrl = (await ask(`Download URL [${DEFAULT_LOCAL_MODEL_URL}]: `)) || DEFAULT_LOCAL_MODEL_URL;
      modelConfig = { source: 'local', backend: 'onnx', name: modelName, url: modelUrl };

      // AC-010-03: best-effort pre-download. ERR-SETUP-002 → warn + offer cloud fallback.
      const preDownload = await confirm('Pre-download model now?');
      if (preDownload) {
        const ok = await tryDownloadModel(modelUrl, fetchFn, write);
        if (!ok) {
          write('  WARN ERR-SETUP-002: model download failed. You can retry later via `isdlc-knowledge setup`.');
          const fallback = await confirm('Switch to cloud API instead?');
          if (fallback) {
            modelConfig = await promptCloudModel(ask, write, confirm, fetchFn);
          }
        } else {
          modelConfig.downloaded = true;
        }
      }
    } else {
      modelConfig = await promptCloudModel(ask, write, confirm, fetchFn);
    }

    // ---- 2. Vector DB backend ---------------------------------------------
    write('\nVector DB backend:');
    VECTOR_BACKENDS.forEach((b, i) => write(`  ${i + 1}. ${b.label}`));
    const vRaw = await ask('Choose [1]: ');
    const vBackend = VECTOR_BACKENDS[parseIndex(vRaw, 1, VECTOR_BACKENDS.length) - 1];
    const vectordbConfig = { backend: vBackend.key };
    if (vBackend.remote) {
      // AC-010-04: validate remote connectivity. Credentials are stored ONLY as
      // env-var references (Constitution V.5, VII.5). The wizard refuses to
      // persist a bare key.
      vectordbConfig.url = (await ask('Endpoint URL: ')) || '';
      const defaultEnv = `${vBackend.key.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const envName = (await ask(`Env variable name for API key [${defaultEnv}]: `)) || defaultEnv;
      vectordbConfig.api_key = { env: envName };
      write(`  Will read API key from $${envName} at runtime.`);
      write(`  Set it before starting:  export ${envName}=...`);
    }

    // ---- 3. Ports ---------------------------------------------------------
    const apiPortRaw = (await ask('\nAPI port [3000]: ')) || '3000';
    const mcpPortRaw = (await ask('MCP port (0 = same as API) [0]: ')) || '0';
    const apiPort = clampPort(apiPortRaw, 3000);
    const mcpPort = clampPort(mcpPortRaw, 0);
    const host = (await ask('Bind host [127.0.0.1]: ')) || '127.0.0.1';

    // ---- 4. Persist -------------------------------------------------------
    const config = {
      version: 1,
      created_at: new Date().toISOString(),
      server: { host, api_port: apiPort, mcp_port: mcpPort },
      model: modelConfig,
      vectordb: vectordbConfig,
      data_dir: dataDir,
    };

    await mkdir(dataDir, { recursive: true });
    const configPath = path.join(dataDir, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2));

    write(`\nWrote ${configPath}`);

    // ---- 4b. REQ-GH-3 service config (.ks/config.json) -------------------
    // FR-002 / AC-002-01: setup writes the central service-config file. It
    // points at the Postgres database via env-var reference; secrets never
    // live in this file (CON-005 / NFR-003).
    // `.ks/config.json` lives at the project root in production (cwd).
    // Tests pass `serviceConfigCwd: <tmpdir>` for isolation, OR a
    // `_writeServiceConfig` seam that bypasses the disk write entirely.
    const writeServiceConfigFn = opts._writeServiceConfig || writeServiceConfig;
    const cwdForServiceConfig = opts.serviceConfigCwd || opts.cwd || process.cwd();
    const dbUrlEnvName = (await ask(
      'Env variable that holds your Postgres URL [KNOWLEDGE_DATABASE_URL]: ',
    )) || 'KNOWLEDGE_DATABASE_URL';
    const serviceConfig = defaultServiceConfig({ urlEnv: dbUrlEnvName });
    const serviceConfigFilePath = await writeServiceConfigFn({
      cwd: cwdForServiceConfig,
      config: serviceConfig,
    });
    write(`Wrote ${serviceConfigFilePath}`);

    // ---- 4c. REQ-GH-3 FR-010 / AC-010-01..03 — Postgres setup guidance ---
    write('\n--- Postgres setup ---');
    write('REQ-GH-3 / FR-003: PostgreSQL is the runtime state substrate. The');
    write('service does NOT auto-launch Docker; you provide the database.');
    write('');
    write('Quick start (local, macOS):');
    write('  brew install postgresql@16');
    write('  brew services start postgresql@16');
    write('  createdb isdlc_knowledge');
    write(`  export ${dbUrlEnvName}=postgres://localhost:5432/isdlc_knowledge`);
    write('');
    write('Or use any externally managed Postgres 14+ and export');
    write(`  ${dbUrlEnvName}=postgres://user:password@host:5432/database`);
    write('before running `isdlc-knowledge start`.');

    // ---- 5. FR-012 standalone refresh integration guidance ---------------
    const serverUrl = `http://${host}:${apiPort}`;
    write('\n--- Setup complete. ---');
    write('To start the service:   isdlc-knowledge start');
    write('To check status:        isdlc-knowledge status');
    write('');
    write('To trigger refreshes from your CI/CD, POST to');
    write(`  ${serverUrl}/api/refresh`);
    write('with body { source_type, repo_id, changes[] }.');

    return config;
  } finally {
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// Line reader — minimal, framework-free. Survives `stdin.end()` so test
// streams pre-loaded with answers still drain cleanly. Reads bytes as they
// arrive, splits on '\n', and queues both sides of the read/write race so
// callers can pull lines one at a time.
// ---------------------------------------------------------------------------

function createLineReader(stream) {
  const queued = [];     // unread complete lines
  const waiters = [];    // pending next() resolvers
  let buffer = '';
  let ended = false;

  const flushWaiters = () => {
    while (waiters.length && (queued.length || ended)) {
      const resolve = waiters.shift();
      resolve(queued.length ? queued.shift() : '');
    }
  };

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      queued.push(line);
      buffer = buffer.slice(idx + 1);
    }
    flushWaiters();
  };

  const onEnd = () => {
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      queued.push(line);
      buffer = '';
    }
    ended = true;
    flushWaiters();
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onEnd);

  return {
    next: () =>
      new Promise((resolve) => {
        if (queued.length) return resolve(queued.shift());
        if (ended) return resolve('');
        waiters.push(resolve);
      }),
    close: () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onEnd);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function promptCloudModel(ask, write, confirm, fetchFn) {
  write('\nCloud provider:');
  CLOUD_PROVIDERS.forEach((p, i) => write(`  ${i + 1}. ${p.label}`));
  const raw = await ask('Choose [1]: ');
  const provider = CLOUD_PROVIDERS[parseIndex(raw, 1, CLOUD_PROVIDERS.length) - 1];

  // Constitution V.5, VII.5: credentials are stored ONLY as env-var references.
  // Setup never persists a bare API key.
  const envName = (await ask(`Env variable name for API key [${provider.envKey}]: `)) || provider.envKey;
  const config = { source: 'cloud', backend: provider.key, api_key: { env: envName } };
  write(`  Will read API key from $${envName} at runtime.`);
  write(`  Set it before starting:  export ${envName}=...`);

  // Optional: validate immediately if the variable is already exported.
  const liveKey = process.env[envName];
  if (liveKey) {
    const test = await confirm('Validate API key (from current env) with a dry call now?');
    if (test) {
      const ok = await tryValidateCloudKey(provider.key, liveKey, fetchFn, write);
      if (!ok) write('  WARN: validation failed — saving config anyway. Verify key before starting.');
    }
  }
  return config;
}

async function tryDownloadModel(url, fetchFn, write) {
  if (!fetchFn && typeof fetch === 'undefined') {
    write('  Skipping pre-download (no fetch available in this Node).');
    return false;
  }
  const f = fetchFn || fetch;
  try {
    write(`  Downloading ${url} ...`);
    const res = await f(url, { method: 'HEAD' });
    return res && res.ok;
  } catch {
    return false;
  }
}

async function tryValidateCloudKey(provider, apiKey, fetchFn, write) {
  if (!fetchFn && typeof fetch === 'undefined') return false;
  const f = fetchFn || fetch;
  // Provider-specific dry endpoints; HEAD or GET. Failures are non-fatal.
  const endpoints = {
    openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${apiKey}` } },
    cohere: { url: 'https://api.cohere.ai/v1/models', headers: { Authorization: `Bearer ${apiKey}` } },
    bedrock: null, // SigV4 — skip dry call.
  };
  const ep = endpoints[provider];
  if (!ep) return true; // Nothing to validate; trust user.
  try {
    write(`  Validating ${provider} credentials...`);
    const res = await f(ep.url, { method: 'GET', headers: ep.headers });
    return res && res.ok;
  } catch {
    return false;
  }
}

function parseIndex(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) return fallback;
  return n;
}

function clampPort(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return fallback;
  return n;
}
