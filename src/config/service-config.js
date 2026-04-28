// REQ-GH-3 FR-002 — Service config loader (`.ks/config.json`).
//
// `.ks/config.json` is the single runtime service-config file from REQ-GH-3
// onward. It points at the Postgres database (by env-var reference, not
// inline secret), the queue provider, the state provider, the vector
// strategy, and DB-test skip behavior.
//
// This file owns the shape contract — read, write, validate. It does NOT
// open any DB connection; that's T004 (`src/db/pool.js`).
//
// Schema (interface-spec.md):
//   {
//     "version": 1,
//     "database": { "urlEnv": "KNOWLEDGE_DATABASE_URL", "schema": "ks", "ssl": false },
//     "queue":    { "provider": "pg-boss", "schema": "pgboss" },
//     "state":    { "provider": "postgres" },
//     "vectors":  { "provider": "existing" },
//     "tests":    { "skipDbE2EWhenUnconfigured": true }
//   }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SERVICE_CONFIG_DIR = '.ks';
export const SERVICE_CONFIG_FILENAME = 'config.json';
export const SERVICE_CONFIG_VERSION = 1;

const DEFAULT_DB_URL_ENV = 'KNOWLEDGE_DATABASE_URL';

export class ServiceConfigError extends Error {
  /**
   * @param {string} code  — stable taxonomy code (ERR-CONFIG-001 / ERR-DB-001).
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ServiceConfigError';
    this.code = code;
  }
}

/**
 * Resolve `.ks/config.json` under the given working directory.
 * @param {string} cwd
 * @returns {string}
 */
export function serviceConfigPath(cwd) {
  return path.join(cwd, SERVICE_CONFIG_DIR, SERVICE_CONFIG_FILENAME);
}

/**
 * Default service config — written by `isdlc-knowledge setup` when the
 * operator confirms Postgres is the runtime state substrate.
 *
 * @param {{ urlEnv?: string, schema?: string, ssl?: boolean }} [overrides]
 * @returns {ServiceConfig}
 */
export function defaultServiceConfig(overrides = {}) {
  return {
    version: SERVICE_CONFIG_VERSION,
    database: {
      urlEnv: overrides.urlEnv || DEFAULT_DB_URL_ENV,
      schema: overrides.schema || 'ks',
      ssl: overrides.ssl ?? false,
    },
    queue: { provider: 'pg-boss', schema: 'pgboss' },
    state: { provider: 'postgres' },
    vectors: { provider: 'existing' },
    tests: { skipDbE2EWhenUnconfigured: true },
  };
}

/**
 * @typedef {object} ServiceConfig
 * @property {number} version
 * @property {{ urlEnv: string, schema: string, ssl: boolean }} database
 * @property {{ provider: string, schema: string }} queue
 * @property {{ provider: string }} state
 * @property {{ provider: string }} vectors
 * @property {{ skipDbE2EWhenUnconfigured: boolean }} tests
 */

/**
 * Validate a parsed service config object. Returns an array of error
 * strings (empty when valid). Each error names the offending field path.
 *
 * @param {object | undefined | null} cfg
 * @returns {string[]}
 */
export function validateServiceConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['service config must be a JSON object'];
  }

  if (cfg.version !== SERVICE_CONFIG_VERSION) {
    errors.push(`version must be ${SERVICE_CONFIG_VERSION} (got ${JSON.stringify(cfg.version)})`);
  }

  const db = cfg.database;
  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    errors.push('database must be an object');
  } else {
    if (typeof db.urlEnv !== 'string' || db.urlEnv.length === 0) {
      errors.push('database.urlEnv must be a non-empty string (env var name; e.g. "KNOWLEDGE_DATABASE_URL")');
    }
    // Reject inline secrets — credentials are env-var references only (CON-005).
    if (typeof db.url === 'string' && db.url.length > 0) {
      errors.push(
        'database.url is not allowed in .ks/config.json — use database.urlEnv to point at an environment variable instead',
      );
    }
    if (db.schema !== undefined && (typeof db.schema !== 'string' || db.schema.length === 0)) {
      errors.push('database.schema must be a non-empty string when present');
    }
    if (db.ssl !== undefined && typeof db.ssl !== 'boolean') {
      errors.push('database.ssl must be a boolean when present');
    }
  }

  if (cfg.queue !== undefined) {
    if (!cfg.queue || typeof cfg.queue !== 'object' || Array.isArray(cfg.queue)) {
      errors.push('queue must be an object when present');
    } else if (cfg.queue.provider !== undefined && cfg.queue.provider !== 'pg-boss') {
      errors.push(`queue.provider must be "pg-boss" (got ${JSON.stringify(cfg.queue.provider)})`);
    }
  }

  if (cfg.state !== undefined) {
    if (!cfg.state || typeof cfg.state !== 'object' || Array.isArray(cfg.state)) {
      errors.push('state must be an object when present');
    } else if (cfg.state.provider !== undefined && cfg.state.provider !== 'postgres') {
      errors.push(`state.provider must be "postgres" (got ${JSON.stringify(cfg.state.provider)})`);
    }
  }

  return errors;
}

/**
 * Load `.ks/config.json` from disk. Throws `ServiceConfigError` with code
 * `ERR-CONFIG-001` when the file is missing or malformed.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<ServiceConfig>}
 */
export async function loadServiceConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const filePath = serviceConfigPath(cwd);

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ServiceConfigError(
        'ERR-CONFIG-001',
        `Service config not found at ${filePath}. Run \`isdlc-knowledge setup\` to create it.`,
      );
    }
    throw new ServiceConfigError(
      'ERR-CONFIG-001',
      `Could not read service config at ${filePath}: ${err.message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ServiceConfigError(
      'ERR-CONFIG-001',
      `Service config at ${filePath} is not valid JSON: ${err.message}`,
    );
  }

  const errors = validateServiceConfig(parsed);
  if (errors.length > 0) {
    throw new ServiceConfigError(
      'ERR-CONFIG-001',
      `Service config at ${filePath} is invalid:\n  - ${errors.join('\n  - ')}`,
    );
  }

  return parsed;
}

/**
 * Resolve the database URL for a loaded service config by reading the
 * configured environment variable.
 *
 * @param {ServiceConfig} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}  resolved postgres URL
 * @throws {ServiceConfigError}  ERR-DB-001 when the env var is unset/empty.
 */
export function resolveDatabaseUrl(config, env = process.env) {
  const name = config?.database?.urlEnv;
  if (typeof name !== 'string' || name.length === 0) {
    throw new ServiceConfigError(
      'ERR-DB-001',
      'database.urlEnv is missing from service config — cannot resolve a Postgres URL.',
    );
  }
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceConfigError(
      'ERR-DB-001',
      `Environment variable $${name} is not set. Export your Postgres connection URL there before starting.`,
    );
  }
  return value;
}

/**
 * Write `.ks/config.json` atomically. Creates the `.ks/` directory when
 * absent. Returns the absolute path written.
 *
 * @param {{ cwd?: string, config?: ServiceConfig }} options
 * @returns {Promise<string>}
 */
export async function writeServiceConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = options.config || defaultServiceConfig();

  const errors = validateServiceConfig(config);
  if (errors.length > 0) {
    throw new ServiceConfigError(
      'ERR-CONFIG-001',
      `Refusing to write invalid service config:\n  - ${errors.join('\n  - ')}`,
    );
  }

  const dir = path.join(cwd, SERVICE_CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, SERVICE_CONFIG_FILENAME);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return filePath;
}
