// Module 4: Source Connectors — default factory.
// Implementations: GitConnector (T012), SvnConnector (T013),
//                  ConfluenceConnector (T014), WebConnector (T015),
//                  GDocsConnector + FilesystemConnector (T016)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//
// Credential resolution (Constitution V.5, VII.5, VII.6): per-source auth
// values may use {env: "..."} references; we resolve them here so connectors
// receive plain strings.

import { GitConnector } from './git.js';
import { SvnConnector } from './svn.js';
import { ConfluenceConnector } from './confluence.js';
import { WebConnector } from './web.js';
import { GDocsConnector } from './gdocs.js';
import { FilesystemConnector } from './filesystem.js';
import { resolveCredential, isCredentialReference } from '../credentials/resolver.js';

export { SourceConnector, ConnectorError } from './connector.js';
export { GitConnector } from './git.js';
export { SvnConnector } from './svn.js';
export { ConfluenceConnector } from './confluence.js';
export { WebConnector } from './web.js';
export { GDocsConnector } from './gdocs.js';
export { FilesystemConnector } from './filesystem.js';

/**
 * Resolve a connector implementation by source type.
 * Auth credential references inside config.auth are resolved before the
 * connector is constructed (so connectors only see plain strings).
 *
 * @param {string} type
 * @param {object} config
 * @returns {import('./connector.js').SourceConnector}
 */
export function getConnector(type, config = {}) {
  const resolvedConfig = resolveConnectorAuth(config);
  switch (type) {
    case 'git':
      return new GitConnector(resolvedConfig);
    case 'svn':
      return new SvnConnector(resolvedConfig);
    case 'confluence':
      return new ConfluenceConnector(resolvedConfig);
    case 'website':
    case 'web':
      return new WebConnector(resolvedConfig);
    case 'gdocs':
      return new GDocsConnector(resolvedConfig);
    case 'filesystem':
      return new FilesystemConnector(resolvedConfig);
    default:
      throw new Error(`Unknown connector type: ${type}`);
  }
}

/**
 * Walk config.auth and resolve any {env: "..."} / {secret_ref} references
 * to plain strings. Pure — returns a shallow clone.
 *
 * @param {object} config
 * @returns {object}
 */
function resolveConnectorAuth(config) {
  if (!config || typeof config !== 'object' || !config.auth || typeof config.auth !== 'object') {
    return config;
  }
  const auth = { ...config.auth };
  for (const key of ['password', 'apiToken', 'api_token', 'bearerToken']) {
    if (isCredentialReference(auth[key])) {
      auth[key] = resolveCredential(auth[key]);
    }
  }
  return { ...config, auth };
}
