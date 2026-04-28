// REQ-GH-3 / FR-002 — DB-specific config helpers.
//
// Bridges the service config (.ks/config.json) to the pool factory.
// Resolves the env-var-referenced URL and returns the pool options shape
// expected by `pool.createPool()`. Surfaces ERR-DB-001 / ERR-DB-002.

import {
  resolveDatabaseUrl,
  ServiceConfigError,
} from '../config/service-config.js';

/**
 * @typedef {object} ResolvedDbConfig
 * @property {string} connectionString  resolved Postgres URL
 * @property {string} schema             namespace for state tables (default "ks")
 * @property {boolean} ssl               whether to enable TLS
 */

/**
 * Resolve a `ServiceConfig` into the concrete options the pool factory
 * needs. The url comes from the configured environment variable; nothing
 * is persisted back to disk.
 *
 * @param {import('../config/service-config.js').ServiceConfig} serviceConfig
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ResolvedDbConfig}
 * @throws {ServiceConfigError}  ERR-DB-001 when the env var is unset.
 */
export function resolveDbConfig(serviceConfig, env = process.env) {
  const connectionString = resolveDatabaseUrl(serviceConfig, env);
  return {
    connectionString,
    schema: serviceConfig?.database?.schema || 'ks',
    ssl: serviceConfig?.database?.ssl ?? false,
  };
}

export { ServiceConfigError };
